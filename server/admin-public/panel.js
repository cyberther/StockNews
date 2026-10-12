// Market Pulse admin panel. Vanilla JS, no build step, no inline code (the CSP
// forbids it). Every value from the server is written with textContent.
(() => {
'use strict';

const root = document.getElementById('app');
const state = { me: null, route: 'users', idleTimer: null };

// ---- DOM helper ----------------------------------------------------------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6',
  log: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  audit: 'M12 3l7 3v5c0 4.5-3 8.2-7 9.5C8 19.2 5 15.5 5 11V6zM9 12l2 2 4-4',
  health: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  content: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  out: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4'
};
function icon(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
  return s;
}

// ---- formatting ----------------------------------------------------------
const fmtTime = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts = { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(undefined, opts);
};
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' d ago';
  return fmtTime(iso);
}
const dur = s => s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? (s / 3600).toFixed(1) + ' h' : (s / 86400).toFixed(1) + ' d';
const num = n => (n == null ? '—' : Number(n).toLocaleString());

// ---- API -----------------------------------------------------------------
const ERRORS = {
  invalid_login: 'That username, password and code combination did not work. After 5 failures the account locks for 15 minutes.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  bad_origin: 'This request came from an unexpected origin. Open the panel at http://127.0.0.1:8081.',
  confirm_mismatch: 'The confirmation did not match the account email.',
  invalid_content: 'That content was rejected.',
  signed_out: 'Your session ended. Sign in again.'
};
class ApiError extends Error { constructor(code, msg, status) { super(msg); this.code = code; this.status = status; } }

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/admin/api' + path, opts); }
  catch { throw new ApiError('network', 'The admin server did not answer. Is the SSH tunnel still open?', 0); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== '/login' && path !== '/me') { state.me = null; renderLogin(ERRORS.signed_out); }
    const code = data.error || 'http_' + r.status;
    const msg = data.message ? (ERRORS[code] || '') + ' ' + data.message : (ERRORS[code] || `Request failed (${code}${data.ref ? ', ref ' + data.ref : ''}).`);
    throw new ApiError(code, msg.trim(), r.status);
  }
  return data;
}

let toastTimer;
function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: bad ? 'alert' : 'status', text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

// ---- login ---------------------------------------------------------------
function renderLogin(message) {
  clearTimeout(state.idleTimer);
  const err = h('div', { class: 'form-error', role: 'alert', text: message || '' });
  const user = h('input', { class: 'input', id: 'u', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { class: 'input', id: 'p', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'input code-input', id: 'c', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: true, placeholder: '000000' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in', icon('arrow'));
  const form = h('form', { novalidate: true, onsubmit: async e => {
    e.preventDefault();
    err.textContent = '';
    if (!user.value.trim() || !pass.value || !/^\d{6}$/.test(code.value)) { err.textContent = 'Enter your username, password and the 6-digit code from your authenticator.'; return; }
    submit.disabled = true; submit.firstChild.textContent = 'Checking…';
    try {
      await api('POST', '/login', { username: user.value.trim(), password: pass.value, code: code.value });
      pass.value = ''; code.value = '';
      await boot();
    } catch (x) {
      err.textContent = x.message; code.value = ''; code.focus();
      submit.disabled = false; submit.firstChild.textContent = 'Sign in';
    }
  } },
    h('label', { class: 'field', for: 'u' }, h('span', { class: 'label', text: 'Username' }), user),
    h('label', { class: 'field', for: 'p' }, h('span', { class: 'label', text: 'Password' }), pass),
    h('label', { class: 'field', for: 'c' }, h('span', { class: 'label', text: 'Authenticator code' }), code),
    err, submit);
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'login-box' },
    h('div', { class: 'brand' }, h('b', { text: 'Market Pulse' }), h('span', { text: 'Admin' })),
    h('h1', { class: 'h1', text: 'Sign in to operate' }),
    h('p', { class: 'mute small', text: 'Accounts, the security log, system health and site content. Every action is recorded.' }),
    form,
    h('p', { class: 'login-foot', text: 'No account? Admins are created on the server: node admin-cli.js create <username>' }))));
  document.title = 'Sign in · Market Pulse Admin';
  (message ? code : user).focus();
}

// ---- shell ---------------------------------------------------------------
const ROUTES = [
  { id: 'users', label: 'Users', icon: 'users', render: renderUsers },
  { id: 'events', label: 'Security log', icon: 'log', render: renderEvents },
  { id: 'audit', label: 'Admin audit', icon: 'audit', render: renderAudit },
  { id: 'health', label: 'Health', icon: 'health', render: renderHealth },
  { id: 'content', label: 'Content', icon: 'content', render: renderContent }
];

