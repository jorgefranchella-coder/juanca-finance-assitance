// Online data is always fetched fresh; no financial data is stored in Cache Storage.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10263c"><title>Juanca — Sem conexão</title><style>body{margin:0;padding:32px;font:18px system-ui;background:#eef2f5;color:#10263c}main{max-width:440px;margin:15vh auto}button{font:inherit;padding:14px 22px;background:#173f61;color:white;border:0;border-radius:10px}</style><main><h1>Juanca</h1><h2>Sem conexão</h2><p>Conecte o celular à internet e ative o Tailscale. O computador de Juanca precisa estar ligado.</p><button onclick="location.reload()">Tentar novamente</button></main></html>`, {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}})));
});
