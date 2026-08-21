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
- loyalty-card.html — Loyalty Card (informativa, no registrazione utente)
- financial-supporters.html — Financial Supporters
- chi-siamo.html — Chi siamo + fondatori
- contatti.html — Contatti (form via Netlify Forms)
- assets/style.css — tutti gli stili, palette e font
- assets/i18n.js — tutte le traduzioni IT/EN (attributi data-i18n nell'HTML)

Il menu principale (header, su tutte le pagine) ha 7 voci, in quest'ordine: Home, Eventi, Artisti,
Loyalty Card ("Carta fedeltà" in IT, "Loyalty Card" in EN — nome invariato in EN perché è un termine
già di uso comune), Financial Supporters ("Supportaci" in IT, "Support us" in EN — nomi tradotti,
diversi dal titolo interno della pagina che resta "Financial Supporters"), Chi siamo, Contatti. Sotto i
1040px scatta il menu hamburger (soglia alzata da 900px per fare spazio alle 7 voci senza andare a capo
su schermi medi tipo tablet/laptop piccoli).

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

## Livello "impatto" — texture, movimento, micro-interazioni (in corso, per ora solo su index.html e art-mall-collab.html)
- Richiesta dell'utente: rendere il sito più "artistico, originale, impattante", ispirandosi a siti di agenzie
  musica/arte (outpump.com già usato per la direzione editoriale di base; poi anche tridentmusic.it per la
  qualità dell'interazione — non replicato letteralmente il carosello di grandi nomi, GrowMi non ha ancora quel
  roster, ma preso come riferimento di "qualità/fluidità del movimento"). Vincolo esplicito: deve restare
  MINIMAL, non solo massimalista/rumoroso — micro-interazioni sobrie, non invasive
- Nuovi file assets/interactive.css + assets/interactive.js, pensati come livello aggiuntivo sopra
  redesign.css/style.css, non li sostituiscono. Cosa fanno: texture di grana leggera su tutto il body (via
  body::after, SVG feTurbulence data-uri), classe .reveal + IntersectionObserver per animazioni fade/slide
  all'ingresso in viewport (rispetta prefers-reduced-motion), cursore custom puntino+anello solo su desktop con
  mouse (media query hover:hover + pointer:fine), bottoni magnetici (.ed-btn-ghost/.btn seguono leggermente il
  cursore), ticker orizzontale infinito (.marquee-band, usato per ora solo in index.html), macchie di colore
  sfocate e animate nell'hero (.blob, solo index.html), hover più vivi su .ed-card e .ed-tri-point
- events-render.js genera le card evento con classe "reveal" già inclusa, quindi l'animazione allo scroll
  copre automaticamente le card ovunque vengano usate (index.html, eventi.html), anche se interactive.css/js
  non sono ancora linkati in eventi.html stessa
- AGGIORNAMENTO: interactive.css/interactive.js sono ora linkati in TUTTE le pagine del sito (richiesta
  esplicita: "utilizza il cursore che ho nella home per tutto il sito") — aggiunti a artisti.html, chi-siamo.html,
  contatti.html, eventi.html, financial-supporters.html, grow-with-us.html, loyalty-card.html,
  the-miseducation-of-growmi.html (mancavano solo questi 8; index.html e art-mall-collab.html li avevano già).
  Il cursore custom si attiva solo su desktop con mouse (media query hover:hover + pointer:fine), quindi su
  mobile/touch non cambia nulla
- Nota tecnica: in ambiente di test sandboxato (browser automatizzato di Claude Code) IntersectionObserver e
  screenshot non sono affidabili quando il pannello non è a fuoco/visibile — verificato invece che la logica
  CSS/JS sia corretta testando i pezzi singolarmente (toggle classi, IntersectionObserver "vuoto" senza
  rootMargin custom). In un browser vero dell'utente questi effetti funzionano normalmente
- .claude/build-preview.ps1 e .claude/serve.ps1 sono stati ricreati da zero in questa cartella (erano andati
  persi nel trasferimento a Growmisito) — build-preview.ps1 ora include anche interactive.css/interactive.js
  nel bundle della preview condivisa

## Triangolo GrowMi interattivo (index.html)
- Il cerchio centrale non ha più testo scritto a mano in SVG ("growmi★") ma il vero logo
  (assets/img/logo-growmi.png, 824x303px, quindi rettangolare largo) inserito via <image> dentro l'SVG, con
  cerchio crema + bordo corallo dietro. ATTENZIONE se lo si ritocca: il logo NON è quadrato, quindi va usato
  preserveAspectRatio="xMidYMid meet" (adatta per intero, senza tagliare) e NON "slice" (che invece
  "riempie" il box tagliando i lati — bug reale riscontrato e corretto, il logo veniva mostrato tagliato a metà)
- I 3 vertici del triangolo (PUBBLICO/LOCALI/ARTISTI) hanno un pallino .tri-vertex con data-vertex
  ("pubblico"/"locali"/"artisti"); passando il mouse sul blocco testuale corrispondente in .ed-tri-points
  (che ha lo stesso data-vertex) il pallino si illumina (classe .is-active, gestito in
  assets/interactive.js → initTriangleLink())
- Il logo centrale ha un piccolo effetto hover (scale+rotate) via .tri-center:hover in interactive.css
- Click su un punto (01/02/03): la descrizione (<p class="tri-desc">) è nascosta di default (max-height:0) e
  si apre a fisarmonica solo al click — un solo punto aperto alla volta (accordion). Contemporaneamente il
  triangolo SVG (classe .tri-svg) fa uno zoom marcato e ruota (scale 1.6 + rotate ±10deg, transform-origin
  sul vertice cliccato) via le classi .ed-triangle.zoom-pubblico/zoom-locali/zoom-artisti — aggiornato dopo
  feedback dell'utente ("più accentuato, con rotazione"), la prima versione era solo scale(1.22) senza
  rotazione, troppo debole. Il punto aperto ha anche un bordo sinistro + ombra magenta che si "accende"
  (.ed-tri-point.is-open) per dare la sensazione visiva di collegamento fra il vertice e la descrizione.
  Aggiunto body{overflow-x:hidden} in style.css come rete di sicurezza dato lo zoom marcato. Tutta la logica
  in assets/interactive.js → initTriangleLink(). Accessibile da tastiera (tabindex, Enter/Spazio, aria-expanded)

## Zoom del triangolo: rifiniture finali
- Le scritte SVG PUBBLICO/ARTISTI/LOCALI ora spariscono (transition .15s, veloce apposta su richiesta
  dell'utente) non appena parte lo zoom/rotazione di un punto, e ricompaiono quando si torna allo stato
  normale — evita che il testo si veda storto/capovolto mentre ruota
- I tre pallini colorati sui vertici (.tri-vertex) sono stati spostati di pochissimo verso l'ESTERNO del
  triangolo (es. pubblico da cy=20 a cy=12) rispetto al punto esatto dove le due linee del triangolo si
  incontrano — il bagliore magenta (drop-shadow) attorno al pallino attivo risultava tagliato/asimmetrico
  quando il pallino stava esattamente sopra l'incrocio delle linee. I vertici del POLIGONO (la forma del
  triangolo stesso) restano invariati, si è mosso solo il pallino decorativo

## Zoom del triangolo reso molto più estremo (più giri di feedback, versione finale)
- Percorso: v1 scale(1.22) senza rotazione → "più accentuato, con rotazione" → v2 scale(1.6)+rotate(10deg) →
  "deve essere maggiore, tanto che scompare il resto" → v3 scale(2.6) dentro un frame che ritaglia
  (.tri-svg-frame, overflow:hidden, aspect-ratio 400/340) + i due vertici/etichette non attivi spariscono
  (opacity:0 su [data-vertex], sia sui cerchietti .tri-vertex sia sui tre <text> SVG, che ora hanno anche
  loro data-vertex="pubblico/locali/artisti") → bug: spazio bianco sotto quando la lista collassava (vedi
  sezione dedicata più sotto) → "aumenta la rotazione", "il rettangolo della descrizione deve ampliarsi e
  coprire gli altri due punti" → v4 ATTUALE:
  - rotazione portata a 20deg (era 10deg) su tutti e tre i vertici
  - transform-origin UNIFICATO a "8% 88%" per tutti e tre gli zoom (prima ognuno zoomava verso il proprio
    angolo con origin diverso) — richiesta esplicita: "porta ogni punto al centro, in linea a dove hai
    posizionato il punto 02" (punto 02 = artisti, che aveva già origin 8% 88%)
  - il riquadro del punto aperto (.ed-tri-point.is-open) ora è position:absolute; inset:0 dentro
    .ed-tri-points (che ha position:relative + min-height:210px per dargli spazio), con sfondo crema,
    bordo magenta, ombra e un'animazione di comparsa "pop" (@keyframes triCardPop, scale+opacity) — copre
    letteralmente gli altri due punti (che restano sotto, affievoliti a opacity:.25)
- Aggiunto body{overflow-x:hidden} in style.css come rete di sicurezza per uno zoom così marcato

## Carosello immagini in home (index.html)
- Richiesto dall'utente, per ora con 4 slide PLACEHOLDER (sfondo sfumato lilla/viola, testo "Foto in arrivo"/
  "Photos coming soon") — le 4 foto vere sono state mandate in chat ma NON risultano salvate da nessuna parte
  sul PC dell'utente (a differenza di altre immagini arrivate prima, queste non sono state salvate
  automaticamente in Download né in "foto growmi" — verificato con ricerca esplicita, nulla trovato).
  IN ATTESA che l'utente le salvi manualmente e confermi, poi sostituire i placeholder con le foto vere