function resetIdle() {
  clearTimeout(state.idleTimer);
  if (!state.me) return;
  // Mirror the server's idle limit so the screen does not sit open after it lapses.
  state.idleTimer = setTimeout(() => { state.me = null; renderLogin('Signed out after ' + state.me_idle + ' minutes without activity.'); }, state.me.idleMinutes * 60_000);
}

function renderShell() {
  const id = (location.hash.replace('#', '') || 'users').split('/')[0];
  state.route = ROUTES.some(r => r.id === id) ? id : 'users';
  const route = ROUTES.find(r => r.id === state.route);
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('header', { class: 'bar' },
      h('div', { class: 'brand' }, h('b', { text: 'Market Pulse' }), h('span', { text: 'Admin' })),
      h('div', { class: 'who' },
        h('span', { class: 'label idle', text: 'Idle sign-out ' + state.me.idleMinutes + ' min' }),
        h('span', { class: 'name', text: state.me.username }),
        h('button', { class: 'btn', type: 'button', onclick: logout }, icon('out'), 'Sign out'))),
    h('nav', { class: 'rail', 'aria-label': 'Sections' },
      ROUTES.map(r => h('a', { class: 'nav', href: '#' + r.id, 'aria-current': r.id === state.route ? 'page' : null }, icon(r.icon), r.label)),
      h('div', { class: 'rail-foot' }, 'Loopback only. Reach it through', h('br'), h('span', { class: 'mono', text: 'ssh -L 8081:127.0.0.1:8081' }))),
    main));
  document.title = route.label + ' · Market Pulse Admin';
  route.render(main);
}

async function logout() {
  try { await api('POST', '/logout', {}); } catch {}
  state.me = null;
  renderLogin('Signed out.');
}

window.addEventListener('hashchange', () => { if (state.me) renderShell(); });
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => { if (state.me) resetIdle(); }, { passive: true }));

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' },
    h('h1', { class: 'h1', text: title }),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
    sub ? h('p', { class: 'sub', text: sub }) : null);
}

function emptyRow(cols, title, body) {
  return h('tr', {}, h('td', { colspan: String(cols) }, h('div', { class: 'empty' }, h('b', { text: title }), body)));
}

