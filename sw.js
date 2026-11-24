/* Painel Amazônia Gráfica · service worker mínimo
   Só existe para o navegador aceitar "Adicionar à tela inicial" como aplicativo.
   Não guarda nada em cache: tudo vem sempre da internet (pedidos sempre atualizados). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request));
});
