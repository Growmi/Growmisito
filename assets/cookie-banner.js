/* Banner informativo sui cookie (solo tecnici/necessari, nessun consenso da raccogliere: non c'è
   nulla da attivare/disattivare, quindi un semplice avviso con un pulsante di chiusura basta).
   Iniettato in modo sincrono (non su DOMContentLoaded) cosi' esiste già nel DOM quando i18n.js
   applica la lingua salvata, ed eredita subito il testo giusto invece di un lampo in italiano/inglese. */
(function(){
  var STORAGE_KEY = 'growmi_cookie_notice_dismissed';
  var dismissed = false;
  try{ dismissed = localStorage.getItem(STORAGE_KEY) === '1'; }catch(e){}
  if(dismissed) return;

  var banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Informativa cookie');
  banner.innerHTML =
    '<div class="cookie-banner-inner">' +
      '<p><span data-i18n="cookie_banner_text">Usiamo solo cookie tecnici necessari al funzionamento del sito (es. per il login) — nessun cookie di tracciamento o pubblicità.</span> ' +
      '<a href="privacy-policy.html" data-i18n="cookie_banner_link">Scopri di più</a></p>' +
      '<button type="button" class="cookie-banner-ok" data-i18n="cookie_banner_ok">Ho capito</button>' +
    '</div>';
  document.body.appendChild(banner);

  banner.querySelector('.cookie-banner-ok').addEventListener('click', function(){
    try{ localStorage.setItem(STORAGE_KEY, '1'); }catch(e){}
    banner.classList.add('is-hidden');
    setTimeout(function(){ banner.remove(); }, 300);
  });
})();
