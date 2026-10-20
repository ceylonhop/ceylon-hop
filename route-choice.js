/* ============================================================
   CEYLON HOP — "two roads" popup (route choice, spec 2026-09-26 §4.5)
   Offers the toll-free local road beside the expressway when the local road is cheaper.
   One component, loaded by the pages that offer the choice (search now, plan next), so the
   popup reads the same wherever it appears.

   Styles are injected here, once, rather than added to site.css: an edit there re-stamps every
   page on the site (the same reason ch-map.js carries its own).

   Every string is set with textContent. Place names arrive from the URL, so nothing the caller
   passes is ever parsed as markup.
   ============================================================ */
(function () {
  const ASKED = 'chRoadAsked:';
  let current = null;   // the open popup's close(), or null
  let seq = 0;          // unique title ids, so aria-labelledby never points at a stale node

  function ensureStyle() {
    if (document.getElementById('ch-rc-style')) return;
    const st = document.createElement('style');
    st.id = 'ch-rc-style';
    st.textContent =
      // Above the sticky header (70), below the place-picker menu (1000).
      '.ch-rc-scrim{position:fixed;inset:0;z-index:500;display:flex;align-items:center;justify-content:center;' +
      'padding:20px;background:rgba(20,30,28,.5);opacity:0;transition:opacity .2s ease}' +
      '.ch-rc-scrim.is-in{opacity:1}' +
      '.ch-rc{position:relative;box-sizing:border-box;width:100%;max-width:560px;max-height:calc(100vh - 40px);overflow-y:auto;' +
      'background:var(--paper,#fffdf8);color:var(--ink,#3A3739);border-radius:20px;padding:26px 26px 22px;' +
      'box-shadow:0 30px 80px -20px rgba(20,30,28,.45);font-family:var(--body,Poppins,system-ui,sans-serif);' +
      'transform:translateY(8px);transition:transform .2s ease}' +
      '.ch-rc-scrim.is-in .ch-rc{transform:none}' +
      '.ch-rc *{box-sizing:border-box}' +
      '.ch-rc-grab{display:none}' +
      '.ch-rc-x{position:absolute;top:12px;right:12px;width:40px;height:40px;display:grid;place-items:center;border:0;' +
      'border-radius:50%;background:rgba(58,55,57,.07);color:var(--ink,#3A3739);font:inherit;font-size:1.4rem;line-height:1;cursor:pointer}' +
      '.ch-rc-x:hover{background:rgba(58,55,57,.13)}' +
      '.ch-rc-title{margin:0 44px 6px 0;font-family:var(--display,Georgia,serif);font-weight:700;font-size:1.75rem;line-height:1.15;overflow-wrap:anywhere}' +
      '.ch-rc-sub{margin:0 0 18px;font-size:.9rem;line-height:1.5;color:var(--ink-soft,#6c6a6b)}' +
      '.ch-rc-opts{display:grid;gap:10px;margin:0 0 20px}' +
      '.ch-rc-opt{position:relative;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:start;padding:15px 16px;' +
      'border:1.5px solid var(--line,#e7e3d6);border-radius:14px;background:#fff;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s}' +
      '.ch-rc-opt:hover{border-color:#cfc9b6}' +
      '.ch-rc-opt:has(input:checked){border-color:var(--btn-accent,#24758A);background:#f3f9fa;box-shadow:0 0 0 1px var(--btn-accent,#24758A)}' +
      '.ch-rc-opt.is-on{border-color:var(--btn-accent,#24758A);background:#f3f9fa;box-shadow:0 0 0 1px var(--btn-accent,#24758A)}' +
      // Drawn, not native: a native radio's focus ring (outline or shadow) is square in Chromium
      // whatever its border-radius. Still a real <input type=radio>, so keys and AT are unchanged.
      '.ch-rc-opt input{grid-row:1 / span 4;appearance:none;-webkit-appearance:none;box-sizing:border-box;width:20px;height:20px;margin:2px 0 0;border-radius:50%;border:2px solid #8a8789;background:var(--paper,#fffdf8);cursor:pointer}' +
      '.ch-rc-opt input:checked{border-color:var(--btn-accent,#24758A);background:radial-gradient(circle,var(--btn-accent,#24758A) 0 4.5px,var(--paper,#fffdf8) 5px)}' +
      // The keyboard ring: a round two-ring shadow (paper gap, then the accent).
      '.ch-rc-opt input:focus-visible{outline:none;box-shadow:0 0 0 3px var(--paper,#fffdf8),0 0 0 5px var(--btn-accent,#24758A)}' +
      '.ch-rc-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}' +
      '.ch-rc-sw{flex:none;width:26px;height:0;border-top:4px solid #2F6DB5;border-radius:2px}' +
      '.ch-rc-opt.is-local .ch-rc-sw{border-top:4px dashed #D9861A;border-radius:0}' +
      '.ch-rc-name{font-weight:700;font-size:1rem}' +
      '.ch-rc-tag{font-size:.72rem;font-weight:700;letter-spacing:.02em;padding:3px 9px;border-radius:999px;background:#e8f0f9;color:#22528a;white-space:nowrap}' +
      '.ch-rc-opt.is-local .ch-rc-tag{background:#fbefdc;color:#8a4f07}' +
      '.ch-rc-fig{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 12px;margin-top:4px}' +
      '.ch-rc-big{font-family:var(--display,Georgia,serif);font-weight:700;font-size:2rem;line-height:1}' +
      '.ch-rc-alt{font-weight:600;font-size:1rem}' +
      '.ch-rc-stats{font-size:.85rem;color:var(--ink-soft,#6c6a6b);overflow-wrap:anywhere}' +
      '.ch-rc-best{font-size:.85rem;font-weight:600;color:var(--ink,#3A3739)}' +
      '.ch-rc-foot{display:flex;justify-content:flex-end;align-items:center;gap:10px}' +
      '.ch-rc-foot button{min-height:46px;padding:0 22px;border-radius:999px;font:inherit;font-weight:700;font-size:.95rem;cursor:pointer}' +
      '.ch-rc-primary{border:0;background:var(--btn-accent,#24758A);color:#fff}' +
      '.ch-rc-primary:hover{background:var(--btn-accent-hover,#1E6273)}' +
      '.ch-rc-foot button:focus-visible,.ch-rc-x:focus-visible{outline:2px solid var(--btn-accent,#24758A);outline-offset:2px}' +
      // Phone: a bottom sheet, modelled on the booking page's summary sheet.
      '@media (max-width:639.98px){' +
        '.ch-rc-scrim{align-items:flex-end;padding:0}' +
        '.ch-rc{position:fixed;left:0;right:0;bottom:0;max-width:none;max-height:92dvh;border-radius:22px 22px 0 0;' +
        'padding:10px 18px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -18px 44px -12px rgba(20,40,38,.35);' +
        'transform:translateY(102%);transition:transform .28s ease}' +
        '.ch-rc-scrim.is-in .ch-rc{transform:translateY(0)}' +
        '.ch-rc-grab{display:block;width:40px;height:4px;margin:0 auto 14px;border-radius:2px;background:#d9d4c4}' +
        '.ch-rc-x{top:14px;right:10px}' +
        '.ch-rc-title{font-size:1.45rem;margin-top:6px}' +
        '.ch-rc-sub{font-size:.85rem;margin-bottom:14px}' +
        '.ch-rc-opt{padding:13px 14px}' +
        '.ch-rc-big{font-size:1.75rem}' +
        '.ch-rc-foot button{flex:1 1 0;padding:0 12px}' +
      '}' +
      '@media (prefers-reduced-motion:reduce){.ch-rc,.ch-rc-scrim{transition:none}}';
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // One road's card: a <label> around a native radio, so the arrow keys move between the two.
  function option(value, o, local) {
    const lab = el('label', 'ch-rc-opt ' + (local ? 'is-local' : 'is-fastest'));
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'ch-rc-road';
    input.value = value;
    lab.appendChild(input);

    const head = el('span', 'ch-rc-head');
    const sw = el('span', 'ch-rc-sw');
    sw.setAttribute('aria-hidden', 'true');
    head.appendChild(sw);
    head.appendChild(el('span', 'ch-rc-name', local ? 'Local road' : 'Expressway'));
    // A caller with no saving to state passes no tag, rather than an empty pill.
    const tag = local ? o.save : 'Fastest';
    if (tag) head.appendChild(el('span', 'ch-rc-tag', tag));
    lab.appendChild(head);

    // One layout for both roads (owner, 2026-09-27): the price leads, then that road's own drive
    // time — no "+1h" difference, which read as a sum ("6h +1h").
    const fig = el('span', 'ch-rc-fig');
    fig.appendChild(el('span', 'ch-rc-big ch-rc-price', o.price));
    const t = el('span', 'ch-rc-alt');
    t.appendChild(el('span', 'ch-rc-time', o.time));
    fig.appendChild(t);
    lab.appendChild(fig);

    const stats = [o.km, local ? 'no tolls' : 'tolls included', o.extra].filter(Boolean).join(' · ');
    lab.appendChild(el('span', 'ch-rc-stats', stats));
    lab.appendChild(el('span', 'ch-rc-best', local ? "Best if you'd rather pay less" : 'Best for a flight or a tight schedule'));
    return lab;
  }

  function open(opts) {
    // Never stacks: a second offer while one is showing simply waits (as the card switch).
    if (current) return;
    opts = opts || {};
    ensureStyle();
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    const titleId = 'ch-rc-title-' + (++seq);

    const scrim = el('div', 'ch-rc-scrim');
    const dlg = el('div', 'ch-rc');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', titleId);

    const grab = el('span', 'ch-rc-grab');
    grab.setAttribute('aria-hidden', 'true');
    dlg.appendChild(grab);
    const x = el('button', 'ch-rc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    dlg.appendChild(x);
    const h = el('h2', 'ch-rc-title', opts.title || '');
    h.id = titleId;
    dlg.appendChild(h);
    if (opts.sub) dlg.appendChild(el('p', 'ch-rc-sub', opts.sub));

    const group = el('div', 'ch-rc-opts');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Road');
    const fast = option('fastest', opts.fastest || {}, false);
    const loc = option('no_tolls', opts.local || {}, true);
    group.appendChild(fast);
    group.appendChild(loc);
    dlg.appendChild(group);

    const foot = el('div', 'ch-rc-foot');
    // One action (owner, 2026-09-27: no "Decide later"). The ×, Escape and the scrim still close it
    // and keep the expressway.
    const primary = el('button', 'ch-rc-primary');
    primary.type = 'button';
    foot.appendChild(primary);
    dlg.appendChild(foot);
    scrim.appendChild(dlg);

    const radios = [fast.querySelector('input'), loc.querySelector('input')];
    const selected = () => (radios[1].checked ? 'no_tolls' : 'fastest');
    const sync = () => {
      primary.textContent = selected() === 'no_tolls' ? 'Use local road' : 'Use expressway';
      // :has() paints the chosen card; this class is the fallback for browsers without it.
      fast.classList.toggle('is-on', radios[0].checked);
      loc.classList.toggle('is-on', radios[1].checked);
    };
    radios[opts.selected === 'no_tolls' ? 1 : 0].checked = true;
    sync();
    group.addEventListener('change', sync);

    let closed = false;
    const close = (fn, arg) => {
      if (closed) return;
      closed = true;
      current = null;
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      if (scrim.parentNode) scrim.remove();
      // Deliberately no focus trap (as ch-map.js openExpanded); focus goes back where it was.
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
      if (typeof fn === 'function') fn(arg);
    };
    const dismiss = () => close(opts.onDismiss);
    // Captured on document and stopped there: while the popup is up, Escape is the popup's, and
    // the page's own Escape handlers (site.js's place menu, say) never see it.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } };

    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) dismiss(); });
    x.addEventListener('click', dismiss);
    primary.addEventListener('click', () => close(opts.onPick, selected()));

    current = close;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(scrim);
    void scrim.offsetWidth;          // commit the off-screen frame so the slide-up animates
    scrim.classList.add('is-in');
    radios[opts.selected === 'no_tolls' ? 1 : 0].focus();
  }

  function wasAsked(key) {
    try { return !!sessionStorage.getItem(ASKED + key); } catch (e) { return false; }
  }
  function markAsked(key) {
    try { sessionStorage.setItem(ASKED + key, '1'); } catch (e) { /* storage blocked: may ask again */ }
  }

  // 374 → '6h 14m', 300 → '5h', 45 → '45 min'.
  function fmtMinutes(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return r ? h + 'h ' + r + 'm' : h + 'h';
  }

  window.CH_ROUTE_CHOICE = { open, isOpen: () => !!current, wasAsked, markAsked, fmtMinutes };
})();
