importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyB7yIl1T6ufniDAhed1vGNzi8c1d-ghfFI",
  authDomain: "juicy-tip-all-in-one.firebaseapp.com",
  projectId: "juicy-tip-all-in-one",
  storageBucket: "juicy-tip-all-in-one.firebasestorage.app",
  messagingSenderId: "1018030638724",
  appId: "1:1018030638724:web:19b945d908229f622664d1"
});

const fcmMessaging=firebase.messaging();

fcmMessaging.onBackgroundMessage(payload=>{
  const data=payload.data||{};
  const type=String(data.type||"").toLowerCase();
  const title=data.title||"Fred Zhang Tip Calculator";
  const body=data.body||"You have a new notification.";

  let vibrate=[250,120,250,120,500];
  let requireInteraction=false;

  if(type==="employee_submit"){
    vibrate=[300,140,300,140,700];
  }else if(type==="tip_approved"){
    vibrate=[420,160,420];
  }else if(type==="tip_rejected"){
    vibrate=[450,120,220,120,450];
    requireInteraction=true;
  }else if(type==="money_ready"){
    vibrate=[700,180,700,180,1100];
    requireInteraction=true;
  }else if(type==="tip_check_cashier"){
    vibrate=[350,130,350,130,750];
    requireInteraction=true;
  }else if(type==="tip_check_completed"){
    vibrate=[450,150,450];
  }

  self.registration.showNotification(title,{
    body,
    icon:"./icon-192.png",
    badge:"./icon-192.png",
    tag:data.tag||data.type||"fred-tip",
    renotify:true,
    silent:false,
    requireInteraction,
    data:{url:data.url||"./",type:data.type||""},
    vibrate
  });
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||"./",self.location.href).href;
  event.waitUntil((async()=>{
    const all=await clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of all){
      if(client.url.startsWith(self.location.origin) && "focus" in client){
        await client.focus();
        if("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if(clients.openWindow) await clients.openWindow(target);
  })());
});

const CACHE="fz-tip-v1364";
const CORE=["./","./index.html","./fresh-v1364.html","./app-v1364.js?v=1364","./simple-ui-v1364.js?v=1364","./firebase-config.js","./push-config.js","./hourly-logic.js","./manifest.webmanifest", "./money-ready-chime.wav"];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE).catch(()=>{})));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  const url=new URL(req.url);
  const localCode=url.origin===self.location.origin &&
    (req.mode==="navigate" || ["script","style","worker"].includes(req.destination));

  if(localCode){
    event.respondWith(
      fetch(req,{cache:"no-store"}).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copy));
        return res;
      }).catch(()=>caches.match(req).then(r=>r||caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>cached||fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy));
      return res;
    }))
  );
});