// ---- users ---------------------------------------------------------------
async function renderUsers(main) {
  const q = { q: '', filter: 'all', page: 1, selected: null };
  const strip = h('div', { class: 'strip', 'aria-label': 'Account totals' });
  const tbody = h('tbody');
  const pager = h('div', { class: 'pager' });
  const detail = h('div');
  const split = h('div', { class: 'split' },
    h('div', {},
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Account', 'Plan', 'Status', 'Last active', 'Joined'].map(t => h('th', { text: t })))),
        tbody)),
      pager),
    detail);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by email or user id', 'aria-label': 'Search accounts', oninput: debounce(() => { q.q = search.value; q.page = 1; load(); }, 250) });
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter' },
    [['all', 'All'], ['pro', 'Pro'], ['free', 'Free'], ['suspended', 'Suspended']].map(([v, l]) =>
      h('button', { class: 'tab', type: 'button', 'aria-pressed': String(v === q.filter), onclick: e => {
        q.filter = v; q.page = 1;
        tabs.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-pressed', String(t === e.currentTarget)));
        load();
      } }, l)));

  main.replaceChildren(h('div', { class: 'page' },
    pageHead('Users', 'Supabase accounts, with the plan and suspension this server enforces.',
      h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, icon('refresh'), 'Refresh')),
    strip,
    h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, search), tabs),
    split));

  async function load(fresh) {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'loading', text: 'Loading accounts…' })));
    try {
      const params = new URLSearchParams({ q: q.q, filter: q.filter, page: q.page });
      if (fresh) params.set('fresh', '1');
      const d = await api('GET', '/users?' + params);
      strip.replaceChildren(...[['Accounts', d.summary.total], ['Pro', d.summary.pro], ['Active last 7 days', d.summary.active7d], ['Suspended', d.summary.suspended]]
        .map(([l, v]) => h('div', {}, h('div', { class: 'label', text: l }), h('div', { class: 'v', text: num(v) }))));
      tbody.replaceChildren(...(d.rows.length ? d.rows.map(u => {
        const tr = h('tr', { class: 'clickable', tabindex: '0', 'aria-selected': String(q.selected === u.id),
          onclick: () => open(u.id), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(u.id); } } },
          h('td', {}, h('div', { class: 'cell-strong', text: u.email }), h('div', { class: 'cell-sub', text: u.providers.join(' · ') || 'email' })),
          h('td', {}, h('span', { class: 'tag' + (u.plan === 'pro' ? ' pro' : ''), text: u.plan })),
          h('td', {}, u.suspended ? h('span', { class: 'tag bad', text: 'Suspended' }) : u.confirmed ? h('span', { class: 'tag ok', text: 'Active' }) : h('span', { class: 'tag', text: 'Unconfirmed' })),
          h('td', { text: ago(u.lastActive || u.lastSignIn) }),
          h('td', { class: 'mute when', text: fmtTime(u.createdAt) }));
        tr.dataset.id = u.id;
        return tr;
      }) : [emptyRow(5, q.q || q.filter !== 'all' ? 'No accounts match' : 'No accounts yet',
        q.q || q.filter !== 'all' ? 'Clear the search or pick another filter.' : 'Accounts appear here once people sign up through Supabase. The web app\'s sign-in is still a local demo until it is wired to Supabase.')]));
      pager.replaceChildren(
        h('span', { text: `${num(d.total)} shown · page ${d.page} of ${d.pages}` }),
        h('button', { class: 'btn', type: 'button', disabled: d.page <= 1, onclick: () => { q.page--; load(); } }, 'Previous'),
        h('button', { class: 'btn', type: 'button', disabled: d.page >= d.pages, onclick: () => { q.page++; load(); } }, 'Next'));
    } catch (x) {
      tbody.replaceChildren(emptyRow(5, 'Could not load accounts', x.message));
    }
  }

  function close() {
    const was = q.selected;
    q.selected = null; split.classList.remove('open'); detail.replaceChildren();
    tbody.querySelectorAll('tr').forEach(r => r.setAttribute('aria-selected', 'false'));
    const row = was && tbody.querySelector(`tr[data-id="${was}"]`);
    if (row) row.focus();
  }
  const onEsc = e => {
    if (!document.body.contains(split)) return window.removeEventListener('keydown', onEsc);
    if (e.key === 'Escape' && q.selected) close();
  };
  window.addEventListener('keydown', onEsc);

  async function open(id) {
    q.selected = id;
    tbody.querySelectorAll('tr').forEach(r => r.setAttribute('aria-selected', String(r.dataset.id === id)));
    split.classList.add('open');
    detail.replaceChildren(h('aside', { class: 'detail', 'aria-label': 'Account detail' }, h('div', { class: 'loading', style: { padding: '24px 18px' }, text: 'Loading…' })));
    let d;
    try { d = await api('GET', '/users/' + id); }
    catch (x) { detail.replaceChildren(h('aside', { class: 'detail' }, h('div', { class: 'empty' }, h('b', { text: 'Could not load account' }), x.message))); return; }
    const u = d.user;
    const act = async (label, fn) => {
      try { await fn(); toast(label); await load(); if (q.selected) open(u.id); }
      catch (x) { toast(x.message, true); }
    };

    const reason = h('input', { class: 'input', maxlength: '200', placeholder: 'Reason (kept in the audit log)', 'aria-label': 'Suspension reason' });
    const confirmInput = h('input', { class: 'input', placeholder: u.email, 'aria-label': 'Type the account email to confirm deletion', autocomplete: 'off', spellcheck: 'false' });
    const delBtn = h('button', { class: 'btn danger', type: 'button', disabled: true, onclick: () => act('Account deleted.', async () => {
      await api('POST', `/users/${u.id}/delete`, { confirm: confirmInput.value }); close();
    }) }, 'Delete account');
    confirmInput.addEventListener('input', () => { delBtn.disabled = confirmInput.value.trim().toLowerCase() !== u.email.toLowerCase(); });

    detail.replaceChildren(h('aside', { class: 'detail', 'aria-label': 'Account detail' },
      h('div', { class: 'detail-head' },
        h('div', {}, h('h2', { class: 'h2', text: u.email }), h('div', { class: 'mono mute', text: u.id })),
        h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Close detail', onclick: close }, icon('close'))),
      h('section', {},
        h('div', { class: 'label', text: 'Account' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Sign-in' }), h('dd', { text: u.providers.join(', ') || 'email' }),
          h('dt', { text: 'Joined' }), h('dd', { text: fmtTime(u.createdAt) }),
          h('dt', { text: 'Last sign-in' }), h('dd', { text: u.lastSignIn ? fmtTime(u.lastSignIn) : 'never' }),
          h('dt', { text: 'Last active' }), h('dd', { text: ago(u.lastActive) }),
          h('dt', { text: 'Email' }), h('dd', { text: u.confirmed ? 'confirmed' : 'not confirmed' }),
          u.suspended ? [h('dt', { text: 'Suspended' }), h('dd', { class: 'bad', text: u.reason || 'no reason given' })] : null)),
      h('section', {},
        h('div', { class: 'label', text: 'Plan' }),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('div', { class: 'tabs', role: 'group', 'aria-label': 'Plan' }, ['free', 'pro'].map(p =>
            h('button', { class: 'tab', type: 'button', 'aria-pressed': String(u.plan === p), onclick: () => {
              if (u.plan !== p) act(`Plan set to ${p}.`, () => api('POST', `/users/${u.id}/plan`, { plan: p }));
            } }, p)))),
        h('p', { class: 'note', text: 'Server-owned: the user cannot change this from the app.' })),
      h('section', {},
        h('div', { class: 'label', text: 'Access' }),
        u.suspended
          ? h('div', { class: 'stack' },
              h('button', { class: 'btn', type: 'button', onclick: () => act('Suspension lifted.', () => api('POST', `/users/${u.id}/suspend`, { suspended: false })) }, 'Lift suspension'))
          : h('div', { class: 'stack' }, reason,
              h('div', { class: 'row' },
                h('button', { class: 'btn', type: 'button', onclick: () => act('Account suspended and signed out.', () => api('POST', `/users/${u.id}/suspend`, { suspended: true, reason: reason.value.trim() || null })) }, 'Suspend'),
                h('button', { class: 'btn', type: 'button', onclick: () => act('Signed out everywhere.', () => api('POST', `/users/${u.id}/signout`, {})) }, 'Sign out everywhere'))),
        h('p', { class: 'note', text: 'Takes effect in the app within 30 seconds. Suspending also blocks new sign-ins.' })),
      h('section', {},
        h('div', { class: 'row' }, h('div', { class: 'label', text: 'Recent security events' }),
          h('a', { class: 'small', href: '#events', style: { marginLeft: 'auto' }, onclick: () => { sessionStorage.setItem('mp-admin-user', u.email); } }, 'Full log')),
        d.events.length
          ? h('ul', { class: 'events-mini' }, d.events.map(e => h('li', {}, h('span', { class: 'cell-strong', text: e.kind.replace(/_/g, ' ') }), h('span', { class: 'mute', text: ago(e.created_at) }), e.detail ? h('span', { class: 'mute', text: e.detail }) : null)))
          : h('p', { class: 'note', text: 'Nothing recorded yet.' })),
      h('section', { class: 'danger-zone' },
        h('div', { class: 'label bad', text: 'Delete account' }),
        h('p', { class: 'note', text: 'Removes the Supabase account, settings and security history. This cannot be undone. Type the email to confirm.' }),
        h('div', { class: 'stack' }, confirmInput, h('div', {}, delBtn)))));
  }

  load();
}

