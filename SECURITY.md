# Heard It First — security review

Scope: the Node app server (`server/`), the Supabase schema it talks to, and the
web client (`templates/stock-news-web/`). Bar: a small production deployment
with real users. Reviewed and changed in this pass — dated below.

Two things were deliberately left alone at your instruction, and both are listed
under *Accepted risks*: the optional `finnhubToken` prop, and the client keeping
its state in `localStorage`.

---

## 1. What was wrong, and what changed

### Server — `server/server.js`

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| 1 | No security headers at all: framable, sniffable, no CSP, full referrer sent off-site | High | One middleware sets CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy`, COOP/CORP, `Permissions-Policy`; HSTS when `NODE_ENV=production` |
| 2 | The Finnhub proxy forwarded `req.query` wholesale — `new URLSearchParams(req.query)` then `set('token', …)` | High | Query strings are now **rebuilt** from an allowlist per endpoint, with a symbol regex, a resolution set and bounded date/epoch ranges. Unknown params are dropped, and a client-supplied `token` can no longer ride along |
| 3 | No rate limiting anywhere — the proxy was an open, token-funded Finnhub gateway, and `/api/settings` an unbounded write endpoint | High | Per-IP token bucket per route class (Finnhub 60/min burst 20, settings write 30/min burst 10, reads 60–120/min), plus single-flight collapsing of identical upstream calls |
| 4 | `PUT /api/settings` accepted any JSON object of any shape | High | Key allowlist (the client's own persisted keys), plus depth ≤ 6, ≤ 2000 nodes, ≤ 100 keys per object, ≤ 200 array items, ≤ 400-char strings, and rejection of `__proto__`/`constructor`/`prototype`. Unknown keys are rejected, not silently dropped |
| 5 | Database errors returned verbatim (`res.json({ error: error.message })`) — internal detail to the client | Medium | Generic error code plus a log reference; the real message goes to stderr only |
| 6 | No `Origin` or content-type check on writes | Medium | Writes require `application/json` and a matching `Origin` (mandatory in production), so a foreign page cannot drive the API |
| 7 | `X-Forwarded-For` implicitly trusted by anything downstream keying on IP | Medium | `trust proxy` is explicit and defaults to **0**; `TRUST_PROXY` is set only when a proxy really is in front, so the rate-limit key cannot be spoofed |
| 8 | Unbounded in-memory cache, and upstream errors cached | Medium | Bounded to 500 entries with FIFO eviction; only successful JSON responses are cached; upstream must declare JSON |
| 9 | Bearer token shape never validated; every request hit Supabase's auth endpoint | Low | JWT shape and length checked before use; verified tokens memoised 30 s, keyed by SHA-256 of the token (never the token itself) |
| 10 | `app.get('*')` returned `index.html` for any missing asset, masking deploy breakage | Low | SPA fallback is GET/HEAD only and refuses paths whose last segment contains a dot; dotfiles denied; `index.html` is `no-store`, other assets 1 h |
| 11 | No request timeouts — trivially slowloris-able | Low | `headersTimeout` 15 s, `requestTimeout` 20 s, `keepAliveTimeout` 5 s, graceful SIGTERM shutdown |
| 12 | A `service_role` key in the environment would have been used happily | Low (high impact) | The process refuses to start if one is present, and validates `SUPABASE_URL` shape |
| 13 | JSON body parser mounted globally with a 64 kB limit | Low | Scoped to `/api`, 32 kB, `strict: true`, malformed bodies answered 400/413 |

### Database — `server/schema.sql`

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| 14 | `anon` retained default table privileges; policies alone were carrying the load | High | `revoke all … from anon`, explicit `grant` to `authenticated`, and `force row level security` on every table so an owner connection cannot bypass policies |
| 15 | `quote_cache` policy was `auth.role() = 'authenticated'` with no grant discipline | Medium | Read granted to `authenticated` only; no insert/update/delete policy exists, so writes require a privileged server context |
| 16 | `data` could be any JSON of any size — free storage for a signed-in user | Medium | `jsonb_typeof(data) = 'object'` and `pg_column_size(data) < 64 kB` constraints |
| 17 | `updated_at` was client-supplied and could be backdated | Low | `before insert or update` trigger sets it server-side |
| 18 | No audit trail of security-relevant actions | Medium | New `security_events` table: read-own + insert-own policies, **no** update or delete policy, a `kind` check constraint, an index on `(user_id, created_at desc)` and a trigger trimming to the newest 200 rows per user |

### Client — `templates/stock-news-web/StockNewsWeb.dc.html`

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| 19 | Security screen showed devices and 2FA but no record of what had happened on the account | Medium | New **Security activity** section: an append-only log of sign-in, sign-out, sign-out-everywhere, 2FA on/off, device revoked, idle lock and failed unlock, newest first, with failures marked in the accent. Mirrors the server's `/api/events` contract |
| 20 | Full referrer could leak app URLs to news publishers | Low | `<meta name="referrer" content="strict-origin-when-cross-origin">` |

Already correct before this pass, and worth keeping that way: outbound story
links go through `window.open(url, '_blank', 'noopener,noreferrer')` with
`opener` nulled and an `^https?://` test, so `javascript:` URLs cannot be
launched; the UI is React-rendered with no `dangerouslySetInnerHTML` and no
`innerHTML`, so story text from the API is escaped by construction; the idle
lock, the 2FA setup flow and the device list already existed.

