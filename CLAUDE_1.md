# Progetto GrowMi — Sito web

## Cos'è GrowMi
GrowMi è un progetto che promuove artisti emergenti (cantautori, producer, DJ, creativi visivi)
attraverso eventi dal vivo a Milano, in collaborazione con locali della città.
Target: 15-35 anni, focus su universitari (18-25, area Bocconi). Milano e dintorni.

## Struttura del sito
Sito statico multi-pagina, nessun framework, nessun build step:
- index.html — Home
- eventi.html — Eventi + acquisto biglietti
- artisti.html — Artisti
- chi-siamo.html — Chi siamo + fondatori
- contatti.html — Contatti (form via Netlify Forms)
- assets/style.css — tutti gli stili, palette e font
- assets/i18n.js — tutte le traduzioni IT/EN (attributi data-i18n nell'HTML)

## Identità di brand
- Palette colori ufficiale: #3E0D5D (viola scuro, base/hero/footer), #B867CD (lilla),
  #F86639 (arancio corallo, colore principale CTA), #FDC631 (giallo, accenti)
- Font titoli: Space Grotesk (geometrico, bold)
- Font testo: Inter
- Logo: wordmark "growmi" nero con outline rosa/magenta e stella

## Hosting e deploy
- Codice su GitHub, repository "Growmi-sito"
- Pubblicato su Netlify, collegato al repo: ogni push su GitHub ripubblica il sito in automatico
- Non serve alcun comando di build: sono file HTML/CSS/JS statici

## Ticketing
- I biglietti si vendono tramite Stripe Payment Links (uno per ogni tipologia di biglietto
  per evento: Early bird / Standard / VIP), creati manualmente dalla dashboard Stripe.
- In eventi.html, ogni bottone "Acquista" ha un href da sostituire con il Payment Link reale.
- Non c'è backend: niente Node/Express, niente chiavi segrete Stripe nel codice.
- Conteggio automatico posti non prioritario per ora (Stripe può gestirlo via limite quantità
  sul Payment Link, se serve in futuro).

## Evento reale: "the miseducation of growmi"
- 10 settembre 2026, Art Mall Milano, apertura 19:00, dress code street wear
- Pagina dedicata: the-miseducation-of-growmi.html (tema hip-hop/graffiti a parte, vedi assets/event-miseducation.css)
- Lineup confermata: Lorenzo Vergani (live graffiti 19:00-23:30, scritta GROWMI + personalizzazione fogli A4 a 3€/persona),
  Lucevera (live sul palco principale 20:45-21:30, scenografia curata con Lulita), Mattia Pagliarin (DJ set 21:30-23:30,
  stanza piccola)
- Card di rimando a questa pagina in eventi.html e nella home (i vecchi eventi demo placeholder sono stati rimossi)

## Contenuti ancora da personalizzare
- Foto artisti (Lucevera, Mattia Pagliarin, Lorenzo Vergani già inseriti come nomi in artisti.html, foto ancora
  sfondi colorati placeholder in .artist-photo) — altri artisti verranno aggiunti man mano
- Foto team fondatori in chi-siamo.html (ora sfondi colorati placeholder in .team-photo) e foto/locandina evento
- Prezzi e Payment Link Stripe per i 3 tier (Early bird/Standard/VIP) di "the miseducation of growmi" — l'utente li definirà
  più avanti, per ora i bottoni mostrano un badge "Presto disponibile" invece di un link finto
- Sezione Staff in chi-siamo.html: struttura pronta (eyebrow "Staff" + empty-state "Il team completo arriva presto"
  + CTA "Candidati" verso contatti.html), da riempire quando l'utente dà nomi/ruoli/foto dello staff
- Sezione "Eventi passati" in eventi.html: struttura pronta con empty-state, ogni evento passato avrà una pagina
  dedicata come the-miseducation-of-growmi.html con una card di rimando in questa sezione
- Sezione sponsor/partner: da creare, servono nomi e loghi
- Financial Supporters: pagina dedicata financial-supporters.html (linkata da un teaser in chi-siamo.html e dal
  footer "Sito" di tutte le pagine) — badge "Dettagli in arrivo", sezione "Come funziona" e 3 esempi di possibili
  vantaggi chiaramente etichettati come non definitivi ("Soglie, quote e vantaggi definitivi sono ancora in
  lavorazione"). Nessun prezzo o beneficio reale inventato, solo direzione/struttura. Palette ink+magenta per il
  tono più esclusivo, coerente con la loyalty card.
- Modulo "entra come staff": non è un form a parte, riusa il form contatti esistente — aggiunta l'opzione
  "Voglio entrare nello staff" al menu a tendina motivo del contatto, raggiungibile dalla sezione Staff
- Stessa logica per i financial supporter: opzione "Voglio diventare financial supporter" aggiunta al menu a
  tendina del form contatti

## Contenuti già personalizzati
- Email di contatto reale: grow.mi@outlook.it (sostituita ovunque a info@growmi.it)
- Link social reali in tutti i footer + sezioni dedicate (contatti.html, chi-siamo.html):
  Instagram https://www.instagram.com/growmiii/ · TikTok https://www.tiktok.com/@growmii_ ·
  YouTube https://www.youtube.com/@GrowMiii · LinkedIn https://www.linkedin.com/company/growmiagency/
- Testo "Chi siamo" sostituito con quello reale del post LinkedIn di GrowMi (IT + traduzione EN)
- Popup newsletter su tutte le pagine (assets/newsletter.js + markup .nl-popup): il guscio (apertura dopo qualche secondo,
  chiusura, promemoria scelta, linguetta di riapertura) resta nostro, ma il form iscrizione vero e proprio è l'embed
  ufficiale di MailerLite (account id 2351466, form id 196308997987370118, gruppo collegato lato MailerLite) —
  stile in assets/mailerlite-form.css, script MailerLite (webforms.min.js + reCAPTCHA) caricati inline nel markup del
  popup. Le iscrizioni finiscono davvero nella lista MailerLite dell'utente, non solo su Netlify. newsletter.js aggancia
  il callback globale ml_webform_success_45022886 per richiudere il nostro popup dopo l'iscrizione riuscita.
  I testi del form MailerLite sono agganciati al cambio lingua IT/EN tramite data-i18n (chiavi nl_eyebrow, nl_title,
  nl_lead, nl_email_placeholder, nl_fine, nl_consent, nl_submit, nl_success_title, nl_success in assets/i18n.js) —
  eccetto l'eyebrow "Newsletter" e h4/testo che sono dentro al form MailerLite ma comunque taggati. I font (Space
  Grotesk per titoli/bottone, Inter per il resto) sono forzati via assets/mailerlite-form.css per restare coerenti
  col resto del sito, sovrascrivendo l'Open Sans di default di MailerLite.
- Oltre al popup, ogni pagina ha anche una sezione fissa "Newsletter" (stile .cta-band) subito prima del footer,
  con un bottone che apre lo stesso popup (attributo data-nl-open, gestito in assets/newsletter.js) invece di avere
  un secondo embed MailerLite duplicato (avrebbe creato id duplicati e conflitti con lo script di MailerLite).

## Loyalty Card
- Pagina dedicata: loyalty-card.html (linkata nel footer "Sito" di tutte le pagine)
- Solo vetrina/spiegazione per ora, NIENTE registrazione utenti/account/database — decisione esplicita dell'utente:
  "vogliamo lasciarla esclusiva". Se in futuro si vuole un vero sistema con account, tessera con QR e storico
  acquisti (tipo Ticketone), serve Supabase o simile + passaggio da Stripe Payment Link a Stripe Checkout — discusso
  ma non ancora avviato.
- Premi confermati: al 3° evento un drink offerto, al 5° evento ingresso gratuito
- Card digitale interattiva ricreata in CSS/HTML (non immagini) con flip 3D al click/tocco (classi .loyalty-card /
  .loyalty-card-inner / .loyalty-card-face, transform:rotateY), fronte e retro basati sul design reale che l'utente
  ha fornito (logo, "LOYALTY CARD", 5 timbri di cui il 3° è un'icona drink e il 5° una stella piena)
  Palette dedicata: --magenta:#E0217A e --loy-cream:#F0DCC5 in assets/style.css (colori del materiale reale del
  brand, non ancora usati altrove nel sito)

## Direzione grafica editoriale (approvata ed estesa a tutto il sito)
- Ispirata a outpump.com (magazine street/cultura milanese: card guidate dall'immagine, piccoli tag categoria
  maiuscoli, poco "bordi e pillole") e apple.com (scala tipografica grande, tanto spazio, tono sicuro/minimale)
- Foglio dedicato assets/redesign.css con classi .ed-* (ed-hero, ed-eyebrow, ed-lead, ed-btn-ghost, ed-triangle,
  ed-card, ed-value-list, ed-cta) — linkato in TUTTE le pagine tranne che non serve dove non usato
- Estesa a: index.html, eventi.html, artisti.html, chi-siamo.html, contatti.html, loyalty-card.html,
  financial-supporters.html. Anche la sezione Newsletter finale di the-miseducation-of-growmi.html usa .ed-cta
  per coerenza, ma il resto di quella pagina mantiene volutamente la sua identità dark/graffiti a sé (ha senso
  restare diversa, è la pagina di una serata a tema)
- Le vecchie classi .hero-dark/.value-card/.ticket/.section-head restano ancora definite in assets/style.css
  (non cancellate, per compatibilità/riferimento) ma non sono più usate da nessuna pagina tranne
  the-miseducation-of-growmi.html — si potrebbero ripulire in futuro se si conferma che non servono più
- Fatto (versione finale): video "cos'è GrowMi" ospitato nativamente in chi-siamo.html (tag &lt;video&gt;, file in
  assets/video/cos-e-growmi.mp4, 39 secondi, ~4.4MB) — niente più embed/iframe Instagram, l'utente ha mandato il
  file mp4 originale (suo contenuto) per evitare qualsiasi rimando a Instagram. Se si vogliono aggiungere altri
  video in futuro, stesso schema: salvare l'mp4 in assets/video/ e duplicare il tag &lt;video&gt;.

## Eventi passati
- Foto reali fornite dall'utente dalla cartella locale "Desktop/foto growemi/", organizzata in sottocartelle per
  evento (7 maggio 2025, 4 giugno 2026) — foto di Alice Amoruso, originali 3-8MB l'una, ridimensionate a 1400px
  di larghezza e compresse (qualità JPEG 78) con .claude/resize-event-photos.ps1, salvate in
  assets/img/eventi/<slug-evento>/01.jpg, 02.jpg... (60-190KB l'una)
- grow-with-us.html: "grow with us", 7 maggio 2025, Black (by Mixum) Milano — primo evento esclusivo GrowMi,
  tema denim party (contest miglior outfit denim), sponsor Pogo Store, DJ Lorenzo, 6 foto
- art-mall-collab.html: "The Art of Being Yourself" (titolo ufficiale, url file rimasto art-mall-collab.html),
  4 giugno 2026, Art Mall Milano — segna l'inizio della collaborazione con il locale Art Mall, stesso
  meccanismo contest outfit del 7 maggio ma con due sponsor: Pogo Store e Dischi Volanti, 13 foto
- Entrambe le pagine seguono lo stesso schema editoriale (.ed-*) delle altre pagine, con galleria fotografica
  (.ed-gallery, nuova classe in assets/redesign.css) e credito fotografo "Foto di Alice Amoruso"
- eventi.html sezione "Eventi passati": ora mostra 2 card reali (non più empty-state) che linkano a queste
  pagine, con foto di copertina
- IMPORTANTE per il prossimo caricamento su GitHub: servono anche le nuove cartelle assets/img/eventi/grow-with-us/
  e assets/img/eventi/art-mall-collab/ (immagini), oltre ai file HTML nuovi grow-with-us.html e art-mall-collab.html

## Bande CTA finali (newsletter, "torna agli eventi")
- Bug corretto: le bande .ed-cta usavano lo stesso padding (110px) sia per CTA principali (es. "Vuoi collaborare
  con GrowMi?") sia per quelle secondarie/di servizio (Newsletter, "Tutti gli eventi"), creando troppo spazio
  vuoto quando il contenuto era breve, e quando due bande si susseguivano si fondevano senza distinzione visiva
- Aggiunta classe .ed-cta.compact (padding ridotto a 56px, titolo più piccolo) in assets/redesign.css, applicata
  alla banda Newsletter su TUTTE le pagine e alla banda "Tutti gli eventi" sulle pagine evento passato
- Aggiunto separatore automatico via CSS (.ed-cta + .ed-cta{border-top}) quando due bande .ed-cta sono una di
  seguito all'altra — nessuna modifica al markup necessaria per questo, scatta da solo

## Menu mobile
- Bug corretto: sotto i 900px il menu (.navlinks) spariva del tutto senza alternativa (nessun hamburger),
  rendendo il sito non navigabile da telefono/schermi stretti — probabile causa di "non si vede la preview"
- Aggiunto bottone hamburger (.nav-toggle, 3 barre, animazione a X quando aperto) in ogni header, CSS in
  assets/style.css, logica in assets/i18n.js (funzione growmiInitNavToggle, scritta per funzionare anche con più
  header nello stesso documento — importante per il file di anteprima bundlizzato che unisce tutte le pagine)

## Sistema eventi automatico (prossimi vs passati)
- Prima gli eventi erano scritti a mano nell'HTML di eventi.html e index.html, quindi spostare un evento da
  "prossimi" a "passati" andava fatto manualmente. Sostituito con un sistema a dati:
  assets/events-data.js contiene l'array GROWMI_EVENTS, un'unica lista con tutti gli eventi (slug, title,
  date in formato AAAA-MM-GG, tag, location, url, cover, comingSoon, draft)
- assets/events-render.js legge quella lista, confronta ogni "date" con la data di oggi e riempie da solo i
  contenitori vuoti in pagina: #upcoming-events-grid e #past-events-grid in eventi.html, #next-event-grid in
  index.html. Prossimi eventi in ordine crescente (il più vicino prima), passati in ordine decrescente (il più
  recente prima). Va eseguito PRIMA di assets/i18n.js, così le traduzioni si applicano anche alle card appena
  generate via JS
- Campo draft:true nasconde completamente un evento (né prossimi né passati) indipendentemente dalla data —
  usato per "The Miseducation of GrowMI" (10 settembre 2026) finché non è pronto per il pubblico
- Per aggiungere/modificare/rinominare un evento ora basta modificare assets/events-data.js: non serve più
  toccare l'HTML di eventi.html o index.html, e il passaggio da prossimo a passato avviene da solo il giorno
  dopo la data dell'evento, senza bisogno di intervento manuale
- Ordine attuale in GROWMI_EVENTS: "The Miseducation of GrowMI" (draft), "The Art of Being Yourself" (ex
  "GrowMi x Art Mall", 4 giugno 2026 — titolo aggiornato anche nella pagina dedicata art-mall-collab.html:
  title, h1, meta description e alt delle foto), "Grow With Us" (7 maggio 2025)

## Note per Claude Code
- Mantieni sempre la struttura a più file HTML statici (non convertire in framework tipo
  React/Next.js a meno che l'utente lo chieda esplicitamente)
- Ogni nuovo testo visibile all'utente deve avere sia la versione IT che EN in assets/i18n.js
  tramite attributo data-i18n, per restare coerente col sistema bilingue esistente
- Non introdurre dipendenze da backend/server: il sito deve restare deployabile su Netlify
  come sito statico
- Il modulo di contatto usa Netlify Forms (attributo data-netlify="true") — funziona solo
  una volta pubblicato su Netlify, non in locale
