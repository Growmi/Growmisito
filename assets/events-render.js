/* Divide GROWMI_EVENTS (assets/events-data.js) in prossimi/passati confrontando
   la data di ogni evento con oggi, e riempie le griglie nella pagina. Va eseguito
   dopo che i contenitori (#upcoming-events-grid, #past-events-grid, #next-event-grid)
   sono già nel documento, e prima di assets/i18n.js così le traduzioni si applicano
   anche alle card appena inserite. */
(function(){
  function todayISO(){
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

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
      ? '<span class="badge-soon" style="margin-top:14px;" data-i18n="ev_soon">Dettagli e biglietti in arrivo</span>'
      : '';
    return (
      '<a class="ed-card reveal" href="' + ev.url + '">' +
        '<div class="ed-card-media' + mediaClass + '">' + mediaInner + '</div>' +
        '<span class="tag">' + escapeHTML(ev.tag) + '</span>' +
        '<h3>' + title + '</h3>' +
        '<p class="meta">' + escapeHTML(ev.location) + '</p>' +
        badge +
      '</a>'
    );
  }

  function render(containerId, list, emptyKey, emptyFallback){
    var el = document.getElementById(containerId);
    if(!el) return;
    if(list.length === 0){
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.setAttribute('data-i18n', emptyKey);
      empty.textContent = emptyFallback;
      el.replaceWith(empty);
      return;
    }
    el.innerHTML = list.map(cardHTML).join('');
  }

  if(typeof GROWMI_EVENTS === 'undefined') return;

  var today = todayISO();
  var visible = GROWMI_EVENTS.filter(function(e){ return !e.draft; });
  var upcoming = visible.filter(function(e){ return e.date >= today; })
    .sort(function(a, b){ return a.date < b.date ? -1 : 1; });
  var past = visible.filter(function(e){ return e.date < today; })
    .sort(function(a, b){ return a.date > b.date ? -1 : 1; });

  render('upcoming-events-grid', upcoming, 'ev_empty', 'Nessun evento in programma al momento.');
  render('past-events-grid', past, 'ev_past_empty', 'Il primo evento deve ancora succedere — a breve la prima retrospettiva.');
  render('next-event-grid', upcoming.slice(0, 1), 'ev_empty', 'Nessun evento in programma al momento.');
})();
