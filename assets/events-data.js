/* Elenco unico di tutti gli eventi GrowMi.
   assets/events-render.js legge questa lista e mostra ogni evento automaticamente
   tra "prossimi eventi" o "eventi passati" confrontando il campo "date" con oggi —
   nessuno spostamento manuale necessario quando una data passa.

   Campi:
   - slug: identificativo breve, solo per riferimento
   - draft: true = evento non ancora pronto per il pubblico, non compare da nessuna
     parte (né prossimi né passati) finché non lo rimuovi o lo metti a false
   - title, tag (data/ora in maiuscolo), location, url: testo mostrato in pagina
   - date: formato AAAA-MM-GG, usato per decidere prossimo/passato e per l'ordine
   - cover: percorso immagine di copertina, oppure null per la card scura col solo testo
   - comingSoon: true = mostra il badge "Dettagli e biglietti in arrivo" (solo per
     eventi futuri senza prezzi/link Stripe ancora pronti)
   - ticketsAnchor: opzionale, es. "#mise-tickets" — se l'evento ha una sezione
     biglietti dedicata nella sua pagina, il menu a tendina "Biglietti" nell'header
     punta lì direttamente invece che all'inizio della pagina */
var GROWMI_EVENTS = [
  {
    slug: "miseducation",
    draft: false,
    title: "The Miseducation of GrowMI",
    date: "2026-09-10",
    tag: "GIO 10 SETT 2026 · APERTURA 19:00",
    location: "Art Mall Milano · Milano",
    url: "the-miseducation-of-growmi.html",
    cover: null,
    comingSoon: false,
    ticketsAnchor: "#mise-tickets"
  },
  {
    slug: "art-mall",
    title: "The Art of Being Yourself",
    date: "2026-06-04",
    tag: "4 GIUGNO 2026",
    location: "Art Mall · Milano",
    url: "art-mall-collab.html",
    cover: "assets/img/eventi/art-mall-collab/01.jpg"
  },
  {
    slug: "grow-with-us",
    title: "Grow With Us",
    date: "2025-05-06",
    tag: "6 MAGGIO 2025",
    location: "Black (by Mixum) · Milano",
    url: "grow-with-us.html",
    cover: "assets/img/eventi/grow-with-us/01.jpg"
  }
];
