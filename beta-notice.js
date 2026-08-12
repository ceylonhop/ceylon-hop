/* Ceylon Hop — beta notice. Shown once per browser to visitors arriving on the new site from
   the old one, then never again. Deliberately NOT on the transactional pages (booking, pay,
   manage, quote): someone mid-checkout does not need a dialog, and the point is to greet an
   arrival, not to interrupt a purchase.

   Storage is wrapped in try/catch throughout. Safari private mode throws on setItem, and a
   notice that cannot record its own dismissal would come back on every page — a modal you
   cannot get rid of is worse than no modal at all, so it fails towards showing once and
   closing cleanly rather than towards being sticky. */
(function (window, document, localStorage) {
  var KEY = 'ceylonhop_beta_notice';

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function remember() { try { localStorage.setItem(KEY, 'dismissed'); } catch (e) {} }

  if (stored() === 'dismissed') return;

  var lastFocus = null;      // returned to on close, so a keyboard user lands where they were
  var priorOverflow = '';

  function el() { return document.querySelector('.ch-beta'); }

  function dismiss() {
    var box = el();
    if (!box) return;
    remember();
    document.removeEventListener('keydown', onKey, true);
    if (box.parentNode) box.parentNode.removeChild(box);
    document.body.style.overflow = priorOverflow;
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { dismiss(); return; }
    // One interactive element, so the trap is simply: Tab keeps you on it. Without this, Tab
    // walks into the page behind the scrim, which is invisible and unreachable by mouse.
    if (e.key === 'Tab') {
      var btn = document.querySelector('.ch-beta button');
      if (btn) { e.preventDefault(); btn.focus(); }
    }
  }

  function render() {
    if (el()) return;
    lastFocus = document.activeElement;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="ch-beta" role="dialog" aria-modal="true" aria-labelledby="ch-beta-title">' +
        '<div class="ch-beta-panel">' +
          '<p class="ch-beta-eyebrow">Beta</p>' +
          '<h2 class="ch-beta-title" id="ch-beta-title">You’ve found the new Ceylon&nbsp;Hop</h2>' +
          '<p class="ch-beta-body">We’ve rebuilt the whole booking site — live prices, any two points, ' +
            'door to door. It’s new, so you may spot the odd rough edge.</p>' +
          '<p class="ch-beta-fine">Prices and bookings here are real, and so is our help if you need it.</p>' +
          '<button type="button" class="btn btn-primary ch-beta-ok">Got it — have a look around</button>' +
        '</div>' +
      '</div>');

    priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    var box = el();
    box.addEventListener('click', function (e) { if (e.target === box) dismiss(); });
    box.querySelector('button').addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey, true);

    var btn = box.querySelector('button');
    if (btn && btn.focus) { try { btn.focus(); } catch (e) {} }
  }

  window.chBetaNotice = { dismiss: dismiss };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})(window, document, window.localStorage);
