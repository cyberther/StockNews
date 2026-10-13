<!-- Converted from "HIF Server Setup.dc.html" (a Claude Design page) when the design-system files were removed. -->

# Running Heard It First on your own machine

A setup guide for Ubuntu or Debian: install the runtime, serve the app on your home network, add real Google and email sign-in, keep the market-data key off the browser, and store watchlists in a database instead of browser storage.

- **Machine:** Ubuntu / Debian
- **Reachable from:** home network only
- **Auth & database:** Supabase (hosted)
- **Time to first run:** about 20 minutes

## Read this first

Three decisions were made for you, and one thing is being deliberately left out.

**Supabase runs your accounts and your database.** Auth and Postgres come from one dashboard on a free tier, which means nothing to install, patch or back up on your side beyond one dump file. It also solves a real problem: Google sign-in demands an HTTPS callback address, and your machine has no public address. Google sends users to Supabase's HTTPS domain, and Supabase hands them back to your local address — so real Google sign-in works on a home network with no domain, no port forwarding and no certificate.

**Apple sign-in is deferred.** It requires a paid Apple Developer account, 99 USD a year, plus a real domain you control. There is no free or local path. Google and email/password cover you until you want one; the iCloud button stays in the interface, wired to the mock, and takes about an hour to make real once the domain exists.

**A small server sits in front of the market data.** A Finnhub key in browser code is a key anyone can read and spend. Sections 04 and 06 put a Node process in between, so the token stays on the machine.

### What runs where

Your machine serves the interface and holds the Finnhub token. Supabase holds accounts, passwords and per-user settings. Finnhub supplies prices. Nothing else is involved, and nothing is exposed to the internet.

## 01 · Base packages

Node 22 is the current long-term-support release. Ubuntu's own repositories carry an older one, so this installs from NodeSource.

```
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw unzip postgresql-client

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v    # expect v22.x
npm -v
```

`postgresql-client` is only for taking backups in section 08; the database itself is hosted.

## 02 · Put the code in place

Either clone your repository, or unzip the download. Both end at the same layout.

```
sudo mkdir -p /srv/hif
sudo chown "$USER":"$USER" /srv/hif
cd /srv/hif

git clone https://github.com/cyberther/StockNews.git .
#   or: unzip ~/Downloads/project.zip -d /srv/hif

mkdir -p server/public
cp export/HIF-Web-Dark.html    server/public/index.html
cp export/HIF-Mobile-Dark.html server/public/mobile.html
```

Those two files in `public/` are the self-contained builds — every script, style and font inlined. They run with no build step, and at this stage they still keep settings in browser storage and use demo prices. Section 06 is where that changes.

## 03 · Supabase project, Google and email sign-in

This part is all in a browser. Find your machine's address on the network first, because several fields below need it.

```
hostname -I | awk '{print $1}'    # e.g. 192.168.1.42
```

**Create the project.**

1. At **supabase.com**, sign up and create a project. Pick the region closest to you and save the database password it generates — it is shown once.

2. Open **Project Settings → API**. Copy the *Project URL* and the *anon public* key; you need both in section 04.

3. Open **SQL Editor**, paste the contents of `server/schema.sql`, and run it. That creates the settings table and the row-level security policies that stop one account reading another's data.

**Tell Supabase where your app lives.** Under **Authentication → URL Configuration**, set Site URL to `http://192.168.1.42:8080` using your own address, and add both of these to Redirect URLs:

```
http://192.168.1.42:8080/**
http://localhost:8080/**
```

The `localhost` entry is for browsing on the machine itself; the numeric one is for your phone and laptop. If your router hands out a new address later, sign-in breaks until you update this field — worth reserving a static lease for this machine.

**Email and password.** Under **Authentication → Providers → Email**, make sure it is enabled. While testing on a home network, turn *Confirm email* off: confirmation links point at your local address and will not open from a phone that has left the house. Turn it back on before you let anyone else sign up.

**Google sign-in.** In the Google Cloud Console:

1. Create a project, then open **APIs & Services → OAuth consent screen**. Choose *External*, fill in the app name and your email, and add your own Google account under *Test users*. Leaving it in testing mode is correct here — it allows up to 100 named accounts with no review.

2. Go to **Credentials → Create credentials → OAuth client ID**, type *Web application*.

3. Under *Authorized redirect URIs* add exactly one entry, your Supabase callback: `https://YOUR-REF.supabase.co/auth/v1/callback`

4. Copy the client ID and client secret into **Supabase → Authentication → Providers → Google**, and enable it.

Why your local address never goes near Google

Google only ever redirects to Supabase, which is why one HTTPS entry is all it needs. Supabase then returns the user to whatever you listed in Redirect URLs, and it accepts plain `http` on a private network. That indirection is what makes a domainless setup work.

## 04 · Configure and start the server

Get a free API key at **finnhub.io** first — the free tier allows 60 calls a minute, and the server caches for 30 seconds, which is comfortably inside it.