- Sezione "GrowMi in scatti" tra "Il valore di GrowMi" e la banda CTA finale
- Layout finale (dopo un correzione): NIENTE frecce prev/next (rimosse), pallini di navigazione in COLONNA
  VERTICALE sulla destra del carosello (classe .carousel-dots.vertical in assets/redesign.css), non più
  orizzontali sotto come nella primissima versione — richiesta esplicita dell'utente
- Componente riutilizzabile: .carousel/.carousel-track/.carousel-slide/.carousel-dots(.vertical) in
  assets/redesign.css (scroll-snap nativo, swipe touch gratis), logica pallini attivi in
  assets/interactive.js → initCarousels()
- QUANDO ARRIVANO LE FOTO VERE: sostituire ogni <div class="carousel-slide placeholder"><span data-i18n=
  "gallery_placeholder">...</span></div> con <div class="carousel-slide"><img src="assets/img/..." alt="...">
  </div> — la struttura/CSS/JS del carosello restano identici, cambia solo il contenuto delle slide

## BUG VERO E IMPORTANTE: le foto/video di sfondo dell'hero erano invisibili (non era cache!)
- Per moltissimi giri di conversazione l'utente ha segnalato "non si vedono le foto/il video di sfondo" e
  ogni volta è stato verificato (struttura HTML, embedding base64 nel bundle, opacity via JS) che tutto
  sembrava corretto — sbagliando a concludere che fosse un problema di cache del browser/della preview.
  L'utente ha poi aperto uno ZIP scaricato in locale (quindi impossibile che fosse cache) e ANCHE LÌ le foto
  non si vedevano: era un bug vero, di stacking CSS
