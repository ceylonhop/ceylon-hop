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
          // The postcard's top half — pure decoration (route line, handwriting, stamp,
          // postmark), so it is aria-hidden; the eyebrow below carries "beta" for AT.
          '<div class="ch-beta-post" aria-hidden="true">' +
            '<svg class="ch-beta-route" viewBox="0 0 560 128" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
              '<circle cx="30" cy="34" r="3.4" fill="currentColor" stroke="none"/>' +
              '<path d="M30 34 C 130 62, 230 88, 312 68 S 384 44, 406 58" stroke-width="2" stroke-dasharray="1 10" vector-effect="non-scaling-stroke"/>' +
              '<path class="ch-beta-pin" d="M406 58c-4-5-11-11-11-19a11 11 0 0 1 22 0c0 8-7 14-11 19z" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
              '<circle class="ch-beta-pin" cx="406" cy="39" r="3" fill="currentColor" stroke="none"/>' +
            '</svg>' +
            '<span class="ch-beta-wish">wish you were here? — you are.</span>' +
            '<span class="ch-beta-stamp">' +
              '<svg viewBox="0 0 64 46">' +
                '<rect width="64" height="46" fill="var(--pc-saffron,#fbf0d8)"/>' +
                '<circle cx="41" cy="25" r="9.5" fill="var(--saffron,#F9A429)"/>' +
                '<rect y="27" width="64" height="19" fill="var(--blue,#63BFD6)" fill-opacity=".55"/>' +
                '<path d="M35 32h12M38 36h7M40 40h4" stroke="var(--paper,#fffdf8)" stroke-opacity=".85" stroke-width="1.6" stroke-linecap="round"/>' +
                '<g fill="none" stroke="var(--ink,#3A3739)" stroke-width="1.5" stroke-linecap="round">' +
                  '<path d="M13 46c1-8 0-14 3-20"/>' +
                  '<path d="M16 26c-5-4-10-4-13-1M16 26c-3-6-8-8-12-7M16 26c2-6 7-8 11-6M16 26c4-4 9-3 12 1"/>' +
                  '<path d="M46 9c2-2 4-2 6 0M52 14c1.6-1.6 3.4-1.6 5 0" stroke-width="1.2"/>' +
                '</g>' +
              '</svg>' +
              '<b>Beta</b><i>Ceylon&nbsp;Hop · ’26</i>' +
            '</span>' +
            '<svg class="ch-beta-postmark" viewBox="0 0 132 70" fill="none" stroke="currentColor">' +
              '<circle cx="33" cy="35" r="26" stroke-width="2" stroke-dasharray="3 4"/>' +
              '<circle cx="33" cy="35" r="19" stroke-width="1.4" stroke-dasharray="2 5"/>' +
              '<path d="M66 22c10 3 18-3 28 0s18-3 28 0M66 35c10 3 18-3 28 0s18-3 28 0M66 48c10 3 18-3 28 0s18-3 28 0" stroke-width="2" stroke-linecap="round"/>' +
            '</svg>' +
          '</div>' +
          '<div class="ch-beta-msg">' +
            '<p class="ch-beta-eyebrow">Beta — freshly rebuilt</p>' +
            '<h2 class="ch-beta-title" id="ch-beta-title">You’ve found the <em>new</em> Ceylon&nbsp;Hop</h2>' +
            '<p class="ch-beta-body">We’ve rebuilt the whole booking site from the road up — live prices, ' +
              'any two points in Sri&nbsp;Lanka, door to door. It’s new, so you may spot the odd rough edge.</p>' +
            '<p class="ch-beta-fine">Everything here is real — the prices, the bookings, and the people behind them if you need a hand.</p>' +
            '<button type="button" class="btn btn-primary ch-beta-ok">Got it — have a look around</button>' +
          '</div>' +
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