// ---- security log --------------------------------------------------------
async function renderEvents(main) {
  const preset = sessionStorage.getItem('mp-admin-user') || '';
  sessionStorage.removeItem('mp-admin-user');
  const f = { kind: '', user: preset, from: '', to: '' };
  const tbody = h('tbody');
  const more = h('div', { class: 'pager' });
  const kind = h('select', { class: 'select', 'aria-label': 'Event type', onchange: () => { f.kind = kind.value; load(); } }, h('option', { value: '', text: 'All events' }));
  const user = h('input', { class: 'input', type: 'search', placeholder: 'Email or user id', value: preset, 'aria-label': 'Filter by account', oninput: debounce(() => { f.user = user.value.trim(); load(); }, 300) });
  const from = h('input', { class: 'input', type: 'date', 'aria-label': 'From date', onchange: () => { f.from = from.value; load(); } });
  const to = h('input', { class: 'input', type: 'date', 'aria-label': 'To date', onchange: () => { f.to = to.value; load(); } });
  const exportBtn = h('a', { class: 'btn', href: '#', download: '' }, icon('download'), 'Export CSV');
  const syncExport = () => { exportBtn.href = '/admin/api/events.csv?' + params(); };

  main.replaceChildren(h('div', { class: 'page' },
    pageHead('Security log', 'Sign-ins, sign-outs, 2FA changes and lockouts from every account. The newest 200 per account are kept.', exportBtn),
    h('div', { class: 'toolbar' },
      h('label', { class: 'field grow' }, h('span', { class: 'label', text: 'Account' }), user),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Type' }), kind),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'From' }), from),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'To' }), to)),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Time', 'Account', 'Event', 'Detail', 'IP'].map(t => h('th', { text: t })))),
      tbody)),
    more));

  function params(before) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (before) p.set('before', before);
    return p;
  }
  const row = e => h('tr', {},
    h('td', { class: 'mute when', text: fmtTime(e.created_at) }),
    h('td', { class: 'cell-strong', text: e.email }),
    h('td', {}, h('span', { class: 'tag' + (/failed|locked/.test(e.kind) ? ' bad' : ''), text: e.kind.replace(/_/g, ' ') })),
    h('td', { text: e.detail || '—' }),
    h('td', { class: 'mono mute', text: e.ip || '—' }));

  async function load(before) {
    syncExport();
    if (!before) tbody.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'loading', text: 'Loading events…' })));
    try {
      const d = await api('GET', '/events?' + params(before));
      if (kind.options.length === 1) d.kinds.forEach(k => kind.append(h('option', { value: k, text: k.replace(/_/g, ' ') })));
      const rows = d.rows.map(row);
      if (before) tbody.append(...rows);
      else tbody.replaceChildren(...(rows.length ? rows : [emptyRow(5, 'No events match', 'Widen the dates or clear the filters.')]));
      const last = d.rows[d.rows.length - 1];
      more.replaceChildren(d.more && last ? h('button', { class: 'btn', type: 'button', onclick: () => load(last.id) }, 'Load older') : h('span', { text: 'End of log' }));
    } catch (x) {
      tbody.replaceChildren(emptyRow(5, 'Could not load events', x.message));
    }
  }
  load();
}

