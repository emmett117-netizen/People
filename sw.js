// Network first, but never hang: after 4 seconds use the saved copy, so a weak signal can't leave the app stuck on its splash screen.
const C='people-v2',SHELL=['./','index.html','manifest.webmanifest','icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
const saved=req=>caches.match(req,{ignoreSearch:true}).then(r=>r||(req.mode==='navigate'?caches.match('index.html',{ignoreSearch:true}):undefined));
self.addEventListener('fetch',e=>{const req=e.request,u=new URL(req.url);if(req.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(new Promise(resolve=>{let done=false;const finish=r=>{if(!done&&r){done=true;resolve(r)}};
    const net=fetch(req).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(req,cp)).catch(()=>{})}finish(r);return r});
    const timer=setTimeout(()=>saved(req).then(finish),4000);
    net.catch(()=>saved(req).then(r=>finish(r||Response.error()))).finally(()=>clearTimeout(timer))}))});
