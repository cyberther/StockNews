---
title: AI News
type: project
status: active
tags: [project, stocknews, prototype, design-system/modernist, beginner-guide]
created: 2026-09-07
updated: 2026-09-08
repo: cyberther/StockNews
---

# AI News

Complete documentation for the **StockNews / Heard It First** prototype — a stock-news terminal.

> [!info] Who this note is for
> Someone who has never seen this project before. It assumes **no knowledge of the codebase** and only basic familiarity with what a web page is. Every file, every screen, and every mechanism is explained, plus how to run it and how to change things.
>
> Read [[#0 Start here]] first if you just want to open the thing and click around.

---

## 0. Start here — the five-minute version

**What is it?** A news-first stock terminal. You follow tickers; it watches for news about them and pushes you the moment a story lands.

**How do I look at it right now?** Open one of these two files in any web browser by double-clicking it:
- `export/HIF-Web-Dark.html` — the desktop version
- `export/HIF-Mobile-Dark.html` — the phone version

These are **self-contained**: everything they need is inside the one file. No server, no install, no internet required. Copy either to a USB stick, open it on another machine, and it works. Your settings (followed tickers, plan, language) save into that browser automatically.

**What will I see?** A sign-in screen. Type any email and any password, click Continue. Pick three tickers. You're in the Feed.

**Where's the real code?** In `templates/`. The two `.dc.html` files there are the actual designs; the `export/` files are flattened copies made for sharing.

**Do I need the server?** Only for real market prices. Without it, the app runs on built-in sample data and says **DEMO DATA** in the top-right corner. That is the normal state and nothing is broken.

---

## 1. Concepts and vocabulary

Terms used throughout this note. If you already know these, skip to [[#2 Where everything lives]].

**Ticker** — a stock's short symbol. `NVDA` is NVIDIA, `AAPL` is Apple. The app is organised around tickers.

**Quote** — the current price and how much it moved today.

**Watchlist / follows** — the tickers you've chosen to track. Stored as a simple list of symbols.

**Free vs Pro** — the two plan tiers. Free: 3 tickers max, news delayed 24h, no analyst breakdown, no chart history past 6 months. Pro: unlimited tickers, 30-minute scans, everything unlocked. There's a toggle in the header to preview either.

**PRO-gated** — a feature visible but locked on Free. Clicking it flashes a message and takes you to the paywall screen rather than doing nothing.

**Design Component (DC)** — the file format the app is built in. A `.dc.html` file that opens directly in a browser but can also be embedded in other designs. It has three parts: a **template** (the markup you see), a **logic class** (the JavaScript behind it), and **props** (settings exposed in a Tweaks panel).

**`renderVals()`** — the single most important function in the codebase. It runs on every render, computes every value the screen needs, and hands them to the template by name. If you want to know where a number on screen comes from, it comes from here.

**Token** — two unrelated meanings, unfortunately:
1. A **design token** is a named colour or size, like `--s-bg` for the page background. Change the token, every screen changes.
2. An **API token** is a password-like string that lets the app fetch real market data from Finnhub.

**localStorage** — a small storage area every browser gives a web page, per site, that survives closing the tab. This is where your settings live. It is not a server; another browser or another machine starts fresh.

**RSI, SMA** — chart indicators. **SMA-20** is the average closing price of the last 20 periods, drawn as a smoothing line. **RSI-14** is a 0-100 momentum reading: above 70 conventionally reads "overbought", below 30 "oversold". Both are computed in the logic class from the price series.

**Finnhub** — the third-party market-data service this app fetches real prices from.

**Supabase** — a hosted Postgres database, used here to store per-user settings and cache quotes.

**RLS (Row Level Security)** — a Postgres feature where the database itself enforces who can read which rows. It is what stops one signed-in user reading another user's watchlist.

---

## 2. Where everything lives

```
templates/                              ← THE ACTUAL APP
  stock-news-web/
    StockNewsWeb.dc.html                desktop terminal — the main file
    ds-base.js                          loads the design system
  stock-news-dark/
    StockNewsDark.dc.html               mobile terminal
  shared/                               ← code both builds use
    hif-data.js                         all content + all copy, in 3 languages
    hif-live.js                         talks to Finnhub
    hif-store.js                        saves settings; password checking

server/                                 ← OPTIONAL, for real prices
  server.js                             the proxy that holds your API key
  schema.sql                            database tables — run once in Supabase
  .env.example                          template for your secrets
  README.md                             setup steps
  package.json                          dependencies

export/                                 ← SHAREABLE COPIES
  HIF-Web-Dark.html                     self-contained desktop build
  HIF-Mobile-Dark.html                  self-contained mobile build
  AI News.md                            this note

HIF Server Setup.dc.html                illustrated setup walkthrough
github.md                               which repo this project belongs to
_ds/modernist-.../                      the Modernist design system
```

### Which file do I edit for what?

| I want to change… | Edit this |
|---|---|
| Any text, label, or button wording | `templates/shared/hif-data.js` → the `UI` object |
| Sample prices, headlines, analyst numbers | `templates/shared/hif-data.js` → `FOLLOWS` and `NEWS` |
| Which tickers are searchable | `templates/shared/hif-data.js` → `UNIVERSE` |
| Desktop layout or screens | `templates/stock-news-web/StockNewsWeb.dc.html` |
| Mobile layout or screens | `templates/stock-news-dark/StockNewsDark.dc.html` |
| Colours, dark/light schemes | the `<helmet><style>` block at the top of each template |
| How settings are saved | `templates/shared/hif-store.js` |
| How real data is fetched | `templates/shared/hif-live.js` |
| Database structure | `server/schema.sql` |

> [!tip] The most common edit
> Almost every copy or content change is in **one file**: `hif-data.js`. Both desktop and mobile read from it, so a change there updates both at once. That's deliberate — it's why the two builds never drift apart.

---

## 3. How a Design Component works

You don't need this section to use the app, but you need it to edit one.

Each `.dc.html` file has three parts.

### The template
The markup. Looks like HTML with `{{ curly braces }}` in it:

```html
<div style="font-size:17px">{{ stock.ticker }}</div>
```

`{{ stock.ticker }}` is a **hole**. At render time it's filled with the value named `stock.ticker`. Holes are **lookups only** — you cannot write `{{ price * 2 }}` or `{{ a + b }}`. Any calculation happens in the logic class and gets exposed under a name.

Two special tags handle repetition and conditionals:

```html
<sc-for list="{{ follows }}" as="row">      ← repeat once per item
  <div>{{ row.ticker }}</div>
</sc-for>

<sc-if value="{{ hasData }}">…</sc-if>      ← show only if true
```

**All styling is inline** (`style="…"` on the element). There are no CSS classes and no stylesheet of our own. This looks repetitive but it's intentional: inline styles paint immediately as the page streams in, whereas class-based CSS makes everything wait.

### The logic class
Plain JavaScript. Holds state, handles clicks, does all the maths:

```js
class Component extends DCLogic {
  state = { screen: 'feed', follows: ['NVDA','AAPL','TSLA'] };
  renderVals() {
    return { screen: this.state.screen, /* …everything the template needs… */ };
  }
}
```

`state` is the app's memory — current screen, followed tickers, plan, language, and so on. Changing it with `setState()` re-renders the screen.

`renderVals()` is the bridge: it returns a flat object, and every key becomes available as a `{{ hole }}` in the template. **This function is where you look first when debugging anything.** In the web build it's roughly 300 lines and computes every value on every screen.

### Props
Settings exposed to a **Tweaks** panel so they can be changed without touching code. This project has one that matters: **`finnhubToken`**. Paste an API key there and the app switches from demo data to live prices.

---

## 4. The screens, in order

### 4.1 Auth (sign-in)

Three ways in:
- **Continue with Google**
- **Continue with Apple / iCloud**
- **Email + password**

The email route shows a **strength meter** as you type and warns if the password appears in a known-breach list.

> [!warning] This is a prototype, not real security
> - The strength meter is a **heuristic** — it scores length, mixed case, digits, symbols. It is not zxcvbn.
> - The breach list is a **hard-coded array of common passwords** in `hif-store.js`. Real breach checking uses k-anonymity against an API (you send the first 5 characters of a hash, never the password). That is deliberately *not* implemented here.
> - The **lock screen accepts any non-empty password**. It demonstrates the flow, it does not authenticate.
>
> None of this is a bug. It's a design prototype; wiring real auth is a build-phase job.

### 4.2 Onboarding

"Follow three to start" — a picker of 10 tickers with story counts. The 3-ticker Free cap is enforced as you tap. Finishing sets `onboarded: true` so you never see it again (unless you clear storage).

### 4.3 Feed

The default screen. Rows of news stories, each showing:
- **Ticker** and score (`#28` = story count in 24h)
- **Headline** and a one-line "why it matters"
- **Source** and timestamp
- **Vol vs avg** — trading volume against its own average, e.g. `3.1×`. This is the app's core signal: unusual volume means something is happening.

Two tabs: **Following** (only your tickers) and **Market** (everything). Rows sort by volume. Each row is a full-width click target and works with the keyboard.

### 4.4 Detail — the quote screen

The densest screen in the app. Top to bottom:

**Header** — ticker, company name, price, today's move, a refresh button, and the primary action button (which reads "Add to list", "Enable push", or "Push on" depending on state and plan).

**Chart** — the centrepiece:
- **Seven ranges**: 1D, 1W, 1M, 6M, YTD, 1Y, 5Y. The last three are **PRO-gated** — clicking one on Free flashes `CHART HISTORY · PRO` and routes to the paywall.
- **Two overlays**, toggleable: SMA-20/50 smoothing lines, and earnings markers on the dates results were reported.
- **Hover crosshair** with a tooltip showing the value at that point.
- **RSI-14 band** underneath, with dashed guides at 70 and 30.
- A one-word signal — `BULLISH` / `BEARISH` / `MIXED` / `BUILDING` — derived from where price sits relative to the two moving averages.

**Analyst sentiment** — the buy/hold/sell split as a stacked bar with counts. PRO-gated; Free sees a locked panel.

**Earnings** — days until the next report, the date, and last quarter's surprise.

**The Call** — the editorial take, one or two sentences. This is the product's voice.

**Story tape** — the news for this ticker specifically.

### 4.5 Watchlist

A table: ticker, company, last price, change, a **1D sparkline**, and a per-ticker push toggle. On Free the toggle reads `PRO · PUSH` and routes to the paywall.

At 3/3 a bordered accent banner appears: a large **3 / 3**, an explanation, and a **Lift the cap** button.

### 4.6 Screener

Search plus four filters:
- **All**
- **Vol ≥ 2×** — only unusual-volume names
- **Earnings ≤ 14d** — reporting soon
- **Most stories** — sorted by news volume

Each result row has an **ADD** button (or reads **ADDED**). Typing a query **deliberately overrides the active filter** — otherwise a saved "Earnings ≤ 14d" filter would silently hide a ticker you searched for by name.

### 4.7 Paywall

Free vs Pro side by side: feed latency, tickers followed, push notifications, analyst breakdown, chart history, pre-open digest.

### 4.8 Account

Plan and ticker count, scan interval, quiet hours (22:00–07:00), manage subscription, sign out. Plus:

**Appearance** — System / Light / Dark, applied live.

**Two independent languages**:
- **App language** — buttons, labels, menus
- **Content language** — the stories and the editorial calls

Both offer EN / RO / DE. They're separate on purpose: plenty of people want a German interface over English-language market news, or vice versa.

### 4.9 Security

- **Two-factor authentication** — setup flow with a secret and downloadable recovery codes
- **Login alerts** — email on new sign-in
- **Inactivity lock** — 90 seconds, 15 minutes, 30 minutes, 1 hour, or Never
- **Active sessions** — a list with individual revoke
- **Connected accounts** — link/unlink Google, iCloud, Email; the one you signed in with is marked PRIMARY and can't be unlinked

---

## 5. The data model

Everything content-related lives in `templates/shared/hif-data.js`, which puts four things on `window.HIF`.

### `NEWS` — story records
```js
{ ticker:'NVDA', source:'Reuters', stamp:'2h', ts:…,
  headline:'…', summary:'…', vol:'3.1x' }
```

### `FOLLOWS` — full per-ticker data
```js
NVDA: { ticker:'NVDA', name:'NVIDIA Corp',
        price:'184.20', move:'+2.4%', up:true,
        score:'88', buyPct:'82', analystDetail:'41/6/2',
        earnDays:'12d', earnDate:'Nov 19', perf6m:'+34.1%',
        latest:{ EN:'…', RO:'…', DE:'…' },
        call:{   EN:'…', RO:'…', DE:'…' } }
```
Note `latest` and `call` are objects keyed by language — that's how the content-language switch works.

### `UNIVERSE` — the searchable market
```js
{ ticker:'SAP', name:'SAP SE', stories:'5' }
```

### `UI` — every string in the app
```js
UI.EN = { feed:'Feed', watchlist:'Watchlist', … }
UI.RO = { feed:'Flux',  watchlist:'Listă',    … }
UI.DE = { feed:'Feed',  watchlist:'Watchlist', … }
```
In the templates these appear as `{{ ui.feed }}`. Add a key to all three languages and it's available everywhere.

### The UNIVERSE / FOLLOWS invariant — read this one

> [!important] Why some tickers show "No data"
> `UNIVERSE` has **34 tickers**. `FOLLOWS` has **7** with complete demo data. This gap is intentional: `UNIVERSE` represents the searchable market, and you should be able to find SAP even though we have no sample data for it.
>
> The 7 with full data: `NVDA AAPL TSLA MSFT AMZN ASML NOVO`
>
> The other 27 (GOOGL, META, AMD, INTC, AVGO, TSM, MU, CRM, ORCL, NFLX, DIS, JPM, GS, V, XOM, LLY, PFE, UNH, BA, CAT, KO, SAP, SIE, RHM, BMW, SHEL, BABA) are **search-only** until a live token is connected.
>
> **How the app handles them.** One function in `renderVals()`:
> ```js
> const dataless = t => !FOLLOWS[t] && !Q[t];
> ```
> "No demo record *and* no live quote." Every part of the UI reads that one predicate:
>
> | Where | Behaviour when dataless |
> |---|---|
> | Detail chart | No chart, no RSI, no signal — a "Live data required" panel instead |
> | Watchlist sparkline | Suppressed; a muted "NO DATA" in its place |
> | Screener + watchlist rows | A small outlined `LIVE` tag next to the ticker |
> | Detail price header | The 32px price/move block is replaced by a muted "NO DATA" |
> | Earnings panel | Same — the display-size figure is suppressed |
>
> **Why so careful?** Two reasons. First, integrity: a synthetic chart with "BEARISH RSI 19.0" over a ticker we have no data for is a confident lie. Second, visual: a placeholder em-dash at 32px in near-white paints as a **solid white bar**, which reads as a broken layout, not as "no data".
>
> The rule, if you change nothing else: **never render a confident read over data that does not exist.**

---

## 6. How settings are saved

`templates/shared/hif-store.js` wraps the browser's localStorage. The web build stores everything under one key, `hif.web.v2`.

What survives a reload is an explicit allowlist called `PERSIST`:

```
session, onboarded, plan, lang, appLang, follows, push,
screenFilter, chartRange, overlays, screen, feedTab, selected,
twofa, twofaSecret, recovery, loginAlerts, timeoutMin,
revoked, links, locked, theme
```

Everything else is deliberately excluded — **live quotes** (they'd go stale) and **transient input** (passwords, 2FA codes, search text) never touch storage.

> [!note] Two decisions worth understanding
> **`locked` persists.** If the inactivity lock engages and you reload the page, you land back on the lock screen. If it didn't persist, reloading would be a way around the lock.
>
> **The idle timer reads state inside a `setState` updater**, not from a captured variable. Reading `this.state` from a closure gives you a snapshot from when the timer was created, which goes stale on reload or during concurrent updates. Reading inside the updater always sees current state.

**To reset everything:** clear the site's localStorage in your browser's dev tools, or open the file in a private window. There's no server-side state to clear.

---

## 7. Real market data

### The three modes

The top-right status chip always tells you which one you're in:

| Chip reads | Meaning |
|---|---|
| `□ DEMO DATA` | No token. Everything from `hif-data.js`. **This is the default.** |
| `■ LIVE · FINNHUB` | Going through the `server/` proxy |
| `■ LIVE · FINNHUB (DIRECT)` | Browser calling Finnhub itself |
| `□ FINNHUB · <ERROR>` | A failure, shown rather than hidden |

The square is filled when live, outlined when not.

### Getting a Finnhub key

1. Go to **finnhub.io** and register — free tier is enough
2. The dashboard shows your **API key** immediately after signup
3. Finnhub calls it an "API key"; our `.env.example` calls it a token — **same string**

### Two ways to use it

**Quick, for testing:** paste the key into the `finnhubToken` prop in the Tweaks panel. The browser calls Finnhub directly. Fine for you on your own machine — but the key is visible to anyone who views the page.

**Proper, for anything shared:** run the server.
```
FINNHUB_TOKEN=your_key_here      ← in server/.env
```
The key stays on the server; the browser only ever talks to your proxy.

> [!danger] Two rules about keys
> 1. **Never put the Finnhub key in the templates** if anyone else will see the page. Anyone can read a web page's source.
> 2. **Never use the Supabase `service_role` key in the browser.** It bypasses every RLS policy in the database — it is a master key. Browser code uses the `anon` key only.

### The server

`server/server.js` — an Express app that holds the key, forwards requests to Finnhub, and optionally caches quotes in Supabase so a page reload doesn't spend an API call.

`server/schema.sql` — run **once**, in the Supabase SQL editor (paste, click Run). It creates:

**`user_settings`** — one row per user, with a JSONB `data` column holding that user's settings. Three RLS policies, all scoped to `auth.uid()` (the caller's own user id): read own, insert own, update own. This is what makes it impossible to read someone else's watchlist.

**`quote_cache`** — symbol, payload, fetched_at. Written by the server only; readable by any authenticated user. Optional.

> [!question] "Where is schema.sql — on my PC or on Supabase?"
> Neither, until you act. It's a file in this project. It reaches your PC when you download or clone the project. It exists **on Supabase** only after you paste its contents into the SQL editor and run it — that's what creates the tables.

---

## 8. Colours and theming

Six CSS variables drive both light and dark. Change a token, everything changes.

| Token | Role | Dark | Light |
|---|---|---|---|
| `--s-bg` | page ground | `#121212` | light |
| `--s-panel` | raised surface, row hover | slightly lifted | slightly darker |
| `--s-ink` | primary text | `#F5F5F7` | near-black |
| `--s-mute` | secondary text, dividers, footnotes | `#A0A0A0` | mid-grey |
| `--s-faint` | faintest fill | — | — |
| `--color-accent` | the single accent | `#D4AF37` gold | `#8A6A12` |

The accent deepens in light mode because bright gold on a light ground doesn't reach the contrast floor. Dark mode keeps the brighter gold.

**Appearance switching** lives in Account: System / Light / Dark. "System" follows your OS setting. The change is instant — it just swaps token values.

**Contrast** — all defects are fixed. Dividers and footnotes were moved from a faint step up to `--s-mute`, measured at **7.4–8.3:1** (the floor for body text is 4.5:1).

### The Modernist rules this app follows

- **Zero corner radius.** Anywhere. Not a soft edge in the app.
- **Flush left**, including labels inside wide buttons — a button wider than its text starts the text at the left padding edge, never centred.
- **Rules, not whitespace.** Sections are separated by visible 1px/2px lines.
- **Accent sparingly** — the primary action and small emphasis. The app is mostly ink on ground.
- Type is **Archivo** throughout.

---

## 9. Responsive behaviour

The desktop build is a three-column shell: left rail nav (212px) + centre content + right watchlist rail (312px).

Originally the shell had `min-width: 1240px` together with `overflow-x: hidden` — a bad pair. Below 1240px the right side was cut off *and* unscrollable, so the plan toggle and Go Pro button became unreachable. Now:

- Shell is `min-width: 0` — it can actually shrink
- A resize listener tracks window width into state as `vw`
- **Right rail hides below 1100px** — on the watchlist screen it duplicates the centre pane anyway
- **Watchlist row tracks** use `minmax()` instead of fixed pixels, so cells compress rather than get sliced
- **Ticker tape** renders only as many cells as fit — 5 at ≥1400px, 3 at ≥1180, 2 at ≥1000, none below — so it always ends at a cell boundary
- Tape dividers are per-cell `border-right`. They used to be the container's background showing through 1px gaps, which left a **bare grey block** when a cell got clipped mid-way

> [!tip] A pattern worth stealing
> The `3 / 3` cap counter used to wrap to two lines. Cause: it was a flex item with default `flex: 1 1 auto`, so it shrank to one glyph's width and wrapped. Fix: `flex: none; white-space: nowrap`. **Any display-size figure inside a flex row needs `flex: none`**, or it will collapse.

---

## 10. Known limitations

Honest list. None of these are accidents.

1. Password strength is heuristic; the breach list is a demo array, not an API
2. The lock screen accepts any non-empty password
3. 2FA codes aren't validated against a real TOTP secret
4. 27 of 34 universe tickers have no demo data — by design, they need a live token
5. The mobile template shares `hif-data.js` so it has the wider universe, but **not** the screener chip-override or the search empty state
6. The chart SVG uses `preserveAspectRatio="none"` so it stretches — acceptable because axis labels are HTML siblings, not SVG `<text>`, so nothing becomes illegible
7. No real push notifications — the toggles record intent
8. Quote caching in Supabase is written but optional and not required by the client

---

## 11. Running and sharing it

### Just look at it
Open `export/HIF-Web-Dark.html` or `export/HIF-Mobile-Dark.html`. Nothing to install.

### Edit it
Open `templates/stock-news-web/StockNewsWeb.dc.html`. It needs its sibling files (`ds-base.js`, `../shared/*.js`, and `_ds/`) to be present — so edit inside the project folder, don't move the single file out.

### Run with live data
```
cd server
cp .env.example .env        # then put your Finnhub key in it
npm install
npm start
```
Then run `schema.sql` in the Supabase SQL editor if you want persistence and caching.

`HIF Server Setup.dc.html` walks through this with illustrations.

### Version control
`github.md` at the project root records the association: repo `cyberther/StockNews`, branch `main`, path `templates/`, plus a last-sync receipt. To push:
```
git add templates server github.md
git commit -m "…"
git push origin main
```

---

## 12. Build history

The order things were built, which is also roughly the order to read the code in.

1. **Ten quote-detail improvements** — chart with ranges and overlays, earnings panel, analyst sentiment, feed sorting, watchlist sparklines, push toggles, error states, PRO gating
2. **Persistence** — the `PERSIST` allowlist: watchlist, plan, languages, push toggles, screener filter, chart range and overlays, last screen, session
3. **Authentication** — Google, iCloud, email + password with strength meter and breach warning
4. **Security suite** — 2FA with recovery codes, login alerts, configurable inactivity lock, active sessions with revoke, connected accounts
5. **Appearance tokens** — System/Light/Dark switching live; the separate light template was dropped in favour of runtime tokens
6. **Contrast pass** — dividers and footnotes moved to `--s-mute`
7. **Server + Supabase** — Finnhub proxy, `user_settings` and `quote_cache` with RLS
8. **Audit pass** — header clipping (the `min-width` bug), row hover states, responsive shell, cap-counter wrap
9. **Search fix** — universe widened from 7 to 34, query overrides filter chips, empty state added
10. **Dataless integrity** — one `dataless()` predicate gating chart, RSI, sparkline and display figures, with `LIVE` tags and "No data" markers

---

## Related

- [[Modernist design system]]
- [[Finnhub API]]
- [[Supabase RLS]]
