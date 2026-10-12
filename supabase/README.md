# Background scan and push alerts

Every 30 minutes a Supabase cron job calls the `scan` Edge Function. It looks up the
tickers on every user's watchlist, fetches their latest Finnhub company news, stores new
stories in `public.stories`, and sends each user one web-push alert for new stories on
tickers they have push turned on for.

The apps keep each signed-in user's watchlist in `public.watchlist` (which also restores
it on a new device), and the Account page has a **Push alerts on this device** switch
that subscribes the browser.

Nothing here runs on Netlify, so it costs no Netlify credits. On Supabase's free tier
it uses about 1,440 function calls a month (the free allowance is 500,000).

## Setup (once)

Do the steps in this order. Never paste the service-role key or the VAPID **private** key
into Netlify or the app; they belong only in Supabase.

1. **Make a key pair for push** on your computer:

   ```bash
   npx web-push generate-vapid-keys
   ```

   Keep both lines; you need the public key twice and the private key once.

2. **Make a scan secret** (any long random string):

   ```bash
   openssl rand -hex 32
   ```

3. **Create the Edge Function.** Supabase Dashboard → Edge Functions → *Deploy a new
   function* → *Via editor*. Name it `scan`, replace the code with
   `supabase/functions/scan/index.ts`, and deploy. Then open the function's settings and
   turn **Enforce JWT verification** off. The function checks `SCAN_SECRET` itself.

   With the Supabase CLI, the equivalent is:

   ```bash
   npx supabase functions deploy scan --project-ref <project-ref> --no-verify-jwt
   ```

4. **Function secrets.** Dashboard → Edge Functions → Secrets:

   | Name | Value |
   |---|---|
   | `FINNHUB_KEY` | the same Finnhub key as `FINNHUB_KEY` on Netlify |
   | `VAPID_PUBLIC_KEY` | public key from step 1 |
   | `VAPID_PRIVATE_KEY` | private key from step 1 |
   | `VAPID_SUBJECT` | `mailto:` plus an address you read |
   | `SCAN_SECRET` | the string from step 2 |
   | `APP_URL` | where a tapped alert opens, e.g. `https://aa-market-pulse.netlify.app/` |

5. **Tables, policies and the schedule.** SQL Editor:
   1. Store the function address and the scan secret in Vault. Replace the placeholders:

      ```sql
      select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/scan', 'scan_url');
      select vault.create_secret('<SCAN_SECRET from step 2>', 'scan_secret');
      ```

   2. Run all of `supabase/push.sql`.

6. **Netlify.** Add `VAPID_PUBLIC_KEY` (the *public* key only) under Project configuration →
   Environment variables. It needs a deploy to take effect: a staging push is free, and the
   next production deploy picks it up.

## Positions table (optional)

The **Positions** table on the Watchlist screen saves each signed-in user's holdings
(ticker, quantity, average price) to `public.holdings`, so they follow the user to other
devices. Run all of `supabase/holdings.sql` in the SQL Editor once. Until then, positions
are kept on the device only and the app says so.

## Checking it works

- Run the scan by hand:

  ```bash
  curl -X POST -H "Authorization: Bearer <SCAN_SECRET>" https://<project-ref>.supabase.co/functions/v1/scan
  ```

  The reply is the run summary, for example `{"tickers":3,"new_stories":12,"pushes":0,"errors":null}`.
- Recent runs are in `select * from scan_runs order by id desc limit 10;`.
- The schedule is in `select * from cron.job;`, and its recent calls are in
  `select * from cron.job_run_details order by start_time desc limit 10;`.

## How alerts behave

- **What triggers an alert.** Only stories published in the last 3 hours that the scan has
  not seen before. Adding a ticker never floods you with its back catalogue.
- **How many alerts.** One per user per scan, naming the newest story and counting the rest.
- **Muting.** A ticker's push toggle in the watchlist mutes it.
- **Signing out** removes that device's subscription.
- **Expired subscriptions.** When a browser drops a subscription, the push service reports
  it and the scan deletes the row.
- **iPhone / iPad.** Web push works only after *Share → Add to Home Screen*, opening the
  app from there (iOS 16.4+).
- **Finnhub budget.** Up to 50 tickers per run. With more, successive runs take turns.