- CAUSA REALE: .ed-hero ha `position:relative` ma NESSUN z-index. Per specifica CSS, position:relative da
  solo (senza z-index) NON crea un nuovo "stacking context" — quindi i figli con z-index negativo
  (.ed-hero-slideshow a z-index:-3, .ed-hero-video a z-index:-2 ecc, usati per mettere foto/video DIETRO al
  testo ma SOPRA lo sfondo della sezione) "sfuggivano" fino allo stacking context della pagina intera,
  finendo disegnati SOTTO lo sfondo opaco `background:var(--ink)` della sezione stessa invece che sopra —
  quindi la foto/il video c'erano, caricavano correttamente, ma erano completamente nascosti dietro un
  muro di colore, invisibili al 100% in QUALSIASI browser reale (non solo nel sandbox di test)
- FIX (una riga, in assets/redesign.css, regola `.ed-hero`): aggiunto `z-index:0` accanto a
  `position:relative`. Questo forza .ed-hero a creare il proprio stacking context locale, cosi' i figli con
  z-index negativo si posizionano correttamente SOPRA lo sfondo della sezione (che diventa il "fondo" di
  quello stacking context) invece che sfuggire altrove. Risolve SIA il carosello foto in home SIA il video
  di contatti.html con la stessa identica correzione, perche' condividono lo stesso componente .ed-hero