// ---- admin audit ---------------------------------------------------------
async function renderAudit(main) {
  const tbody = h('tbody');
  const more = h('div', { class: 'pager' });
  main.replaceChildren(h('div', { class: 'page' },
    pageHead('Admin audit', 'Everything done from this panel and the admin CLI, including failed sign-ins. Append only: nobody can edit or delete it.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Time', 'Admin', 'Action', 'Target', 'Detail', 'IP'].map(t => h('th', { text: t })))),
      tbody)),
    more));
  async function load(before) {
    try {
      const d = await api('GET', '/audit' + (before ? '?before=' + before : ''));
      const rows = d.rows.map(r => h('tr', {},
        h('td', { class: 'mute when', text: fmtTime(r.created_at) }),
        h('td', { class: 'cell-strong', text: r.admin }),
        h('td', {}, h('span', { class: 'tag' + (/fail|delete|suspend/.test(r.action) ? ' bad' : ''), text: r.action.replace(/_/g, ' ') })),
        h('td', { class: 'mono', text: r.target || '—' }),
        h('td', { class: 'small mute', text: r.detail ? Object.entries(r.detail).filter(([k]) => k !== 'username').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '—' }),
        h('td', { class: 'mono mute', text: r.ip || '—' })));
      if (before) tbody.append(...rows);
      else tbody.replaceChildren(...(rows.length ? rows : [emptyRow(6, 'Nothing yet', 'Actions appear here as soon as they happen.')]));
      const last = d.rows[d.rows.length - 1];
      more.replaceChildren(d.more && last ? h('button', { class: 'btn', type: 'button', onclick: () => load(last.id) }, 'Load older') : h('span', { text: 'End of audit' }));
    } catch (x) { tbody.replaceChildren(emptyRow(6, 'Could not load the audit', x.message)); }
  }
  load();
}

