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
  window.CMARK_SRC = "data:image/png;base64,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";
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
      <image-slot id="foot-cta-photo" shape="rect" placeholder="Drop a photo — nine-arch bridge train through jungle"></image-slot>
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
            <a href="#" aria-label="Instagram">${ICON.ig}</a><a href="#" aria-label="TikTok">${ICON.tiktok}</a>
            <a href="#" aria-label="X">${ICON.x}</a><a href="#" aria-label="Facebook">${ICON.fb}</a>
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
        <span><a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a> · <a href="terms.html#refunds">Cancellation policy</a></span>
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
  };
})();
