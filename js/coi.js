// Loaded only by pc.html (as a classic script, before the app). Makes the page cross-origin
// isolated through coi-sw.js so the multi-threaded engine can run. If that is not possible, the
// app notices (window.crossOriginIsolated stays false) and falls back to the phone engine.
(function () {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const FLAG = 'chessReview.coiReload';
  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(FLAG);
    return;
  }
  navigator.serviceWorker.register('coi-sw.js', { scope: './' }).then(() => {
    // A page only gets the new headers when it is loaded through the worker, so reload once.
    // The flag stops an endless reload loop in a browser that still refuses isolation.
    navigator.serviceWorker.ready.then(() => {
      if (sessionStorage.getItem(FLAG)) return;
      sessionStorage.setItem(FLAG, '1');
      window.location.reload();
    });
  }).catch(() => { /* service workers unavailable: the app falls back to the phone engine */ });
})();
