/**
 * lang-init.js: pick the language before the page paints, so Arabic readers do
 * not see a flash of English or a layout jump. A plain script (not a module)
 * loaded in <head> because it has to run first. i18n.js takes over from here.
 *
 * Order: ?lang= in the address, then the saved choice, then the browser language.
 */
(function () {
  var html = document.documentElement;
  var lang = new URLSearchParams(location.search).get('lang');
  if (lang !== 'ar' && lang !== 'en') {
    try { lang = localStorage.getItem('face-unlock-demo:lang'); } catch (e) { lang = null; }
  }
  if (lang !== 'ar' && lang !== 'en') lang = /^ar\b/i.test(navigator.language || '') ? 'ar' : 'en';

  html.dataset.lang = lang; // the choice, for i18n.js
  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';

  if (lang === 'ar') {
    // Hidden until the Arabic text is in place. On a very slow connection, show the page in
    // readable English instead of waiting, or of mixing English text with a right-to-left layout.
    // i18n.js switches to Arabic as soon as it arrives.
    html.classList.add('i18n-pending');
    setTimeout(function () {
      if (!html.classList.contains('i18n-pending')) return;
      html.classList.remove('i18n-pending');
      html.lang = 'en';
      html.dir = 'ltr';
    }, 3000);

    ['vendor/fonts/noto-naskh-arabic-variable.woff2', 'vendor/fonts/ibm-plex-sans-arabic-400.woff2'].forEach(function (href) {
      var link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'font';
      link.type = 'font/woff2';
      link.crossOrigin = 'anonymous';
      link.href = href;
      document.head.appendChild(link);
    });
  }
})();
