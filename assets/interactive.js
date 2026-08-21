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

  initReveal();
  initCursor();
  initMagnetic();
  initTriangleLink();
  initCarousels();
  initHeroSlideshow();
  initLogosCluster();
})();
