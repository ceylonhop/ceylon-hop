// The hand-off to PayHere's hosted checkout, SHARED by booking.html (the website checkout) and
// manage.html (the booking link in every email and the ops drawer's pay link). Both left PayHere's
// iframe SDK for a top-level redirect on 2026-09-24 (docs/checkout-redirect-spec.md §1.4, §10), and
// until this file each carried its own copy of the form, the WhatsApp text and — worse — a private
// sessionStorage key the other page had to know by heart. pay.html still has its own copy of the
// form (its flow was live-verified separately; folding it in is a follow-up).

// Where manage.html keeps its manage token for this tab. The token is taken OUT of the address bar
// (analytics, recordings and the error beacon all read location.href), so a reload — and the
// return leg from PayHere, whose URL carries only the status-only `rt` — reads it from here.
// booking.html writes it here right before its own hand-off, so the website customer lands on
// their full booking. One name, one place.
window.CH_MANAGE_TOKEN_KEY = 'chManageToken';

// D1 — a TOP-LEVEL form POST to the gateway's own URL. The fields are the server's verbatim, in
// the server's order: `hash` covers merchant_id + order_id + amount + currency and is signed server
// side, so reordering, renaming or adding anything here would be refused by the gateway.
window.chSubmitToGateway = function (checkout) {
  var form = document.createElement('form');
  form.method = 'POST';
  form.action = checkout.checkoutUrl;
  Object.keys(checkout.fields).forEach(function (k) {
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = checkout.fields[k];
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
};

// The one-tap WhatsApp message that already names the booking. An incomplete PayHere payment ends
// silently on our side (no decline webhook, nothing on the page), so the customer is the only
// witness to what went wrong — and one who has to find their reference first often doesn't write.
//   'failed'  — a payment that didn't work (or may not have). The OTHER copy of this text is
//               api/src/services/notifications.ts paymentTroubleWhatsApp(), in the payment-failure
//               emails; web-tests/unit/checkout-handoff.test.js keeps the two identical.
//   'contact' — a neutral question, for states where nothing failed (already paid, awaiting a
//               hand price, no longer payable): "my payment didn't go through" would be untrue.
window.chTellUsHref = function (reference, kind) {
  var text = kind === 'contact'
    ? 'Hi Ceylon Hop, a question about ' + (reference ? 'booking ' + reference : 'my booking') + ': '
    : 'Hi Ceylon Hop, my payment' + (reference ? ' for booking ' + reference : '') + ' didn\'t go through. What I saw: ';
  return 'https://wa.me/94779669662?text=' + encodeURIComponent(text);
};
