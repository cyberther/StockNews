// Supabase Edge Function "scan": the Market Pulse background scan.
//
// pg_cron calls it every 30 minutes (supabase/push.sql). Each run:
//   1. collects the tickers on every user's watchlist,
//   2. asks Finnhub for each ticker's latest company news,
//   3. stores stories it has not seen before in public.stories,
//   4. sends each user one web-push alert listing new stories on the tickers they have
//      push turned on for, and drops subscriptions the push service says are gone.
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

type Story = { id: string; ticker: string; headline: string; source: string | null; url: string | null;
  summary: string | null; published_at: string };

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

async function companyNews(ticker: string, errors: string[]): Promise<Story[]> {
  const now = Date.now();
  const url = `${env('FINNHUB_BASE') || 'https://finnhub.io/api/v1'}/company-news?symbol=${encodeURIComponent(ticker)}&from=${ymd(now - 2 * 86400000)}&to=${ymd(now + 86400000)}`;
  try {
    const res = await fetch(url, { headers: { 'X-Finnhub-Token': env('FINNHUB_KEY') } });
    if (!res.ok) { errors.push(`${ticker}: finnhub ${res.status}`); return []; }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.filter(n => n && n.id && n.headline && n.datetime).slice(0, 40).map(n => ({
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

// One alert per user per run: the newest story leads, the rest are counted.
function message(stories: Story[], appUrl: string) {
  const s = [...stories].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const tickers = [...new Set(s.map(x => x.ticker))];
  const title = s.length === 1 ? `${s[0].ticker} · new story` : `${s.length} new stories · ${tickers.slice(0, 4).join(', ')}${tickers.length > 4 ? '…' : ''}`;
  const body = s[0].headline + (s.length > 1 ? `  (+${s.length - 1} more)` : '');
  return JSON.stringify({ title, body, url: appUrl, tag: 'market-pulse-scan' });
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
  let tickers = [...new Set((wl || []).map(r => r.ticker).filter(t => TICKER_RE.test(t)))].sort();
  if (tickers.length > MAX_TICKERS) {
    const slots = Math.ceil(tickers.length / MAX_TICKERS);
    const slot = Math.floor(Date.now() / (30 * 60000)) % slots;
    tickers = tickers.slice(slot * MAX_TICKERS, (slot + 1) * MAX_TICKERS);
  }

  const found = (await pool(tickers, CONCURRENCY, t => companyNews(t, errors))).flat();

  // Insert what is new; ON CONFLICT DO NOTHING returns only the rows actually inserted.
  const fresh: Story[] = [];
  for (let i = 0; i < found.length; i += 500) {
    const { data, error } = await db.from('stories')
      .upsert(found.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true })
      .select('id,ticker,headline,source,url,summary,published_at');
    if (error) errors.push('stories: ' + error.message);
    else fresh.push(...(data || []));
  }

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

  const summary = { started_at, tickers: tickers.length, new_stories: fresh.length, pushes,
    errors: errors.length ? errors.slice(0, 20).join('\n') : null };
  await db.from('scan_runs').insert(summary);
  return Response.json(summary);
});
