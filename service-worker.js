const CACHE="fz-tip-v1230";
const CORE=["./","./index.html","./app-v1230.js","./firebase-config.js","./hourly-logic.js","./manifest.webmanifest", "./money-ready-chime.wav"];

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
  if(req.method!=="GET") return;

  const url=new URL(req.url);
  const isCode=url.pathname.endsWith("/") ||
               url.pathname.endsWith("/index.html") ||
               url.pathname.endsWith(".js") ||
               url.pathname.endsWith("/service-worker.js");

  if(isCode){
    event.respondWith(
      fetch(req,{cache:"no-store"})
        .then(res=>{
          const copy=res.clone();
          caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
          return res;
        })
        .catch(()=>caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
      return res;
    }))
  );
});
