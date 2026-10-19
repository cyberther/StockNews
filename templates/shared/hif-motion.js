// Motion for the Market Pulse apps: GSAP drives the timelines, Lenis the smooth scrolling,
// and the effects are hand-ported from React Bits (SplitText/BlurText, SpotlightCard, Aurora,
// ShinyText, CountUp) and 21st.dev / Magic UI (Marquee, BorderBeam, ShimmerButton,
// NumberTicker), restyled for the gold-on-dark terminal.
//
// The templates opt in with data attributes, so the markup stays declarative and the page
// runtime keeps owning the DOM. A MutationObserver picks elements up as they mount.
//
//   data-m="rise"       fades and lifts in when it mounts; siblings mounting together stagger
//   data-m="fade"       fades in when it mounts (whole views, so nested rises don't compound)
//   data-m="slide"      slides in from the right (drawers)
//   data-m="wipe"       reveals left to right (charts)
//   data-m="draw"       draws an SVG line along its length
//   data-m="reveal"     waits out of sight and rises in when scrolled into view; several
//                       arriving together come one after another. "reveal-left",
//                       "reveal-right" slide in from that side, "reveal-zoom" grows in
//   data-m="split"      words rise out of a blur one by one (headlines with fixed structure)
//   data-m="shine"      a sheen runs across the text
//   data-m="shimmer"    a light sweeps across the button
//   data-m="beam"       a light travels round the border
//   data-m="spotlight"  a soft light follows the pointer
//   data-m="aurora"     fills an empty, absolutely placed element with drifting light
//   data-m="marquee"    scrolls its first child (two copies of the content) forever
//   data-m="smooth"     Lenis wheel smoothing for this scroll container
//   data-m-count="1"    numbers tween to their new value; "in" also counts up on mount
//   data-m-flash="1"    flashes when its number changes
//   data-m-key="..."    replays the entrance (rise/fade/wipe) whenever the value changes
// Tokens combine: data-m="rise spotlight". With prefers-reduced-motion everything settles
// instantly, the marquee stands still and scrolling stays native.
(function(){
if (window.HIFMotion) return;

const reduceQ = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const reduced = () => reduceQ.matches;
const has = (el, t) => el.nodeType === 1 && (' ' + (el.getAttribute('data-m') || '') + ' ').indexOf(' ' + t + ' ') >= 0;
let gsap = null, Lenis = null, started = false;

// ---- styles for the CSS-only effects -------------------------------------------------
const CSS = `
@property --m-a{syntax:'<angle>';inherits:false;initial-value:0deg}
[data-m~="spotlight"]{isolation:isolate}
[data-m~="spotlight"]:not([style*="position"]){position:relative}
[data-m~="spotlight"]::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:0;transition:opacity .35s ease;
  background:radial-gradient(320px circle at var(--mx,50%) var(--my,50%),color-mix(in srgb,var(--color-accent) 13%,transparent),transparent 70%)}
[data-m~="spotlight"]:hover::before{opacity:1}
[data-m~="shimmer"]{overflow:hidden}
[data-m~="shimmer"]:not([style*="position"]){position:relative}
[data-m~="shimmer"]::after{content:"";position:absolute;inset:0;pointer-events:none;transform:translateX(-110%);
  background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.5) 50%,transparent 70%);animation:m-shimmer 3.6s cubic-bezier(.4,0,.2,1) infinite}
@keyframes m-shimmer{0%,58%{transform:translateX(-110%)}100%{transform:translateX(110%)}}
[data-m~="beam"]:not([style*="position"]){position:relative}
[data-m~="beam"]::after{content:"";position:absolute;inset:-1px;padding:1px;pointer-events:none;border-radius:inherit;
  background:conic-gradient(from var(--m-a),transparent 0 72%,color-mix(in srgb,var(--color-accent) 60%,transparent) 84%,#FFF4CF 90%,transparent 97%);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:m-beam 6s linear infinite}
@keyframes m-beam{to{--m-a:360deg}}
[data-m~="shine"]{background:linear-gradient(110deg,var(--color-accent) 42%,#FFF1C2 50%,var(--color-accent) 58%) 0 0/250% 100%;
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:m-shine 5s linear infinite}
@keyframes m-shine{from{background-position:100% 0}to{background-position:-150% 0}}
[data-m~="aurora"]{pointer-events:none;overflow:hidden}
.m-blob{position:absolute;width:70%;aspect-ratio:1;border-radius:50%;mix-blend-mode:screen;will-change:transform}
[data-m~="marquee"]>*{display:flex;width:max-content;will-change:transform}
.m-flash{animation:m-flash 1.1s ease-out}
@keyframes m-flash{from{box-shadow:inset 0 0 0 100vmax color-mix(in srgb,var(--color-accent) 30%,transparent)}to{box-shadow:inset 0 0 0 100vmax transparent}}
.m-word{display:inline-block;will-change:transform,opacity,filter}
[data-m~="shine"] .m-word{-webkit-text-fill-color:var(--color-accent)}
.m-rv [data-m~="reveal"],.m-rv [data-m~="reveal-left"],.m-rv [data-m~="reveal-right"],.m-rv [data-m~="reveal-zoom"]{
  transition:opacity .75s cubic-bezier(.2,.7,.2,1),transform .75s cubic-bezier(.2,.7,.2,1)}
.m-rv [data-m~="reveal"]:not([data-m-in]){opacity:0;transform:translateY(36px)}
.m-rv [data-m~="reveal-left"]:not([data-m-in]){opacity:0;transform:translateX(-48px)}
.m-rv [data-m~="reveal-right"]:not([data-m-in]){opacity:0;transform:translateX(48px)}
.m-rv [data-m~="reveal-zoom"]:not([data-m-in]){opacity:0;transform:translateY(18px) scale(.92)}
@media (prefers-reduced-motion:reduce){[data-m~="shimmer"]::after,[data-m~="beam"]::after,[data-m~="shine"],.m-flash{animation:none}}
`;
function injectCss() {
  if (document.getElementById('hif-motion-css')) return;
  const s = document.createElement('style'); s.id = 'hif-motion-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

// ---- entrances ----------------------------------------------------------------------
// Only animate properties the page has not set inline, and hand them back afterwards.
function free(el, prop) { return !el.style[prop]; }

function entrance(els, kind) {
  if (!els.length) return;
  if (reduced()) return;
  const step = kind === 'rise' ? 0.045 : 0;
  els.forEach((el, i) => {
    const delay = Math.min(i, 12) * step;
    if (kind === 'wipe') {
      gsap.fromTo(el, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.9, ease: 'power2.inOut', overwrite: 'auto', clearProps: 'clipPath' });
      return;
    }
    const from = {}, to = { duration: kind === 'fade' ? 0.3 : kind === 'slide' ? 0.45 : 0.5, delay, ease: 'power3.out', overwrite: 'auto' }, clear = [];
    if (free(el, 'opacity')) { from.opacity = 0; to.opacity = 1; clear.push('opacity'); }
    if (free(el, 'transform')) {
      if (kind === 'rise') { from.y = 14; to.y = 0; clear.push('transform'); }
      if (kind === 'slide') { from.xPercent = 100; to.xPercent = 0; clear.push('transform'); }
    }
    if (!clear.length) return;
    to.clearProps = clear.join(',');
    gsap.fromTo(el, from, to);
  });
}

function draw(el) {
  if (reduced() || typeof el.getTotalLength !== 'function') return;
  let len = 0; try { len = el.getTotalLength(); } catch (e) {}
  if (!len) return;
  gsap.fromTo(el, { strokeDasharray: len, strokeDashoffset: len },
    { strokeDashoffset: 0, duration: 1.3, ease: 'power2.out', delay: 0.2, clearProps: 'strokeDasharray,strokeDashoffset' });
}

// SplitText / BlurText. The runtime owns the text nodes, so they are parked while the
// words animate and put back afterwards. A text update that lands mid-animation goes to
// the parked node and shows once it is back.
function split(el) {
  if (reduced() || el._mSplit) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) nodes.push(n);
  if (!nodes.length) return;
  const parked = [], words = [];
  nodes.forEach(n => {
    const wrap = document.createElement('span');
    n.nodeValue.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { wrap.appendChild(document.createTextNode(part)); return; }
      const w = document.createElement('span'); w.className = 'm-word'; w.textContent = part;
      wrap.appendChild(w); words.push(w);
    });
    n.parentNode.replaceChild(wrap, n); parked.push([wrap, n]);
  });
  el._mSplit = true;
  const restore = () => {
    parked.forEach(([wrap, n]) => { if (wrap.parentNode) wrap.parentNode.replaceChild(n, wrap); });
    el._mSplit = false;
  };
  gsap.fromTo(words, { opacity: 0, yPercent: 45, filter: 'blur(10px)' },
    { opacity: 1, yPercent: 0, filter: 'blur(0px)', duration: 0.8, ease: 'power3.out', stagger: 0.07, delay: 0.1, onComplete: restore, onInterrupt: restore });
}

