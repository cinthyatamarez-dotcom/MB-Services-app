// Service worker mínimo — solo lo necesario para que el navegador
// permita "instalar" la app en el celular/PC. No cachea nada todavía.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());
self.addEventListener("fetch", () => {});
