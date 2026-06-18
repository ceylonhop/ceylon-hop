/* ============================================================
   CEYLON HOP — route catalogue (shared data)
   ============================================================ */
window.ROUTES = [
  {
    id:'island-loop-9',
    type:'loop',
    name:'The Island Loop — 9 Stops',
    tag:'Most popular',
    blurb:'The full island. Beaches, hill country, ancient cities and safari — the whole tapestry of Sri Lanka in one flexible pass.',
    from:'Airport / Colombo', days:9, price:129, mapBg:'ph-teal',
    stops:['Airport','Negombo','Sigiriya','Kandy','Ella','Yala','Mirissa','Weligama','Galle'],
    hero:'Sri Lanka island loop — surf, safari, tea country'
  },
  {
    id:'island-loop-6',
    type:'loop',
    name:'The Island Loop — 6 Stops',
    tag:'Best of, fast',
    blurb:'Short on time? The greatest hits — culture, hills and a taste of the south coast in a tighter, breezier loop.',
    from:'Airport / Colombo', days:6, price:95, mapBg:'ph-teal',
    stops:['Airport','Sigiriya','Kandy','Ella','Mirissa','Galle'],
    hero:'Highlights loop — Sigiriya, Kandy, Ella, Mirissa'
  },
  {
    id:'southern-coast-8',
    type:'loop',
    name:'Southern Coast — 8 Stops + Arugam Bay',
    tag:'Surf & sand',
    blurb:'Golden beaches, surf breaks and sunsets. Hop the waves and slow down along the island\u2019s sunniest stretch.',
    from:'Airport CMB', days:6, price:99, mapBg:'ph-saffron',
    stops:['Airport','Galle','Thalpe','Ahangama','Weligama','Mirissa','Hiriketiya','Arugam Bay'],
    hero:'Southern coast beaches — surf, whales, palm bays'
  },
  {
    id:'negombo-sigiriya',
    type:'shared',
    name:'Negombo to Sigiriya — Shared Ride',
    tag:'Daily 7:30am',
    blurb:'Skip the public-bus chaos. A comfy AC seat from Negombo straight to the Lion Rock, with a Pro Hopper guide aboard.',
    from:'Negombo (CMB pickup)', days:1, price:19.49, mapBg:'ph-saffron',
    stops:['Negombo','Sigiriya'],
    hero:'Sigiriya rock fortress at golden hour'
  },
  {
    id:'ella-yala',
    type:'shared',
    name:'Ella to Yala — Shared Ride',
    tag:'Daily',
    blurb:'From the cool tea hills to leopard country. The easiest way to swap Ella\u2019s views for a Yala safari morning.',
    from:'Ella', days:1, price:22, mapBg:'ph-saffron',
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
    from:'Ella', days:1, price:24, mapBg:'ph-saffron',
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
