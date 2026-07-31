/* ============================================================
   CEYLON HOP — shared site chrome + helpers (vanilla)
   ============================================================ */
(function(){
  const WA = 'https://wa.me/94779669662';

  // ---- SVG snippets ----
  const ICON = {
    wa:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 1 1 6.97 3.86zm4.52-6.16c-.25-.12-1.47-.72-1.69-.8-.23-.08-.39-.12-.56.13-.16.25-.64.8-.79.97-.14.16-.29.18-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.16.04-.31-.02-.43-.06-.12-.56-1.35-.76-1.85-.2-.48-.41-.42-.56-.43h-.48c-.16 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.16 1.75 2.67 4.25 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg>',
    arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    ig:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68A6.16 6.16 0 1 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 16 12a4 4 0 0 1-4 4zm6.41-10.4a1.44 1.44 0 1 0 1.44 1.44 1.44 1.44 0 0 0-1.44-1.44z"/></svg>',
    tiktok:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82a4.28 4.28 0 0 1-1.06-2.82h-3.3v12.6a2.34 2.34 0 1 1-2.34-2.34c.23 0 .46.04.67.1V9.98a5.66 5.66 0 0 0-.67-.04 5.66 5.66 0 1 0 5.66 5.66V9.01a7.52 7.52 0 0 0 4.4 1.4V7.1a4.28 4.28 0 0 1-3.36-1.28z"/></svg>',
    x:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.24 2H21l-6.56 7.5L22.5 22h-6.06l-4.74-6.2L6.2 22H3.44l7.02-8.03L1.5 2h6.22l4.29 5.67L18.24 2zm-1.06 18h1.68L7.92 3.9H6.12L17.18 20z"/></svg>',
    fb:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
  };
  window.ICON = ICON;

  // ---- Brand C mark (real Ceylon Hop logo glyph) ----
  window.CMARK_SRC = "img/ceylon-hop-c.png";
  // A cacheable file, not ~8KB of base64 inlined into every page (the generated route pages
  // carried it TWICE, about half their weight). The glyph is cropped to its bounding box so it
  // actually fills the 34px slot instead of sitting ~14px inside empty canvas.
  window.cmark = function(size=34, _color){
    return `<img class="cmark" src="${window.CMARK_SRC}" style="width:${size}px;height:${size}px;object-fit:contain;vertical-align:middle" alt="Ceylon Hop" aria-hidden="true">`;
  };

  // ---- Placeholder ----
  window.ph = function(label, cls='ph-photo', extra=''){
    return `<div class="ph ${cls}" ${extra}><span class="ph-label">${label}</span></div>`;
  };

  // ---- Header ----
  const NAVLINKS = [
    ['Plan a trip','plan.html'],
    ['Ride board','board.html'],
    ['Tours','tours.html'],
    ['Travel Guide','blog.html'],
    ['Why us','why.html'],
    ['About','about.html']
  ];
  window.mountHeader = function(active='', onDark=false, showCta=true){
    const host=document.querySelector('[data-header]'); if(!host) return;
    const links = NAVLINKS.map(([t,h])=>`<a href="${h}" class="${active===h?'active':''}">${t}</a>`).join('');
    const mlinks = NAVLINKS.map(([t,h])=>`<a href="${h}">${t}</a>`).join('');
    const ctaBtn = '';
    const mCtaBtn = '';
    host.innerHTML = `
    <header class="nav ${onDark?'on-dark':''}" data-nav>
      <div class="wrap nav-inner">
        <a href="index.html" class="brand">${cmark(34,'currentColor')}<span>Ceylon Hop</span></a>
        <nav class="nav-links">${links}</nav>
        <div class="nav-cta">
          ${ctaBtn}
          <button class="btn nav-burger" aria-label="Menu" data-burger><span></span><span></span><span></span></button>
        </div>
      </div>
    </header>
    <div class="mobile-menu" data-mobile>${mlinks}${mCtaBtn}</div>`;
    const nav=host.querySelector('[data-nav]');
    const onScroll=()=>nav.classList.toggle('scrolled', window.scrollY>20);
    onScroll();
    window.addEventListener('scroll',onScroll,{passive:true});
    document.addEventListener('scroll',onScroll,{passive:true});
    const burger=host.querySelector('[data-burger]'), menu=host.querySelector('[data-mobile]');
    burger.addEventListener('click',()=>menu.classList.toggle('open'));
  };

  // ---- Footer ----
  window.mountFooter = function(showCta=true){
    const host=document.querySelector('[data-footer]'); if(!host) return;
    const cta = showCta ? `
    <section class="foot-cta">
      <image-slot id="foot-cta-photo" shape="rect" src="img/cta-nine-arch.jpg" placeholder="Drop a photo — nine-arch bridge train through jungle"></image-slot>
      <div class="wrap">
        <div class="sun" style="margin:0 auto 10px">${cmark(64,'#fff')}</div>
        <h2 style="color:#fff;max-width:20ch;margin:0 auto .6rem">Your whole route, planned in minutes</h2>
        <p style="color:rgba(255,255,255,.85);max-width:46ch;margin:0 auto 1.6rem">Drop in your stops, set your nights, and see one fixed price for every transfer &mdash; or message us and we&rsquo;ll plan it together.</p>
        <div class="flex gap" style="justify-content:center;flex-wrap:wrap">
          <a href="plan.html" class="btn btn-light btn-lg">Open the trip planner</a>
          <a href="${WA}" class="btn btn-wa btn-lg">${ICON.wa} Chat on WhatsApp</a>
        </div>
      </div>
    </section>` : '';
    host.innerHTML = cta + `
    <footer class="footer">
      <div class="wrap foot-grid">
        <div>
          <a href="index.html" class="brand" style="color:#fff">${cmark(34,'#fff')}<span>Ceylon Hop</span></a>
          <p style="margin-top:14px;color:#9a968d;max-width:30ch">Private transfers &amp; shared rides that make exploring Sri Lanka easy, social and stress-free.</p>
          <div class="soc" style="margin-top:18px">
            <a href="https://www.instagram.com/ceylonhop" aria-label="Instagram" target="_blank" rel="noopener noreferrer">${ICON.ig}</a><a href="https://www.facebook.com/p/Ceylon-Hop-61561725411635/" aria-label="Facebook" target="_blank" rel="noopener noreferrer">${ICON.fb}</a>
          </div>
        </div>
        <div><h4>Explore</h4><ul>
          <li><a href="index.html#book">Get a transfer quote</a></li><li><a href="plan.html">Plan a multi-stop trip</a></li>
          <li><a href="tours.html">Ready-made tours</a></li><li><a href="blog.html">Travel guide</a></li></ul></div>
        <div><h4>Company</h4><ul>
          <li><a href="why.html">Why Hop With Us</a></li><li><a href="about.html">About</a></li>
          <li><a href="blog.html">Travel blog</a></li><li><a href="${WA}">Contact</a></li></ul></div>
        <div><h4>Get in touch</h4><ul>
          <li><a href="${WA}">WhatsApp +94 77 966 9662</a></li><li><a href="mailto:hello@ceylonhop.com">hello@ceylonhop.com</a></li>
          <li style="margin-top:6px"><span class="pill pill-saffron">★ Tripadvisor — Excellent</span></li></ul></div>
      </div>
      <div class="wrap foot-bottom">
        <span>© ${new Date().getFullYear()} Ceylon Hop. All rights reserved.</span>
        <span><a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html#refunds">Cancellation policy</a> · <a href="credits.html">Photo credits</a></span>
      </div>
    </footer>`;
  };

  // ---- Breadcrumbs ----
  // Usage: mountBreadcrumbs([['Home','index.html'],['Routes','routes.html'],['Ella']])
  // Last item (no href) is the current page. Renders into [data-breadcrumbs].
  window.mountBreadcrumbs = function(trail){
    const host=document.querySelector('[data-breadcrumbs]'); if(!host||!trail||!trail.length) return;
    const sep='<svg class="bc-sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    const items=trail.map((it,i)=>{
      const last=i===trail.length-1;
      const [label,href]=it;
      if(last||!href) return `<span class="bc-cur" aria-current="page">${label}</span>`;
      return `<a href="${href}">${label}</a>`;
    }).join(sep);
    host.innerHTML=`<nav class="breadcrumbs wrap" aria-label="Breadcrumb">${items}</nav>`;
  };

  // ---- WhatsApp FAB (retired) ----
  // The floating button was removed by request; WhatsApp is still reachable
  // from the footer, search help card and the booking summary. Kept as a
  // no-op so existing calls don't error, and we clean up any stray FAB.
  window.mountWA = function(){
    document.querySelectorAll('.wa-fab').forEach(el=>el.remove());
  };

  // ---- Shared place helpers (componentized) ----
  // One source of truth for the destination list used by booking + planner.
  window.placeNames = function(){
    const T=window.TRANSFERS; const set=new Set();
    if(T){ T.PLACES.forEach(p=>set.add(p.name)); (T.EXTRA||[]).forEach(e=>set.add(e[0])); }
    return [...set];
  };
  function nPlace(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); }
  window.placeSourceLabel = function(source){
    if(source==='google') return 'Google';
    return source==='known' ? 'Popular Route' : 'Popular place';
  };
  window.resolvePlaceInput = function(value){
    const T=window.TRANSFERS;
    const text=String(value||'').trim();
    if(!T || !text) return { id:null, name:text, known:false };
    const direct=T.place(text);
    if(direct) return { id:direct.id, name:direct.name, known:true };
    const found=T.PLACES.find(p=>nPlace(p.name)===nPlace(text));
    if(found) return { id:found.id, name:found.name, known:true };
    const extra=(T.EXTRA||[]).find(e=>nPlace(e[0])===nPlace(text));
    return extra ? { id:null, name:extra[0], known:false, popular:true } : { id:null, name:text, known:false };
  };
  window.attachLocalPlaceAutocomplete = function(input, opts={}){
    const T=window.TRANSFERS; if(!input || !T || input.dataset.placeAc==='1') return;
    input.dataset.placeAc='1';
    input.setAttribute('autocomplete','off');
    input.setAttribute('spellcheck','false');
    const limit=opts.limit||6;
    let menu=null, items=[], active=-1, seq=0, committed=false, openedAt=0;
    function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function close(reset=true, invalidate=true){ if(menu) menu.remove(); menu=null; if(reset) active=-1; if(invalidate) seq++; }
    function choose(item){
      committed=true;
      seq++;
      input.value=item.label;
      input.dataset.placeId=item.id||'';
      input.dataset.placeSource=item.source||'';
      close(false);
      input.dispatchEvent(new Event('change',{bubbles:true}));
      if(typeof opts.onPick==='function') opts.onPick(item, input);
    }
    function mergeSuggestions(local, google){
      const seen=new Set();
      const out=[];
      function add(p){
        const key=nPlace(p.label || p.main);
        if(!key || seen.has(key)) return;
        seen.add(key); out.push(p);
      }
      local.forEach(add);
      google.forEach(add);
      return out.slice(0,limit);
    }
    function shouldAskGoogle(q, local){
      if(!window.CH_MAP || !window.CH_MAP.suggest || !window.CEYLON_MAPS_KEY || q.length<2) return false;
      const exactLocal=local.some(p=>p.source==='known' && nPlace(p.label)===nPlace(q));
      const oneWord=!/\s/.test(q);
      return !exactLocal && !(oneWord && local.length>=3);
    }
    function paint(nextItems, opts={}){
      close(false, false);
      items=nextItems || [];
      if(!items.length && !opts.loading) return;
      menu=document.createElement('div');
      menu.className='place-menu';
      menu.setAttribute('role','listbox');
      menu.innerHTML=items.map((p,i)=>`<button type="button" class="place-option${i===active?' hi':''}" role="option"><span>${esc(p.label)}</span><small>${esc(window.placeSourceLabel(p.source))}</small></button>`).join('')+
        (opts.loading ? `<button type="button" class="place-option loading" disabled aria-disabled="true"><span>Searching Google…</span><small>Google</small></button>` : '');
      const r=input.getBoundingClientRect();
      const menuW=Math.min(r.width, window.innerWidth-24);
      const left=Math.min(Math.max(12,r.left), window.innerWidth-menuW-12);
      const below=r.bottom+6;
      const maxBelow=window.innerHeight-below-12;
      const preferredH=Math.min(280, Math.max(96, items.length*50+16));
      const top=maxBelow>=Math.min(180, preferredH) ? below : Math.max(12, r.top-6-preferredH);
      menu.style.left=left+'px';
      menu.style.top=top+'px';
      menu.style.width=menuW+'px';
      menu.style.maxHeight=Math.max(96, Math.min(280, window.innerHeight-top-12))+'px';
      menu.addEventListener('mousedown',e=>e.preventDefault());
      menu.addEventListener('click',e=>{
        const btn=e.target.closest('.place-option'); if(!btn) return;
        if(btn.disabled || btn.classList.contains('loading')) return;
        const idx=[...menu.querySelectorAll('.place-option')].indexOf(btn);
        if(items[idx]) choose(items[idx]);
      });
      document.body.appendChild(menu);
      openedAt=Date.now();
    }
    function refresh(){
      const q=input.value.trim();
      if(!q){ close(); return; }
      const mySeq=++seq;
      committed=false;
      active=-1;
      const local=(T.placeSuggestions?T.placeSuggestions(q,limit):[]).filter(Boolean);
      if(shouldAskGoogle(q, local)){
        paint(local, { loading:true });
        window.CH_MAP.suggest(q).then(list=>{
          if(mySeq!==seq || committed || document.activeElement!==input) return;
          const google=(list||[]).map(s=>({
            label:s.text || s.main,
            main:s.main || s.text,
            secondary:s.secondary,
            source:'google',
            id:null,
            item:s
          }));
          if(google.length) paint(mergeSuggestions(local, google));
          else paint(local);
        }).catch(()=>{});
      } else {
        paint(local);
      }
    }
    input.addEventListener('focus',refresh);
    input.addEventListener('input',()=>{ input.dataset.placeId=''; input.dataset.placeSource=''; refresh(); if(typeof opts.onInput==='function') opts.onInput(input); });
    input.addEventListener('change',()=>{ const r=window.resolvePlaceInput(input.value); input.dataset.placeId=r.id||''; input.dataset.placeSource=r.known?'known':(r.popular?'extra':''); if(typeof opts.onInput==='function') opts.onInput(input); });
    input.addEventListener('keydown',e=>{
      if(!menu) return;
      if(e.key==='ArrowDown'){ e.preventDefault(); active=Math.min(active+1,items.length-1); paint(items); }
      else if(e.key==='ArrowUp'){ e.preventDefault(); active=Math.max(active-1,0); paint(items); }
      else if(e.key==='Enter' && active>=0 && items[active]){ e.preventDefault(); choose(items[active]); }
      else if(e.key==='Escape'){ close(); }
    });
    input.addEventListener('blur',()=>setTimeout(close,160));
    window.addEventListener('scroll',()=>{ if(Date.now()-openedAt>250) close(); },true);
    window.addEventListener('wheel',()=>close(),{passive:true});
    window.addEventListener('touchmove',()=>close(),{passive:true});
  };
  // Fill a <datalist> with destinations. variants=true adds “— your hotel” etc.
  window.mountPlacesDatalist = function(id, variants){
    const dl=document.getElementById(id); if(!dl) return;
    let names=placeNames();
    if(variants){ const ex=[]; names.forEach(n=>{ ex.push(n); ex.push(n+' \u2014 your hotel'); ex.push(n+' \u2014 town centre'); }); names=ex; }
    if(variants) names.push('Bandaranaike Intl Airport (CMB) \u2014 Arrivals');
    dl.innerHTML=[...new Set(names)].map(s=>`<option value="${s}">`).join('');
  };
  // Reusable labelled field + select markup helpers.
  window.fieldHTML = function(label, inner){ return `<div class="field"><label>${label}</label>${inner}</div>`; };
  window.selectHTML = function(id, opts, attrs=''){
    return `<select id="${id}" ${attrs}>`+opts.map(o=>`<option value="${o.v}" ${o.sel?'selected':''} ${o.dis?'disabled':''}>${o.t}</option>`).join('')+`</select>`;
  };
  // 1-hour increment time options across the whole day (00:00–23:00).
  window.hourlyTimes = function(){
    const out=[]; for(let h=0;h<24;h++){ out.push((h<10?'0':'')+h+':00'); } return out;
  };

  // ---- Scroll reveal ----
  window.initReveal = function(){
    const els=document.querySelectorAll('.reveal');
    if(!('IntersectionObserver' in window)){els.forEach(e=>e.classList.add('in'));return;}
    const io=new IntersectionObserver((ents)=>{
      ents.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});
    },{threshold:.12, rootMargin:'0px 0px -8% 0px'});
    els.forEach(e=>io.observe(e));
  };

  // ---- Boot ----
  window.initChrome = function(opts={}){
    mountHeader(opts.active||'', opts.onDark||false, opts.navCta!==false);
    mountFooter(opts.footerCta!==false);
    if(opts.breadcrumbs) mountBreadcrumbs(opts.breadcrumbs);
    mountWA();
    initReveal();
    // Every page gets animated <details> — the FAQ is the only user today, but this is the
    // right place for it: any page that grows one later is covered without a second thought.
    if(window.CH && CH.motion) CH.motion.details();
  };
})();

