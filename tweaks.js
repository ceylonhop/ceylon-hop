/* ============================================================
   CEYLON HOP — Tweaks applier (vanilla, loads on every page)
   Applies persisted design tweaks as CSS variables site-wide.
   ============================================================ */
(function(){
  // Mark that JS is available as early as possible (tweaks.js loads in <head>
  // on every page) so CSS can gate scroll-reveal — content stays visible if
  // scripts ever fail to run.
  try{document.documentElement.classList.add('js');}catch(e){}
  const KEY='ceylonhop_tweaks';
  const ACCENTS={
    teal:['#0AB9B6','#08938f'],
    blue:['#3a9fc0','#2d7e93'],
    saffron:['#e7920f','#a96b04']
  };
  const CTAS={tomato:'#EC3A24',saffron:'#e7920f',teal:'#0AB9B6',ink:'#2C2A2B'};
  const FONTS={
    'Newsreader':"'Newsreader', Georgia, serif",
    'Bricolage Grotesque':"'Bricolage Grotesque', system-ui, sans-serif",
    'Spectral':"'Spectral', Georgia, serif"
  };
  const RAD={sharp:0.34,rounded:1,pill:1.5};
  const HEADLINES={
    'Door to door':[
      '<span class="hl-swash">Anywhere</span> in&nbsp;Sri&nbsp;Lanka,<br>door to&nbsp;door.',
      'Book a <b>private</b> AC car or van between any two points — your schedule, a fixed price. On popular routes you can <b>share a seat</b> and pay a fraction.'],
    'Private comfort':[
      '<span class="hl-swash">Private</span> comfort,<br>shared-ride prices.',
      'Door-to-door in your own AC car or van at a <b>fixed price</b>. Travelling a popular route? <b>Share a seat</b> and pay a fraction of a private driver.'],
    'Your call':[
      'Private when you want.<br><span class="hl-swash">Shared</span> when you don’t.',
      'Book a <b>private</b> transfer between any two points, or hop a seat on our <b>daily shared</b> service and meet fellow travelers — your call.']
  };

  function loadFont(name){
    if(name==='Newsreader'||!FONTS[name])return;
    const id='tf-'+name.replace(/\s/g,'');
    if(document.getElementById(id))return;
    const l=document.createElement('link');l.rel='stylesheet';l.id=id;
    l.href='https://fonts.googleapis.com/css2?family='+name.replace(/\s/g,'+')+':wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  }
  function apply(t){
    if(!t)return;
    const r=document.documentElement.style;
    if(t.accent&&ACCENTS[t.accent]){r.setProperty('--accent',ACCENTS[t.accent][0]);r.setProperty('--accent-deep',ACCENTS[t.accent][1]);}
    if(t.cta&&CTAS[t.cta])r.setProperty('--cta',CTAS[t.cta]);
    if(t.font&&FONTS[t.font]){r.setProperty('--display',FONTS[t.font]);loadFont(t.font);}
    if(t.radius&&RAD[t.radius]!=null){const m=RAD[t.radius];r.setProperty('--r-lg',(24*m)+'px');r.setProperty('--r',(16*m)+'px');r.setProperty('--r-sm',(10*m)+'px');r.setProperty('--r-xl',(34*m)+'px');}
    if(t.headline&&HEADLINES[t.headline]){
      const h=document.querySelector('[data-tweak-h1]'), l=document.querySelector('[data-tweak-lead]');
      if(h)h.innerHTML=HEADLINES[t.headline][0];
      if(l)l.innerHTML=HEADLINES[t.headline][1];
    }
    if(t.hero&&window.__heroVariant)window.__heroVariant(t.hero);
  }
  window.__tweaks={
    read:()=>{try{return JSON.parse(localStorage.getItem(KEY))||{}}catch(e){return{}}},
    save:(t)=>localStorage.setItem(KEY,JSON.stringify(t)),
    apply
  };
  apply(window.__tweaks.read());
})();