// ---- health --------------------------------------------------------------
async function renderHealth(main) {
  const body = h('div', { class: 'grid2' }, h('div', { class: 'loading', text: 'Checking…' }));
  const stamp = h('span', { class: 'label' });
  main.replaceChildren(h('div', { class: 'page' },
    pageHead('Health', 'Live counters from the app server since its last restart, plus a database round trip.',
      stamp, h('button', { class: 'btn', type: 'button', onclick: () => load() }, icon('refresh'), 'Check now')),
    body));

  const panel = (title, ok, ...kids) => h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('span', { class: 'dot ' + (ok === null ? 'idle' : ok ? 'ok' : 'bad'), 'aria-hidden': 'true' }), h('h2', { class: 'h2', text: title }),
      h('span', { class: 'tag ' + (ok === null ? '' : ok ? 'ok' : 'bad'), text: ok === null ? 'Off' : ok ? 'OK' : 'Problem' })),
    h('div', { class: 'panel-body' }, kids));
  const kv = pairs => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v, cls]) => [h('dt', { text: k }), h('dd', { class: cls || null, text: v })]));

  let timer;
  async function load() {
    clearTimeout(timer);
    let d;
    try { d = await api('GET', '/health'); }
    catch (x) { body.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Health check failed' }), x.message)); return; }
    stamp.textContent = 'Checked ' + new Date(d.checkedAt).toLocaleTimeString();
    const a = d.app;
    const parts = [];
    if (a.ok) {
      const f = a.finnhub, used = f.lastMinute / f.quotaPerMinute;
      const reqTotal = a.requests.total || 0;
      parts.push(panel('App server', true, kv([
        ['Uptime', dur(a.uptimeS)], ['Memory', a.rssMb + ' MB'], ['Node', a.node], ['Mode', a.production ? 'production' : 'development'],
        ['Requests', num(reqTotal)], ['Server errors', num(a.requests.s5xx), a.requests.s5xx ? 'bad' : null],
        ['Client errors', num(a.requests.s4xx)],
        ['Blocked', `${num(a.blocked.suspended)} suspended · ${num(a.blocked.revoked)} signed out`]
      ])));
      parts.push(panel('Finnhub proxy', a.liveData ? f.upstreamErrors === 0 || f.upstreamErrors / Math.max(1, f.upstream) < 0.1 : null,
        a.liveData ? [
          h('div', { class: 'row' }, h('span', { class: 'label', text: 'Calls in the last minute' }), h('span', { class: 'cell-strong', style: { marginLeft: 'auto' }, text: `${f.lastMinute} / ${f.quotaPerMinute}` })),
          h('div', { class: 'meter' + (used > 0.8 ? ' hot' : ''), role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(f.quotaPerMinute), 'aria-valuenow': String(f.lastMinute), 'aria-label': 'Finnhub quota used' }, h('i', { style: { width: Math.min(100, used * 100) + '%' } })),
          kv([['Upstream calls', num(f.upstream)], ['Upstream errors', num(f.upstreamErrors), f.upstreamErrors ? 'warn' : null],
            ['Cache hits', num(f.cacheHits)], ['Coalesced', num(f.coalesced)], ['Cached keys', num(f.cacheSize)]])
        ] : h('p', { class: 'note', text: 'No FINNHUB_TOKEN on the app server, so the app shows demo data.' })));
      const rl = Object.entries(a.rateLimited);
      parts.push(panel('Rate limits', rl.length ? null : true,
        rl.length ? kv(rl.sort((x, y) => y[1] - x[1]).map(([k, v]) => [k.replace(/_/g, ' '), num(v) + ' refused'])) : h('p', { class: 'note', text: 'No request has been refused since the last restart.' })));
      parts.push(panel('Recent errors', a.errors.total ? false : true,
        a.errors.recent.length
          ? h('ul', { class: 'events-mini' }, a.errors.recent.map(e => h('li', {}, h('span', { class: 'cell-strong', text: `${e.status} ${e.code}` }), h('span', { class: 'mute', text: ago(new Date(e.at).toISOString()) }), h('span', { class: 'mono mute', text: 'ref ' + e.ref }))))
          : h('p', { class: 'note', text: 'None since the last restart. Each error\'s ref matches a line in the app server log.' })));
    } else {
      parts.push(panel('App server', false, h('p', { class: 'note', text: a.error === 'unreachable'
        ? 'The stats port did not answer. Check the app server is running and STATS_TOKEN matches in both .env and admin.env.'
        : a.error })));
    }
    parts.push(panel('Database', d.database.ok, d.database.ok ? kv([['Round trip', d.database.ms + ' ms']]) : h('p', { class: 'note', text: 'Supabase did not answer. Check the project status and SUPABASE_URL.' })));
    parts.push(panel('Admin process', true, kv([['Uptime', dur(d.admin.uptimeS)], ['Memory', d.admin.rssMb + ' MB'], ['Node', d.admin.node]])));
    body.replaceChildren(...parts);
    if (state.route === 'health') timer = setTimeout(() => { if (state.route === 'health' && document.body.contains(body)) load(); }, 15_000);
  }
  load();
}

