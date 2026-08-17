/* ============================================================
   CEYLON HOP — route catalogue (shared data)
   NOTE: `type:'shared'` seat prices are GENERATED from the shared
   catalogue (source of truth: api/src/db/departureRepo.ts
   SHARED_PRODUCTS) by `npm run generate` — do not hand-edit them.

   Each entry here is a MARKETED product with its own landing page.
   The legs it is sold on live in SHARED_PRODUCTS; `stops[0] -> stops[1]`
   must resolve there or codegen fails loudly.
   ============================================================ */
window.ROUTES = [
  {
    id:'negombo-sigiriya',
    type:'shared',
    name:'Negombo to Sigiriya — Shared Ride',
    tag:'Wed & Sat · 7:30am',
    blurb:'Skip the public-bus chaos. A comfy AC seat from Negombo straight to the Lion Rock, with a Pro Hopper guide aboard.',
    from:'Negombo (CMB pickup)', days:1, price:27.49, mapBg:'ph-saffron',
    corridor:'airport-cultural', times:['07:30'],
    stops:['Negombo','Sigiriya'],
    hero:'Sigiriya rock fortress at golden hour'
  },
  {
    id:'sigiriya-kandy',
    type:'shared',
    name:'Sigiriya to Kandy — Shared Ride',
    tag:'Wed & Sat · 11:30am',
    blurb:'Get from Sigiriya to Kandy with a cool breeze. A confirmed seat and a trusted driver, straight from the Lion Rock to the hill capital.',
    from:'Sigiriya', days:1, price:19.99, mapBg:'ph-saffron',
    corridor:'airport-cultural', times:['11:30'],
    stops:['Sigiriya','Kandy'],
    hero:'Kandy — the temple and the lake'
  },
  {
    id:'ella-yala',
    type:'shared',
    name:'Ella to Yala — Shared Ride',
    tag:'Wed & Sat · 9am',
    blurb:'From the cool tea hills to leopard country. The easiest way to swap Ella’s views for a Yala safari morning.',
    from:'Ella', days:1, price:22.99, mapBg:'ph-saffron',
    corridor:'ella-east', times:['09:00'],
    stops:['Ella','Yala'],
    hero:'Yala safari — leopards and elephants'
  },
  {
    id:'south-airport',
    type:'shared',
    name:'Mirissa / Weligama to Airport — Shared Ride',
    tag:'Wed & Sat · 2:45pm',
    blurb:'Catch that comfy ride to the airport. Exit in comfort — picked up on the south coast, dropped at Colombo or straight to CMB.',
    from:'Mirissa (Weligama pickup)', days:1, price:29.99, mapBg:'ph-saffron',
    corridor:'south-airport', times:['14:45'],
    stops:['Mirissa','Colombo Airport (CMB)'],
    hero:'Colombo Airport — the easy way out'
  },
  {
    id:'custom',
    type:'custom',
    name:'Customised Itinerary',
    tag:'Built around you',
    blurb:'Your route, your pace. Tell our Hop Concierge where you dream of going and we’ll build a private plan to match.',
    from:'Anywhere', days:0, price:null, mapBg:'ph-blue',
    stops:['You decide'],
    hero:'Plan your own Sri Lanka adventure'
  }
];
window.getRoute = id => window.ROUTES.find(r=>r.id===id);
