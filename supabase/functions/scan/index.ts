// Supabase Edge Function "scan": the Market Pulse background scan.
//
// pg_cron calls it every 10 minutes (supabase/push.sql). Each run:
//   1. collects the tickers on every user's watchlist, plus the US Market tab's ten names,
//   2. asks Finnhub for each ticker's latest company news,
//   3. stores stories it has not seen before in public.stories,
//   4. sends each user one web-push alert listing new stories on the tickers they have
//      push turned on for, and drops subscriptions the push service says are gone,
//   5. alerts the admins (account_status.is_admin) of new accounts waiting for approval.
//
// Secrets (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   FINNHUB_KEY        the same Finnhub key as on Netlify
//   VAPID_PUBLIC_KEY   } the key pair from `npx web-push generate-vapid-keys`;
//   VAPID_PRIVATE_KEY  } the public half also goes on Netlify as VAPID_PUBLIC_KEY
//   VAPID_SUBJECT      mailto:you@example.com (push services contact this if needed)
//   SCAN_SECRET        a long random string; the cron job sends it as a bearer token
//   APP_URL            where a tapped alert opens, e.g. https://aa-market-pulse.pages.dev/
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// A signed-in user can also send themselves a test alert (the app's Account screen):
// header x-hif-test: 1 with their own access token; it goes to their own devices only, at
// most once every 30 seconds, and opens their latest stories like a real alert.
// Deploy with JWT verification off (the bearer token is SCAN_SECRET, not a user JWT):
//   supabase functions deploy scan --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const env = (k: string) => Deno.env.get(k) ?? '';
const MAX_TICKERS = 50;               // Finnhub's free tier allows 60 calls a minute
const CONCURRENCY = 4;
const FRESH_MS = 3 * 3600 * 1000;     // alert only on stories published in the last 3 hours
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
// The app's US Market tab (templates/shared/hif-data.js MARKET_TOP): stored whoever follows
// them, so the AI summary job writes their summaries too. No alerts unless followed.
// On hold (config/flags.json usMarket: false) unless the function's FLAG_US_MARKET secret is 'true'.
const MARKET_TOP = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'TSM', 'JPM'];
const flagOn = (name: string) => env(name) === 'true';

type Story = { id: string; ticker: string; headline: string; source: string | null; url: string | null;
  summary: string | null; published_at: string };

// ---- relevance and publisher: the same rules as netlify/functions/_shared/news-clean.js
// (keep the two in step). Finnhub tags tickers onto general market articles, and
// syndicated stories arrive as "Yahoo" behind a finnhub.io redirect.
const SUFFIX = /\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|se|a\/s|asa|ab|oyj|spa|ADR|class [a-c]|the)\b\.?/gi;
const GENERIC = new Set(['international', 'technologies', 'technology', 'systems', 'global', 'american',
  'america', 'financial', 'capital', 'energy', 'pharmaceuticals', 'therapeutics', 'motors', 'platforms',
  'semiconductor', 'manufacturing', 'industries', 'services', 'solutions', 'communications', 'networks',
  'resources', 'brands', 'enterprises', 'partners', 'trust', 'bank', 'bancorp', 'chase', 'and']);
// Names the press uses that the registered name doesn't contain.
const ALIASES: Record<string, string[]> = {
  GOOGL: ['Google', 'Alphabet'], GOOG: ['Google', 'Alphabet'], META: ['Meta', 'Facebook', 'Instagram', 'WhatsApp'],
  TSM: ['TSMC', 'Taiwan Semiconductor'], NVO: ['Novo Nordisk', 'Novo', 'Wegovy', 'Ozempic'], LLY: ['Eli Lilly', 'Lilly'],
  JPM: ['JPMorgan', 'JP Morgan'], BRK: ['Berkshire'], 'BRK.B': ['Berkshire'], 'BRK.A': ['Berkshire'],
  AMZN: ['Amazon', 'AWS'], MSFT: ['Microsoft', 'Azure'], AAPL: ['Apple', 'iPhone'], NVDA: ['Nvidia'],
  TSLA: ['Tesla'], AVGO: ['Broadcom'], AMD: ['AMD', 'Advanced Micro Devices'], ASTS: ['AST SpaceMobile', 'SpaceMobile']
};

