/* Sostituisce la griglia statica in artisti.html con le card lette da /api/public-artists
   (pannello aziendale). Se la fetch fallisce, il markup statico già nella pagina resta com'è —
   nessun rischio di pagina vuota. Va incluso prima di assets/interactive.js (stesso ordine di
   assets/events-render.js) così l'animazione "reveal" osserva anche queste card. */
(function(){
  function escapeHTML(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  }

  function cardHTML(a){
    var name = escapeHTML(a.name);
    var mediaInner = a.cardImageUrl
      ? '<img src="' + a.cardImageUrl + '" alt="' + name + '" loading="lazy" style="width:100%;height:100%;object-fit:cover;object-position:' + escapeHTML(a.cardImagePosition || 'center') + ';">'
      : '<span>' + name + '</span>';
    var mediaClass = a.cardImageUrl ? '' : ' dark';
    return (
      '<a class="ed-card reveal" href="' + a.pageUrl + '">' +
        '<div class="ed-card-media' + mediaClass + '">' + mediaInner + '</div>' +
        '<span class="tag">' + escapeHTML(a.role) + '</span>' +
        '<h3>' + name + '</h3>' +
      '</a>'
    );
  }

  var grid = document.getElementById('artisti-grid');
  if (!grid) return;

  fetch('/api/public-artists')
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      if (!data || !data.artists || !data.artists.length) return; // resta il fallback statico
      grid.innerHTML = data.artists.map(cardHTML).join('');
      grid.querySelectorAll('.reveal').forEach(function(card){ card.classList.add('is-visible'); });
    })
    .catch(function(){ /* resta il markup statico già in pagina */ });
})();