// ---- scroll reveals ---------------------------------------------------------------------
// Hidden by the stylesheet while html has .m-rv, shown when data-m-in is set as each comes
// into view (the observer works against the viewport, inside any scroll container). The
// runtime rewrites inline styles when it renders, so the state lives in an attribute it
// doesn't own. Elements arriving together come in page order, 90 ms apart.
let revealIO = null;
function onReveal(entries) {
  const show = entries.filter(e => e.isIntersecting).map(e => e.target);
  show.forEach(el => revealIO.unobserve(el));
  show.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  show.forEach((el, i) => setTimeout(() => el.setAttribute('data-m-in', ''), Math.min(i, 8) * 90));
}
function reveal(el) {
  if (reduced() || !revealIO || el.hasAttribute('data-m-in')) return;
  revealIO.observe(el);
}

// ---- numbers ------------------------------------------------------------------------
// Parses "$1,234.56", "+2.4%", "1.234,5" etc. into { pre, num, post, dec, group, decimals }.
function parseNum(text) {
  const m = /^(.*?)(-?)(\d[\d.,]*)(.*)$/s.exec(text || '');
  if (!m) return null;
  const body = m[3], lastDot = body.lastIndexOf('.'), lastComma = body.lastIndexOf(',');
  let dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',', idx = Math.max(lastDot, lastComma);
    const single = body.indexOf(sep) === idx, tail = body.length - idx - 1;
    dec = single && tail !== 3 ? sep : '';
  }
  const group = dec === '.' ? ',' : dec === ',' ? '.' : (body.indexOf(',') >= 0 ? ',' : body.indexOf('.') >= 0 ? '.' : '');
  const decimals = dec ? body.length - body.lastIndexOf(dec) - 1 : 0;
  const clean = body.split(group).join('').replace(dec || '#', '.');
  const num = parseFloat(clean) * (m[2] ? -1 : 1);
  return isFinite(num) ? { pre: m[1], num, post: m[4], dec: dec || '.', group, decimals } : null;
}
function formatNum(p, v) {
  const neg = v < 0, fixed = Math.abs(v).toFixed(p.decimals);
  let [int, frac] = fixed.split('.');
  if (p.group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, p.group);
  return p.pre + (neg ? '-' : '') + int + (frac ? p.dec + frac : '') + p.post;
}

