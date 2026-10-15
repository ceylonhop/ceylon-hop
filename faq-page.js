/* ============================================================
   CEYLON HOP — travel FAQ page
   ============================================================
   Five small behaviours, no dependencies, classic script:
     1. reveal-on-scroll (the site's initReveal(), same timing)
     2. deep link: #<topic>-<item> opens that question on load
     3. copy link: writes the absolute URL, sets the hash without scrolling
     4. scroll-spy: marks the current topic in the index (desktop column)
     5. Topics pill: shows once the index has scrolled off, jumps back to it
   Every animation is CSS; this file only toggles classes. Reduced motion is honoured by
   the stylesheet and by the scroll behaviour below.
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var behavior = reduce ? 'auto' : 'smooth';

  // 1. Reveal
  var els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); }
  else {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { io.observe(e); });
  }

  // 2. Deep link
  function openHash() {
    var id = location.hash.slice(1);
    if (!id) return;
    var t = document.getElementById(id);
    if (!t) return;
    if (t.tagName === 'DETAILS') t.open = true;
    t.scrollIntoView({ block: 'start', behavior: behavior });
  }
  openHash();
  window.addEventListener('hashchange', openHash);

  // 3. Copy link
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('button.cl'), function (b) {
    b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', function () {
      var url = b.getAttribute('data-link');
      var label = b.querySelector('span');
      copy(url).then(function () {
        history.replaceState(null, '', '#' + url.split('#')[1]);
        b.classList.add('done'); label.textContent = 'Copied';
        setTimeout(function () { b.classList.remove('done'); label.textContent = 'Copy link'; }, 1500);
      }, function () { label.textContent = 'Press ⌘C'; });
    });
  });

  // 4. Scroll-spy
  var index = document.getElementById('topics');
  var links = index ? Array.prototype.slice.call(index.querySelectorAll('a[href^="#"]')) : [];
  function light(id) {
    links.forEach(function (a) { a.parentNode.classList.toggle('on', a.getAttribute('href') === '#' + id); });
  }
  if (links.length && 'IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) light(e.target.id); });
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); })
      .filter(Boolean).forEach(function (s) { spy.observe(s); });
  }

  // 5. Topics pill
  var pill = document.getElementById('pill');
  if (pill && index && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (ents) {
      var e = ents[0];
      pill.classList.toggle('on', !e.isIntersecting && e.boundingClientRect.top < 0);
    }, { threshold: 0 }).observe(index);
    pill.addEventListener('click', function (ev) {
      ev.preventDefault();
      index.scrollIntoView({ block: 'start', behavior: behavior });
    });
  }
})();
