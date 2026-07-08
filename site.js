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

  // ---- Brand C mark (original simple sunburst badge) ----
  window.cmark = function(size=34, color='var(--accent)'){
    return `<svg class="cmark" viewBox="0 0 48 48" style="width:${size}px;height:${size}px" aria-hidden="true">
      <g stroke="${color}" stroke-width="2.4" stroke-linecap="round">
        <line x1="24" y1="3" x2="24" y2="9"/><line x1="38" y1="6" x2="35" y2="11"/>
        <line x1="45" y1="18" x2="40" y2="20"/><line x1="10" y1="6" x2="13" y2="11"/>
        <line x1="3" y1="18" x2="8" y2="20"/>
      </g>
      <path d="M37 17a15 15 0 1 0 0 16" fill="none" stroke="${color}" stroke-width="6.4" stroke-linecap="round"/>
    </svg>`;
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
        <span><a href="#">Terms</a> · <a href="#">Privacy</a> · <a href="#">Cancellation policy</a></span>
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
    let menu=null, items=[], active=-1, seq=0;
    function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function close(reset=true){ if(menu) menu.remove(); menu=null; if(reset) active=-1; }
    function choose(item){
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
    function paint(nextItems){
      close(false);
      items=nextItems || [];
      if(!items.length) return;
      menu=document.createElement('div');
      menu.className='place-menu';
      menu.setAttribute('role','listbox');
      menu.innerHTML=items.map((p,i)=>`<button type="button" class="place-option${i===active?' hi':''}" role="option"><span>${esc(p.label)}</span><small>${esc(window.placeSourceLabel(p.source))}</small></button>`).join('');
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
        const idx=[...menu.querySelectorAll('.place-option')].indexOf(btn);
        if(items[idx]) choose(items[idx]);
      });
      document.body.appendChild(menu);
    }
    function refresh(){
      const q=input.value.trim();
      if(!q){ close(); return; }
      const mySeq=++seq;
      active=-1;
      const local=(T.placeSuggestions?T.placeSuggestions(q,limit):[]).filter(Boolean);
      paint(local);
      if(shouldAskGoogle(q, local)){
        window.CH_MAP.suggest(q).then(list=>{
          if(mySeq!==seq) return;
          const google=(list||[]).map(s=>({
            label:s.text || s.main,
            main:s.main || s.text,
            secondary:s.secondary,
            source:'google',
            id:null,
            item:s
          }));
          if(google.length) paint(mergeSuggestions(local, google));
        }).catch(()=>{});
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
