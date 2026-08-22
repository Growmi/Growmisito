import Stripe from "stripe";
import QRCode from "qrcode";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

// Punto d'ingresso del Worker: serve il sito statico (assets/*.html, css, js, immagini) e in più
// gestisce le rotte /api/* per il backend biglietti/QR. Il binding ASSETS (vedi wrangler.toml)
// serve automaticamente i file statici dalla root del repo.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Diagnostica: dice solo se ogni variabile/secret è presente o no, mai il valore vero.
    // Serve solo per debug in questa fase, si può togliere una volta che tutto funziona.
    if (url.pathname === "/api/env-check") {
      return new Response(JSON.stringify({
        RESEND_API_KEY: !!env.RESEND_API_KEY,
        STRIPE_SECRET_KEY: !!env.STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET: !!env.STRIPE_WEBHOOK_SECRET,
        STRIPE_WEBHOOK_SECRET_TEST: !!env.STRIPE_WEBHOOK_SECRET_TEST,
        TICKETS_KV: !!env.TICKETS
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
      // Tutta la gestione del webhook è avvolta qui, dal primo all'ultimo rigo: senza questo,
      // un'eccezione qualsiasi (anche nella creazione del client Stripe) produce solo un
      // generico errore 1101 di Cloudflare, senza dire cosa è andato storto davvero.
      try {
        return await handleStripeWebhook(request, env);
      } catch (err) {
        console.log("Errore webhook:", err.stack || err.message);
        return new Response(`Errore interno: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/api/checkin" && request.method === "POST") {
      try {
        return await handleCheckin(request, env);
      } catch (err) {
        console.log("Errore checkin:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      try {
        return await handleStats(request, env);
      } catch (err) {
        console.log("Errore stats:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/attendees" && request.method === "GET") {
      try {
        return await handleAttendees(request, env);
      } catch (err) {
        console.log("Errore attendees:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

// Genera un codice biglietto breve, facile da mostrare/leggere se serve anche a occhio
// (es. se il QR non si legge bene), oltre che come contenuto del QR stesso.
function generateTicketCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Template dell'email di conferma acquisto: stile a "card" scura sui colori GrowMi (viola,
// corallo, giallo), stessa impostazione grafica delle altre email automatiche già in uso
// (intestazione con emoji, elenco puntato con i dati in grassetto). È un template vero e
// proprio — cambiano solo i dati passati (evento, fascia, nome, codice), non va toccato per
// ogni evento nuovo.
// Costruito con tabelle (non <div>) e attributo bgcolor oltre allo style: Outlook (desktop e
// molte caselle @outlook.it/@hotmail) usa il motore di rendering di Word, che ignora quasi
// tutto il CSS moderno sui <div> ma capisce bene le tabelle HTML — è lo standard per le email
// che devono restare leggibili ovunque, non solo su Gmail/Apple Mail.
function buildTicketEmailHTML({ name, eventName, eventDate, eventLocation, eventTeaser, tierName, ticketCode, qrBase64 }) {
  const firstName = name ? name.split(" ")[0] : "";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#2C0943" style="background:#2C0943; border-radius:24px; max-width:600px;">
        <tr>
          <td style="padding:48px 44px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

              <tr><td align="center" style="font-size:32px; font-weight:bold; color:#F86639; padding-bottom:22px; line-height:1.3;">&#127881; Biglietto confermato! &#127881;</td></tr>

              <tr><td align="center" style="font-size:21px; color:#FBF6F0; padding-bottom:16px; line-height:1.5;">Ciao <strong>${firstName || "!"}</strong>${firstName ? "," : ""}<br>grazie per aver scelto di partecipare a:</td></tr>

              <tr><td align="center" style="font-size:29px; font-weight:bold; color:#FDC631; padding-bottom:16px; line-height:1.3;">${eventName}</td></tr>

              <tr><td align="center" style="font-size:19px; color:#FBF6F0; padding-bottom:6px;">&#128205; ${eventLocation}</td></tr>
              <tr><td align="center" style="font-size:19px; color:#FBF6F0; padding-bottom:22px;">&#128336; ${eventDate}</td></tr>

              ${eventTeaser ? `<tr><td align="center" style="font-size:18px; color:#FBF6F0; line-height:1.6; padding-bottom:24px;">${eventTeaser}</td></tr>` : ""}

              <tr><td style="border-top:1px solid #5C3E75; font-size:1px; line-height:1px;">&nbsp;</td></tr>

              <tr><td style="font-size:19px; font-weight:bold; color:#FDC631; padding-top:24px; padding-bottom:12px;">&#128203; Dettagli biglietto:</td></tr>
              <tr><td style="font-size:18px; color:#FBF6F0; padding-bottom:8px;">&bull; Nome: <strong>${name || "&mdash;"}</strong></td></tr>
              ${tierName ? `<tr><td style="font-size:18px; color:#FBF6F0; padding-bottom:8px;">&bull; Tipo: <strong>${tierName}</strong></td></tr>` : ""}
              <tr><td style="font-size:18px; color:#FBF6F0; padding-bottom:24px;">&bull; Codice biglietto: <strong>${ticketCode}</strong></td></tr>

              <tr><td align="center" style="font-size:18px; color:#FBF6F0; padding-bottom:14px;">Mostra questo QR allo staff all'ingresso (basta il telefono):</td></tr>
              <tr>
                <td align="center" bgcolor="#FFFFFF" style="background:#FFFFFF; border-radius:14px; padding:20px;">
                  <img src="data:image/svg+xml;base64,${qrBase64}" alt="QR biglietto" width="210" height="210" style="display:block; border:0; margin:0 auto;">
                </td>
              </tr>

              <tr><td style="border-top:1px solid #5C3E75; font-size:1px; line-height:1px; padding-top:24px;">&nbsp;</td></tr>
              <tr><td align="center" style="font-size:17px; color:#C9BCD6; padding-top:18px; line-height:1.6;">Ricordati di portare il biglietto (anche solo sul telefono) e un documento d'identit&agrave; all'ingresso.</td></tr>
              <tr><td align="center" style="font-size:18px; color:#FBF6F0; padding-top:22px;">Keep growing &#127793;</td></tr>
              <tr><td align="center" style="font-size:17px; color:#C9BCD6; padding-top:2px;">Il team GrowMi</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
}

// Biglietto in PDF, allegato in più oltre all'SVG/anteprima nell'email: utile a chi preferisce
// un file "vero" da salvare o stampare invece di dover aprire l'email ogni volta.
// Il QR è disegnato come una griglia di rettangoli (i "moduli" del QR, presi da
// QRCode.create() — solo calcolo puro, nessun renderer/canvas coinvolto) invece che come
// immagine incorporata: pdf-lib non converte SVG in PDF da solo, ma disegnare rettangoli è
// una funzione base di qualunque libreria PDF, quindi funziona ovunque senza dipendenze extra.
async function buildTicketPDF({ name, eventName, eventDate, eventLocation, tierName, ticketCode }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([420, 620]);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const purple = rgb(0.1725, 0.0353, 0.2627);
  const yellow = rgb(0.9922, 0.7765, 0.1922);
  const coral = rgb(0.9725, 0.4, 0.2235);
  const cream = rgb(0.9843, 0.9647, 0.9412);

  page.drawRectangle({ x: 0, y: 0, width: 420, height: 620, color: purple });

  let y = 570;
  page.drawText("GrowMi", { x: 40, y, size: 22, font: fontBold, color: yellow });
  y -= 36;
  page.drawText("Biglietto confermato", { x: 40, y, size: 16, font: fontRegular, color: coral });
  y -= 34;

  function wrapText(text, maxChars) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > maxChars) { lines.push(line.trim()); line = w; }
      else { line += " " + w; }
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }

  for (const line of wrapText(eventName, 34)) {
    page.drawText(line, { x: 40, y, size: 18, font: fontBold, color: cream });
    y -= 24;
  }
  y -= 8;
  page.drawText(eventLocation, { x: 40, y, size: 12.5, font: fontRegular, color: cream });
  y -= 18;
  page.drawText(eventDate, { x: 40, y, size: 12.5, font: fontRegular, color: cream });
  y -= 34;

  page.drawText(`Nome: ${name || "-"}`, { x: 40, y, size: 12, font: fontRegular, color: cream });
  y -= 18;
  if (tierName) {
    page.drawText(`Tipo: ${tierName}`, { x: 40, y, size: 12, font: fontRegular, color: cream });
    y -= 18;
  }
  page.drawText(`Codice: ${ticketCode}`, { x: 40, y, size: 12, font: fontBold, color: cream });
  y -= 30;

  // Griglia del QR: quadrato bianco di sfondo, poi un rettangolo nero per ogni modulo "acceso".
  const qr = QRCode.create(ticketCode, { errorCorrectionLevel: "M" });
  const qrSize = qr.modules.size;
  const qrData = qr.modules.data;
  const boxSize = 260;
  const boxX = 40;
  const boxY = y - boxSize;
  const quietZone = 12;
  const moduleSize = (boxSize - quietZone * 2) / qrSize;

  page.drawRectangle({ x: boxX, y: boxY, width: boxSize, height: boxSize, color: cream });
  for (let row = 0; row < qrSize; row++) {
    for (let col = 0; col < qrSize; col++) {
      if (qrData[row * qrSize + col]) {
        page.drawRectangle({
          x: boxX + quietZone + col * moduleSize,
          y: boxY + boxSize - quietZone - (row + 1) * moduleSize,
          width: moduleSize,
          height: moduleSize,
          color: purple
        });
      }
    }
  }

  page.drawText("Mostra questo QR allo staff all'ingresso", { x: 40, y: boxY - 24, size: 11, font: fontRegular, color: cream });

  return pdfDoc.save();
}

// Verifica il biglietto letto dallo scanner dello staff: valido/già usato/non trovato, e lo
// marca come usato al primo check-in valido, cosi' non si può rientrare due volte con lo
// stesso QR. Protetto da una chiave condivisa (STAFF_KEY) invece che da un vero login, dato
// che è uno strumento interno per il personale all'ingresso, non per i clienti.
async function handleCheckin(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const { code } = await request.json();
  const ticketCode = String(code || "").trim().toUpperCase();
  if (!ticketCode) {
    return jsonResponse({ error: "missing code" }, 400);
  }

  const kvKey = `ticket:${ticketCode}`;
  const raw = await env.TICKETS.get(kvKey);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "not_found" });
  }

  const ticket = JSON.parse(raw);
  if (ticket.used) {
    return jsonResponse({ valid: false, reason: "already_used", usedAt: ticket.usedAt, email: ticket.email });
  }

  ticket.used = true;
  ticket.usedAt = new Date().toISOString();
  // La metadata (used, nome, email, fascia, orario) oltre al campo dentro il JSON permette a
  // /api/stats e /api/attendees di leggere l'elenco di chi è entrato con un solo elenco delle
  // chiavi, senza dover leggere per intero ogni singolo biglietto uno per uno.
  await env.TICKETS.put(kvKey, JSON.stringify(ticket), {
    metadata: { used: true, name: ticket.name, email: ticket.email, tierName: ticket.tierName, usedAt: ticket.usedAt }
  });

  return jsonResponse({ valid: true, email: ticket.email, name: ticket.name, eventName: ticket.eventName, tierName: ticket.tierName });
}

// Riepilogo per la dashboard staff: quanti biglietti venduti in totale e quanti già entrati,
// contando i moduli/chiavi elencate (con la loro metadata) invece di leggere ogni biglietto —
// molto più veloce quando i biglietti sono centinaia. Protetto dalla stessa chiave staff dello
// scanner, non un dato pubblico.
async function handleStats(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  let total = 0;
  let checkedIn = 0;
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      total++;
      if (key.metadata?.used) checkedIn++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ total, checkedIn });
}

// Elenco di chi è entrato davvero (per la pagina staff-attendees.html), letto dalla metadata
// delle chiavi già entrate — nessuna lettura dei singoli biglietti, veloce anche con centinaia
// di persone. Stessa chiave staff dello scanner.
async function handleAttendees(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const attendees = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if (key.metadata?.used) {
        attendees.push({
          name: key.metadata.name || null,
          email: key.metadata.email || null,
          tierName: key.metadata.tierName || null,
          usedAt: key.metadata.usedAt || null
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  attendees.sort(function(a, b){ return (a.name || "").localeCompare(b.name || ""); });

  return jsonResponse({ attendees });
}

async function handleStripeWebhook(request, env) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  // Prova prima la chiave live, poi quella di test: sono due endpoint webhook diversi su Stripe
  // (uno per pagamenti veri, uno per "stripe trigger" in modalità test) che mandano entrambi qui,
  // ognuno firmato con la propria secret. Cosi' possiamo testare in sicurezza senza toccare la
  // configurazione live.
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (liveErr) {
    if (!env.STRIPE_WEBHOOK_SECRET_TEST) {
      return new Response(`Webhook Error: ${liveErr.message}`, { status: 400 });
    }
    event = await stripe.webhooks.constructEventAsync(body, signature, env.STRIPE_WEBHOOK_SECRET_TEST);
  }

  if (event.type === "checkout.session.completed") {
    if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

    // Stripe può rimandare lo stesso evento più di una volta (es. se la risposta precedente è
    // arrivata in ritardo o si è persa in rete): senza questo controllo, un evento gia' gestito
    // genererebbe un secondo biglietto duplicato per lo stesso acquisto.
    const dedupeKey = `evt:${event.id}`;
    const alreadyHandled = await env.TICKETS.get(dedupeKey);
    if (alreadyHandled) {
      return new Response("ok (già elaborato)", { status: 200 });
    }

    const session = event.data.object;
    const email = session.customer_details?.email;
    const customerName = session.customer_details?.name || null;

    if (!email) {
      console.log("checkout.session.completed senza email cliente, ignorato:", session.id);
    }

    if (email) {
      // Nome evento, data e location si leggono dai metadata del Payment Link Stripe usato per
      // l'acquisto (chiavi "event", "event_date", "event_location" — da impostare quando si crea
      // il Payment Link per un nuovo evento, in Advanced → Metadata). Se mancano (come sui
      // Payment Link già esistenti del 10 settembre, creati prima di questa modifica), restano
      // sui valori di quell'evento come default: nessuna rottura per quelli già in vendita.
      const eventName = session.metadata?.event || "The Miseducation of GrowMi";
      const eventDate = session.metadata?.event_date || "Giovedì 10 settembre 2026 · Apertura 19:00";
      const eventLocation = session.metadata?.event_location || "Art Mall Milano, Milano";
      const eventTeaser = session.metadata?.event_teaser || "Una notte dedicata alla cultura hip-hop: graffiti dal vivo, musica e DJ set nel cuore di Milano.";
      const ticketCode = generateTicketCode();

      // Il nome della fascia/prodotto acquistato (es. "Prima fascia - Solo ingresso") si legge
      // dalla riga d'acquisto vera su Stripe, non va assunto: cosi' il biglietto e l'email
      // mostrano sempre cosa è stato comprato davvero, qualunque dei 6 Payment Link sia stato
      // usato, senza doverli distinguere a mano nel codice.
      let tierName = null;
      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
        tierName = lineItems.data[0]?.description || null;
      } catch (e) {
        console.log("Impossibile leggere i line item:", e.message);
      }

      // SVG invece di PNG: su Cloudflare Workers la libreria carica la sua versione "da
      // browser" (punta a un <canvas> che qui non esiste, e in quella versione manca anche
      // toBuffer). toString con type "svg" è testo puro, funziona in qualsiasi ambiente.
      const qrSvg = await QRCode.toString(ticketCode, { type: "svg", margin: 1, width: 400 });
      const qrBase64 = btoa(qrSvg);

      await env.TICKETS.put(`ticket:${ticketCode}`, JSON.stringify({
        email,
        name: customerName,
        eventName,
        eventDate,
        eventLocation,
        tierName,
        amountTotal: session.amount_total,
        currency: session.currency,
        used: false,
        createdAt: new Date().toISOString(),
        stripeSessionId: session.id
      }), { metadata: { used: false } });
      // Segna l'evento Stripe come gestito solo ORA che il biglietto esiste davvero su KV:
      // cosi' se il Worker si interrompe prima di questo punto, un eventuale nuovo tentativo di
      // Stripe riesce comunque a creare il biglietto, invece di essere scartato come "già fatto"
      // quando in realtà non è mai stato completato.
      await env.TICKETS.put(dedupeKey, ticketCode);

      if (env.RESEND_API_KEY) {
        let pdfBase64 = null;
        try {
          const pdfBytes = await buildTicketPDF({ name: customerName, eventName, eventDate, eventLocation, tierName, ticketCode });
          pdfBase64 = Buffer.from(pdfBytes).toString("base64");
        } catch (e) {
          console.log("Errore generazione PDF biglietto:", e.message);
        }

        const attachments = [];
        if (pdfBase64) attachments.push({ filename: "biglietto-growmi.pdf", content: pdfBase64 });

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "GrowMi <onboarding@resend.dev>",
            to: email,
            subject: `Il tuo biglietto — ${eventName}`,
            html: buildTicketEmailHTML({ name: customerName, eventName, eventDate, eventLocation, eventTeaser, tierName, ticketCode, qrBase64 }),
            attachments
          })
        });
        if (!resendRes.ok) {
          console.log("Resend error:", resendRes.status, await resendRes.text());
        }
      }
    }
  }

  return new Response("ok", { status: 200 });
}
