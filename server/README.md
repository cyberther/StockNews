# hif-server

Serves the Heard It First front-end, proxies Finnhub, stores each user's
settings in Supabase Postgres, and keeps an append-only security log.

    cp .env.example .env && chmod 600 .env   # then fill in the values
    npm install
    npm start

Put the built front-end in `./public` (`index.html` = the web build).
Run `schema.sql` once in the Supabase SQL editor before first use.
Full setup, including Supabase and Google sign-in: see "HIF Server Setup".
The threat model, findings and residual risks: see `../SECURITY.md`.

## What the server enforces

| Area | Behaviour |
| --- | --- |
| Headers | CSP, `nosniff`, `DENY` framing, `strict-origin-when-cross-origin`, COOP/CORP, Permissions-Policy; HSTS when `NODE_ENV=production` |
| Rate limits | Per-IP token bucket per route class (Finnhub 60/min, settings write 30/min) |
| Writes | Bearer token required, `Origin` must match `PUBLIC_ORIGIN`, `application/json` only, 32 kB cap |
| Settings | Key allowlist plus depth, node, string and array bounds; unknown keys are rejected, not dropped |
| Proxy | Upstream query strings rebuilt from validated values — the client's query is never forwarded |
| Errors | Generic codes plus a log reference; upstream and database messages stay in the log |
| Secrets | Refuses to start if a `service_role` key is present in the environment |

## Deployment

TLS terminates in front of the app. Bind the app to loopback and let the proxy
be the only thing on :443 — Caddy needs no more than this:

    hif.example.com {
      encode gzip
      reverse_proxy 127.0.0.1:8080
    }

Then set `BIND=127.0.0.1`, `TRUST_PROXY=1` and `PUBLIC_ORIGIN=https://hif.example.com`.

systemd unit — the sandboxing directives matter as much as the app code:

    [Unit]
    Description=Heard It First
    After=network-online.target

    [Service]
    Type=simple
    User=hif
    Group=hif
    WorkingDirectory=/opt/hif/server
    EnvironmentFile=/opt/hif/server/.env
    ExecStart=/usr/bin/node server.js
    Restart=on-failure

    NoNewPrivileges=yes
    PrivateTmp=yes
    PrivateDevices=yes
    ProtectSystem=strict
    ProtectHome=yes
    ProtectKernelTunables=yes
    ProtectKernelModules=yes
    ProtectControlGroups=yes
    ReadWritePaths=/opt/hif/server/public
    RestrictAddressFamilies=AF_INET AF_INET6
    RestrictNamespaces=yes
    LockPersonality=yes
    MemoryDenyWriteExecute=yes
    SystemCallFilter=@system-service
    CapabilityBoundingSet=
    UMask=0077

    [Install]
    WantedBy=multi-user.target

Operational hygiene:

- `npm ci --omit=dev` in deployment, and `npm audit` on a schedule.
- Keep `.env` at mode 0600, owned by the service user; rotate the Finnhub token
  and any Supabase keys if a host is ever compromised.
- Back up `user_settings` and `security_events`; both are small.
- The rate limiter and the response cache are per process. Running more than one
  instance means moving both to Redis, or the limits multiply.