// The text node inside el that carries the number.
function numberNode(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/\d/.test(n.nodeValue)) return n;
  return null;
}

function countTo(node, fromText, toText) {
  const a = parseNum(fromText), b = parseNum(toText);
  // A change of sign or unit ("+" to "−", "K" to "M") just snaps.
  if (!a || !b || a.num === b.num || reduced() || a.pre !== b.pre || a.post !== b.post || (a.num < 0) !== (b.num < 0)) return;
  if (node._mTween) node._mTween.kill();
  const o = { v: a.num };
  node._mExpect = formatNum(b, a.num); node.nodeValue = node._mExpect;
  node._mTween = gsap.to(o, { v: b.num, duration: 0.9, ease: 'power2.out',
    onUpdate: () => { node._mExpect = formatNum(b, o.v); node.nodeValue = node._mExpect; },
    onComplete: () => { node._mExpect = toText; node.nodeValue = toText; node._mTween = null; } });
}

function flash(el) {
  if (reduced()) return;
  el.classList.remove('m-flash'); void el.offsetWidth; el.classList.add('m-flash');
}

// Remember each watched node's last real value, to know what it changed from.
const lastText = new WeakMap();
function textChanged(node) {
  if (node._mExpect !== undefined && node.nodeValue === node._mExpect) return;
  const host = node.parentElement && node.parentElement.closest('[data-m-count],[data-m-flash]');
  if (!host) return;
  const prev = lastText.get(node), next = node.nodeValue;
  lastText.set(node, next);
  if (prev === undefined || prev === next) return;
  const a = parseNum(prev), b = parseNum(next);
  if (host.hasAttribute('data-m-flash') && a && b && a.num !== b.num) flash(host);
  if (host.hasAttribute('data-m-count')) countTo(node, prev, next);
}
function watchNumbers(el) {
  const n = numberNode(el); if (!n) return;
  lastText.set(n, n.nodeValue);
  if (el.getAttribute('data-m-count') === 'in' && !reduced()) {
    const b = parseNum(n.nodeValue);
    if (b) countTo(n, formatNum(b, 0), n.nodeValue);
  }
}

