/*
 * Service worker do CineClip.
 *
 * Existe para o Android tratar o site como aplicativo instalável (e mostrá-lo no
 * menu "Compartilhar" do TikTok e do Kwai) e para mostrar a notificação de fim do
 * lote. Não guarda nada em cache de propósito: o app depende de chegar sempre à
 * versão mais recente (ver README → cache).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Versões antigas do Chrome só ofereciam "Instalar app" com um ouvinte de fetch.
// Não intercepta nada: o navegador continua a ir à rede como sempre.
self.addEventListener("fetch", () => {});

// Tocar na notificação de fim do lote abre (ou traz para a frente) o app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ("focus" in janela) return janela.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow("./") : undefined;
    })
  );
});
