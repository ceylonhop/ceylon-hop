/* ============================================================
   CEYLON HOP — destination guide page
   ============================================================
   Four small behaviours, no dependencies, classic script:
     1. reveal-on-scroll (the site's initReveal(), same timing)
     2. jump nav: smooth scroll under the sticky bar + scroll-spy on the chips
     3. FAQ tabs
     4. Eat & stay "More" — expands a card's summary in place
   Every animation is CSS; this file only toggles classes. Reduced motion is honoured by
   the stylesheet and by the scroll behaviour below.
   ============================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. Reveal
  var els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); }
  else {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    els.forEach(function (e) { io.observe(e); });
  }

  // 2. Jump nav
  var jump = document.getElementById('jump');
  var links = jump ? Array.prototype.slice.call(jump.querySelectorAll('a')) : [];
  function light(a) {
    links.forEach(function (l) { l.classList.toggle('on', l === a); });
    if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
  links.forEach(function (a) {
    a.addEventListener('click', function (ev) {
      var t = document.querySelector(a.getAttribute('href'));
      if (!t) return;
      ev.preventDefault();
      var y = t.getBoundingClientRect().top + window.scrollY - jump.getBoundingClientRect().height - 12;
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
      light(a);
    });
  });
  if (links.length && 'IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = '#' + e.target.id;
        links.forEach(function (l) { if (l.getAttribute('href') === id) light(l); });
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    links.map(function (a) { return document.querySelector(a.getAttribute('href')); })
      .filter(Boolean).forEach(function (s) { spy.observe(s); });
  }

  // 3. FAQ tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#qtabs button'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.groups .group'));
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var i = +t.getAttribute('data-g');
      tabs.forEach(function (x) { x.classList.toggle('on', x === t); });
      groups.forEach(function (g, j) { g.classList.toggle('on', j === i); });
    });
  });

  // 4. Eat & stay "More"
  Array.prototype.forEach.call(document.querySelectorAll('.pl .tg'), function (b) {
    b.addEventListener('click', function () {
      var c = b.closest('.pl'), open = c.classList.toggle('open');
      b.textContent = open ? 'Less' : 'More';
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });
})();
