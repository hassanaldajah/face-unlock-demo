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

  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';

  if (lang === 'ar') {
    // Hidden until the Arabic text is in place, with a limit so a slow load can never hide the page
    html.classList.add('i18n-pending');
    setTimeout(function () { html.classList.remove('i18n-pending'); }, 1500);

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