function keywordsFor(symbol: string, companyName: string) {
  const words = new Set(ALIASES[symbol] || []);
  const clean = String(companyName || '').replace(SUFFIX, ' ').replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean) {
    words.add(clean);
    clean.split(' ').forEach(w => { if (w.length >= 4 && !GENERIC.has(w.toLowerCase())) words.add(w); });
  }
  return [...words];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matcher(symbol: string, companyName: string) {
  const words = keywordsFor(symbol, companyName);
  const nameRe = words.length ? new RegExp('\\b(' + words.map(esc).join('|') + ')\\b', 'i') : null;
  // The bare ticker only counts in capitals ("AMD", "$NVDA"), and not for one- or
  // two-letter tickers, which collide with ordinary words.
  const tickerRe = symbol.length >= 3 ? new RegExp('(^|[^A-Za-z])\\$?' + esc(symbol) + '(?![A-Za-z])') : null;
  return (text: string) => (nameRe && nameRe.test(text)) || (tickerRe && tickerRe.test(text));
}

const PUBLISHERS: Record<string, string> = {
  'fool.com': 'Motley Fool', '247wallst.com': '24/7 Wall St.', 'finance.yahoo.com': 'Yahoo Finance',
  'yahoo.com': 'Yahoo Finance', 'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg', 'cnbc.com': 'CNBC',
  'marketwatch.com': 'MarketWatch', 'barrons.com': "Barron's", 'wsj.com': 'WSJ', 'ft.com': 'FT',
  'seekingalpha.com': 'Seeking Alpha', 'benzinga.com': 'Benzinga', 'investors.com': "Investor's Business Daily",
  'zacks.com': 'Zacks', 'thestreet.com': 'TheStreet', 'forbes.com': 'Forbes', 'businessinsider.com': 'Business Insider',
  'insidermonkey.com': 'Insider Monkey', 'investopedia.com': 'Investopedia', 'techcrunch.com': 'TechCrunch',
  'theverge.com': 'The Verge', 'fortune.com': 'Fortune', 'apnews.com': 'AP', 'nytimes.com': 'New York Times',
  'gurufocus.com': 'GuruFocus', 'simplywall.st': 'Simply Wall St', 'tipranks.com': 'TipRanks',
  'globenewswire.com': 'GlobeNewswire', 'prnewswire.com': 'PR Newswire', 'businesswire.com': 'Business Wire',
  'accessnewswire.com': 'ACCESS Newswire', 'investing.com': 'Investing.com', 'nasdaq.com': 'Nasdaq',
  'morningstar.com': 'Morningstar', 'tikr.com': 'TIKR', 'qz.com': 'Quartz', 'marketbeat.com': 'MarketBeat', 'kiplinger.com': 'Kiplinger', 'axios.com': 'Axios', 'theinformation.com': 'The Information'
};
function publisherFor(href: string, fallback: string | null) {
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { return fallback; }
  if (PUBLISHERS[host]) return PUBLISHERS[host];
  const parent = host.split('.').slice(-2).join('.');
  return PUBLISHERS[parent] || parent || fallback;
}


// The real article behind a finnhub.io/api/news redirect ('' when it doesn't resolve).
async function finalUrl(link: string) {
  if (!/^https:\/\/finnhub\.io\/api\/news\?/.test(link)) return '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
      const loc = res.headers.get('location') || '';
      if (/^https:\/\//.test(loc)) return loc;
      if (res.status !== 429 || attempt) return '';
      await new Promise(r => setTimeout(r, 400));
    } catch { return ''; }
  }
  return '';
}

function ymd(ms: number) { return new Date(ms).toISOString().slice(0, 10); }

// Constant-time comparison for the bearer secret.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Bucharest (.RO), XETRA (.DE) and London (.L) listings have no Finnhub news. Their stories
// come from the app's own market gateway (APP_URL), which reads the Romanian, German and
// British press and already files each story under the company it names.
const viaGateway = (t: string) => /\.(RO|DE|L)$/.test(t);