/* ============================================================
   CH.motion — the four ways this site changes shape or value
   ------------------------------------------------------------
   Every one of these replaced a snap. Cards appeared at full size mid-list,
   prices swapped instantly when the vehicle changed, and switching Single →
   Multi-stop resized the booking card in a single frame. The content was
   right; it just arrived without ever being on its way, which reads as the
   page redrawing rather than responding.

   Measured, not guessed: heights come from the real laid-out element, so
   nothing here needs a hard-coded size and no card can be clipped by one.
   All four no-op under prefers-reduced-motion — the end state is applied
   immediately, never skipped.
   ============================================================ */
(function(){
  const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(.22,.75,.3,1)';   // one curve for the whole site: quick out, soft landing

  /* Grow a just-inserted element from nothing to its natural height. The element must
     already be in the DOM and laid out — we read the height it WANTS, then animate to it,
     so a two-line card and a six-line card each take their own correct size. */
  function enter(el, opts){
    opts = opts || {};
    if(!el || reduce()) return Promise.resolve();
    const cs = getComputedStyle(el);
    const h = el.getBoundingClientRect().height;
    const mb = cs.marginBottom;
    const prev = el.style.cssText;
    el.style.overflow = 'hidden';   // content must not spill while the box is shorter than it
    const anim = el.animate([
      { height:'0px', opacity:0, marginBottom:'0px', transform:'translateY(-4px)' },
      { height:h+'px', opacity:1, marginBottom:mb, transform:'none' },
    ], { duration: opts.duration || 360, easing: EASE });
    return anim.finished.catch(()=>{}).then(()=>{ el.style.cssText = prev; });
  }

  /* Collapse an element away, then hand back so the caller can drop it from state.
     Mirror of enter() — a card that grows in and then vanishes in one frame is worse
     than one that never animated at all, because the pair draws attention to the cut. */
  function exit(el, opts){
    opts = opts || {};
    if(!el || reduce()) return Promise.resolve();
    const cs = getComputedStyle(el);
    const h = el.getBoundingClientRect().height;
    el.style.overflow = 'hidden';
    const anim = el.animate([
      { height:h+'px', opacity:1, marginBottom:cs.marginBottom, transform:'none' },
      { height:'0px', opacity:0, marginBottom:'0px', transform:'translateY(-4px)' },
    ], { duration: opts.duration || 260, easing: EASE });
    return anim.finished.catch(()=>{});
  }

  /* Animate a container across a change that alters its height. `mutate` does the real
     work (swap markup, add a field); we measure before and after and travel between.
     Used where the change is a RESIZE rather than an arrival — switching the booking card
     from one transfer to a multi-stop trip, where the card itself persists. */
  function resize(el, mutate, opts){
    opts = opts || {};
    if(!el || reduce()){ mutate(); return Promise.resolve(); }
    const from = el.getBoundingClientRect().height;
    mutate();
    const to = el.getBoundingClientRect().height;
    if(Math.abs(to-from) < 1) return Promise.resolve();
    const prev = el.style.cssText;
    el.style.overflow = 'hidden';
    const anim = el.animate(
      [{ height:from+'px' }, { height:to+'px' }],
      { duration: opts.duration || 320, easing: EASE }
    );
    return anim.finished.catch(()=>{}).then(()=>{ el.style.cssText = prev; });
  }

  /* Count a price from its old value to its new one. Takes the two rendered STRINGS and
     tweens every number inside them in step, so "$70–$85" moves as a range and "$72.50"
     keeps its cents — no format rules encoded here, the strings carry them.
     Falls back to a plain swap when the shapes differ (e.g. "$—" → "$72.50"), because
     there is no sensible number to count from. */
  const NUM = /\d[\d,]*\.?\d*/g;
  function tweenNumber(el, fromText, toText, opts){
    opts = opts || {};
    if(!el) return;
    if(reduce() || fromText == null){ el.textContent = toText; return; }
    const a = String(fromText).match(NUM), b = String(toText).match(NUM);
    if(!a || !b || a.length !== b.length){ el.textContent = toText; return; }
    const av = a.map(n=>parseFloat(n.replace(/,/g,'')));
    const bv = b.map(n=>parseFloat(n.replace(/,/g,'')));
    if(av.every((v,i)=>v===bv[i])){ el.textContent = toText; return; }
    // A stalled tween must never be able to leave a WRONG PRICE on screen. requestAnimationFrame
    // does not run in a background tab, so a traveller who switches tabs mid-count and comes
    // back to a re-rendered page could otherwise be looking at the old vehicle's figure. Two
    // guards: don't start a count we know can't run, and back every count with a timer that
    // writes the true value regardless of whether a single frame ever fired.
    if(document.hidden){ el.textContent = toText; return; }
    const dp = b.map(n=>(n.split('.')[1]||'').length);
    const dur = opts.duration || 420, t0 = performance.now();
    if(el._chTween) cancelAnimationFrame(el._chTween);
    if(el._chTweenT) clearTimeout(el._chTweenT);
    const land = () => {
      if(el._chTween) cancelAnimationFrame(el._chTween);
      el._chTween = null; el._chTweenT = null;
      el.textContent = toText;                 // the exact string, never a rounded rebuild of it
    };
    el._chTweenT = setTimeout(land, dur + 80); // backstop: the figure is correct even with zero frames
    (function frame(now){
      const p = Math.min(1, (now-t0)/dur);
      const e = 1-Math.pow(1-p, 3);            // ease-out cubic — fast start, settles on the figure
      let i = 0;
      el.textContent = toText.replace(NUM, () => {
        const v = av[i] + (bv[i]-av[i])*e, d = dp[i];
        i++;
        return v.toFixed(d);
      });
      if(p < 1) el._chTween = requestAnimationFrame(frame);
      else land();
    })(t0);
  }

  window.CH = window.CH || {};
  /* Upgrade native <details> so the panel travels open instead of snapping. The FAQ's summary
     marker already rotates on a .2s transition — someone intended this to feel like opening —
     but the panel itself appeared in one frame, so the icon animated and the content did not.

     Intercepting the summary click (rather than listening for `toggle`, which fires after the
     box has already resized) lets resize() measure both states and travel between them. Under
     reduced motion we don't preventDefault at all, so the browser's own instant behaviour and
     all of its keyboard/AT semantics are left completely untouched. */
  function details(root){
    (root || document).querySelectorAll('details').forEach(function(d){
      if(d._chDetails) return;
      d._chDetails = true;
      const sum = d.querySelector('summary');
      if(!sum) return;
      sum.addEventListener('click', function(e){
        if(reduce()) return;                       // native open/close, no interception
        e.preventDefault();                        // we own the state change for this gesture
        resize(d, function(){ d.open = !d.open; }, { duration: 260 });
      });
    });
  }

  window.CH.motion = { enter, exit, resize, tweenNumber, details, reduce, EASE };
})();
