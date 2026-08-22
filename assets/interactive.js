/* Livello "impatto": reveal allo scroll, cursore custom, hover magnetici sui bottoni.
   Va incluso DOPO che il contenuto dinamico (events-render.js) ha già popolato la pagina,
   così osserva anche le card generate via JS. Nessuna dipendenza esterna. */
(function(){
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasFinePointer = window.matchMedia('(hover:hover) and (pointer:fine)').matches;

  function initReveal(){
    var els = document.querySelectorAll('.reveal');
    if(reducedMotion || !('IntersectionObserver' in window)){
      els.forEach(function(el){ el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold:0.15, rootMargin:'0px 0px -40px 0px' });
    els.forEach(function(el){ io.observe(el); });
  }

  function initCursor(){
    if(!hasFinePointer || reducedMotion) return;
    var dot = document.createElement('div'); dot.className = 'cursor-dot';
    var ring = document.createElement('div'); ring.className = 'cursor-ring';
    document.body.appendChild(dot);
    document.body.appendChild(ring);
    document.documentElement.classList.add('has-custom-cursor');

    var tx = 0, ty = 0, rx = 0, ry = 0, started = false;
    window.addEventListener('mousemove', function(e){
      tx = e.clientX; ty = e.clientY;
      dot.style.left = tx + 'px'; dot.style.top = ty + 'px';
      if(!started){ rx = tx; ry = ty; started = true; }
    });
    (function loop(){
      rx += (tx - rx) * 0.18;
      ry += (ty - ry) * 0.18;
      ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
      requestAnimationFrame(loop);
    })();

    document.querySelectorAll('a, button').forEach(function(el){
      el.addEventListener('mouseenter', function(){ ring.classList.add('is-active'); });
      el.addEventListener('mouseleave', function(){ ring.classList.remove('is-active'); });
    });
  }

  function initMagnetic(){
    if(!hasFinePointer || reducedMotion) return;
    document.querySelectorAll('.ed-btn-ghost, .btn').forEach(function(btn){
      btn.addEventListener('mousemove', function(e){
        var r = btn.getBoundingClientRect();
        var x = e.clientX - r.left - r.width / 2;
        var y = e.clientY - r.top - r.height / 2;
        btn.style.transform = 'translate(' + (x * 0.18) + 'px,' + (y * 0.35) + 'px)';
      });
      btn.addEventListener('mouseleave', function(){ btn.style.transform = ''; });
    });
  }

  function initTriangleLink(){
    var triangle = document.querySelector('.ed-triangle');
    var pointsWrap = document.querySelector('.ed-tri-points');
    var points = document.querySelectorAll('.ed-tri-point[data-vertex]');
    if(!points.length) return;

    points.forEach(function(point){
      var name = point.getAttribute('data-vertex');
      var vertex = document.querySelector('.tri-vertex[data-vertex="' + name + '"]');
      if(!vertex) return;

      point.addEventListener('mouseenter', function(){
        if(!point.classList.contains('is-open')) vertex.classList.add('is-active');
      });
      point.addEventListener('mouseleave', function(){
        if(!point.classList.contains('is-open')) vertex.classList.remove('is-active');
      });

      function toggle(){
        var wasOpen = point.classList.contains('is-open');
        points.forEach(function(p){
          p.classList.remove('is-open');
          p.setAttribute('aria-expanded', 'false');
          var v = document.querySelector('.tri-vertex[data-vertex="' + p.getAttribute('data-vertex') + '"]');
          if(v) v.classList.remove('is-active');
        });
        if(triangle) triangle.className = triangle.className.replace(/\bzoom-\w+\b/g, '').trim();
        if(!wasOpen){
          point.classList.add('is-open');
          point.setAttribute('aria-expanded', 'true');
          vertex.classList.add('is-active');
          if(triangle) triangle.classList.add('zoom-' + name);
          if(pointsWrap) pointsWrap.classList.add('has-open');
        } else if(pointsWrap){
          pointsWrap.classList.remove('has-open');
        }
      }

      point.addEventListener('click', toggle);
      point.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(); }
      });
    });
  }

  function initCarousels(){
    document.querySelectorAll('.carousel').forEach(function(carousel){
      var track = carousel.querySelector('.carousel-track');
      var slides = track ? track.querySelectorAll('.carousel-slide') : [];
      if(!track || !slides.length) return;
      var prev = carousel.querySelector('.carousel-arrow.prev');
      var next = carousel.querySelector('.carousel-arrow.next');
      var dotsWrap = carousel.querySelector('.carousel-dots');

      var dots = [];
      if(dotsWrap){
        dotsWrap.innerHTML = '';
        slides.forEach(function(slide, i){
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'carousel-dot';
          dot.setAttribute('aria-label', 'Vai alla foto ' + (i + 1));
          dot.addEventListener('click', function(){
            slide.scrollIntoView({ behavior:'smooth', inline:'center', block:'nearest' });
          });
          dotsWrap.appendChild(dot);
        });
        dots = dotsWrap.querySelectorAll('.carousel-dot');
      }

      function updateActive(){
        var trackRect = track.getBoundingClientRect();
        var center = trackRect.left + trackRect.width / 2;
        var closest = 0, minDist = Infinity;
        slides.forEach(function(slide, i){
          var r = slide.getBoundingClientRect();
          var dist = Math.abs((r.left + r.width / 2) - center);
          if(dist < minDist){ minDist = dist; closest = i; }
        });
        dots.forEach(function(d, i){ d.classList.toggle('is-active', i === closest); });
      }

      var scrollTimer;
      track.addEventListener('scroll', function(){
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(updateActive, 80);
      }, { passive:true });
      updateActive();

      if(prev) prev.addEventListener('click', function(){
        track.scrollBy({ left: -(slides[0].offsetWidth + 20), behavior:'smooth' });
      });
      if(next) next.addEventListener('click', function(){
        track.scrollBy({ left: slides[0].offsetWidth + 20, behavior:'smooth' });
      });
    });
  }

  function initHeroSlideshow(){
    var slideshow = document.querySelector('.ed-hero-slideshow');
    var slides = document.querySelectorAll('.ed-hero-slide');
    if(!slideshow || slides.length < 2) return;
    var dotsWrap = document.querySelector('.ed-hero-dots');
    var i = 0;
    var timer;

    var dots = [];
    if(dotsWrap){
      slides.forEach(function(_, idx){
        var dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'ed-hero-dot';
        dot.setAttribute('aria-label', 'Vai alla foto ' + (idx + 1));
        dot.addEventListener('click', function(){ goTo(idx); restart(); });
        dotsWrap.appendChild(dot);
      });
      dots = dotsWrap.querySelectorAll('.ed-hero-dot');
    }

    function goTo(idx){
      slides[i].classList.remove('is-active');
      if(dots[i]) dots[i].classList.remove('is-active');
      i = idx;
      slides[i].classList.add('is-active');
      if(dots[i]) dots[i].classList.add('is-active');
    }
    function next(){ goTo((i + 1) % slides.length); }
    function restart(){
      window.clearInterval(timer);
      timer = window.setInterval(next, 4500);
    }

    if(dots[0]) dots[0].classList.add('is-active');
    restart();
  }

  function initLogosCluster(){
    var cluster = document.querySelector('.ed-logos-cluster');
    if(!cluster) return;
    var items = cluster.querySelectorAll('.ed-logo-item');
    items.forEach(function(item){
      item.addEventListener('click', function(){
        if(item.classList.contains('is-active')){
          item.classList.remove('is-active');
          cluster.classList.remove('zoom-active');
        } else {
          items.forEach(function(i){ i.classList.remove('is-active'); });
          item.classList.add('is-active');
          cluster.classList.add('zoom-active');
        }
      });
    });
  }

  function initTicketsOverlay(){
    var toggle = document.querySelector('.nav-tickets-toggle');
    var overlay = document.getElementById('tickets-overlay');
    var grid = document.getElementById('tickets-overlay-grid');
    if(!toggle || !overlay || !grid || typeof GROWMI_EVENTS === 'undefined') return;

    function escapeHTML(s){
      return String(s).replace(/[&<>"]/g, function(c){
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
      });
    }
    function cardHTML(ev){
      var title = escapeHTML(ev.title);
      var mediaInner = ev.cover
        ? '<img src="' + ev.cover + '" alt="' + title + '" loading="lazy" style="width:100%;height:100%;object-fit:cover;">'
        : '<span>' + title + '</span>';
      var mediaClass = ev.cover ? '' : ' dark';
      var badge = ev.comingSoon
        ? '<span class="badge-soon" style="margin-top:14px;">Dettagli e biglietti in arrivo</span>'
        : '';
      return (
        '<a class="ed-card" href="' + ev.url + (ev.ticketsAnchor || '') + '">' +
          '<div class="ed-card-media' + mediaClass + '">' + mediaInner + '</div>' +
          '<span class="tag">' + escapeHTML(ev.tag) + '</span>' +
          '<h3>' + title + '</h3>' +
          '<p class="meta">' + escapeHTML(ev.location) + '</p>' +
          badge +
        '</a>'
      );
    }

    function open(){
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      // filtro rifatto a ogni apertura: un evento la cui data è passata smette di
      // comparire da solo, senza bisogno di toccare nulla a mano
      var upcoming = GROWMI_EVENTS.filter(function(ev){
        if(ev.draft) return false;
        var d = new Date(ev.date + 'T00:00:00');
        return d >= today;
      }).sort(function(a, b){ return new Date(a.date) - new Date(b.date); });

      grid.innerHTML = upcoming.length
        ? upcoming.map(cardHTML).join('')
        : '<p class="tickets-overlay-empty">Nessun evento disponibile al momento.</p>';

      overlay.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
    function close(){
      if(overlay.hidden) return;
      var panel = overlay.querySelector('.tickets-overlay-panel');
      toggle.setAttribute('aria-expanded', 'false');
      panel.classList.add('is-closing');
      // timeout invece di animationend: cosi' la tendina si chiude comunque anche se
      // l'animazione viene saltata (prefers-reduced-motion) o interrotta
      setTimeout(function(){
        panel.classList.remove('is-closing');
        overlay.hidden = true;
      }, 280);
    }

    toggle.addEventListener('click', function(e){ e.preventDefault(); open(); });
    overlay.querySelectorAll('[data-tickets-close]').forEach(function(el){
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && !overlay.hidden) close();
    });
  }

  // Menu che si apre cliccando una card area del team (chi-siamo.html), stesso identico
  // meccanismo di apertura/chiusura di initTicketsOverlay qui sopra — cambia solo il contenuto
  // (persone dell'area invece di eventi) e il fatto che ci sono più bottoni che aprono lo
  // stesso overlay, uno per area. Sostituisce le pagine team-*.html separate: aggiungere o
  // togliere una persona significa modificare solo assets/team-data.js.
  function initTeamOverlay(){
    var triggers = document.querySelectorAll('[data-team-area]');
    var overlay = document.getElementById('team-overlay');
    var grid = document.getElementById('team-overlay-grid');
    var titleEl = document.getElementById('team-overlay-title');
    var leadEl = document.getElementById('team-overlay-lead');
    if(!triggers.length || !overlay || !grid || typeof GROWMI_TEAM === 'undefined') return;

    function escapeHTML(s){
      return String(s).replace(/[&<>"]/g, function(c){
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
      });
    }
    function memberHTML(m){
      return (
        '<div class="team-card">' +
          '<div class="team-photo"></div>' +
          '<h3>' + escapeHTML(m.name) + '</h3>' +
          '<p class="role">' + escapeHTML(m.role) + '</p>' +
        '</div>'
      );
    }

    function open(areaKey){
      var area = GROWMI_TEAM[areaKey];
      if(!area) return;
      titleEl.textContent = area.name;
      leadEl.textContent = area.lead || '';
      grid.innerHTML = area.members.map(memberHTML).join('');
      overlay.hidden = false;
      triggers.forEach(function(t){ t.setAttribute('aria-expanded', t.getAttribute('data-team-area') === areaKey ? 'true' : 'false'); });
    }
    function close(){
      if(overlay.hidden) return;
      var panel = overlay.querySelector('.tickets-overlay-panel');
      triggers.forEach(function(t){ t.setAttribute('aria-expanded', 'false'); });
      panel.classList.add('is-closing');
      setTimeout(function(){
        panel.classList.remove('is-closing');
        overlay.hidden = true;
      }, 280);
    }

    triggers.forEach(function(trigger){
      trigger.addEventListener('click', function(){ open(trigger.getAttribute('data-team-area')); });
    });
    overlay.querySelectorAll('[data-team-close]').forEach(function(el){
      el.addEventListener('click', close);
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape' && !overlay.hidden) close();
    });
  }

  // dissolvenza in uscita quando si clicca un link interno verso un'altra pagina del sito,
  // cosi' il passaggio da una pagina all'altra non è un cambio secco. Va in fondo al bootstrap
  // cosi' il suo listener sul click gira per ultimo: se un altro handler ha già gestito il click
  // (es. il toggle "Biglietti", i popup) e ha chiamato preventDefault, qui non si fa nulla.
  function initPageTransitions(){
    document.addEventListener('click', function(e){
      if(e.defaultPrevented || e.button !== 0) return;
      if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var link = e.target.closest('a[href]');
      if(!link || link.target === '_blank' || link.hasAttribute('download')) return;
      var href = link.getAttribute('href');
      if(!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
      if(link.hostname !== window.location.hostname) return;
      e.preventDefault();
      document.body.classList.add('page-leaving');
      setTimeout(function(){ window.location.href = link.href; }, 550);
    });
  }

  initReveal();
  initCursor();
  initMagnetic();
  initTriangleLink();
  initCarousels();
  initHeroSlideshow();
  initLogosCluster();
  // se la pagina viene ripristinata dalla cache del browser (bfcache) a metà di una dissolvenza
  // in uscita, resterebbe bloccata invisibile: qui si toglie quello stato. L'animazione di
  // rientro vera e propria è già decisa PRIMA che questo script giri, da uno script inline in <head>.
  window.addEventListener('pageshow', function(){
    document.body.classList.remove('page-leaving');
  });

  initTicketsOverlay();
  initTeamOverlay();
  initPageTransitions();
})();
