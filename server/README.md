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

## Admin panel

A second process, `admin.js`, serves the operator panel: users (plan, suspend,
sign out everywhere, delete), the security log with CSV export, the admin audit
trail, live health counters, and editable site content. It holds the Supabase
`service_role` key, so it is kept apart from the public server on purpose:

- its own env file, `admin.env` (the public server never reads it, and still
  refuses to start if that key reaches its environment)
- listens on `127.0.0.1:8081` only, and rejects any other `Host` header
- its own login: scrypt password + authenticator code, lockout after 5 failures
- every action is written to `admin_audit`, which cannot be edited or deleted

Setup, once:

    psql / Supabase SQL editor: re-run schema.sql (adds the admin tables)
    cp admin.env.example admin.env && chmod 600 admin.env   # fill it in
    # put the same STATS_TOKEN in .env too, then restart the public server
    node admin-cli.js create yourname     # prompts for a password, prints the 2FA secret
    npm run admin

Then from your own machine:

    ssh -L 8081:127.0.0.1:8081 you@server
    open http://127.0.0.1:8081

There is no way to create an admin from the web. Manage admins with
`admin-cli.js` (`list`, `reset-2fa`, `set-password`, `disable`, `enable`, `unlock`).

systemd unit for the admin process — same sandboxing as the app, plus loopback-only networking:

    [Unit]
    Description=Market Pulse admin
    After=network-online.target

    [Service]
    Type=simple
    User=hif
    Group=hif
    WorkingDirectory=/opt/hif/server
    EnvironmentFile=/opt/hif/server/admin.env
    ExecStart=/usr/bin/node admin.js
    Restart=on-failure
    NoNewPrivileges=yes
    PrivateTmp=yes
    PrivateDevices=yes
    ProtectSystem=strict
    ProtectHome=yes
    ProtectKernelTunables=yes
    ProtectKernelModules=yes
    ProtectControlGroups=yes
    RestrictAddressFamilies=AF_INET AF_INET6
    RestrictNamespaces=yes
    LockPersonality=yes
    MemoryDenyWriteExecute=yes
    SystemCallFilter=@system-service
    CapabilityBoundingSet=
    UMask=0077

    [Install]
    WantedBy=multi-user.target

Keep `admin.env` readable only by the service user. If the box is shared,
run the admin unit as a separate user that alone can read `admin.env`.