- LEZIONE per il futuro: quando si usa `position:relative` + `z-index` negativo sui figli per un effetto
  "immagine di sfondo dietro al testo ma sopra il colore di sfondo", il genitore relative DEVE avere anche
  un suo z-index esplicito (anche solo 0), altrimenti il layer di sfondo puo' finire nascosto in modo
  silenzioso — bug facile da non notare in ambienti di test senza screenshot reali (verificabile pero' con
  `document.elementFromPoint(x,y)` per controllare l'ordine di disegno reale, tecnica usata per diagnosticarlo)
- Rifiniture collegate fatte nello stesso giro: overlay scuro sopra le foto ridotto da opacity .6 a .42 (le
  foto ora si vedono meglio), macchia magenta decorativa (.blob-1) nell'hero nascosta (display:none) su
  richiesta dell'utente, triangolo GrowMi ingrandito su schermi larghi (.tri-svg-frame max-width sale a
  560px sopra i 1400px e 640px sopra i 1800px, via media query — le percentuali dello zoom restano valide
  senza doverle ricalcolare, dato che sono relative alla dimensione dell'elemento stesso)

## Bottoni CTA con rettangolo bianco + icone social vere
- I bottoni dentro le bande viola (.ed-cta) — "Vai ai contatti", "Iscrivimi" — ora hanno uno sfondo bianco/
  crema con angoli arrotondati (.ed-cta .ed-btn-ghost in redesign.css) invece del semplice link sottolineato.
  Attenzione: la regola è scoped a `.ed-cta .ed-btn-ghost`, quindi i bottoni FUORI dalle bande CTA (es. quelli
  dell'hero "Vedi i prossimi eventi") restano link sottolineati come prima — è così che è stato chiesto,
  non un'incoerenza
- Icone social in chi-siamo.html (sezione "Seguici", .social-row): prima erano sigle testuali (IG/TT/YT/LI),
  ora SVG inline con la forma semplificata di ciascun logo (non i file ufficiali scaricati — nessun problema
  di copyright/trademark, leggerissimi, colorati via currentColor quindi seguono automaticamente il colore
  del sito)

## Altre rifiniture (triangolo rimpicciolito, ticker, footer)
- Bug corretto: la descrizione del punto del triangolo era rimasta SEMPRE visibile per errore (persa la
  regola max-height:0/opacity:0 di default durante una modifica precedente) — ripristinata, ora si vede
  solo quando il punto è aperto
- La scritta "PUBBLICO" veniva tagliata dal ritaglio della cornice in alto. Soluzione (su suggerimento
  dell'utente): rimpicciolito leggermente TUTTO il contenuto del triangolo (polygon, vertici, cerchio
  centrale, testi) con un gruppo SVG <g class="tri-shrink" transform="translate(200,170) scale(0.88)
  translate(-200,-170)">, che crea margine su tutti i lati senza toccare viewBox/frame. Le coordinate dei
  vertici sono quindi CAMBIATE (pubblico ora a 200,32.72 invece di 200,20 ecc. dopo la trasformazione) — i
  valori di translate% per lo zoom sono stati ricalcolati e riverificati da capo con lo stesso metodo di
  misura nel browser
- Ticker orizzontale (.marquee-track): il punto di giunzione tra le due copie del testo aveva uno spazio
  (padding-right) troppo grande (48px) rispetto alla spaziatura interna delle parole, si notava come un
  salto innaturale — ridotto a 16px
- Footer: aggiunta una barra divisoria più marcata (2px) tra l'ultima banda CTA (newsletter) e il footer,
  che prima si fondevano essendo dello stesso colore viola senza alcuna separazione. Su schermi molto larghi
  (footer .wrap) il contenitore del footer ora arriva a 1600px (invece di 1180px come il resto del sito),
  cosi' le colonne si distribuiscono su piu' spazio invece di restare compresse al centro

## Rifiniture finali post-lancio
- Foto vere dello slideshow hero: arrivate e collegate (assets/img/home/slide-01/02/03.jpg — concerto Art
  Mall, ingresso locale Black, DJ Lorenzo). Non più placeholder
- Posizione finale del pallino/vertice attivo nel triangolo zoomato: 86% orizzontale (non 90% o 95%, tagliavano
  il pallino/alone), 50% verticale (centrato, non 35% — tentativo scartato dopo verifica con l'utente)
- Testo PUBBLICO/ARTISTI/LOCALI: sparizione veloce (.15s) quando parte lo zoom, ricomparsa lenta (.7s) quando
  si esce — durate diverse in entrata/uscita ottenute con due regole CSS separate sullo stesso selettore
  (transition sulla regola base = quella usata quando si TORNA allo stato senza zoom)
- Riga separatrice nel footer (sopra "© 2026 GrowMi"): prima si fermava alla larghezza del contenitore
  centrale (max 1180px), ora arriva da un bordo all'altro della finestra con la tecnica del "full-bleed"
  (::before position:absolute, width:100vw, left:50%, margin-left:-50vw) — vedi .foot-bottom in style.css

## Carosello spostato nell'hero della home (slideshow di sfondo, non più sezione a parte)
- L'utente ha chiesto di spostare il carosello "in alto dove c'è scritto Free to be GrowMi, come sfondo" —
  rimossa la sezione "GrowMi in scatti" più in basso, il carosello ORA VIVE dentro .ed-hero di index.html
- Riferimento esplicito dato dall'utente: tridentmusic.it (foto piena a schermo, pallini di navigazione sul
  bordo destro, non frecce). Implementato cosi': .ed-hero-slideshow (foto a piena hero, dissolvenza automatica
  ogni 4.5s) + .ed-hero-slideshow-overlay (velo scuro rgba(30,12,44,.6) per leggibilità testo — l'utente ha
  ribadito piu' volte che i titoli devono restare leggibili) + .ed-hero-dots (pallini verticali sul bordo
  destro dell'hero, cliccabili per saltare a una foto specifica, sincronizzati con l'autoplay — click su un
  pallino riavvia anche il timer). Tutto in assets/redesign.css + assets/interactive.js → initHeroSlideshow()
- ANCORA CON PLACEHOLDER: l'utente ha mandato 3 foto reali in chat per questo slideshow (concerto Art Mall,
  locandina "Black" all'ingresso, DJ con luci viola) ma — come già successo altre volte — non risultano
  salvate automaticamente da nessuna parte sul PC (verificato, nulla in Download né in "foto growmi").
  Servirà chiedere all'utente di salvarle manualmente prima di poterle usare
- QUANDO ARRIVANO LE FOTO VERE: sostituire ogni <div class="ed-hero-slide placeholder">...</div> con
  <div class="ed-hero-slide"><img src="assets/img/..." alt="..."></div> (la prima deve avere anche
  class="is-active")

## Video di sfondo nell'hero di contatti.html
- Video fornito dall'utente (file originale "GROWMI IS BACK 3 (1).mp4", 1.16MB), copiato in
  assets/video/contatti-bg.mp4. Nell'hero: <video autoplay muted loop playsinline> con sopra un velo
  scuro (.ed-hero-video-overlay, rgba(30,12,44,.68)) per mantenere leggibili titolo/testo — richiesta
  esplicita "in trasparenza per far comunque vedere i titoli". Classi riutilizzabili in redesign.css:
  .ed-hero-video (z-index:-2) + .ed-hero-video-overlay (z-index:-1), sotto sia la texture puntinata che
  la striscia diagonale decorative dell'.ed-hero (che restano a z-index:auto, sopra) e sotto il testo
  (.ed-wrap, z-index:2)
- IMPORTANTE: .claude/build-preview.ps1 NON inlinea i video (solo assets/img/*, per restare sotto il tetto
  di 16MB dell'Artifact) — quindi nella preview condivisa su claude.ai il video di sfondo di contatti.html
  NON si vede (percorso relativo non risolvibile in un file HTML unico). Funziona regolarmente sul sito
  vero una volta pubblicato su Netlify/GitHub Pages. Stesso limite già noto per il video di chi-siamo.html

## Rotazioni finali del triangolo (valori precisi forniti dall'utente)
- Dopo il tentativo con rotazione uniforme (20deg) giudicato "non va bene", l'utente ha chiesto rotazioni
  specifiche e diverse per ciascun vertice (non simmetriche): 01 Pubblico rotate(90deg), 02 Artisti
  rotate(-115deg), 03 Locali rotate(-75deg) — in assets/interactive.css. Le transform-origin sono tornate
  quelle reali per-vertice (50% 6% / 8% 88% / 92% 88%), NON più unificate su un punto solo (era stato un
  tentativo intermedio, poi scartato: l'utente ha chiarito la mappatura 01=alto, 02=basso-sinistra,
  03=basso-destra e voleva che ciascuno zoomasse verso la propria posizione reale)

## Galleria art-mall-collab.html: tornata a 13 foto
- Le foto 14.jpg (chitarra/fiori) e 15.jpg (t-shirt) erano state aggiunte in un round precedente per
  richiesta dell'utente, poi l'utente ha chiesto di toglierle da questa pagina — rimosse sia dall'HTML che
  i file fisici da assets/img/eventi/art-mall-collab/. Se dovessero servire altrove (es. artisti.html) vanno
  ricreate da capo, non sono state spostate

## Data reale evento "Grow With Us": 6 maggio 2025 (non 7)
- Risolto un dubbio rimasto aperto per gran parte della conversazione: la locandina ufficiale (fornita
  dall'utente, salvata in assets/img/eventi/grow-with-us/poster.png) conferma 6 MAGGIO 2025, non 7 come
  usato fino ad ora ovunque nel sito. Corretto in: grow-with-us.html (title, meta description, eyebrow,
  campo Data, alt delle foto), art-mall-collab.html (un riferimento incrociato "la serata del 7 maggio"),
  assets/events-data.js (date: "2025-05-06", tag: "6 MAGGIO 2025"). Se si trovano ancora "7 maggio" in giro
  è un residuo da correggere allo stesso modo
- grow-with-us.html ora ha anche un .ed-poster-feature con la locandina ufficiale (stesso pattern usato in
  art-mall-collab.html), al posto del vecchio sticker Pogo isolato — la locandina include già i loghi di
  Pogo, Door e DJ Lorenzo, quindi lo sticker singolo non serviva più

## Bug corretto: zoom del triangolo lasciava spazio bianco vuoto
- Prima versione: quando un punto (01/02/03) veniva aperto, gli ALTRI due collassavano a max-height:0
  (scomparivano del tutto). Bug reale segnalato dall'utente su mobile: la colonna .ed-tri-points è affiancata
  in una grid alla colonna del triangolo (.tri-svg-frame, altezza fissa via aspect-ratio); quando il testo
  collassava, la RIGA della grid restava comunque alta quanto il triangolo, lasciando uno spazio vuoto color
  crema sotto l'unico punto rimasto visibile
- Corretto: ora gli altri due punti NON collassano più, restano alla loro altezza normale ma si affievoliscono
  (opacity:.3) quando un altro è aperto — stesso effetto "focus" richiesto, senza il problema di layout.
  Regola in assets/interactive.css: .ed-tri-points.has-open .ed-tri-point:not(.is-open){opacity:.3}

## Bug corretto: menu a tendina mobile invisibile con la banda viola in cima
- Il menu a tendina mobile (.navlinks.open, sotto i 1040px) ha SEMPRE sfondo crema, indipendentemente dalla
  banda viola trasparente dell'header. La regola header.at-top .navlinks a{color:cream} però restava attiva
  anche dentro la tendina, rendendo i nomi delle pagine invisibili (crema su crema) — si vedevano solo i
  bordini inferiori dei link. Corretto con header.at-top .navlinks.open a{color:ink} che ha la precedenza.
  Se in futuro si tocca ancora la banda viola dell'header, ricontrollare sempre anche lo stato aperto del
  menu mobile, non solo la vista desktop

## Menu trasparente in cima alla pagina (ispirato a tridentmusic.it)
- Su ogni pagina con hero scuro subito sotto l'header (.ed-hero o .mise-hero), l'header diventa una BANDA VIOLA
  SEMI-TRASPARENTE con sfocatura (rgba(62,13,93,.55) + backdrop-filter blur) quando si è in cima alla pagina
  (classe .at-top su <header>, aggiunta/rimossa in base a scrollY in assets/i18n.js →
  growmiInitHeaderScroll(), chiamata su ogni pagina dato che i18n.js è ovunque)
- ATTENZIONE, bug reale già preso e corretto: la prima versione usava background:transparent puro. Siccome
  <header> è position:sticky (occupa spazio proprio nel flusso, non si sovrappone all'hero sotto), uno sfondo
  "trasparente" mostrava semplicemente lo sfondo crema del body dietro — e col testo dei link colorato crema
  (per contrasto sull'hero scuro) il risultato erano scritte invisibili (crema su crema). Non riprodurre
  questo errore: usare sempre uno sfondo semi-opaco/tinto (non trasparente puro) quando l'header non si
  sovrappone realmente allo sfondo scuro sottostante
- CSS in assets/style.css (header.at-top e le regole a cascata per .navlinks a/.lang-switch/.nav-toggle,
  tutte portate a var(--cream) per il contrasto sulla banda viola)

## Footer e contrasti di colore
- Footer (style.css, sezione footer/.foot-*) reso più "pulito" ispirandosi al footer di tridentmusic.it:
  più padding/respiro (90px in alto), intestazioni colonna in corallo invece che bianco, hover dei link in
  giallo invece che bianco semplice, logo più grande — resta comunque il layout a colonne già esistente
  (Sito/Contatti/Social + bottom bar copyright), la banda newsletter (.ed-cta.compact) PRIMA del footer resta
  invariata su richiesta esplicita dell'utente
- Sezione "Il valore di GrowMi" in index.html: i tre numeri "01/02/03" ora hanno colori diversi (magenta,
  corallo, un giallo scurito #C99A1F per restare leggibile su sfondo chiaro) invece di essere tutti magenta

## Badge sponsor sulle pagine eventi passati
- art-mall-collab.html: il poster ufficiale (.ed-poster-feature) ha ora DUE sticker sovrapposti agli angoli:
  badge-dischivolanti.png in basso a destra (.ed-poster-badge) e badge-pogo.png in basso a sinistra
  (.ed-poster-badge-left, nuova classe)
- grow-with-us.html: non ha un poster ufficiale, quindi badge-pogo.png è mostrato come sticker autonomo
  (.ed-sponsor-badges/.ed-sponsor-badge, nuove classi in redesign.css) subito sopra il blocco info evento —
  riutilizzabile in futuro per altri sponsor su pagine senza poster
- File sorgente badge-pogo.png: originale "Logo Esteso.png" mandato dall'utente (375x213, sfondo trasparente),
  copiato identico (senza resize, è già leggero) in assets/img/eventi/art-mall-collab/ e
  assets/img/eventi/grow-with-us/

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
- art-mall-collab.html ha anche 3 asset grafici ufficiali (non foto evento) in
  assets/img/eventi/art-mall-collab/: title-art.png (scritta "The Art of Being Yourself" in stile bubble
  letters, usata nell'hero a fianco del testo via .ed-hero-split in redesign.css), poster.png (poster ufficiale
  con lineup, mostrato in un riquadro dedicato via .ed-poster-feature) e badge-dischivolanti.png (sticker
  "GrowMi x Dischi Volanti · Official Experience Partner", sovrapposto come adesivo sull'angolo del poster via
  .ed-poster-badge). File originali erano nei Download dell'utente con nomi diversi (rinominati alla copia)
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
  title, h1, meta description e alt delle foto), "Grow With Us" (6 maggio 2025)

## Hero a tutto schermo + fix video di sfondo troppo "tagliato" su schermi larghi
- Richiesta: "per tutte le schermate quando si entra ci deve essere solo all'inizio solo header, poi
  scorrendo verso il basso compaiono tutti gli altri elementi della pagina" — ogni hero (.ed-hero e
  .mise-hero) ora riempie tutta l'altezza della finestra al caricamento, il resto del contenuto si
  scopre solo scorrendo
- Aggiunto a .ed-hero (assets/redesign.css) e .mise-hero (assets/event-miseducation.css):
  min-height:100vh + min-height:100dvh (fallback per mobile con barra indirizzi dinamica),
  display:flex, align-items:center, box-sizing:border-box. Aggiunta anche la regola
  `.ed-hero > .wrap{width:100%;}` / `.mise-hero > .wrap{width:100%;}` — necessaria perché dentro un
  flex container un div senza width esplicita si restringe al contenuto invece di riempire la riga
- Nota: i controlli inline `style="padding:110px 0 80px;"` presenti in diverse pagine continuano a
  funzionare normalmente: sovrascrivono solo il padding, non min-height/display/align-items che restano
  quelli della classe
- Effetto collaterale scoperto nello stesso giro: con l'hero ora alto quanto tutta la finestra su
  schermi larghi, il video di sfondo di contatti.html (assets/video/contatti-bg.mp4, verticale
  1080x1920 — un video girato da telefono) con object-fit:cover veniva ingrandito per riempire l'altezza
  e i lati finivano tagliati, nascondendo parte della scritta presente nel video ("se ho la pagina
  piccola si vede bene, sennò si vede solo una parte della frase"). Primo tentativo: da 900px di
  larghezza in su passare a object-fit:contain (video sempre intero, bande scure ai lati). L'utente ha
  scelto esplicitamente di NON tenere le bande nere ("riempi tutto lo schermo, taglia i lati" — opzione
  scelta tra 3 proposte) quindi la versione finale è tornata a object-fit:cover fisso a tutte le
  larghezze: su schermi molto larghi il video (verticale) viene ingrandito e i lati tagliati, per scelta
  consapevole dell'utente a favore dello sfondo a tutto schermo

## Triangolo e loyalty card ingranditi + bug reale trovato (shrink-to-fit su .tri-svg-frame)
- Richiesta: "ingrandisci tutta la sezione del triangolo nella home e la carta fedeltà in modo che si
  veda meglio e abbia più impatto"
- BUG VERO trovato durante la verifica: .tri-svg-frame (assets/interactive.css) aveva `margin:0 auto`
  ma NESSUN `width` esplicito (solo `max-width`). Dentro `.ed-triangle` che è un grid a due colonne,
  questa combinazione (margini auto + width:auto, nessuna larghezza esplicita) fa sì che il browser
  usi lo "shrink-to-fit" invece di riempire la colonna della grid — e per un `<svg>` senza width/height
  attribute il valore di fallback è l'intrinsic size di default (300x150, qui 300x255 per via
  dell'aspect-ratio 400/340 sull'elemento). Risultato: il triangolo era bloccato a 300px di larghezza
  SEMPRE, indipendentemente dai vari max-width impostati nei breakpoint (anche quelli aggiunti in
  sessioni precedenti per gli schermi larghi non avevano mai fatto effetto per questo motivo). Fix:
  aggiunta `width:100%;` esplicita a `.tri-svg-frame` — ora riempie davvero la sua colonna nella grid
- Nuovi breakpoint per .tri-svg-frame: 480px di base, poi 560px (≥768px), 660px (≥1100px), 760px
  (≥1400px), 860px (≥1800px). Le percentuali di translate/rotate dello zoom sui vertici restano valide
  a qualsiasi dimensione del frame (sono calcolate in %, non in px), quindi non è stato necessario
  ricalcolarle — verificato cliccando un vertice e controllando la transform calcolata
- .loyalty-card (assets/style.css) da 360px a 480px di larghezza da 640px di viewport in su, con logo/
  padding/timbri/font interni scalati leggermente in proporzione nello stesso breakpoint

## Hero fotografico della home ripulito dagli elementi decorativi standard
- L'utente ha notato (con screenshot) che sopra le foto vere del carosello in home restavano visibili
  gli elementi decorativi pensati per l'hero "a tinta unita" delle altre pagine: la texture a puntini
  (.ed-hero::before), la striscia diagonale magenta (.ed-hero::after, la "barra rosa" nello screenshot)
  e il blob sfocato corallo (.blob-2) — tutti pensati per uno sfondo scuro in tinta unita, non per
  stare sopra delle fotografie
- Fix scoped SOLO all'hero con foto (selettore `.ed-hero:has(.ed-hero-slideshow)`), per non toccare le
  altre pagine che usano ancora normalmente questi elementi decorativi: `::before`/`::after` a
  display:none e `.blob-2` a display:none quando dentro un `.ed-hero` che contiene `.ed-hero-slideshow`
- Il velo scuro sopra le foto (.ed-hero-slideshow-overlay) è stato invece MANTENUTO e anzi aumentato
  (da .42 a .6 di opacità) su richiesta esplicita per far risaltare meglio le scritte del titolo sopra
  le foto — l'utente aveva inizialmente chiesto di eliminarlo del tutto ("lasciare solo le foto come
  sfondo") ma ha poi corretto il tiro chiarendo che il problema era solo la striscia/texture decorativa,
  non il velo di leggibilità sulle foto stesse

## Note per Claude Code
- Mantieni sempre la struttura a più file HTML statici (non convertire in framework tipo
  React/Next.js a meno che l'utente lo chieda esplicitamente)
- Ogni nuovo testo visibile all'utente deve avere sia la versione IT che EN in assets/i18n.js
  tramite attributo data-i18n, per restare coerente col sistema bilingue esistente
- Non introdurre dipendenze da backend/server: il sito deve restare deployabile su Netlify
  come sito statico
- Il modulo di contatto usa Netlify Forms (attributo data-netlify="true") — funziona solo
  una volta pubblicato su Netlify, non in locale