async function companyNews(ticker: string, name: string, errors: string[]): Promise<Story[]> {
  const now = Date.now();
  const range = `from=${ymd(now - 2 * 86400000)}&to=${ymd(now + 86400000)}`;
  const bvb = viaGateway(ticker);
  const url = bvb
    ? new URL(`api/finnhub?path=/company-news&symbol=${encodeURIComponent(ticker)}&${range}`, env('APP_URL') || 'http://invalid/').toString()
    : `${env('FINNHUB_BASE') || 'https://finnhub.io/api/v1'}/company-news?symbol=${encodeURIComponent(ticker)}&${range}`;
  try {
    const res = await fetch(url, bvb ? { signal: AbortSignal.timeout(15000) } : { headers: { 'X-Finnhub-Token': env('FINNHUB_KEY') } });
    if (!res.ok) { errors.push(`${ticker}: ${bvb ? 'gateway' : 'finnhub'} ${res.status}`); return []; }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const relevant = bvb ? () => true : matcher(ticker, name);
    return rows.filter(n => n && n.id && n.headline && n.datetime && relevant(n.headline + ' ' + (n.summary || '')))
      .sort((a, b) => b.datetime - a.datetime).slice(0, 25).map(n => ({
      id: `${ticker}:${n.id}`,
      ticker,
      headline: String(n.headline).slice(0, 500),
      source: n.source ? String(n.source).slice(0, 120) : null,
      url: /^https?:\/\//.test(n.url || '') ? String(n.url).slice(0, 1000) : null,
      summary: n.summary ? String(n.summary).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
      published_at: new Date(n.datetime * 1000).toISOString(),
    }));
  } catch (e) {
    errors.push(`${ticker}: ${(e as Error).message}`);
    return [];
  }
}

