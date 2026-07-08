/* ============================================================
   CEYLON HOP — lightweight custom date picker
   Replaces the native <input type=date> chrome with a branded,
   dd-Mon-yyyy popover calendar. Keeps the underlying input so
   existing change-handlers (search/route/plan) keep working.
   Opt in with: <input type="date" data-datepicker data-placeholder="Add a date">
   ============================================================ */
(function(){
  const MN=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW=['Su','Mo','Tu','We','Th','Fr','Sa'];
  const CAL='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>';

  const fmt=d=>d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  function parseISO(s){ if(!s) return null; const p=s.split('-').map(Number); if(!p[0]) return null; return new Date(p[0],p[1]-1,p[2]); }
  function addMonths(d,n){ return new Date(d.getFullYear(), d.getMonth()+n, d.getDate()); }
  const monthStart=d=>new Date(d.getFullYear(),d.getMonth(),1);

  function enhance(input){
    if(input.__dp) return; input.__dp=true;
    const today=new Date(); today.setHours(0,0,0,0);
    const tomorrow=new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    const minDate = input.dataset.min ? parseISO(input.dataset.min) : tomorrow;
    const maxDate = input.dataset.max ? parseISO(input.dataset.max) : addMonths(today, 12);
    input.min = iso(minDate);
    input.max = iso(maxDate);
    const placeholder = input.getAttribute('data-placeholder') || 'Select a date';
    let sel = parseISO(input.value);
    let view = monthStart(sel||today);

    const wrap=document.createElement('div'); wrap.className='dp';
    const btn=document.createElement('button'); btn.type='button'; btn.className='dp-btn';
    btn.setAttribute('aria-haspopup','dialog'); btn.setAttribute('aria-expanded','false');
    if(input.getAttribute('aria-label')) btn.setAttribute('aria-label', input.getAttribute('aria-label'));
    const pop=document.createElement('div'); pop.className='dp-pop'; pop.hidden=true; pop.setAttribute('role','dialog'); pop.setAttribute('aria-label','Choose a date');

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input); wrap.appendChild(btn);
    // portal the popover to <body> so it escapes any ancestor stacking
    // context / overflow clip (otherwise it hides under later sections).
    document.body.appendChild(pop);
    input.type='hidden';

    function renderBtn(){
      btn.innerHTML = CAL + `<span>${sel?fmt(sel):placeholder}</span>`;
      btn.classList.toggle('empty', !sel);
    }
    function renderPop(){
      const y=view.getFullYear(), m=view.getMonth();
      const first=new Date(y,m,1).getDay();
      const days=new Date(y,m+1,0).getDate();
      const prevOff = monthStart(view) <= monthStart(minDate);
      const nextOff = monthStart(new Date(view.getFullYear(), view.getMonth()+1, 1)) > monthStart(maxDate);
      let h=`<div class="dp-head"><button type="button" class="dp-nav" data-d="-1" ${prevOff?'disabled':''} aria-label="Previous month">‹</button><b>${MN[m]} ${y}</b><button type="button" class="dp-nav" data-d="1" ${nextOff?'disabled':''} aria-label="Next month">›</button></div><div class="dp-grid">`;
      DOW.forEach(d=>h+=`<span class="dp-dow">${d}</span>`);
      for(let i=0;i<first;i++) h+='<span></span>';
      for(let d=1;d<=days;d++){
        const date=new Date(y,m,d); const off=date<minDate || date>maxDate; const on=sel&&date.getTime()===sel.getTime();
        h+=`<button type="button" class="dp-day${off?' off':''}${on?' sel':''}" ${off?'disabled':''} data-day="${d}">${d}</button>`;
      }
      pop.innerHTML = h+'</div>';
    }
    // position the portaled popover against the button, flipping above when
    // there isn't room below, and clamping inside the viewport horizontally.
    function place(){
      const r=btn.getBoundingClientRect();
      const vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
      const pw=pop.offsetWidth, ph=pop.offsetHeight;
      let top=r.bottom+8;
      if(top+ph>vh-8 && r.top-8-ph>8) top=r.top-8-ph;     // flip above
      top=Math.max(8, Math.min(top, vh-8-ph));
      let left=r.left;
      if(left+pw>vw-8) left=vw-8-pw;
      left=Math.max(8, left);
      pop.style.top=top+'px'; pop.style.left=left+'px';
    }
    function open(){ renderPop(); pop.hidden=false; place(); btn.setAttribute('aria-expanded','true'); document.addEventListener('mousedown',onDoc); document.addEventListener('keydown',onKey); window.addEventListener('scroll',place,true); window.addEventListener('resize',place); }
    function close(){ pop.hidden=true; btn.setAttribute('aria-expanded','false'); document.removeEventListener('mousedown',onDoc); document.removeEventListener('keydown',onKey); window.removeEventListener('scroll',place,true); window.removeEventListener('resize',place); }
    function onDoc(e){ if(!wrap.contains(e.target) && !pop.contains(e.target)) close(); }
    function onKey(e){ if(e.key==='Escape'){ close(); btn.focus(); } }

    btn.addEventListener('click',()=>{ pop.hidden?open():close(); });
    pop.addEventListener('click',e=>{
      const nav=e.target.closest('.dp-nav');
      if(nav){ view=new Date(view.getFullYear(),view.getMonth()+Number(nav.dataset.d),1); renderPop(); place(); return; }
      const day=e.target.closest('.dp-day');
      if(day && !day.disabled){
        sel=new Date(view.getFullYear(),view.getMonth(),Number(day.dataset.day));
        input.value=iso(sel);
        input.dispatchEvent(new Event('change',{bubbles:true}));
        renderBtn(); close(); btn.focus();
      }
    });
    renderBtn();
  }
  window.enhanceDate=enhance;
  function init(){ document.querySelectorAll('input[type=date][data-datepicker]').forEach(enhance); }
  if(document.readyState!=='loading') init(); else document.addEventListener('DOMContentLoaded',init);
})();