```
cd /srv/hif/server
cp .env.example .env
chmod 600 .env        # only your user can read the keys
nano .env             # fill in SUPABASE_URL, SUPABASE_ANON_KEY, FINNHUB_TOKEN

npm install
npm start
```

Open `http://192.168.1.42:8080` from any device on your network. The web build is at the root, the phone build at `/mobile.html`. Stop it with Ctrl-C; section 07 makes it permanent.

## 05 · Close the machine off

Check your subnet with `ip -4 addr` — most home routers use `192.168.0.0/16`, some use `10.0.0.0/8`. Adjust the two rules to match.

```
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.0.0/16 to any port 22   proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 8080 proto tcp
sudo ufw enable
sudo ufw status verbose
```

Nothing is forwarded at the router, so the site is unreachable from outside your house — which is what you asked for, and also why there is no HTTPS here. Traffic stays on your own network in the clear. That is an acceptable trade at home; it stops being acceptable the moment you forward a port, and section 09 covers what changes then.

## 06 · Move accounts and settings onto the server

Everything up to here serves the prototype as it stands: the sign-in screen is a convincing mock, and your watchlist lives in one browser. Making it real is a front-end change, and it is mine to make rather than yours — the server side is already built and waiting.

What the running server already offers:

| Endpoint | What it does |
|---|---|
| GET /api/config | Hands the browser its Supabase URL and public key, so no key is baked into the HTML |
| GET /api/settings | Returns the signed-in user's watchlist, theme, language and toggles |
| PUT /api/settings | Saves them, scoped to that account by row-level security |
| GET /api/finnhub/:kind | Proxies quotes, candles, news, earnings and recommendations, cached 30s, token never leaving the machine |

When you want it wired up, the front-end work is: swap the mocked sign-in for the Supabase client, replace the browser-storage layer with those two settings calls, point the chart and feed at the proxy, and turn the security screen's real features on — Supabase provides genuine authenticator-app two-factor and session revoke, so those stop being mock and start working. Say the word and I will do it. Login alerts need an email service, and are the one item on that screen with no free path.

## 07 · Keep it running after a reboot

Replace `YOUR-USER` with the output of `whoami`, then paste the whole block.

```
sudo tee /etc/systemd/system/hif.service >/dev/null <<'EOF'
[Unit]
Description=Heard It First
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR-USER
WorkingDirectory=/srv/hif/server
EnvironmentFile=/srv/hif/server/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/srv/hif

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now hif
systemctl status hif --no-pager
journalctl -u hif -f          # live log; Ctrl-C to stop watching
```

The four `Protect` and `Private` lines are cheap insurance: the process gets a read-only view of the filesystem and can only write inside `/srv/hif`. After changing code: `sudo systemctl restart hif`.

## 08 · Backups

The free Supabase tier has no point-in-time recovery, so take your own dump. Get the connection string from **Project Settings → Database** and add it to `.env` as `SUPABASE_DB_URL`.

```
mkdir -p /srv/hif/backups

sudo tee /usr/local/bin/hif-backup >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
source /srv/hif/server/.env
pg_dump "$SUPABASE_DB_URL" | gzip > "/srv/hif/backups/hif-$(date +%F).sql.gz"
find /srv/hif/backups -name 'hif-*.sql.gz' -mtime +30 -delete
EOF
sudo chmod +x /usr/local/bin/hif-backup

/usr/local/bin/hif-backup     # test it now
( crontab -l 2>/dev/null; echo "17 3 * * * /usr/local/bin/hif-backup" ) | crontab -
```

Nightly at 03:17, keeping thirty days. A backup on the same machine as nothing else is only half a backup — copy the folder somewhere else periodically.

## 09 · When you want it on the internet

Do not forward port 8080 on your router. Forwarding puts an unencrypted login form on the public internet, and passwords would cross it in plain text. Use a tunnel instead: Cloudflare Tunnel or Tailscale Funnel give you an HTTPS address without opening a single port, and both have a free tier. Then update the Site URL and Redirect URLs in Supabase to the new address, and that same address is what unlocks Apple sign-in.

| Item | Cost | Needed for |
|---|---|---|
| Supabase | Free tier | Accounts, database — enough for personal use |
| Google sign-in | Free | Works today, no domain |
| Finnhub | Free tier | Live prices, 60 calls a minute |
| Domain | ~12 USD / yr | Public access, Apple sign-in |
| Apple Developer | 99 USD / yr | iCloud sign-in, no free alternative |

## Four rules worth keeping

1. The *anon* key belongs in the browser; the *service_role* key never does. It bypasses every security policy in section 03 and would let any visitor read every account.

2. Row-level security stays on, on every table you add. It is the only thing separating one user's watchlist from another's.

3. `.env` is `chmod 600` and in `.gitignore`. A key in a commit is a key you must rotate, even in a private repository.

4. No HTTPS means no public exposure. The two are one decision, not two.
