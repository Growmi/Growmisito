(function(){
  function ready(fn){
    if(document.readyState !== 'loading'){ fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  ready(function(){
    var popup = document.getElementById('nl-popup');
    var tab = document.getElementById('nl-tab');
    if(!popup) return;

    var DISMISS_KEY = 'growmi_nl_dismissed';
    var SUBSCRIBED_KEY = 'growmi_nl_subscribed';

    function alreadyHandled(){
      try{ return localStorage.getItem(SUBSCRIBED_KEY) === '1' || localStorage.getItem(DISMISS_KEY) === '1'; }
      catch(e){ return false; }
    }
    function isSubscribed(){
      try{ return localStorage.getItem(SUBSCRIBED_KEY) === '1'; }
      catch(e){ return false; }
    }
    function openPopup(){
      popup.hidden = false;
      if(tab) tab.hidden = true;
    }
    function closePopup(remember){
      popup.hidden = true;
      if(remember){
        try{ localStorage.setItem(DISMISS_KEY, '1'); }catch(e){}
        if(tab && !isSubscribed()) tab.hidden = false;
      }
    }

    popup.querySelectorAll('[data-nl-close]').forEach(function(el){
      el.addEventListener('click', function(){ closePopup(true); });
    });

    // Il form (markup MailerLite lasciato invariato per non toccare i 20 file HTML del sito)
    // viene intercettato qui invece di mandarlo davvero a MailerLite — così l'iscritto finisce
    // nel sistema newsletter interno. Stesso comportamento di successo di prima (mostra il
    // messaggio di grazie, salva il flag in localStorage).
    var form = popup.querySelector('.ml-block-form');
    if (form) {
      form.addEventListener('submit', function(e){
        e.preventDefault();
        var emailInput = form.querySelector('input[name="fields[email]"]');
        var email = emailInput ? emailInput.value.trim() : '';
        if (!email) return;
        var submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        fetch('/api/newsletter-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function(){
          try{ localStorage.setItem(SUBSCRIBED_KEY, '1'); }catch(err){}
          var successBody = popup.querySelector('.row-success');
          var formBody = popup.querySelector('.row-form');
          if (successBody) successBody.style.display = '';
          if (formBody) formBody.style.display = 'none';
          window.setTimeout(function(){ closePopup(false); }, 2200);
        }).catch(function(){
          if (submitBtn) submitBtn.disabled = false;
        });
      });
    }
    if(tab){
      tab.addEventListener('click', openPopup);
    }
    document.querySelectorAll('[data-nl-open]').forEach(function(el){
      el.addEventListener('click', openPopup);
    });

    if(!alreadyHandled()){
      window.setTimeout(openPopup, 4000);
    } else if(tab && !isSubscribed()){
      tab.hidden = false;
    }

    // MailerLite calls this global function on a successful signup.
    // Wrap it so our popup shell (backdrop, reopen tab, dismiss memory) stays in sync.
    var mlOriginalSuccess = window.ml_webform_success_45022886;
    window.ml_webform_success_45022886 = function(){
      if(typeof mlOriginalSuccess === 'function'){ mlOriginalSuccess(); }
      try{ localStorage.setItem(SUBSCRIBED_KEY, '1'); }catch(e){}
      window.setTimeout(function(){ closePopup(false); }, 2200);
    };
  });
})();
