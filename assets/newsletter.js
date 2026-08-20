(function(){
  function ready(fn){
    if(document.readyState !== 'loading'){ fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  ready(function(){
    var popup = document.getElementById('nl-popup');
    var tab = document.getElementById('nl-tab');
    var form = document.getElementById('nl-form');
    var success = document.getElementById('nl-success');
    if(!popup || !form) return;

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
    if(tab){
      tab.addEventListener('click', openPopup);
    }

    if(!alreadyHandled()){
      window.setTimeout(openPopup, 4000);
    } else if(tab && !isSubscribed()){
      tab.hidden = false;
    }

    form.addEventListener('submit', function(e){
      e.preventDefault();
      var data = new FormData(form);
      fetch('/', {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(data).toString()
      }).then(onSubscribed).catch(onSubscribed);
    });

    function onSubscribed(){
      form.hidden = true;
      if(success) success.hidden = false;
      try{ localStorage.setItem(SUBSCRIBED_KEY, '1'); }catch(e){}
      window.setTimeout(function(){ closePopup(false); }, 2200);
    }
  });
})();
