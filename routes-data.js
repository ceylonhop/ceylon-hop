/* ============================================================
   CEYLON HOP — route catalogue (shared data)
   NOTE: `type:'shared'` seat prices MIRROR the backend corridor
   seat prices (source of truth: api/src/db/departureRepo.ts
   CORRIDOR_ROUTES). Keep them in sync — a shared ride's price is
   its corridor's flat seat price:
     Negombo→Sigiriya = airport-cultural $19
     Ella→Yala / Ella→Arugam = ella-east $23 (flat, same corridor)
     Yala→Mirissa = yala-south $16
   ============================================================ */
window.ROUTES = [
  {
    id:'negombo-sigiriya',
    type:'shared',
    name:'Negombo to Sigiriya — Shared Ride',
    tag:'Daily 7:30am',
    blurb:'Skip the public-bus chaos. A comfy AC seat from Negombo straight to the Lion Rock, with a Pro Hopper guide aboard.',
    from:'Negombo (CMB pickup)', days:1, price:19, mapBg:'ph-saffron',
    stops:['Negombo','Sigiriya'],
    hero:'Sigiriya rock fortress at golden hour'
  },
  {
    id:'ella-yala',
    type:'shared',
    name:'Ella to Yala — Shared Ride',
    tag:'Daily',
    blurb:'From the cool tea hills to leopard country. The easiest way to swap Ella\u2019s views for a Yala safari morning.',
    from:'Ella', days:1, price:23, mapBg:'ph-saffron',
    stops:['Ella','Yala'],
    hero:'Yala safari — leopards and elephants'
  },
  {
    id:'yala-mirissa',
    type:'shared',
    name:'Yala to Mirissa / Weligama / Ahangama',
    tag:'Daily 8am',
    blurb:'Trade the bush for the beach. Get from Ella & Yala to the south-coast surf towns with a confirmed seat and a trusted driver.',
    from:'Yala', days:1, price:16, mapBg:'ph-saffron',
    stops:['Yala','Mirissa','Weligama','Ahangama'],
    hero:'Mirissa beach — coconut tree hill & whales'
  },
  {
    id:'ella-arugam',
    type:'shared',
    name:'Ella to Arugam Bay — Shared Ride',
    tag:'Daily 8am',
    blurb:'From the misty hills to the surf capital of South Asia. One easy hop to Sri Lanka\u2019s most famous point break.',
    from:'Ella', days:1, price:23, mapBg:'ph-saffron',
    stops:['Ella','Arugam Bay'],
    hero:'Arugam Bay — surf point break at sunrise'
  },
  {
    id:'custom',
    type:'custom',
    name:'Customised Itinerary',
    tag:'Built around you',
    blurb:'Your route, your pace. Tell our Hop Concierge where you dream of going and we\u2019ll build a private plan to match.',
    from:'Anywhere', days:0, price:null, mapBg:'ph-blue',
    stops:['You decide'],
    hero:'Plan your own Sri Lanka adventure'
  }
];
window.getRoute = id => window.ROUTES.find(r=>r.id===id);
