// What to tell a payer whose card was refused — SHARED by pay.html (quote pay links) and
// booking.html (the website checkout), because both hand the same customer to the same
// gateway and a decline reads identically from either door.
//
// PayHere's own modal says "Payment Declined · try a different payment method" and stops
// there; by the time the payer is back on our page they have decided to pay and been told
// no, with nothing to act on. Ordered by what actually clears it: US and EU issuers
// routinely block a first charge from a Sri Lankan merchant, and the block lifts the moment
// the cardholder approves it (2026-08-02).
//
// Show these ONLY after a real attempt at the gateway. A validation miss ("enter your
// billing city") or a booking that never reached a card must not hand anyone four
// paragraphs about phoning their bank.
window.CH_DECLINE_HELP = [
  'Check your banking app — a blocked foreign payment usually appears there with an “approve” or “was this you?” prompt. Approving it and paying again is the quickest fix.',
  'Or call the number on the back of your card and say you’re authorising a payment to a travel company in Sri Lanka.',
  'Trying a different card can also work — Visa, Mastercard and Amex are assessed separately, so one may go through where another didn’t.',
  'Still stuck? Message us on WhatsApp and we’ll send you another way to pay. Nothing has been charged.',
];