---

## 2. Accepted risks (your call, recorded here)

1. **`finnhubToken` prop.** The component can take a Finnhub token as a prop,
   which means it ships to the browser and is readable by anyone with dev tools.
   The server-side proxy exists precisely so this is unnecessary. Recommendation
   if you revisit: drop the prop and always proxy. Anyone using the prop should
   assume that token is public and rate-limit it at Finnhub.
2. **`localStorage` state.** Watchlist, positions, session marker, the 2FA
   secret and recovery codes persist unencrypted under `hif.web.v2`. Any XSS on
   the origin reads all of it, and so does anyone with the unlocked device —
   the idle lock is a UI gate, not encryption. Browser-side encryption would
   not change this much (the key would sit next to the data); moving secrets to
   `/api/settings` and keeping only UI state local is the real fix.

## 3. Residual risks and next steps

1. **CSP still needs `script-src 'unsafe-inline'`**, because the built
   front-end inlines its scripts. This is the biggest remaining item: emit a
   per-response nonce and stamp it on each inline `<script>`, then drop
   `'unsafe-inline'`. Until then CSP mitigates injected *external* script, not
   injected inline script.
2. **Rate limits and the response cache are per process.** Two instances mean
   double the limits; move both to Redis before scaling out.
3. **2FA is a prototype flow.** The code is accepted without server-side TOTP
   verification, and recovery codes are generated client-side. Real enrolment
   belongs in Supabase MFA.
4. **The device list is illustrative** — four static rows. Wire it to
   `auth.sessions` (or your own table) so "revoke" revokes something.
5. **No account lockout or CAPTCHA** on repeated failed unlocks; the log now
   records them, which is the prerequisite for acting on them.
6. **No dependency pinning beyond semver ranges.** Commit a lockfile, deploy
   with `npm ci --omit=dev`, and run `npm audit` on a schedule.
7. **Logs are stdout only.** Ship them somewhere durable if you want the audit
   trail to survive a host.

## 4. Deployment checklist

- [ ] `NODE_ENV=production`, `PUBLIC_ORIGIN` set to the real origin
- [ ] `BIND=127.0.0.1` with TLS terminating in Caddy/nginx, `TRUST_PROXY=1`
- [ ] `.env` mode 0600, owned by the service user, never committed
- [ ] No `service_role` key anywhere near the app process
- [ ] `schema.sql` run, and RLS confirmed enabled on all three tables
- [ ] systemd unit with the sandboxing directives from `server/README.md`
- [ ] Backups of `user_settings` and `security_events`