// ---- content -------------------------------------------------------------
const LANGS = ['EN', 'RO', 'DE'];

async function renderContent(main) {
  const list = h('div', { class: 'content-list' }, h('div', { class: 'loading', text: 'Loading content…' }));
  main.replaceChildren(h('div', { class: 'page' },
    pageHead('Content', 'Edit what visitors see without a redeploy. Changes reach the site within 30 seconds; Reset returns to the copy built into the page.'),
    list));
  let data;
  try { data = await api('GET', '/content'); }
  catch (x) { list.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Could not load content' }), x.message)); return; }

  function editor(key, title, help, fields, read, write) {
    const status = h('span', { class: 'status' });
    const current = data[key];
    const setStatus = (text, cls) => { status.className = 'status' + (cls ? ' ' + cls : ''); status.textContent = text; };
    setStatus(current ? `Live · saved by ${current.updatedBy || '?'} ${ago(current.updatedAt)}` : 'Using the built-in default');
    if (current) write(current.value);
    const save = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      let value;
      try { value = read(); } catch (x) { setStatus(x.message, 'bad'); return; }
      save.disabled = true;
      try {
        await api('PUT', '/content/' + key, { value });
        data[key] = { value, updatedAt: new Date().toISOString(), updatedBy: state.me.username };
        setStatus('Saved. Live within 30 seconds.', 'up');
        reset.disabled = false;
      } catch (x) { setStatus(x.message, 'bad'); }
      save.disabled = false;
    } }, 'Save');
    const reset = h('button', { class: 'btn ghost', type: 'button', disabled: !current, onclick: async () => {
      try {
        await api('DELETE', '/content/' + key);
        data[key] = null; reset.disabled = true;
        setStatus('Reset to the built-in default. Reload this page to clear the form.', 'up');
      } catch (x) { setStatus(x.message, 'bad'); }
    } }, 'Reset to default');
    return h('section', { class: 'panel', 'aria-labelledby': 'c-' + key },
      h('div', { class: 'panel-head' }, h('h2', { class: 'h2', id: 'c-' + key, text: title })),
      h('div', { class: 'panel-body' }, h('p', { class: 'note', style: { margin: '0 0 14px' }, text: help }), fields),
      h('div', { class: 'panel-foot' }, status, reset, save));
  }

  const inp = (label, attrs) => {
    const el = h('input', Object.assign({ class: 'input' }, attrs));
    return { el, field: h('label', { class: 'field' + (attrs.wide ? ' wide' : '') }, h('span', { class: 'label', text: label }), el) };
  };
  const area = (label, attrs) => {
    const el = h('textarea', Object.assign({ class: 'textarea' }, attrs));
    return { el, field: h('label', { class: 'field' }, h('span', { class: 'label', text: label }), el) };
  };
  const sym = v => { const t = v.trim().toUpperCase(); if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t)) throw new Error(`"${v.trim()}" is not a ticker symbol.`); return t; };

  // Featured story
  const fx = {
    ticker: inp('Ticker', { placeholder: 'NVDA', maxlength: '12' }), score: inp('Score', { placeholder: '+72', maxlength: '8' }),
    delta: inp('Move', { placeholder: '+2.4%', maxlength: '10' }), source: inp('Source', { placeholder: 'Reuters', maxlength: '40' }),
    stamp: inp('Time', { placeholder: '09:29:14', maxlength: '20' })
  };
  const heads = LANGS.map(l => area('Headline · ' + l, { maxlength: '160', rows: '2' }));
  const watches = LANGS.map(l => area('What to watch · ' + l, { maxlength: '240', rows: '3' }));
  const featured = editor('featured', 'Featured story', 'The "Top story now" card on the landing page. English is required; Romanian and German fall back to English when empty.',
    [h('div', { class: 'form-grid' }, Object.values(fx).map(x => x.field)),
     h('div', { class: 'lang-grid', style: { marginTop: '12px' } }, heads.map(x => x.field)),
     h('div', { class: 'lang-grid', style: { marginTop: '12px' } }, watches.map(x => x.field))],
    () => {
      const loc = arr => Object.fromEntries(LANGS.map((l, i) => [l, arr[i].el.value.trim()]).filter(([, v]) => v));
      const v = { ticker: sym(fx.ticker.el.value), score: fx.score.el.value.trim(), delta: fx.delta.el.value.trim(), source: fx.source.el.value.trim(),
        headline: loc(heads), watch: loc(watches) };
      if (fx.stamp.el.value.trim()) v.stamp = fx.stamp.el.value.trim();
      if (!v.headline.EN || !v.watch.EN) throw new Error('Fill in the English headline and what-to-watch line.');
      return v;
    },
    v => {
      for (const k of Object.keys(fx)) fx[k].el.value = v[k] || '';
      LANGS.forEach((l, i) => { heads[i].el.value = (v.headline || {})[l] || ''; watches[i].el.value = (v.watch || {})[l] || ''; });
    });

  // Landing tickers
  const tk = inp('Symbols, in order, comma-separated', { placeholder: 'NVDA, AAPL, MSFT, TSLA, AMZN' });
  const tickers = editor('tickers', 'Landing ticker strip', 'Up to 8 symbols. A symbol without demo data or a live quote is skipped rather than shown empty.',
    tk.field,
    () => { const v = tk.el.value.split(/[,\n]+/).map(x => x.trim()).filter(Boolean).map(sym); if (!v.length || v.length > 8) throw new Error('List between 1 and 8 symbols.'); if (new Set(v).size !== v.length) throw new Error('A symbol is listed twice.'); return v; },
    v => { tk.el.value = v.join(', '); });

  // Sources count
  const sc = inp('Number of news sources', { type: 'number', min: '0', max: '100000', step: '1', placeholder: '840' });
  const sources = editor('sources', 'Sources count', 'The figure shown on the landing page and in the app rail.',
    h('div', { class: 'form-grid' }, sc.field),
    () => { const n = Number(sc.el.value); if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error('Enter a whole number from 0 to 100,000.'); return { count: n }; },
    v => { sc.el.value = v.count; });

  // Search universe
  const un = area('One per line: SYMBOL Company name', { rows: '6', placeholder: 'PLTR Palantir Technologies\nSHOP Shopify Inc', spellcheck: 'false' });
  const universe = editor('universe', 'Searchable market', 'Extra names added to search and the screener. They show as "live data required" until a Finnhub token is set.',
    un.field,
    () => un.el.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = /^(\S+)\s+(.+)$/.exec(l); if (!m) throw new Error(`"${l}" needs a symbol and a name.`);
      return { ticker: sym(m[1]), name: m[2].trim().slice(0, 60) };
    }),
    v => { un.el.value = v.map(r => `${r.ticker} ${r.name}`).join('\n'); });

  // Copy overrides
  const lang = h('select', { class: 'select', 'aria-label': 'Language' }, LANGS.map(l => h('option', { value: l, text: l })));
  const copyText = {};
  const ov = area('Overrides: one per line, key = text', { rows: '8', spellcheck: 'false', placeholder: 'lpH1a = Hear the news\nlpCta = Start free' });
  let shownLang = lang.value;
  ov.el.addEventListener('input', () => { copyText[shownLang] = ov.el.value; });
  lang.addEventListener('change', () => { shownLang = lang.value; ov.el.value = copyText[shownLang] || ''; });
  const copy = editor('copy', 'Interface copy', 'Replace any built-in string by its key, per language: for example lpH1a, lpH1b, lpSub, lpCta for the landing headline and button. Unknown keys are ignored by the site.',
    [h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', { class: 'label', text: 'Language' }), lang)), h('div', { style: { marginTop: '12px' } }, ov.field)],
    () => {
      copyText[shownLang] = ov.el.value;
      const out = {};
      for (const l of LANGS) {
        const lines = String(copyText[l] || '').split('\n').map(x => x.trim()).filter(Boolean);
        if (!lines.length) continue;
        out[l] = {};
        for (const line of lines) {
          const m = /^([A-Za-z][A-Za-z0-9]{0,40})\s*=\s*(.+)$/.exec(line);
          if (!m) throw new Error(`${l}: "${line.slice(0, 40)}" should look like key = text.`);
          out[l][m[1]] = m[2];
        }
      }
      return out;
    },
    v => { for (const l of LANGS) copyText[l] = Object.entries(v[l] || {}).map(([k, t]) => `${k} = ${t}`).join('\n'); ov.el.value = copyText[shownLang] || ''; });

  list.replaceChildren(featured, tickers, sources, universe, copy);
}

// ---- utils / boot --------------------------------------------------------
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function boot() {
  try {
    state.me = await api('GET', '/me');
    state.me_idle = state.me.idleMinutes;
    resetIdle();
    renderShell();
  } catch (x) {
    renderLogin(x.code === 'network' ? x.message : '');
  }
}
boot();
})();
