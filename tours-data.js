/* ============================================================
   CEYLON HOP — packaged tours data
   Ready-made ROUTE SUGGESTIONS — a set of stops you can take as-is or
   tweak. Priced point-to-point by default (a private AC transfer between
   each stop); add a Pro Hopper chauffeur-guide who stays with you the
   whole trip as an optional upgrade. Airport transfers and door-to-door
   pick-up at every stop. You book your own hotels (we send a hand-picked
   shortlist for each night). Prices shown are the point-to-point "from",
   per vehicle (up to 4 guests); chauffeur-guide is priced per day.
   ============================================================ */
(function(){
  const TOURS = [
    {
      id:'classic-hop',
      name:'The Classic Hop',
      theme:'classic',
      days:7, nights:6,
      price:520,
      tag:'Bestseller',
      mapBg:'ph-teal',
      pace:'Balanced',
      best:'Year-round',
      photo:'PHOTO — Sigiriya Lion Rock rising over the jungle at dawn',
      blurb:'The whole island in one unhurried week — ancient rock fortress, the temple city of Kandy, misty tea country, the famous hill-country train, and a leopard safari to finish.',
      regions:['Cultural Triangle','Kandy','Hill Country','Ella','Safari'],
      stops:['Negombo','Sigiriya','Kandy','Nuwara Eliya','Ella','Yala','Colombo'],
      highlights:[
        'Dawn climb up Sigiriya Lion Rock',
        'Kandy → Ella scenic hill-country train',
        'Jeep safari for leopards in Yala'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 6 nights',
        'Door-to-door pick-up at every hotel along the way',
        'Optional upgrade: a chauffeur-guide who stays with you the whole trip',
        'Airport pick-up & drop-off',
        'Reserved seats on the Ella train',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Site entrance tickets','Safari jeep & park fees','Tips'],
      itinerary:[
        {place:'Negombo', t:'Arrive — welcome to Ceylon', body:'Your chauffeur-guide meets you at Colombo Airport with a Ceylon Hop sign. A short hop to laid-back Negombo to shake off the flight — lagoon breezes, a fresh seafood dinner and an early night.'},
        {place:'Sigiriya', t:'Into the Cultural Triangle', body:'Drive north to the heart of the island. Stop at the golden Dambulla Cave Temple, then arrive in Sigiriya for an evening 4×4 safari in Minneriya — home to the famous “elephant gathering”.'},
        {place:'Kandy', t:'Lion Rock & the sacred city', body:'Beat the heat with a sunrise climb of Sigiriya rock fortress. After breakfast, drive to Kandy via a spice garden, arriving for the evening rituals at the Temple of the Sacred Tooth Relic.'},
        {place:'Nuwara Eliya', t:'Up into tea country', body:'Visit the Peradeniya Royal Botanical Gardens, then climb into the cool highlands past Ramboda Falls. Tour a working tea factory and sip a fresh Ceylon brew in “Little England”.'},
        {place:'Ella', t:'The world’s prettiest train ride', body:'Board the hill-country train from Nanu Oya — rolling tea fields, waterfalls and misty ridges all the way to Ella. Afternoon stroll to the iconic Nine Arch Bridge.'},
        {place:'Yala', t:'Little Adam’s Peak & leopards', body:'Sunrise hike up Little Adam’s Peak, then descend south to Yala. An afternoon jeep safari in Sri Lanka’s best-known park gives you a real shot at leopard, elephant and sloth bear.'},
        {place:'Colombo', t:'Coast road home', body:'A relaxed drive back along the coast to Colombo or the airport, with time for a final lunch by the sea. Onward with a camera full of Ceylon.'}
      ]
    },
    {
      id:'grand-island-loop',
      name:'Grand Island Loop',
      theme:'grand',
      days:10, nights:9,
      price:760,
      tag:'Most complete',
      mapBg:'ph-saffron',
      pace:'Balanced',
      best:'Dec–Mar',
      photo:'PHOTO — Galle Fort lighthouse and ramparts at golden hour',
      blurb:'Our flagship grand tour. Everything in the Classic Hop, plus the ancient capital of Anuradhapura, a second safari at Udawalawe, and four unwinding days on the southern coast around Galle and Mirissa.',
      regions:['Cultural Triangle','Kandy','Hill Country','Safari','South Coast'],
      stops:['Negombo','Anuradhapura','Sigiriya','Kandy','Ella','Udawalawe','Mirissa','Galle','Colombo'],
      highlights:[
        'Two wildlife parks — Minneriya & Udawalawe',
        'Ancient capitals of Anuradhapura & Polonnaruwa',
        'Beach days & whale watching off Mirissa'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 9 nights',
        'Door-to-door pick-up at every hotel along the way',
        'Optional upgrade: a chauffeur-guide who stays with you the whole trip',
        'Airport pick-up & drop-off',
        'Reserved seats on the Ella train',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Site entrance tickets','Safari jeep & park fees','Whale-watching boat','Tips'],
      itinerary:[
        {place:'Negombo', t:'Arrive — welcome to Ceylon', body:'Airport welcome and a short transfer to Negombo for a restful first night by the lagoon.'},
        {place:'Anuradhapura', t:'The first ancient capital', body:'Drive to Anuradhapura, a sacred UNESCO city of giant white stupas and the world’s oldest documented tree. An unhurried afternoon among pilgrims and ruins.'},
        {place:'Sigiriya', t:'Caves, kings & elephants', body:'Explore Polonnaruwa’s royal ruins and the Dambulla Cave Temple en route to Sigiriya. Evening 4×4 safari in Minneriya for the elephant gathering.'},
        {place:'Kandy', t:'Lion Rock & the sacred city', body:'Sunrise climb of Sigiriya, then drive to Kandy for the Temple of the Sacred Tooth and a traditional Kandyan dance show.'},
        {place:'Ella', t:'Tea country & the famous train', body:'Botanical gardens and a tea-factory tour, then the unforgettable hill-country train down to Ella and the Nine Arch Bridge.'},
        {place:'Udawalawe', t:'Hike & a gentle safari', body:'Morning at Little Adam’s Peak, then transfer to Udawalawe — the surest place in Sri Lanka to watch big herds of wild elephants up close.'},
        {place:'Mirissa', t:'Down to the south coast', body:'Drive to the palm-lined beaches of Mirissa. The rest of the day is yours — hammocks, surf and a seafood sunset.'},
        {place:'Mirissa', t:'Whales & warm water', body:'Optional dawn whale-watching boat in search of blue whales, then a slow beach day. Snorkel, swim, or simply do nothing at all.'},
        {place:'Galle', t:'The Dutch fort city', body:'Wander the ramparts and cobbled lanes of Galle Fort, a living 17th-century walled town of galleries, cafés and ocean views.'},
        {place:'Colombo', t:'Coast road home', body:'Coastal drive back to Colombo or the airport, with a final stop wherever takes your fancy.'}
      ]
    },
    {
      id:'tea-and-trains',
      name:'Tea, Trains & Misty Hills',
      theme:'hills',
      days:5, nights:4,
      price:380,
      tag:'Hill country',
      mapBg:'ph-blue',
      pace:'Relaxed',
      best:'Jan–Apr',
      photo:'PHOTO — blue train curving through emerald tea plantations near Ella',
      blurb:'A short, scenic escape into the cool highlands — Kandy’s sacred temple, the tea estates of Nuwara Eliya, the world-famous train to Ella, and a sunrise above the clouds at World’s End.',
      regions:['Kandy','Hill Country','Ella'],
      stops:['Kandy','Nuwara Eliya','Horton Plains','Ella','Colombo'],
      highlights:[
        'Ride the celebrated hill-country train',
        'Sunrise at World’s End, Horton Plains',
        'Pick & taste leaves at a working tea estate'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 4 nights',
        'Door-to-door pick-up at every hotel along the way',
        'Optional upgrade: a chauffeur-guide who stays with you the whole trip',
        'Airport pick-up & drop-off',
        'Reserved seats on the Ella train',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Site entrance tickets','Horton Plains park fees','Tips'],
      itinerary:[
        {place:'Kandy', t:'Up to the sacred city', body:'Pick-up from Colombo or the airport and a scenic drive to Kandy. Evening at the Temple of the Sacred Tooth Relic and a walk around the lake.'},
        {place:'Nuwara Eliya', t:'Into the tea hills', body:'Climb into the highlands past Ramboda Falls. Tour a working Ceylon tea factory, pick a few leaves yourself, and settle into cool, colonial Nuwara Eliya.'},
        {place:'Horton Plains', t:'World’s End at sunrise', body:'An early start for Horton Plains — a misty plateau hike to the sheer cliff of World’s End and Baker’s Falls before the clouds roll in.'},
        {place:'Ella', t:'The famous train', body:'Board the hill-country train to Ella, widely called one of the most beautiful rides on earth. Afternoon at the Nine Arch Bridge.'},
        {place:'Colombo', t:'Little Adam’s Peak & home', body:'Sunrise hike up Little Adam’s Peak, then the drive back down to Colombo or the airport.'}
      ]
    },
    {
      id:'wild-ceylon',
      name:'Wild Ceylon Safari',
      theme:'wildlife',
      days:6, nights:5,
      price:470,
      tag:'For wildlife lovers',
      mapBg:'ph-teal',
      pace:'Active',
      best:'May–Sep',
      photo:'PHOTO — wild elephants gathering at a Minneriya reservoir at dusk',
      blurb:'Three parks, three landscapes. Track leopards in Wilpattu, watch hundreds of elephants gather at Minneriya, and search the grasslands of Udawalawe — with Sigiriya and a cave temple woven in.',
      regions:['Wilpattu','Cultural Triangle','Safari'],
      stops:['Wilpattu','Sigiriya','Kandy','Udawalawe','Yala','Colombo'],
      highlights:[
        'Leopards & sloth bears in Wilpattu',
        'The Minneriya elephant gathering',
        'Big herds on the plains of Udawalawe'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 5 nights',
        'Door-to-door pick-up at every hotel along the way',
        'Optional upgrade: a chauffeur-guide who stays with you the whole trip',
        'Airport pick-up & drop-off',
        '3 shared jeep safaris arranged for you',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Park entrance & jeep fees','Site entrance tickets','Tips'],
      itinerary:[
        {place:'Wilpattu', t:'Into leopard country', body:'Drive from the airport to Wilpattu, Sri Lanka’s largest and wildest park. An afternoon game drive among its lakes — prime leopard, elephant and sloth-bear territory.'},
        {place:'Sigiriya', t:'Caves & the Cultural Triangle', body:'Cross to Sigiriya, stopping at the Dambulla Cave Temple. Late-day 4×4 safari in Minneriya, where hundreds of elephants gather around the reservoir.'},
        {place:'Kandy', t:'Lion Rock & the sacred city', body:'Sunrise climb of Sigiriya rock fortress, then a drive to Kandy for the Temple of the Sacred Tooth — a cultural breather between safaris.'},
        {place:'Udawalawe', t:'Elephants on the plains', body:'Transfer south to Udawalawe and an afternoon safari almost guaranteed to put you among big, relaxed herds of wild elephants.'},
        {place:'Yala', t:'One more for the leopards', body:'A dawn jeep safari in Yala, the park with the densest leopard population in the world, then an easy afternoon near Tissa lake.'},
        {place:'Colombo', t:'Coast road home', body:'A scenic drive back to Colombo or the airport along the southern coast.'}
      ]
    },
    {
      id:'cultural-triangle-express',
      name:'Cultural Triangle Express',
      theme:'culture',
      days:4, nights:3,
      price:300,
      tag:'Short & rich',
      mapBg:'ph-saffron',
      pace:'Active',
      best:'Year-round',
      photo:'PHOTO — golden Buddha statues inside the Dambulla cave temple',
      blurb:'A compact heritage tour for short stays and stopovers — the cave temples, two ancient capitals, the Sigiriya rock fortress and the sacred city of Kandy, all in four well-planned days.',
      regions:['Cultural Triangle','Kandy'],
      stops:['Sigiriya','Polonnaruwa','Anuradhapura','Kandy','Colombo'],
      highlights:[
        'Climb the Sigiriya rock fortress',
        'Two UNESCO ancient capitals',
        'Temple of the Sacred Tooth, Kandy'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 3 nights',
        'Door-to-door pick-up at every hotel along the way',
        'Optional upgrade: a chauffeur-guide who stays with you the whole trip',
        'Airport pick-up & drop-off',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Site entrance tickets','Tips'],
      itinerary:[
        {place:'Sigiriya', t:'Caves & the road north', body:'Met at the airport and driven into the Cultural Triangle, stopping at the Dambulla Cave Temple. Evening at leisure beneath Sigiriya rock.'},
        {place:'Sigiriya', t:'Lion Rock & Polonnaruwa', body:'Dawn climb of the Sigiriya fortress, then explore the royal ruins of Polonnaruwa by bicycle or vehicle in the afternoon.'},
        {place:'Kandy', t:'Anuradhapura & on to Kandy', body:'Morning among the great stupas of Anuradhapura, then a drive south to Kandy for the evening temple rituals.'},
        {place:'Colombo', t:'Kandy & home', body:'Botanical gardens and a last look at Kandy before the drive back to Colombo or the airport.'}
      ]
    },
    {
      id:'coast-honeymoon',
      name:'Coast & Honeymoon Escape',
      theme:'honeymoon',
      days:9, nights:8,
      price:690,
      tag:'For couples',
      mapBg:'ph-blue',
      pace:'Relaxed',
      best:'Nov–Apr',
      photo:'PHOTO — a couple on a quiet palm-fringed beach at Tangalle',
      blurb:'A gentle, romantic blend of just-enough culture and plenty of slow coast. Tea hills and the Ella train, a private safari, then long unwinding days between Mirissa, Galle and secluded Tangalle.',
      regions:['Hill Country','Ella','Safari','South Coast'],
      stops:['Kandy','Ella','Yala','Tangalle','Mirissa','Galle','Colombo'],
      highlights:[
        'Private sunset safari at Yala',
        'The hill-country train to Ella',
        'Secluded beach days at Tangalle & Mirissa'
      ],
      includes:[
        'Private AC vehicle for every transfer between your stops',
        'A hand-picked hotel shortlist for all 8 nights',
        'Door-to-door pick-up at every hotel along the way',
        'A candlelit beach dinner, on us',
        'Airport pick-up & drop-off',
        'Reserved seats on the Ella train',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Site entrance tickets','Safari jeep & park fees','Whale-watching boat','Tips'],
      itinerary:[
        {place:'Kandy', t:'Arrive & ease into the hills', body:'Airport welcome and a scenic drive to Kandy. A gentle evening at the Temple of the Sacred Tooth and a lakeside stroll.'},
        {place:'Ella', t:'Tea hills & the famous train', body:'A tea-estate visit, then the celebrated hill-country train to Ella. Settle into a view over the valley.'},
        {place:'Ella', t:'Slow morning in Ella', body:'Sunrise at Little Adam’s Peak and the Nine Arch Bridge, with a lazy afternoon among the cafés and tea fields.'},
        {place:'Yala', t:'A private safari', body:'Transfer to Yala for a private sunset jeep safari in search of leopard — just the two of you and your tracker.'},
        {place:'Tangalle', t:'First taste of the coast', body:'Drive to secluded Tangalle, the quietest of the southern beaches. Nothing on the agenda but warm sand and a candlelit dinner.'},
        {place:'Mirissa', t:'Whales & golden bays', body:'Optional dawn whale-watching off Mirissa, then a slow day on its famous crescent beach.'},
        {place:'Mirissa', t:'Pure beach day', body:'A full day to do as little or as much as you like — surf lessons, a hidden cove, or a hammock and a book.'},
        {place:'Galle', t:'The romantic fort', body:'Up the coast to Galle Fort for sunset on the ramparts and a boutique stay inside the old walls.'},
        {place:'Colombo', t:'One last coastal drive', body:'A relaxed return to Colombo or the airport, ending a honeymoon you won’t stop talking about.'}
      ]
    },
    {
      id:'southern-surf',
      name:'Southern Surf Coast',
      theme:'coast',
      days:7, nights:6,
      price:430,
      tag:'Surf & sand',
      mapBg:'ph-saffron',
      pace:'Relaxed',
      best:'Nov-Apr (south) · Apr-Oct (Arugam)',
      photo:'PHOTO — surfers at a golden point break, Arugam Bay at sunrise',
      blurb:'Golden beaches, easy surf and slow sunsets down the south coast and round to the point breaks of Arugam Bay — the island’s sunniest, most laid-back stretch.',
      regions:['South Coast','Surf','East Coast'],
      stops:['Airport','Galle','Ahangama','Weligama','Mirissa','Hiriketiya','Arugam Bay'],
      highlights:[
        'Beginner-friendly surf at Weligama & Hiriketiya',
        'Galle Fort at golden hour',
        'The famous point break at Arugam Bay'
      ],
      includes:[
        'Private AC vehicle for every transfer, door to door',
        'A hand-picked hotel shortlist for all 6 nights',
        'Airport pick-up & drop-off',
        'All driving, fuel, tolls & parking'
      ],
      excludes:['Hotels & accommodation — you book your own','International flights','All meals & drinks','Surf lessons & board hire','Tips'],
      itinerary:[
        {place:'Galle', t:'Arrive & the old fort', body:'Airport welcome and a drive down to Galle. Settle in and wander the ramparts of the 17th-century Dutch fort at sunset.'},
        {place:'Ahangama', t:'Easy south-coast surf', body:'A short hop to the mellow breaks and palm-lined bays around Ahangama and Midigama — a good place to find your feet on a board.'},
        {place:'Weligama', t:'Learn to surf', body:'The gentle beach break at Weligama is the island’s best spot for a first lesson. An afternoon of sand, surf and coconut roti.'},
        {place:'Mirissa', t:'Whales & golden bays', body:'Optional dawn whale-watching, then a slow day on Mirissa’s crescent beach and coconut tree hill.'},
        {place:'Hiriketiya', t:'The horseshoe bay', body:'Drive to the tucked-away horseshoe bay of Hiriketiya — surf, swim, and a laid-back beach-cafe evening.'},
        {place:'Arugam Bay', t:'The point break', body:'Cross to the east coast and Sri Lanka’s most famous surf town. Sunrise sessions at the point and a final few easy days by the sea.'}
      ]
    }
  ];

  window.TOURS = TOURS;
  window.getTour = function(id){ return TOURS.find(t=>t.id===id) || null; };
})();