// ---- aurora ---------------------------------------------------------------------------
const BLOBS = [
  ['#D4AF37', 0.30, '-10%', '-25%'],
  ['#8A5A12', 0.34, '45%', '-10%'],
  ['#E8C76A', 0.16, '15%', '35%'],
];
function aurora(el) {
  if (el._mAurora) return;
  el.setAttribute('aria-hidden', 'true');
  const tweens = [];
  BLOBS.forEach(([c, a, x, y], i) => {
    const b = document.createElement('div'); b.className = 'm-blob';
    b.style.cssText = 'left:' + x + ';top:' + y + ';background:radial-gradient(closest-side,' + hexA(c, a) + ',transparent)';
    el.appendChild(b);
    if (!reduced()) tweens.push(gsap.to(b, { xPercent: gsap.utils.random(-22, 22), yPercent: gsap.utils.random(-18, 18), scale: gsap.utils.random(0.85, 1.25),
      duration: gsap.utils.random(9, 14), ease: 'sine.inOut', repeat: -1, yoyo: true, delay: -i * 3 }));
  });
  el._mAurora = tweens;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + (n >> 16) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
}

// ---- marquee ------------------------------------------------------------------------
const marquees = new Set();
function marquee(el) {
  if (el._mMarquee) return;
  const m = { el, pos: 0, speed: 0, target: 38 };
  el._mMarquee = m; marquees.add(m);
  el.addEventListener('mouseenter', () => { m.target = 0; });
  el.addEventListener('mouseleave', () => { m.target = 38; });
  el.addEventListener('focusin', () => { m.target = 0; });
  el.addEventListener('focusout', () => { m.target = 38; });
}
function tickMarquees(dt) {
  marquees.forEach(m => {
    if (!m.el.isConnected) { marquees.delete(m); return; }
    const track = m.el.firstElementChild; if (!track) return;
    const copy = track.firstElementChild, dup = track.children[1];
    const half = copy ? copy.offsetWidth : 0, fits = half <= m.el.clientWidth;
    if (dup) dup.style.visibility = fits ? 'hidden' : '';
    if (fits || reduced() || !half) { m.pos = 0; track.style.transform = ''; return; }
    m.speed += (m.target - m.speed) * Math.min(1, dt * 4);
    m.pos -= m.speed * dt;
    if (m.pos <= -half) m.pos += half;
    track.style.transform = 'translate3d(' + m.pos.toFixed(2) + 'px,0,0)';
  });
}

// ---- smooth scroll (Lenis) ------------------------------------------------------------
const smoothers = new Map();
function smooth(el) {
  if (smoothers.has(el) || reduced() || !Lenis) return;
  // Touch keeps native scrolling (syncTouch off); this only smooths wheel and trackpad.
  const lenis = new Lenis({ wrapper: el, content: el, autoRaf: false, smoothWheel: true, lerp: 0.14,
    allowNestedScroll: true, autoResize: true });
  smoothers.set(el, lenis);
}
function resizeSmoothers() {
  smoothers.forEach((lenis, el) => {
    if (!el.isConnected) { lenis.destroy(); smoothers.delete(el); return; }
    lenis.resize();
  });
}