// The BVB and EU Market feed tabs: every Romanian (or German and British) press story that
// names a listed company, whoever follows it. Stored like the rest so the AI summary job
// writes summaries for those tabs too; alerts still go only to users who follow the company.
// Ids match companyNews() for .RO, .DE and .L tickers.
async function pressMarketNews(path: string, label: string, errors: string[], keep: (t: string) => boolean = viaGateway): Promise<Story[]> {
  const appUrl = env('APP_URL');
  if (!appUrl) return [];
  try {
    const res = await fetch(new URL(`api/finnhub?path=${path}`, appUrl).toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { errors.push(`${label}: gateway ${res.status}`); return []; }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const since = Date.now() - 2 * 86400000;
    return rows.filter(n => n && n.id && n.headline && n.datetime * 1000 > since && TICKER_RE.test(String(n.related || '')) && keep(n.related))
      .slice(0, 100).map(n => ({
        id: `${n.related}:${n.id}`,
        ticker: n.related,
        headline: String(n.headline).slice(0, 500),
        source: n.source ? String(n.source).slice(0, 120) : null,
        url: /^https?:\/\//.test(n.url || '') ? String(n.url).slice(0, 1000) : null,
        summary: n.summary ? String(n.summary).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
        published_at: new Date(n.datetime * 1000).toISOString(),
      }));
  } catch (e) {
    errors.push(`${label}: ${(e as Error).message}`);
    return [];
  }
}

// One alert per user per run: the newest story leads, the rest are counted. A tap opens
// the article itself when there is one story (article), else the app on those stories
// (url …#alert=<ids>, the app's "From this alert" screen).
function message(stories: Story[], appUrl: string) {
  const s = [...stories].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const tickers = [...new Set(s.map(x => x.ticker))];
  const title = s.length === 1 ? `${s[0].ticker} · new story` : `${s.length} new stories · ${tickers.slice(0, 4).join(', ')}${tickers.length > 4 ? '…' : ''}`;
  const body = s[0].headline + (s.length > 1 ? `  (+${s.length - 1} more)` : '');
  const base = appUrl.replace(/#.*$/, '');
  const url = base + '#alert=' + s.slice(0, 20).map(x => encodeURIComponent(x.id)).join(',');
  const article = s.length === 1 && s[0].url && /^https:\/\//.test(s[0].url) ? s[0].url : null;
  return JSON.stringify({ title, body, url, article, tag: 'market-pulse-scan' });
}

// ---- the test alert ---------------------------------------------------------------------
// The app's own sites (production, its branch deploys such as staging--) may call it.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  let app = '';
  try { app = new URL(env('APP_URL')).origin; } catch { /* unset */ }
  // Netlify (branch deploys: staging--) and Cloudflare Pages (branch and commit previews: staging.).
  const ok = origin && (origin === app || /^https:\/\/(?:(?:[a-z0-9-]+--)?aa-market-pulse\.netlify\.app|(?:[a-z0-9-]+\.)?aa-market-pulse\.pages\.dev)$/.test(origin));
  return ok ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, x-hif-test, content-type, apikey', 'access-control-max-age': '600', vary: 'origin' } : { vary: 'origin' };
}
const lastTest = new Map<string, number>();
async function testAlert(req: Request): Promise<Response> {
  const cors = corsFor(req);
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'sign in required' }, 401);
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data: who, error: whoErr } = await db.auth.getUser(token);
  const uid = who && who.user && who.user.id;
  if (whoErr || !uid) return reply({ error: 'sign in required' }, 401);
  // The database's own rule (approved, not suspended, two-factor code given when set up).
  const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { auth: { persistSession: false }, global: { headers: { Authorization: 'Bearer ' + token } } });
  const { data: ok } = await asUser.rpc('is_approved');
  if (ok !== true) return reply({ error: 'account not approved' }, 403);
  const now = Date.now();
  if (now - (lastTest.get(uid) || 0) < 30_000) return reply({ error: 'wait' }, 429);
  lastTest.set(uid, now);
  if (!(env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY') && env('VAPID_SUBJECT'))) return reply({ error: 'push not configured' }, 503);
  const { data: subs } = await db.from('push_subscriptions').select('endpoint,p256dh,auth').eq('user_id', uid);
  if (!subs || !subs.length) return reply({ sent: 0, devices: 0 });
  // The user's three latest stories, so the tap does what a real alert does.
  const { data: wl } = await db.from('watchlist').select('ticker').eq('user_id', uid);
  const tickers = [...new Set((wl || []).map(r => r.ticker))].slice(0, 100);
  let stories: Story[] = [];
  if (tickers.length) {
    const { data } = await db.from('stories').select('id,ticker,headline,source,url,summary,published_at').in('ticker', tickers)
      .order('published_at', { ascending: false }).limit(3);
    stories = (data || []) as Story[];
  }
  const appUrl = env('APP_URL') || '/';
  const payload = stories.length
    ? (() => { const m = JSON.parse(message(stories, appUrl)); return JSON.stringify(Object.assign(m, { title: 'Test · ' + m.title, tag: 'market-pulse-test' })); })()
    : JSON.stringify({ title: 'Market Pulse · test', body: 'Notifications work on this device.', url: appUrl.replace(/#.*$/, ''), tag: 'market-pulse-test' });
  webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  let sent = 0;
  await pool(subs, 6, async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 600, urgency: 'high' });
      sent++;
      await db.from('push_subscriptions').update({ last_ok: new Date().toISOString() }).eq('endpoint', sub.endpoint);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    }
  });
  return reply({ sent, devices: subs.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req) });
  if (req.headers.get('x-hif-test') === '1') return testAlert(req);
  const secret = env('SCAN_SECRET');
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(given, secret)) return new Response('forbidden', { status: 403 });

  const started_at = new Date().toISOString();
  const errors: string[] = [];
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: wl, error: wlErr } = await db.from('watchlist').select('user_id,ticker,push');
  if (wlErr) return Response.json({ error: 'watchlist: ' + wlErr.message }, { status: 500 });

  // Alerts only (?mode=alerts, or the SCAN_FETCH secret set to 'off'): the ingestion job
  // (ingest/, GitHub Actions) has already stored the news; this run only sends the push
  // alerts for stories not alerted yet, and fetches nothing itself.
  const alertsOnly = new URL(req.url).searchParams.get('mode') === 'alerts' || env('SCAN_FETCH') === 'off';
  let tickers: string[] = [];
  const fresh: Story[] = [];
  if (alertsOnly) {
    const { data, error } = await db.from('stories').select('id,ticker,headline,source,url,summary,published_at')
      .is('alerted_at', null).gt('found_at', new Date(Date.now() - 3600000).toISOString()).limit(500);
    if (error) errors.push('stories: ' + error.message);
    fresh.push(...(data || []));
    tickers = [...new Set(fresh.map(s => s.ticker))];
  } else {

  // Every distinct ticker; past the Finnhub budget, successive runs take turns.
  const allTickers = [...new Set((wl || []).map(r => r.ticker).concat(flagOn('FLAG_US_MARKET') ? MARKET_TOP : []).filter(t => TICKER_RE.test(t)))].sort();
  tickers = allTickers;
  if (tickers.length > MAX_TICKERS) {
    const slots = Math.ceil(tickers.length / MAX_TICKERS);
    const slot = Math.floor(Date.now() / (10 * 60000)) % slots;
    tickers = tickers.slice(slot * MAX_TICKERS, (slot + 1) * MAX_TICKERS);
  }

  // Company names (for the relevance check), cached in public.ticker_names.
  const names = new Map<string, string>();
  const { data: nameRows } = await db.from('ticker_names').select('ticker,name').in('ticker', tickers);
  (nameRows || []).forEach(r => names.set(r.ticker, r.name || ''));
  const unnamed = tickers.filter(t => !names.has(t) && !viaGateway(t)).slice(0, 10);
  for (const t of unnamed) {
    try {
      const res = await fetch(`${env('FINNHUB_BASE') || 'https://finnhub.io/api/v1'}/stock/profile2?symbol=${encodeURIComponent(t)}`, { headers: { 'X-Finnhub-Token': env('FINNHUB_KEY') } });
      const name = res.ok ? String((await res.json()).name || '') : '';
      names.set(t, name);
      await db.from('ticker_names').upsert({ ticker: t, name, updated_at: new Date().toISOString() });
    } catch { names.set(t, ''); }
  }

  const followed = (await pool(tickers, CONCURRENCY, t => companyNews(t, names.get(t) || '', errors))).flat();
  const seen = new Set(followed.map(s => s.id));
  // US press releases and CNBC / MarketWatch stories (us-news.js) for every followed US ticker,
  // named as in public.ticker_names.
  const usTickers = new Set(allTickers.filter(t => !viaGateway(t)));
  const { data: usNameRows } = await db.from('ticker_names').select('ticker,name').in('ticker', [...usTickers]);
  const usNames = (usNameRows || []).filter(r => r.name).slice(0, 80)
    .map(r => r.ticker + ':' + String(r.name).replace(/[^\w .,&'()-]/g, ' ').slice(0, 80)).join('|');
  const press = (await pressMarketNews('/ro-news', 'bvb feed', errors))
    // The EU Market tab's feed (every XETRA and London story) only while that tab is on;
    // followed .DE and .L shares get theirs from companyNews above.
    .concat(flagOn('FLAG_EU_MARKET') ? await pressMarketNews('/eu-news', 'eu feed', errors) : [])
    .concat(await pressMarketNews('/us-news&names=' + encodeURIComponent(usNames), 'us press', errors, t => usTickers.has(t)));
  const found = followed.concat(press.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; }));

  // Insert what is new; ON CONFLICT DO NOTHING returns only the rows actually inserted.
  for (let i = 0; i < found.length; i += 500) {
    const { data, error } = await db.from('stories')
      .upsert(found.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true })
      .select('id,ticker,headline,source,url,summary,published_at');
    if (error) errors.push('stories: ' + error.message);
    else fresh.push(...(data || []));
  }

  // The real publisher and article link for the stories that are actually new.
  // Two at a time: Finnhub refuses bursts of these lookups.
  await pool(fresh, 2, async s => {
    const url = await finalUrl(s.url || '');
    if (!url) return;
    s.url = url; s.source = publisherFor(url, s.source);
    await db.from('stories').update({ url, source: s.source }).eq('id', s.id);
  });
  } // end of fetching (not in alerts-only mode)

  // Alerts: recent new stories, for users with push on for that ticker.
  const recent = fresh.filter(s => Date.now() - Date.parse(s.published_at) < FRESH_MS);
  const byTicker = new Map<string, Story[]>();
  recent.forEach(s => byTicker.set(s.ticker, [...(byTicker.get(s.ticker) || []), s]));
  const perUser = new Map<string, Story[]>();
  (wl || []).forEach(r => {
    if (!r.push || !byTicker.has(r.ticker)) return;
    perUser.set(r.user_id, [...(perUser.get(r.user_id) || []), ...byTicker.get(r.ticker)!]);
  });

  let pushes = 0;
  const vapidOk = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY') && env('VAPID_SUBJECT');
  if (perUser.size && !vapidOk) errors.push('push: VAPID secrets are not set');
  if (perUser.size && vapidOk) {
    webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
    const { data: subs, error: subErr } = await db.from('push_subscriptions')
      .select('endpoint,user_id,p256dh,auth').in('user_id', [...perUser.keys()]);
    if (subErr) errors.push('subscriptions: ' + subErr.message);
    const appUrl = env('APP_URL') || '/';
    await pool(subs || [], 6, async sub => {
      const payload = message(perUser.get(sub.user_id) || [], appUrl);
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600, urgency: 'normal' });
        pushes++;
        await db.from('push_subscriptions').update({ last_ok: new Date().toISOString() }).eq('endpoint', sub.endpoint);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: the browser unsubscribed or the subscription expired.
        if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        else errors.push(`push ${code || ''}: ${(e as Error).message}`.slice(0, 200));
      }
    });
  }

  // Each story is alerted at most once, whether or not anyone had push on for it.
  if (alertsOnly && fresh.length) {
    // In slices: the ids go in the request's URL.
    const at = new Date().toISOString();
    for (let i = 0; i < fresh.length; i += 100) {
      const { error } = await db.from('stories').update({ alerted_at: at }).in('id', fresh.slice(i, i + 100).map(s => s.id));
      if (error) errors.push('alerted_at: ' + error.message);
    }
  }

  // New accounts waiting for the owner's approval (supabase/approval.sql): one alert to the
  // admins' devices, once per account.
  const { data: waiting } = await db.from('account_status').select('user_id,email')
    .eq('approved', false).is('notified_at', null).limit(20);
  if (waiting && waiting.length && vapidOk) {
    const { data: admins } = await db.from('account_status').select('user_id').eq('is_admin', true);
    const ids = (admins || []).map(a => a.user_id);
    const { data: adminSubs } = ids.length
      ? await db.from('push_subscriptions').select('endpoint,p256dh,auth').in('user_id', ids) : { data: [] };
    webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
    const payload = JSON.stringify({ title: waiting.length === 1 ? 'Cont nou de aprobat' : `${waiting.length} conturi noi de aprobat`,
      body: waiting.map(w => w.email || '?').join(', ') + ' · Supabase → account_status → approved',
      url: (env('APP_URL') || '/').replace(/#.*$/, '') + '#admin', tag: 'market-pulse-signup' });
    let sent = 0;
    await pool(adminSubs || [], 4, async sub => {
      try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, urgency: 'high' }); sent++; }
      catch (e) { errors.push(`signup alert: ${(e as Error).message}`.slice(0, 200)); }
    });
    // Marked only once an admin device got it; until then it is tried again every run.
    if (sent) await db.from('account_status').update({ notified_at: new Date().toISOString() }).in('user_id', waiting.map(w => w.user_id));
  }

  const summary = { started_at, mode: alertsOnly ? 'alerts' : 'scan', tickers: tickers.length, new_stories: fresh.length, pushes,
    errors: errors.length ? errors.slice(0, 20).join('\n') : null };
  // The table has no mode column: an extra field made the insert fail (and "last scan" stop).
  const { error: runErr } = await db.from('scan_runs').insert({ started_at, tickers: tickers.length, new_stories: fresh.length, pushes, errors: summary.errors });
  if (runErr) console.log(JSON.stringify({ evt: 'scan.runs_insert_failed', message: runErr.message }));
  return Response.json(summary);
});
