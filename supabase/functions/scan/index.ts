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
//   APP_URL            where a tapped alert opens, e.g. https://aa-market-pulse.netlify.app/
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
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
const MARKET_TOP = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'TSM', 'JPM'];

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

Deno.serve(async (req) => {
  const secret = env('SCAN_SECRET');
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(given, secret)) return new Response('forbidden', { status: 403 });

  const started_at = new Date().toISOString();
  const errors: string[] = [];
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const { data: wl, error: wlErr } = await db.from('watchlist').select('user_id,ticker,push');
  if (wlErr) return Response.json({ error: 'watchlist: ' + wlErr.message }, { status: 500 });

  // Every distinct ticker; past the Finnhub budget, successive runs take turns.
  const allTickers = [...new Set((wl || []).map(r => r.ticker).concat(MARKET_TOP).filter(t => TICKER_RE.test(t)))].sort();
  let tickers = allTickers;
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
    .concat(await pressMarketNews('/eu-news', 'eu feed', errors))
    .concat(await pressMarketNews('/us-news&names=' + encodeURIComponent(usNames), 'us press', errors, t => usTickers.has(t)));
  const found = followed.concat(press.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; }));

  // Insert what is new; ON CONFLICT DO NOTHING returns only the rows actually inserted.
  const fresh: Story[] = [];
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

  const summary = { started_at, tickers: tickers.length, new_stories: fresh.length, pushes,
    errors: errors.length ? errors.slice(0, 20).join('\n') : null };
  await db.from('scan_runs').insert(summary);
  return Response.json(summary);
});