// ---- spotlight ------------------------------------------------------------------------
function onPointer(e) {
  const t = e.target && e.target.closest && e.target.closest('[data-m~="spotlight"]');
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  t.style.setProperty('--my', (e.clientY - r.top) + 'px');
}

// ---- wiring ---------------------------------------------------------------------------
const SEL = '[data-m],[data-m-count],[data-m-flash]';
function mount(el) {
  if (el._mSeen) return; el._mSeen = true;
  if (has(el, 'aurora')) aurora(el);
  if (has(el, 'marquee')) marquee(el);
  if (has(el, 'smooth')) smooth(el);
  if (has(el, 'split')) split(el);
  if (has(el, 'draw')) draw(el);
  if (/(^|\s)reveal(-left|-right|-zoom)?(\s|$)/.test(el.getAttribute('data-m') || '')) reveal(el);
  if (el.hasAttribute('data-m-count') || el.hasAttribute('data-m-flash')) watchNumbers(el);
}
function kindOf(el) { return ['rise', 'fade', 'slide', 'wipe'].find(k => has(el, k)); }

function mountAll(roots) {
  const found = [];
  roots.forEach(r => {
    if (r.nodeType !== 1) return;
    if (r.matches(SEL)) found.push(r);
    r.querySelectorAll(SEL).forEach(e => found.push(e));
  });
  const fresh = found.filter(e => !e._mSeen);
  fresh.forEach(mount);
  // Entrances: stagger siblings that mounted in the same batch.
  const groups = new Map();
  fresh.forEach(e => {
    const k = kindOf(e); if (!k) return;
    const g = groups.get(e.parentNode) || {}; (g[k] = g[k] || []).push(e); groups.set(e.parentNode, g);
  });
  groups.forEach(g => Object.keys(g).forEach(k => entrance(g[k], k)));
}

let resizeQueued = false;
function onMutations(records) {
  const added = [];
  for (const r of records) {
    if (r.type === 'characterData') { textChanged(r.target); continue; }
    if (r.type === 'attributes') {
      const el = r.target, k = kindOf(el);
      if (r.oldValue !== el.getAttribute('data-m-key') && k && el._mSeen) entrance([el], k);
      continue;
    }
    r.addedNodes.forEach(n => {
      if (n.nodeType === 1) added.push(n);
      else if (n.nodeType === 3) textChanged(n);
    });
  }
  if (added.length) mountAll(added);
  if (!resizeQueued && smoothers.size) { resizeQueued = true; requestAnimationFrame(() => { resizeQueued = false; resizeSmoothers(); }); }
}

function start() {
  if (started) return true;
  gsap = window.gsap; Lenis = window.Lenis;
  if (!gsap || !document.body) return false;
  started = true;
  injectCss();
  if ('IntersectionObserver' in window && !reduced()) {
    revealIO = new IntersectionObserver(onReveal, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 });
    document.documentElement.classList.add('m-rv');
  }
  gsap.ticker.lagSmoothing(0);
  gsap.ticker.add((time, deltaMs) => {
    const dt = Math.min(0.1, deltaMs / 1000);
    smoothers.forEach(l => l.raf(time * 1000));
    tickMarquees(dt);
  });
  document.addEventListener('pointermove', onPointer, { passive: true });
  new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['data-m-key'], attributeOldValue: true });
  mountAll([document.body]);
  return true;
}

// The page runtime appends the helmet scripts one after another, so GSAP and Lenis may
// land after this file. Wait for them briefly; without GSAP the page simply stays still.
(function wait(n) {
  if (start() || n > 200) return;
  setTimeout(() => wait(n + 1), 25);
})(0);

window.HIFMotion = { reduced, parseNum, formatNum, flash, lenisFor: el => smoothers.get(el) || null };
})();
