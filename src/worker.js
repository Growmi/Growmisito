import Stripe from "stripe";
import QRCode from "qrcode";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

// Punto d'ingresso del Worker: serve il sito statico (assets/*.html, css, js, immagini) e in più
// gestisce le rotte /api/* per il backend biglietti/QR. Il binding ASSETS (vedi wrangler.toml)
// serve automaticamente i file statici dalla root del repo.
export default {
  async fetch(request, env, ctx) {
    const response = await handleFetch(request, env, ctx);
    return withSecurityHeaders(response);
  },

  // Cron giornaliero (vedi [triggers] in wrangler.toml): manda il feedback in automatico agli
  // eventi finiti ieri. Avvolto in try/catch perché un'eccezione qui non ha nessuno a cui
  // rispondere con un errore (non è una richiesta HTTP) — finirebbe solo nei log di Cloudflare.
  async scheduled(event, env, ctx) {
    try {
      await runScheduledFeedback(env);
    } catch (err) {
      console.log("Errore cron feedback:", err.stack || err.message);
    }
  }
};

// Aggiunge gli header di sicurezza standard a ogni risposta (API e asset statici). Niente
// Content-Security-Policy qui: il sito carica script/embed da diversi domini terzi (Stripe,
// MailerLite, Google Fonts/reCAPTCHA) su ~20 pagine diverse, una CSP scritta senza controllare
// ogni pagina rischierebbe di rompere silenziosamente uno di questi imbed.
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleFetch(request, env, ctx) {
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
        MAILERLITE_API_KEY: !!env.MAILERLITE_API_KEY,
        TICKETS_KV: !!env.TICKETS
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Endpoint di debug TEMPORANEO, protetto dalla chiave staff: forza la verifica di un
    // account senza passare dal link email, serve solo per creare le credenziali di test
    // dell'area personale mentre Resend è ancora in sandbox. Da rimuovere appena non serve più.
    if (url.pathname === "/api/debug-verify-account" && request.method === "POST") {
      try {
        const staffKey = request.headers.get("x-staff-key");
        if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) return jsonResponse({ error: "unauthorized" }, 401);
        const { email } = await request.json();
        const raw = await env.TICKETS.get(`account:${email}`);
        if (!raw) return jsonResponse({ error: "account non trovato" }, 404);
        const account = JSON.parse(raw);
        account.emailVerified = true;
        delete account.verifyToken;
        await env.TICKETS.put(`account:${email}`, JSON.stringify(account));
        return jsonResponse({ ok: true });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Endpoint di debug/admin, protetto dalla chiave staff: annulla il riscatto di una carta
    // fisica (es. riscattata per errore o solo per un test) — libera il numero e riporta
    // l'account a "nessuna loyalty card", come se non l'avesse mai riscattata (potrà
    // richiederne una digitale o riscattarne un'altra fisica quando vuole).
    if (url.pathname === "/api/debug-release-physical-card" && request.method === "POST") {
      try {
        const staffKey = request.headers.get("x-staff-key");
        if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) return jsonResponse({ error: "unauthorized" }, 401);
        const body = await request.json();
        const parsed = parseInt(String(body.cardNumber || "").trim(), 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
          return jsonResponse({ error: "numero carta non valido" }, 400);
        }
        const cardNumber = String(parsed).padStart(3, "0");
        const claimRaw = await env.TICKETS.get(`physicalcard:${cardNumber}`);
        if (!claimRaw) return jsonResponse({ error: "questo numero non risulta riscattato" }, 404);
        const { email } = JSON.parse(claimRaw);

        const accountRaw = await env.TICKETS.get(`account:${email}`);
        if (accountRaw) {
          const account = JSON.parse(accountRaw);
          account.customerNumber = null;
          account.physicalCardClaimed = false;
          await env.TICKETS.put(`account:${email}`, JSON.stringify(account));
        }
        await env.TICKETS.delete(`physicalcard:${cardNumber}`);
        await env.TICKETS.delete(`customernum:${cardNumber}`);
        return jsonResponse({ ok: true, releasedFrom: email });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
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

    if (url.pathname === "/api/send-feedback" && request.method === "POST") {
      try {
        return await handleSendFeedback(request, env);
      } catch (err) {
        console.log("Errore send-feedback:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/feedback-submit" && request.method === "POST") {
      try {
        return await handleFeedbackSubmit(request, env);
      } catch (err) {
        console.log("Errore feedback-submit:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/feedback-list" && request.method === "GET") {
      try {
        return await handleFeedbackList(request, env);
      } catch (err) {
        console.log("Errore feedback-list:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/event-tiers" && request.method === "GET") {
      try {
        return await handleEventTiers(request, env);
      } catch (err) {
        console.log("Errore event-tiers:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      try {
        return await handleRegister(request, env);
      } catch (err) {
        console.log("Errore register:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/validate-coupon" && request.method === "POST") {
      try {
        return await handleValidateCoupon(request, env);
      } catch (err) {
        console.log("Errore validate-coupon:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      try {
        return await handleCreateCheckoutSession(request, env);
      } catch (err) {
        console.log("Errore create-checkout-session:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Area personale: registrazione, login, verifica email, recupero password, dati account.
    if (url.pathname === "/api/account/register" && request.method === "POST") {
      try {
        return await handleAccountRegister(request, env);
      } catch (err) {
        console.log("Errore account/register:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/verify" && request.method === "GET") {
      try {
        return await handleAccountVerify(request, env);
      } catch (err) {
        console.log("Errore account/verify:", err.stack || err.message);
        return new Response("Errore interno: " + err.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/account/login" && request.method === "POST") {
      try {
        return await handleAccountLogin(request, env);
      } catch (err) {
        console.log("Errore account/login:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/logout" && request.method === "POST") {
      try {
        return await handleAccountLogout(request, env);
      } catch (err) {
        console.log("Errore account/logout:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/me" && request.method === "GET") {
      try {
        return await handleAccountMe(request, env);
      } catch (err) {
        console.log("Errore account/me:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/profile" && request.method === "POST") {
      try {
        return await handleAccountProfile(request, env);
      } catch (err) {
        console.log("Errore account/profile:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/tickets" && request.method === "GET") {
      try {
        return await handleAccountTickets(request, env);
      } catch (err) {
        console.log("Errore account/tickets:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/loyalty" && request.method === "GET") {
      try {
        return await handleAccountLoyalty(request, env);
      } catch (err) {
        console.log("Errore account/loyalty:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/ticket-qr" && request.method === "GET") {
      try {
        return await handleAccountTicketQr(request, env);
      } catch (err) {
        console.log("Errore account/ticket-qr:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/loyalty-barcode" && request.method === "GET") {
      try {
        return await handleAccountLoyaltyBarcode(request, env);
      } catch (err) {
        console.log("Errore account/loyalty-barcode:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/request-loyalty-card" && request.method === "POST") {
      try {
        return await handleRequestLoyaltyCard(request, env);
      } catch (err) {
        console.log("Errore account/request-loyalty-card:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/claim-physical-card" && request.method === "POST") {
      try {
        return await handleClaimPhysicalCard(request, env);
      } catch (err) {
        console.log("Errore account/claim-physical-card:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/lookup-customer" && request.method === "GET") {
      try {
        return await handleLookupByCustomerNumber(request, env);
      } catch (err) {
        console.log("Errore lookup-customer:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/redeem-reward" && request.method === "POST") {
      try {
        return await handleRedeemReward(request, env);
      } catch (err) {
        console.log("Errore redeem-reward:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/forgot-password" && request.method === "POST") {
      try {
        return await handleAccountForgotPassword(request, env);
      } catch (err) {
        console.log("Errore account/forgot-password:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/reset-password" && request.method === "POST") {
      try {
        return await handleAccountResetPassword(request, env);
      } catch (err) {
        console.log("Errore account/reset-password:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return env.ASSETS.fetch(request);
}

// Registro eventi: fonte di verità server-side per nome/data/location e fasce prezzo con
// capacità. Aggiungere un evento nuovo = aggiungere una voce qui (slug → dati), niente Payment
// Link esterni da creare uno per uno né HTML da riscrivere per il blocco acquisto. Le capacità
// sono numeri semplici: si alzano/abbassano modificandoli qui, nessuna logica da toccare.
const EVENTS = {
  "miseducation-2026-09-10": {
    name: "The Miseducation of GrowMi",
    dateDisplay: "Giovedì 10 settembre 2026 · Apertura 19:00",
    dateIso: "2026-09-10",
    location: "Art Mall Milano, Milano",
    teaser: "Una notte dedicata alla cultura hip-hop: graffiti dal vivo, musica e DJ set nel cuore di Milano.",
    tiers: [
      {
        id: "fascia1", name: "Prima fascia", sub: "Posti limitati", capacity: 50,
        options: [
          { id: "plain", label: "Solo ingresso", priceCents: 1200 },
          { id: "food", label: "+ Birra e panzerotto", priceCents: 1850 }
        ]
      },
      {
        id: "fascia2", name: "Seconda fascia", sub: "Prossimo scaglione", capacity: 50,
        options: [
          { id: "plain", label: "Solo ingresso", priceCents: 1500 },
          { id: "food", label: "+ Birra e panzerotto", priceCents: 2150 }
        ]
      },
      {
        id: "fascia3", name: "Terza fascia", sub: "Ultimo scaglione", capacity: 35,
        options: [
          { id: "plain", label: "Solo ingresso", priceCents: 2000 },
          { id: "food", label: "+ Birra e panzerotto", priceCents: 2650 }
        ]
      }
    ]
  }
};

function findTierOption(eventSlug, tierId, optionId) {
  const event = EVENTS[eventSlug];
  const tier = event?.tiers.find(function(t){ return t.id === tierId; });
  const option = tier?.options.find(function(o){ return o.id === optionId; });
  if (!event || !tier || !option) return null;
  return { event, tier, option };
}

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
function buildTicketEmailHTML({ name, eventName, eventDate, eventLocation, eventTeaser, tierName, optionId, ticketCode, qrBase64 }) {
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

              ${optionId === "food" ? `<tr><td align="center" style="font-size:17px; color:#FDC631; background:#3D1657; border-radius:12px; padding:14px 18px;">&#127866;&#129386; Il tuo biglietto include birra e panzerotto &mdash; ritirali al banco mostrando il QR!</td></tr><tr><td style="font-size:1px; line-height:14px;">&nbsp;</td></tr>` : ""}

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
    metadata: {
      used: true, name: ticket.name, email: ticket.email, tierName: ticket.tierName,
      usedAt: ticket.usedAt, eventName: ticket.eventName, eventDateIso: ticket.eventDateIso,
      // eventSlug/tierId restano anche dopo il check-in: /api/event-tiers conta TUTTI i
      // biglietti venduti di una fascia (entrati o no), non solo quelli ancora "used:false" —
      // senza questi due campi qui, fare check-in libererebbe per sbaglio un posto già venduto.
      eventSlug: ticket.eventSlug, tierId: ticket.tierId
    }
  });

  // Timbro loyalty qui, alla presenza reale — se questo check-in sblocca una ricompensa (3°/5°
  // evento) lo staff lo vede subito nella risposta e può darla sul posto, senza dover cercare
  // separatamente la loyalty card. stamps è null se la persona non ha un account GrowMi.
  const stamps = await addLoyaltyStamp(env, ticket.email, { eventName: ticket.eventName, ticketCode, stampedAt: ticket.usedAt });

  return jsonResponse({
    valid: true, email: ticket.email, name: ticket.name, eventName: ticket.eventName, tierName: ticket.tierName,
    stamps: stamps, reward3: stamps === 3, reward5: stamps === 5
  });
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
          usedAt: key.metadata.usedAt || null,
          eventName: key.metadata.eventName || null
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // Chi ha la loyalty card (account creato, con o senza carta fisica riscattata) e chi invece
  // ha comprato solo "come ospite", senza mai registrarsi — utile allo staff per capire chi
  // proporre di iscrivere. Una sola cache per email, così una persona con più biglietti non fa
  // una lettura KV ripetuta per ogni evento a cui è stata.
  const accountCache = new Map();
  for (const attendee of attendees) {
    if (!attendee.email) { attendee.hasLoyaltyAccount = false; attendee.physicalCardClaimed = false; continue; }
    if (!accountCache.has(attendee.email)) {
      const raw = await env.TICKETS.get(`account:${attendee.email}`);
      accountCache.set(attendee.email, raw ? JSON.parse(raw) : null);
    }
    const account = accountCache.get(attendee.email);
    attendee.hasLoyaltyAccount = !!account;
    attendee.physicalCardClaimed = !!(account && account.physicalCardClaimed);
  }

  attendees.sort(function(a, b){ return (a.name || "").localeCompare(b.name || ""); });

  return jsonResponse({ attendees });
}

// Email di feedback GRAZIA: usa lo stesso template "a card" delle conferme biglietto, ma con un
// pulsante che porta al form (Google Form o altro, l'URL arriva nella richiesta — non è mai
// hardcoded nel codice) invece del QR. Nessuna dipendenza da servizi esterni oltre a Resend,
// già collegato per i biglietti.
function buildFeedbackEmailHTML({ name, eventName, feedbackFormUrl }) {
  const firstName = name ? name.split(" ")[0] : "";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#2C0943" style="background:#2C0943; border-radius:24px; max-width:600px;">
        <tr>
          <td style="padding:48px 44px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="font-size:30px; font-weight:bold; color:#F86639; padding-bottom:18px; line-height:1.3;">&#128155; Grazie per essere stato con noi!</td></tr>
              <tr><td align="center" style="font-size:19px; color:#FBF6F0; padding-bottom:16px; line-height:1.5;">Ciao <strong>${firstName || "!"}</strong>${firstName ? "," : ""}<br>speriamo tu ti sia divertito a</td></tr>
              <tr><td align="center" style="font-size:26px; font-weight:bold; color:#FDC631; padding-bottom:22px; line-height:1.3;">${eventName}</td></tr>
              <tr><td align="center" style="font-size:17px; color:#FBF6F0; line-height:1.6; padding-bottom:28px;">Ci piacerebbe sapere cosa ne pensi: ci vogliono meno di due minuti, e ci aiuti a rendere il prossimo evento ancora migliore.</td></tr>
              <tr>
                <td align="center" style="padding-bottom:8px;">
                  <a href="${feedbackFormUrl}" style="display:inline-block; background:#F86639; color:#FFFFFF; font-family:Arial, Helvetica, sans-serif; font-weight:bold; font-size:17px; text-decoration:none; padding:16px 36px; border-radius:12px;">Lascia il tuo feedback</a>
                </td>
              </tr>
              <tr><td style="border-top:1px solid #5C3E75; font-size:1px; line-height:1px; padding-top:28px;">&nbsp;</td></tr>
              <tr><td align="center" style="font-size:18px; color:#FBF6F0; padding-top:22px;">Keep growing &#127793;</td></tr>
              <tr><td align="center" style="font-size:15px; color:#C9BCD6; padding-top:2px;">Il team GrowMi</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
}

// Legge dalla metadata KV tutti gli attendee (used:true) di un evento, opzionalmente filtrando
// per nome evento. Usata sia dall'invio manuale (pulsante) sia da quello automatico (cron).
async function listAttendeesForEvent(env, eventName) {
  const attendees = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const m = key.metadata;
      if (m?.used && m.email && (!eventName || m.eventName === eventName)) {
        attendees.push({ name: m.name, email: m.email, eventName: m.eventName });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return attendees;
}

// Costruisce il link al form di feedback nativo del sito (feedback.html), con l'evento già
// precompilato nell'URL — non serve più che qualcuno crei/incolli un Google Form a mano.
function buildFeedbackUrl(env, eventName) {
  const base = env.SITE_URL || "https://growmisito.grow-mi.workers.dev";
  return `${base}/feedback?event=${encodeURIComponent(eventName || "GrowMi")}`;
}

// Manda l'email di feedback alla lista di attendee data, uno per uno via Resend. Usata sia
// dall'invio manuale sia da quello automatico. Il link punta sempre al form nativo del sito.
async function sendFeedbackEmails(env, attendees) {
  let sent = 0;
  let failed = 0;
  for (const a of attendees) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "GrowMi <noreply@growmi.it>",
          to: a.email,
          subject: `Com'è andata a ${a.eventName || "GrowMi"}?`,
          html: buildFeedbackEmailHTML({ name: a.name, eventName: a.eventName || "GrowMi", feedbackFormUrl: buildFeedbackUrl(env, a.eventName) })
        })
      });
      if (res.ok) sent++; else { failed++; console.log("Resend feedback error:", res.status, await res.text()); }
    } catch (e) {
      failed++;
      console.log("Errore invio feedback a", a.email, e.message);
    }
  }
  return { sent, failed };
}

// Manda l'email di feedback a tutti quelli che sono entrati davvero a un evento (mai a chi ha
// solo comprato senza presentarsi). Pulsante manuale su staff-attendees.html — resta utile
// anche con l'invio automatico attivo, per rimandare o testare senza aspettare il cron. Il link
// nell'email punta sempre al form nativo del sito (feedback.html), niente più Google Form.
async function handleSendFeedback(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY non configurato");

  const { eventName } = await request.json().catch(function(){ return {}; });

  const attendees = await listAttendeesForEvent(env, eventName);
  const { sent, failed } = await sendFeedbackEmails(env, attendees);

  return jsonResponse({ totalAttendees: attendees.length, sent, failed });
}

// Salva una risposta al form di feedback (feedback.html) su KV — nessun servizio esterno,
// stesso archivio dei biglietti, prefisso diverso per non mischiarli.
async function handleFeedbackSubmit(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const rating = Number(body.rating) || null;
  if (!rating || rating < 1 || rating > 5) {
    return jsonResponse({ error: "valutazione mancante o non valida" }, 400);
  }

  const id = crypto.randomUUID();
  await env.TICKETS.put(`feedback:${id}`, JSON.stringify({
    eventName: String(body.eventName || "").slice(0, 200) || null,
    name: String(body.name || "").slice(0, 200) || null,
    email: String(body.email || "").slice(0, 200) || null,
    rating,
    liked: String(body.liked || "").slice(0, 2000),
    improve: String(body.improve || "").slice(0, 2000),
    wouldRecommend: body.wouldRecommend === true,
    comments: String(body.comments || "").slice(0, 2000),
    submittedAt: new Date().toISOString()
  }));

  return jsonResponse({ ok: true });
}

// Legge tutte le risposte al form di feedback da KV (prefisso "feedback:"), più recenti prima.
// Protetta da STAFF_KEY come le altre rotte staff — vista di sola lettura per lo staff.
async function handleFeedbackList(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const responses = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "feedback:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) responses.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  responses.sort(function(a, b){ return (b.submittedAt || "").localeCompare(a.submittedAt || ""); });

  return jsonResponse({ responses });
}

// Cron giornaliero (vedi [triggers] in wrangler.toml): controlla se qualche evento è finito
// ieri e, se sì, manda in automatico l'email di feedback (che punta al form nativo del sito) ai
// suoi attendee — una volta sola per evento, grazie al marcatore
// "feedback_sent:<eventName>:<dataIso>" su KV che evita reinvii se il cron gira più volte.
async function runScheduledFeedback(env) {
  if (!env.TICKETS || !env.RESEND_API_KEY) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Raggruppa gli attendee per evento, leggendo eventDateIso dalla metadata.
  const events = new Map(); // eventName -> { dateIso, attendees: [] }
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const m = key.metadata;
      if (!m?.used || !m.email || !m.eventName) continue;
      if (!events.has(m.eventName)) {
        events.set(m.eventName, { dateIso: m.eventDateIso, attendees: [] });
      }
      events.get(m.eventName).attendees.push({ name: m.name, email: m.email, eventName: m.eventName });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  for (const [eventName, info] of events) {
    if (info.dateIso !== yesterday) continue;

    const sentMarkerKey = `feedback_sent:${eventName}:${info.dateIso}`;
    if (await env.TICKETS.get(sentMarkerKey)) continue;

    const result = await sendFeedbackEmails(env, info.attendees);
    await env.TICKETS.put(sentMarkerKey, JSON.stringify({ ...result, sentAt: new Date().toISOString() }));
    console.log(`Feedback automatico per "${eventName}": ${result.sent} inviate, ${result.failed} fallite`);
  }
}

// Stato reale delle fasce prezzo di un evento: conta i biglietti già venduti per fascia
// leggendo la metadata KV (stesso pattern di handleStats/handleAttendees, una sola lista invece
// di una GET per biglietto) e lo confronta con la capacità nel registro EVENTS. La fascia attiva
// è la prima non esaurita; il client non decide mai da solo cosa è disponibile.
async function handleEventTiers(request, env) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("event");
  const event = EVENTS[slug];
  if (!event) return jsonResponse({ error: "evento non trovato" }, 404);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const soldByTier = {};
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const m = key.metadata;
      if (m?.eventSlug === slug && m.tierId) {
        soldByTier[m.tierId] = (soldByTier[m.tierId] || 0) + 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let activeAssigned = false;
  const tiers = event.tiers.map(function(t){
    const sold = soldByTier[t.id] || 0;
    const soldOut = sold >= t.capacity;
    const active = !soldOut && !activeAssigned;
    if (active) activeAssigned = true;
    return { id: t.id, name: t.name, sub: t.sub, options: t.options, soldOut, active };
  });

  return jsonResponse({ eventName: event.name, tiers, allSoldOut: !activeAssigned });
}

// Iscrive alla newsletter MailerLite chi ha spuntato la relativa casella nel form di acquisto —
// stessa lista usata dal popup newsletter del sito. Avvolta in try/catch e non awaitata dal
// chiamante in modo bloccante sull'esito: se MailerLite non risponde o la chiave non è
// configurata, la registrazione del biglietto deve comunque andare a buon fine.
async function subscribeToMailerLite(env, email, name) {
  if (!env.MAILERLITE_API_KEY) return;
  try {
    const body = { email, fields: { name: name || "" } };
    if (env.MAILERLITE_GROUP_ID) body.groups = [env.MAILERLITE_GROUP_ID];
    const res = await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.MAILERLITE_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.log("MailerLite subscribe error:", res.status, await res.text());
  } catch (e) {
    console.log("Errore iscrizione MailerLite:", e.message);
  }
}

// Salva i dati raccolti dal form "I tuoi dati" (nome/cognome/email/consensi) prima
// dell'acquisto. Sostituisce Netlify Forms, oggi rotto e comunque scollegato dal pagamento
// reale: qui i dati restano su KV e vengono ripresi dal webhook dopo il pagamento, cosi' il
// biglietto usa davvero quello che la persona ha scritto sul sito.
// Controlla un codice coupon (5° evento gratis) per una data email: esiste, non è scaduto, non
// è già stato usato, ed è effettivamente di quella persona (mai fidarsi solo del codice — senza
// il controllo email chiunque intercetti un codice altrui potrebbe usarlo). Usata sia da
// handleRegister (al submit del form) sia da handleValidateCoupon (validazione live in pagina).
async function validateCoupon(env, code, email) {
  const raw = await env.TICKETS.get(`coupon:${code}`);
  if (!raw) return { valid: false, error: "coupon non valido" };
  const coupon = JSON.parse(raw);
  if (coupon.email.toLowerCase() !== String(email || "").trim().toLowerCase()) {
    return { valid: false, error: "questo coupon non è associato a questa email" };
  }
  if (coupon.used) return { valid: false, error: "coupon già utilizzato" };
  if (new Date(coupon.expiresAt) < new Date()) return { valid: false, error: "coupon scaduto" };
  return { valid: true, coupon };
}

async function handleValidateCoupon(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const code = String(body.code || "").trim().toUpperCase();
  const email = String(body.email || "").trim();
  if (!code || !email) return jsonResponse({ valid: false, error: "codice ed email obbligatori" }, 400);
  const result = await validateCoupon(env, code, email);
  return jsonResponse(result);
}

async function handleRegister(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const eventSlug = String(body.eventSlug || "");
  const name = String(body.name || "").trim().slice(0, 200);
  const phone = String(body.phone || "").trim().slice(0, 40);
  const email = String(body.email || "").trim().slice(0, 200);
  const termsAccepted = body.termsAccepted === true;
  const photoConsent = body.photoConsent === true;
  const newsletterOptin = body.newsletterOptin === true;
  const couponCode = String(body.couponCode || "").trim().toUpperCase();

  if (!EVENTS[eventSlug]) return jsonResponse({ error: "evento non valido" }, 400);
  if (!name || !phone || !email || !termsAccepted || !photoConsent) {
    return jsonResponse({ error: "nome, telefono, email, termini e condizioni e consenso foto/video sono obbligatori" }, 400);
  }

  // Il coupon è facoltativo: se il campo è vuoto si procede normalmente. Se è compilato, deve
  // essere valido — meglio bloccare qui con un errore chiaro che scoprirlo al checkout.
  if (couponCode) {
    const check = await validateCoupon(env, couponCode, email);
    if (!check.valid) return jsonResponse({ error: check.error }, 400);
  }

  const registrationId = crypto.randomUUID();
  await env.TICKETS.put(`registration:${registrationId}`, JSON.stringify({
    eventSlug, name, phone, email, termsAccepted, photoConsent, newsletterOptin,
    couponCode: couponCode || null,
    createdAt: new Date().toISOString()
  }));

  if (newsletterOptin) {
    await subscribeToMailerLite(env, email, name);
  }

  return jsonResponse({ registrationId });
}

// Crea la sessione di pagamento Stripe incorporata nel sito (ui_mode "embedded" invece del
// redirect a un Payment Link esterno). Prezzo e capacità si leggono SEMPRE dal registro
// server-side (EVENTS), mai da quello che manda il client: evita sia di far pagare un prezzo
// sbagliato sia di vendere una fascia già esaurita per una gara tra due richieste ravvicinate.
async function handleCreateCheckoutSession(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY non configurato");

  const { registrationId, tierId, optionId } = await request.json();

  const rawReg = registrationId ? await env.TICKETS.get(`registration:${registrationId}`) : null;
  if (!rawReg) return jsonResponse({ error: "registrazione non trovata o scaduta" }, 400);
  const registration = JSON.parse(rawReg);

  const found = findTierOption(registration.eventSlug, tierId, optionId);
  if (!found) return jsonResponse({ error: "fascia o opzione non valida" }, 400);

  // Ricontrollo la capacità qui, non solo lato UI: se nel frattempo la fascia si è esaurita
  // (un'altra persona ha comprato l'ultimo posto un attimo prima), rifiuto la creazione della
  // sessione invece di far pagare un biglietto per un posto che non c'è più.
  let sold = 0;
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if (key.metadata?.eventSlug === registration.eventSlug && key.metadata?.tierId === tierId) sold++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (sold >= found.tier.capacity) {
    return jsonResponse({ error: "fascia esaurita" }, 409);
  }

  // Ricontrollo il coupon qui, non solo al momento della registrazione: è il punto più vicino
  // possibile alla creazione della sessione di pagamento, quindi il controllo più affidabile
  // (nel mezzo qualcun altro potrebbe averlo già usato, o potrebbe essere scaduto proprio ora).
  let priceCents = found.option.priceCents;
  let couponApplied = null;
  if (registration.couponCode) {
    const check = await validateCoupon(env, registration.couponCode, registration.email);
    if (!check.valid) return jsonResponse({ error: "coupon non più valido: " + check.error }, 400);
    priceCents = 0;
    couponApplied = registration.couponCode;
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const origin = new URL(request.url).origin;

  const session = await stripe.checkout.sessions.create({
    ui_mode: "embedded",
    mode: "payment",
    client_reference_id: registrationId,
    customer_email: registration.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: priceCents,
        product_data: { name: `${found.event.name} — ${found.tier.name} — ${found.option.label}` + (couponApplied ? " (coupon 5° evento)" : "") }
      }
    }],
    metadata: {
      event: registration.eventSlug,
      tierId,
      optionId,
      couponCode: couponApplied || ""
    },
    return_url: `${origin}/biglietto-confermato?session_id={CHECKOUT_SESSION_ID}`
  });

  return jsonResponse({ clientSecret: session.client_secret });
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

    // Nome/email/consensi arrivano dalla registrazione fatta sul form del sito PRIMA del
    // pagamento (POST /api/register), recuperata via client_reference_id — non più da
    // session.customer_details di Stripe: cosi' il biglietto usa davvero i dati raccolti sul
    // sito (compresi i consensi, che con il vecchio form Netlify si perdevano).
    const registrationId = session.client_reference_id;
    const rawReg = registrationId ? await env.TICKETS.get(`registration:${registrationId}`) : null;

    if (!rawReg) {
      console.log("checkout.session.completed senza registrazione trovata, ignorato:", session.id);
    }

    if (rawReg) {
      const registration = JSON.parse(rawReg);
      const eventSlug = session.metadata?.event || registration.eventSlug;
      const tierId = session.metadata?.tierId;
      const optionId = session.metadata?.optionId;
      const found = findTierOption(eventSlug, tierId, optionId);
      const eventInfo = found?.event || EVENTS[eventSlug];

      const email = registration.email;
      const customerName = registration.name;
      const customerPhone = registration.phone;
      const eventName = eventInfo?.name || "GrowMi";
      const eventDate = eventInfo?.dateDisplay || "";
      const eventLocation = eventInfo?.location || "";
      const eventTeaser = eventInfo?.teaser || "";
      // Data in formato AAAA-MM-GG: serve al cron giornaliero per capire "questo evento è stato
      // ieri?" e mandare il feedback da solo.
      const eventDateIso = eventInfo?.dateIso || null;
      const tierName = found ? `${found.tier.name} — ${found.option.label}` : null;
      const ticketCode = generateTicketCode();

      // SVG invece di PNG: su Cloudflare Workers la libreria carica la sua versione "da
      // browser" (punta a un <canvas> che qui non esiste, e in quella versione manca anche
      // toBuffer). toString con type "svg" è testo puro, funziona in qualsiasi ambiente.
      const qrSvg = await QRCode.toString(ticketCode, { type: "svg", margin: 1, width: 400 });
      const qrBase64 = btoa(qrSvg);

      await env.TICKETS.put(`ticket:${ticketCode}`, JSON.stringify({
        email,
        name: customerName,
        phone: customerPhone,
        eventName,
        eventDate,
        eventDateIso,
        eventLocation,
        tierName,
        eventSlug,
        tierId,
        optionId,
        termsAccepted: registration.termsAccepted,
        photoConsent: registration.photoConsent,
        newsletterOptin: registration.newsletterOptin,
        amountTotal: session.amount_total,
        currency: session.currency,
        used: false,
        createdAt: new Date().toISOString(),
        stripeSessionId: session.id
      }), { metadata: { used: false, eventSlug, tierId, email, eventName, eventDateIso, tierName } });

      // Se questo acquisto ha usato un coupon (5° evento gratis), lo segno come speso solo ORA
      // che il biglietto esiste davvero — mai prima, altrimenti un pagamento fallito/abbandonato
      // brucerebbe comunque il coupon senza che la persona abbia ottenuto nulla in cambio.
      const couponCode = session.metadata?.couponCode;
      if (couponCode) {
        const couponRaw = await env.TICKETS.get(`coupon:${couponCode}`);
        if (couponRaw) {
          const coupon = JSON.parse(couponRaw);
          coupon.used = true;
          coupon.usedAt = new Date().toISOString();
          coupon.usedForTicketCode = ticketCode;
          await env.TICKETS.put(`coupon:${couponCode}`, JSON.stringify(coupon));
        }
      }

      // La registrazione è servita al suo scopo (i dati sono ora sul biglietto): la rimuovo per
      // non lasciare copie sparse di dati personali su KV più a lungo del necessario.
      await env.TICKETS.delete(`registration:${registrationId}`);
      // Segna l'evento Stripe come gestito solo ORA che il biglietto esiste davvero su KV:
      // cosi' se il Worker si interrompe prima di questo punto, un eventuale nuovo tentativo di
      // Stripe riesce comunque a creare il biglietto, invece di essere scartato come "già fatto"
      // quando in realtà non è mai stato completato.
      await env.TICKETS.put(dedupeKey, ticketCode);

      // Nessun timbro loyalty qui: scatta solo alla presenza reale confermata al check-in
      // (vedi handleCheckin) — chi compra e non si presenta non riceve il timbro.

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
            from: "GrowMi <noreply@growmi.it>",
            to: email,
            subject: `Il tuo biglietto — ${eventName}`,
            html: buildTicketEmailHTML({ name: customerName, eventName, eventDate, eventLocation, eventTeaser, tierName, optionId, ticketCode, qrBase64 }),
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

// ============================================================================
// Area personale: account cliente, login/sessione via cookie, loyalty card.
// Stesso archivio KV "TICKETS" di tutto il resto (nessuna nuova infrastruttura), prefissi
// nuovi: account:<email>, session:<token>, loyalty:<email>.
// ============================================================================

// Hash password con PBKDF2-SHA256 via Web Crypto nativo (nessuna libreria esterna: bcrypt non
// è disponibile su Cloudflare Workers, PBKDF2 sì ed è considerato sicuro con iterazioni alte).
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Confronto a tempo costante: evita che un attaccante deduca quanto è "vicina" una password
// sbagliata misurando quanto ci mette il confronto a fallire (timing attack).
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach(function(part) {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `growmi_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
function clearSessionCookieHeader() {
  return "growmi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

// Legge la sessione dal cookie e restituisce l'email dell'account loggato, o null. Usata da
// ogni endpoint /api/account/* che deve sapere CHI sta chiedendo — mai fidarsi di un'email
// mandata dal client stesso nel body della richiesta.
async function getSessionEmail(request, env) {
  const cookies = parseCookies(request);
  const token = cookies["growmi_session"];
  if (!token) return null;
  const raw = await env.TICKETS.get(`session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (new Date(session.expiresAt) < new Date()) {
    await env.TICKETS.delete(`session:${token}`);
    return null;
  }
  return session.email;
}

// Template email account (verifica/reset password): stessa impostazione a card viola delle
// altre email GrowMi, ma senza QR — solo un pulsante.
function buildAccountEmailHTML({ title, lead, buttonLabel, buttonUrl, note }) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#2C0943" style="background:#2C0943; border-radius:24px; max-width:600px;">
        <tr>
          <td style="padding:48px 44px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="font-size:26px; font-weight:bold; color:#F86639; padding-bottom:18px; line-height:1.3;">${title}</td></tr>
              <tr><td align="center" style="font-size:17px; color:#FBF6F0; line-height:1.6; padding-bottom:26px;">${lead}</td></tr>
              <tr>
                <td align="center" style="padding-bottom:10px;">
                  <a href="${buttonUrl}" style="display:inline-block; background:#F86639; color:#FFFFFF; font-family:Arial, Helvetica, sans-serif; font-weight:bold; font-size:16px; text-decoration:none; padding:15px 34px; border-radius:12px;">${buttonLabel}</a>
                </td>
              </tr>
              ${note ? `<tr><td align="center" style="font-size:13px; color:#C9BCD6; padding-top:18px;">${note}</td></tr>` : ""}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
}

async function sendAccountEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "GrowMi <noreply@growmi.it>", to, subject, html })
  });
  if (!res.ok) console.log("Resend error (account):", res.status, await res.text());
}

// Piccola pagina HTML autonoma per i link cliccati direttamente dalle email (conferma email,
// eventuali errori) — non serve caricare tutto il sito per un messaggio di conferma.
function accountStatusPageHTML(title, message) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — GrowMi</title>
<meta name="robots" content="noindex, nofollow">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  body{ background:#FBF6F0; color:#1E0C2C; font-family:'Inter',sans-serif; min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; }
  .card{ max-width:420px; }
  h1{ font-family:'Space Grotesk',sans-serif; font-size:24px; margin-bottom:12px; }
  p{ color:#6E6478; font-size:14.5px; }
  a{ display:inline-block; margin-top:22px; background:#F86639; color:#fff; text-decoration:none; padding:13px 26px; border-radius:12px; font-weight:600; font-family:'Space Grotesk',sans-serif; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/area-personale">Vai alla tua area personale</a>
  </div>
</body>
</html>`;
}

// Tabella di codifica Code128 (set B — ASCII 32-127, sufficiente per un numero cliente
// numerico), verificata contro la libreria jsbarcode: ogni voce è un pattern di 11 moduli
// (13 per lo stop finale), 1=barra nera 0=spazio bianco. Niente libreria esterna: stesso
// approccio già usato per il QR nel PDF biglietto (disegnare moduli grezzi invece di
// affidarsi a un renderer che su Cloudflare Workers non ha canvas disponibile).
const CODE128_BARS = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100, 10001001100, 10011001000, 10011000100,
  10001100100, 11001001000, 11001000100, 11000100100, 10110011100, 10011011100, 10011001110, 10111001100,
  10011101100, 10011100110, 11001110010, 11001011100, 11001001110, 11011100100, 11001110100, 11101101110,
  11101001100, 11100101100, 11100100110, 11101100100, 11100110100, 11100110010, 11011011000, 11011000110,
  11000110110, 10100011000, 10001011000, 10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110, 10111011000, 10111000110, 10001110110,
  11101110110, 11010001110, 11000101110, 11011101000, 11011100010, 11011101110, 11101011000, 11101000110,
  11100010110, 11101101000, 11101100010, 11100011010, 11101111010, 11001000010, 11110001010, 10100110000,
  10100001100, 10010110000, 10010000110, 10000101100, 10000100110, 10110010000, 10110000100, 10011010000,
  10011000010, 10000110100, 10000110010, 11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100, 10011110010, 11110100100, 11110010100,
  11110010010, 11011011110, 11011110110, 11110110110, 10101111000, 10100011110, 10001011110, 10111101000,
  10111100010, 11110101000, 11110100010, 10111011110, 10111101110, 11101011110, 11110101110, 11010000100,
  11010010000, 11010011100, 1100011101011
];
const CODE128_START_B = 104;
const CODE128_STOP = 106;

// Codifica una stringa (solo ASCII 32-127: cifre e lettere bastano per il numero cliente)
// nella sequenza di simboli Code128 Set B, checksum incluso — formula standard:
// (valore_start + Σ valore_carattere_i × posizione_i) mod 103.
function encodeCode128B(text) {
  const values = [CODE128_START_B];
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) throw new Error("carattere non supportato dal barcode: " + ch);
    values.push(code - 32);
  }
  let checksum = values[0];
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103);
  values.push(CODE128_STOP);
  return values.map(v => String(CODE128_BARS[v]));
}

// Disegna i moduli del barcode come rettangoli SVG (stessa logica "solo calcolo, nessun
// renderer" già usata per il QR del PDF biglietto).
function code128Svg(text, opts) {
  opts = opts || {};
  const height = opts.height || 90;
  const moduleWidth = opts.moduleWidth || 2.4;
  const quietZone = moduleWidth * 10;
  const patterns = encodeCode128B(text);
  let x = quietZone;
  let rects = "";
  for (const pattern of patterns) {
    for (const bit of pattern) {
      if (bit === "1") rects += `<rect x="${x}" y="0" width="${moduleWidth}" height="${height}" fill="#000"/>`;
      x += moduleWidth;
    }
  }
  const totalWidth = x + quietZone;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" width="${totalWidth}" height="${height}">` +
    `<rect x="0" y="0" width="${totalWidth}" height="${height}" fill="#fff"/>${rects}</svg>`;
}

// Numero cliente per chi richiede una loyalty card digitale (senza carta fisica): sequenziale
// a partire da 251, per non sovrapporsi mai alle carte fisiche numerate 1-250 (200 già
// consegnate il 4 giugno + margine fino a 250 per stampe future). Nessuna vera transazione
// atomica su KV — un rischio di collisione esiste solo se due persone la richiedono nello
// stesso istante esatto, accettabile ai volumi di GrowMi (stesso principio già scelto per il
// numero cliente casuale che questa funzione sostituisce).
async function nextSequentialCustomerNumber(env) {
  const raw = await env.TICKETS.get("config:nextCustomerNumber");
  const next = raw ? parseInt(raw, 10) : 251;
  await env.TICKETS.put("config:nextCustomerNumber", String(next + 1));
  return String(next).padStart(3, "0");
}

// Email del coupon "5° evento gratis": stesso stile a card viola delle altre email GrowMi,
// codice mostrato in grande dentro un riquadro cosi' è facile da leggere/copiare anche da
// telefono, pulsante che porta dritti alla pagina eventi per usarlo subito o quando vuole.
function buildCouponEmailHTML({ name, code, expiresLabel }) {
  const firstName = name ? name.split(" ")[0] : "";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#2C0943" style="background:#2C0943; border-radius:24px; max-width:600px;">
        <tr>
          <td style="padding:48px 44px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="font-size:28px; font-weight:bold; color:#F86639; padding-bottom:14px; line-height:1.3;">&#127881; Hai sbloccato il 5&deg; timbro, ${firstName}!</td></tr>
              <tr><td align="center" style="font-size:16px; color:#FBF6F0; line-height:1.6; padding-bottom:26px;">Come promesso dalla tua loyalty card GrowMi, ecco il codice per il tuo <strong>ingresso gratuito</strong> al prossimo evento che scegli.</td></tr>
              <tr>
                <td align="center" style="padding-bottom:22px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0; border-radius:14px; border:2px dashed #F86639;">
                    <tr><td style="padding:18px 30px; font-family:'Courier New', monospace; font-size:28px; font-weight:bold; letter-spacing:4px; color:#2C0943;">${code}</td></tr>
                  </table>
                </td>
              </tr>
              <tr><td align="center" style="font-size:13px; color:#C9BCD6; padding-bottom:26px;">Valido fino al ${expiresLabel} &middot; utilizzabile una sola volta, per qualsiasi evento GrowMi tu scelga.</td></tr>
              <tr>
                <td align="center">
                  <a href="https://growmisito.grow-mi.workers.dev/eventi" style="display:inline-block; background:#F86639; color:#FFFFFF; font-family:Arial, Helvetica, sans-serif; font-weight:bold; font-size:16px; text-decoration:none; padding:15px 34px; border-radius:12px;">Scegli il tuo evento</a>
                </td>
              </tr>
              <tr><td align="center" style="font-size:13px; color:#C9BCD6; padding-top:22px;">Inseriscilo nel campo "Codice coupon" al momento dell'acquisto: il biglietto risulterà a costo zero.</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
}

// Genera e manda via email il coupon per l'ingresso gratuito al 5° evento — uso singolo, valido
// 6 mesi dall'emissione, per qualsiasi evento GrowMi scelto dal cliente (non solo il prossimo in
// assoluto). Chiamata una volta sola da addLoyaltyStamp, esattamente al quinto timbro.
async function issueGrowMiCoupon(env, email, name) {
  const code = generateTicketCode();
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 6);
  await env.TICKETS.put(`coupon:${code}`, JSON.stringify({
    email, name, createdAt: new Date().toISOString(), expiresAt: expires.toISOString(), used: false
  }));
  if (env.RESEND_API_KEY) {
    await sendAccountEmail(env, {
      to: email,
      subject: "🎉 Il tuo coupon per l'ingresso gratuito — GrowMi",
      html: buildCouponEmailHTML({
        name,
        code,
        expiresLabel: expires.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" })
      })
    });
  }
  return code;
}

// Aggiunge un timbro loyalty, evitando doppioni se lo stesso biglietto viene passato due volte
// (es. check-in ripetuto per errore). Scatta solo alla presenza reale confermata al check-in
// (vedi handleCheckin) — chi compra e non si presenta non riceve il timbro, cosi' il vantaggio
// (drink al 3° evento, ingresso gratis al 5°) è utilizzabile subito sul posto. Se l'account non
// esiste ancora, non fa nulla: il timbro arriva comunque in automatico quando la persona crea
// l'account (vedi handleAccountRegister → backfillLoyaltyFromTickets, solo biglietti già usati).
// Ritorna il numero di timbri aggiornato, o null se non è stato aggiunto nulla (nessun account,
// o timbro già dato in precedenza per lo stesso biglietto).
async function addLoyaltyStamp(env, email, entry) {
  if (!email) return null;
  const accountRaw = await env.TICKETS.get(`account:${email}`);
  if (!accountRaw) return null;
  const account = JSON.parse(accountRaw);
  const raw = await env.TICKETS.get(`loyalty:${email}`);
  const loyalty = raw ? JSON.parse(raw) : { stamps: 0, history: [], redeemed: {} };
  if (loyalty.history.some(function(h){ return h.ticketCode === entry.ticketCode; })) return loyalty.stamps;
  loyalty.stamps += 1;
  loyalty.history.push(entry);
  loyalty.redeemed = loyalty.redeemed || {};
  // Il 5° timbro è "automatico": a differenza del drink al 3° (dato di persona dallo staff, vedi
  // handleRedeemReward), qui non serve nessuna azione dello staff — il coupon parte via email da
  // solo nell'istante esatto in cui scatta il quinto timbro. Il flag redeemed["5"] qui significa
  // "coupon già emesso", non più "dato allo scanner".
  if (loyalty.stamps === 5 && !loyalty.redeemed["5"]) {
    await issueGrowMiCoupon(env, email, account.name);
    loyalty.redeemed["5"] = new Date().toISOString();
  }
  await env.TICKETS.put(`loyalty:${email}`, JSON.stringify(loyalty));
  return loyalty.stamps;
}

// Al momento della creazione dell'account, timbra retroattivamente gli eventi a cui la persona
// si è già presentata (check-in fatto) con quella email PRIMA di registrarsi (acquisto "come
// ospite" avvenuto prima dell'account) — cosi' chi si registra dopo aver già partecipato a un
// evento non perde il timbro. I biglietti comprati ma mai usati non contano, stessa regola di
// handleCheckin.
async function backfillLoyaltyFromTickets(env, email) {
  const entries = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      // Solo i biglietti già usati (check-in reale confermato): il timbro segue la stessa
      // regola di handleCheckin, mai un biglietto comprato e basta senza essersi presentati.
      if (key.metadata?.email === email && key.metadata?.used) {
        entries.push({
          eventName: key.metadata.eventName || null,
          ticketCode: key.name.replace("ticket:", ""),
          stampedAt: key.metadata.usedAt || key.metadata.eventDateIso || new Date().toISOString()
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!entries.length) return;

  const raw = await env.TICKETS.get(`loyalty:${email}`);
  const loyalty = raw ? JSON.parse(raw) : { stamps: 0, history: [] };
  for (const entry of entries) {
    if (!loyalty.history.some(function(h){ return h.ticketCode === entry.ticketCode; })) {
      loyalty.stamps += 1;
      loyalty.history.push(entry);
    }
  }
  await env.TICKETS.put(`loyalty:${email}`, JSON.stringify(loyalty));
}

async function handleAccountRegister(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 200);

  if (!email || !email.includes("@") || !name) {
    return jsonResponse({ error: "nome ed email sono obbligatori" }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: "la password deve avere almeno 8 caratteri" }, 400);
  }
  if (await env.TICKETS.get(`account:${email}`)) {
    return jsonResponse({ error: "esiste già un account con questa email" }, 409);
  }

  const salt = crypto.randomUUID();
  const passwordHash = await hashPassword(password, salt);
  const verifyToken = crypto.randomUUID();

  await env.TICKETS.put(`account:${email}`, JSON.stringify({
    email, name, passwordHash, salt,
    emailVerified: false,
    verifyToken,
    // Nessun numero cliente/loyalty card alla semplice registrazione: arriva solo quando la
    // persona lo richiede esplicitamente dall'area personale (vedi handleRequestLoyaltyCard),
    // oppure riscatta una carta fisica già posseduta (vedi handleClaimPhysicalCard).
    customerNumber: null,
    physicalCardClaimed: false,
    createdAt: new Date().toISOString(),
    // Dati personali estesi (sezione "Dati personali e consensi"), vuoti finché la persona non
    // li compila dalla propria area personale — vedi handleAccountProfile.
    profile: {
      customerType: null, title: null, firstName: null, lastName: null,
      birthDay: null, birthMonth: null, birthYear: null,
      gender: null, birthCountry: null, birthCity: null,
      newsletterOptin: false
    }
  }));

  await backfillLoyaltyFromTickets(env, email);

  const origin = new URL(request.url).origin;
  const verifyUrl = `${origin}/api/account/verify?token=${verifyToken}`;
  await sendAccountEmail(env, {
    to: email,
    subject: "Conferma la tua email — GrowMi",
    html: buildAccountEmailHTML({
      title: `Ciao ${name.split(" ")[0] || ""}!`,
      lead: "Conferma la tua email per attivare il tuo account GrowMi e iniziare a timbrare la tua loyalty card.",
      buttonLabel: "Conferma email",
      buttonUrl: verifyUrl
    })
  });

  return jsonResponse({ ok: true, message: "Controlla la tua email per confermare l'account." });
}

async function handleAccountVerify(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response(accountStatusPageHTML("Link non valido", "Manca il codice di conferma."), { headers: { "Content-Type": "text/html" }, status: 400 });
  }

  // Nessun indice separato token→email: si scorrono gli account (volumi piccoli per GrowMi,
  // non serve altro) cercando quello con questo verifyToken.
  let cursor = undefined;
  let found = null;
  do {
    const page = await env.TICKETS.list({ prefix: "account:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      const acc = JSON.parse(raw);
      if (acc.verifyToken === token) { found = { key: key.name, acc }; break; }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && !found);

  if (!found) {
    return new Response(accountStatusPageHTML("Link non valido", "Questo link di conferma non è valido o è già stato usato."), { headers: { "Content-Type": "text/html" }, status: 400 });
  }

  found.acc.emailVerified = true;
  delete found.acc.verifyToken;
  await env.TICKETS.put(found.key, JSON.stringify(found.acc));

  return new Response(accountStatusPageHTML("Email confermata!", "Il tuo account GrowMi è attivo. Ora puoi accedere alla tua area personale."), { headers: { "Content-Type": "text/html" } });
}

async function handleAccountLogin(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return jsonResponse({ error: "email e password sono obbligatorie" }, 400);

  const raw = await env.TICKETS.get(`account:${email}`);
  if (!raw) return jsonResponse({ error: "email o password non corretti" }, 401);
  const account = JSON.parse(raw);

  const hash = await hashPassword(password, account.salt);
  if (!timingSafeEqual(hash, account.passwordHash)) {
    return jsonResponse({ error: "email o password non corretti" }, 401);
  }
  if (!account.emailVerified) {
    return jsonResponse({ error: "conferma prima la tua email — controlla la posta in arrivo" }, 403);
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.TICKETS.put(`session:${token}`, JSON.stringify({ email, expiresAt }));

  return new Response(JSON.stringify({ ok: true, name: account.name, email }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token, 30 * 24 * 60 * 60) }
  });
}

async function handleAccountLogout(request, env) {
  const cookies = parseCookies(request);
  const token = cookies["growmi_session"];
  if (token) await env.TICKETS.delete(`session:${token}`);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookieHeader() }
  });
}

async function handleAccountMe(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  const raw = await env.TICKETS.get(`account:${email}`);
  if (!raw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(raw);
  return jsonResponse({
    email: account.email, name: account.name, createdAt: account.createdAt,
    customerNumber: account.customerNumber || null,
    physicalCardClaimed: !!account.physicalCardClaimed,
    profile: account.profile || {}
  });
}

// Salva la scheda "Dati personali e consensi" — stesso account, campi in più (numero cliente
// escluso, quello non si cambia). Tutto facoltativo: si può salvare anche solo qualche campo
// alla volta, non serve compilarli tutti insieme.
async function handleAccountProfile(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const raw = await env.TICKETS.get(`account:${email}`);
  if (!raw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(raw);

  const body = await request.json();
  const allowed = ["customerType", "title", "firstName", "lastName", "birthDay", "birthMonth", "birthYear", "gender", "birthCountry", "birthCity", "newsletterOptin"];
  account.profile = account.profile || {};
  for (const key of allowed) {
    if (key in body) {
      account.profile[key] = key === "newsletterOptin" ? body[key] === true : String(body[key] || "").trim().slice(0, 200) || null;
    }
  }

  await env.TICKETS.put(`account:${email}`, JSON.stringify(account));
  return jsonResponse({ ok: true, profile: account.profile });
}

// Storico biglietti dell'account loggato: legge dalla metadata KV (email inclusa dalla
// creazione del biglietto in poi), stesso pattern di /api/attendees — una sola KV.list()
// invece di una GET per ogni biglietto esistente sul sito.
async function handleAccountTickets(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const tickets = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if (key.metadata?.email === email) {
        tickets.push({
          code: key.name.replace("ticket:", ""),
          eventName: key.metadata.eventName || null,
          eventDateIso: key.metadata.eventDateIso || null,
          tierName: key.metadata.tierName || null,
          used: !!key.metadata.used,
          usedAt: key.metadata.usedAt || null
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  tickets.sort(function(a, b){ return (b.eventDateIso || "").localeCompare(a.eventDateIso || ""); });
  return jsonResponse({ tickets });
}

// Ridà il QR di un singolo biglietto a chi è loggato, solo se il biglietto è davvero suo
// (stessa email della sessione) — evita che qualcuno possa indovinare un codice e vedere il
// QR di un altro cliente.
async function handleAccountTicketQr(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const url = new URL(request.url);
  const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
  if (!code) return jsonResponse({ error: "codice mancante" }, 400);

  const raw = await env.TICKETS.get(`ticket:${code}`);
  if (!raw) return jsonResponse({ error: "biglietto non trovato" }, 404);
  const ticket = JSON.parse(raw);
  if (ticket.email !== email) return jsonResponse({ error: "non autorizzato" }, 403);

  const qrSvg = await QRCode.toString(code, { type: "svg", margin: 1, width: 320 });
  return jsonResponse({
    code, eventName: ticket.eventName, eventDate: ticket.eventDate, tierName: ticket.tierName,
    used: ticket.used, usedAt: ticket.usedAt || null,
    qrBase64: btoa(qrSvg)
  });
}

async function handleAccountLoyalty(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  const raw = await env.TICKETS.get(`loyalty:${email}`);
  const loyalty = raw ? JSON.parse(raw) : { stamps: 0, history: [] };
  return jsonResponse(loyalty);
}

// Barcode Code128 del numero cliente dell'account loggato, da mostrare nell'area personale e
// far scansionare allo staff all'ingresso (identificazione, non timbra nulla — il timbro
// loyalty resta legato solo all'acquisto del biglietto, vedi addLoyaltyStamp).
async function handleAccountLoyaltyBarcode(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  const raw = await env.TICKETS.get(`account:${email}`);
  if (!raw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(raw);
  if (!account.customerNumber) return jsonResponse({ error: "numero cliente mancante" }, 404);
  const svg = code128Svg(account.customerNumber);
  return jsonResponse({ customerNumber: account.customerNumber, svgBase64: btoa(svg) });
}

// Assegna una loyalty card digitale a chi non ne ha ancora una (né fisica né richiesta prima):
// numero sequenziale a partire da 251 (vedi nextSequentialCustomerNumber), così non si scontra
// mai con le carte fisiche numerate 1-250. Azione esplicita dell'account loggato, niente più
// assegnazione automatica alla semplice registrazione.
async function handleRequestLoyaltyCard(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const accountRaw = await env.TICKETS.get(`account:${email}`);
  if (!accountRaw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(accountRaw);
  if (account.customerNumber) {
    return jsonResponse({ error: "hai già una loyalty card" }, 409);
  }

  const customerNumber = await nextSequentialCustomerNumber(env);
  account.customerNumber = customerNumber;
  await env.TICKETS.put(`account:${email}`, JSON.stringify(account));
  await env.TICKETS.put(`customernum:${customerNumber}`, email);

  return jsonResponse({ ok: true, customerNumber });
}

// Collega una carta fedeltà fisica già posseduta (numeri 1-250: le 200 consegnate il 4 giugno
// più margine per stampe future, mai timbrate finora) all'account online: il numero fisico
// diventa il "numero cliente" ufficiale dell'account, così la card fisica e quella digitale
// sono la stessa identità agli occhi dello staff. Un numero può essere riscattato una volta sola.
async function handleClaimPhysicalCard(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const parsed = parseInt(String(body.cardNumber || "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
    return jsonResponse({ error: "numero carta non valido (deve essere tra 1 e 250)" }, 400);
  }
  const cardNumber = String(parsed).padStart(3, "0");

  const accountRaw = await env.TICKETS.get(`account:${email}`);
  if (!accountRaw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(accountRaw);
  if (account.physicalCardClaimed) {
    return jsonResponse({ error: "hai già collegato una carta fisica a questo account" }, 409);
  }

  const claimKey = `physicalcard:${cardNumber}`;
  if (await env.TICKETS.get(claimKey)) {
    return jsonResponse({ error: "questo numero carta è già stato riscattato" }, 409);
  }

  const oldCustomerNumber = account.customerNumber;
  await env.TICKETS.put(claimKey, JSON.stringify({ email, claimedAt: new Date().toISOString() }));
  if (oldCustomerNumber) await env.TICKETS.delete(`customernum:${oldCustomerNumber}`);
  await env.TICKETS.put(`customernum:${cardNumber}`, email);

  account.customerNumber = cardNumber;
  account.physicalCardClaimed = true;
  await env.TICKETS.put(`account:${email}`, JSON.stringify(account));

  return jsonResponse({ ok: true, customerNumber: cardNumber });
}

// Sia il numero sequenziale digitale (251 in su) sia quello di una carta fisica riscattata
// (001-250) sono zero-paddati a 3 cifre: proviamo prima il valore così com'è, poi la versione
// paddata, così lo staff può anche digitare "7" a mano invece di leggerlo dal barcode.
async function resolveEmailByCustomerNumber(env, raw) {
  const candidates = [raw, raw.padStart(3, "0")];
  for (const candidate of candidates) {
    const email = await env.TICKETS.get(`customernum:${candidate}`);
    if (email) return email;
  }
  return null;
}

// Cerca un account dal numero cliente scansionato (barcode digitale o carta fisica riscattata):
// mostra allo staff chi è e a che punto è con la loyalty card. Sola lettura, nessun timbro —
// protetta dalla stessa chiave staff dello scanner biglietti, stesso principio di handleCheckin.
async function handleLookupByCustomerNumber(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const url = new URL(request.url);
  const raw = String(url.searchParams.get("number") || "").trim();
  if (!raw) return jsonResponse({ found: false });

  const email = await resolveEmailByCustomerNumber(env, raw);
  if (!email) return jsonResponse({ found: false });

  const accountRaw = await env.TICKETS.get(`account:${email}`);
  if (!accountRaw) return jsonResponse({ found: false });
  const account = JSON.parse(accountRaw);

  const loyaltyRaw = await env.TICKETS.get(`loyalty:${email}`);
  const loyalty = loyaltyRaw ? JSON.parse(loyaltyRaw) : { stamps: 0, redeemed: {} };
  const redeemed = loyalty.redeemed || {};

  return jsonResponse({
    found: true,
    name: account.name,
    email: account.email,
    customerNumber: account.customerNumber,
    physicalCardClaimed: !!account.physicalCardClaimed,
    stamps: loyalty.stamps || 0,
    reward3: (loyalty.stamps || 0) >= 3,
    reward3Redeemed: !!redeemed["3"],
    reward5: (loyalty.stamps || 0) >= 5,
    reward5Redeemed: !!redeemed["5"]
  });
}

// Segna una ricompensa (drink al 3° evento, ingresso gratis al 5°) come "data" dallo staff —
// una volta sola, cosi' non si può rivendicare due volte lo stesso vantaggio mostrando di nuovo
// la card. Protetta dalla stessa chiave staff, sola scrittura su un flag, nessun timbro toccato.
async function handleRedeemReward(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const reward = String(body.reward || "").trim();
  if (reward !== "3" && reward !== "5") {
    return jsonResponse({ error: "parametri mancanti o non validi" }, 400);
  }

  // Accetta l'email diretta (lo scanner biglietti la conosce già dal check-in appena fatto,
  // non serve richiedere di nuovo il numero cliente) oppure il numero cliente/carta (lo usa la
  // ricerca loyalty, che parte solo dal numero scansionato).
  let email = String(body.email || "").trim().toLowerCase();
  if (!email) {
    const raw = String(body.number || "").trim();
    if (!raw) return jsonResponse({ error: "parametri mancanti o non validi" }, 400);
    email = await resolveEmailByCustomerNumber(env, raw);
  }
  if (!email) return jsonResponse({ error: "cliente non trovato" }, 404);

  const loyaltyRaw = await env.TICKETS.get(`loyalty:${email}`);
  const loyalty = loyaltyRaw ? JSON.parse(loyaltyRaw) : { stamps: 0, history: [], redeemed: {} };
  loyalty.redeemed = loyalty.redeemed || {};

  const threshold = reward === "3" ? 3 : 5;
  if ((loyalty.stamps || 0) < threshold) {
    return jsonResponse({ error: "non ha ancora abbastanza timbri per questa ricompensa" }, 409);
  }
  if (loyalty.redeemed[reward]) {
    return jsonResponse({ error: "ricompensa già data in precedenza" }, 409);
  }

  loyalty.redeemed[reward] = new Date().toISOString();
  await env.TICKETS.put(`loyalty:${email}`, JSON.stringify(loyalty));

  return jsonResponse({ ok: true, reward });
}

async function handleAccountForgotPassword(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return jsonResponse({ error: "email obbligatoria" }, 400);

  const raw = await env.TICKETS.get(`account:${email}`);
  // Risponde sempre "ok", anche se l'account non esiste: cosi' non si rivela a chi lo chiede
  // se una certa email ha o no un account GrowMi.
  if (raw) {
    const account = JSON.parse(raw);
    account.resetToken = crypto.randomUUID();
    account.resetExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.TICKETS.put(`account:${email}`, JSON.stringify(account));

    const origin = new URL(request.url).origin;
    const resetUrl = `${origin}/area-personale?reset=${account.resetToken}&email=${encodeURIComponent(email)}`;
    await sendAccountEmail(env, {
      to: email,
      subject: "Reimposta la tua password — GrowMi",
      html: buildAccountEmailHTML({
        title: "Reimposta la password",
        lead: "Hai chiesto di reimpostare la password del tuo account GrowMi. Il link scade tra un'ora.",
        buttonLabel: "Scegli una nuova password",
        buttonUrl: resetUrl,
        note: "Se non sei stato tu, ignora questa email: la tua password resta quella di sempre."
      })
    });
  }

  return jsonResponse({ ok: true, message: "Se l'email è registrata, ti abbiamo mandato le istruzioni." });
}

async function handleAccountResetPassword(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  const token = String(body.token || "");
  const newPassword = String(body.newPassword || "");
  if (!email || !token || newPassword.length < 8) {
    return jsonResponse({ error: "dati mancanti o password troppo corta (minimo 8 caratteri)" }, 400);
  }

  const raw = await env.TICKETS.get(`account:${email}`);
  if (!raw) return jsonResponse({ error: "link non valido" }, 400);
  const account = JSON.parse(raw);
  if (!account.resetToken || account.resetToken !== token) {
    return jsonResponse({ error: "link non valido" }, 400);
  }
  if (new Date(account.resetExpires) < new Date()) {
    return jsonResponse({ error: "link scaduto, richiedine uno nuovo" }, 400);
  }

  account.salt = crypto.randomUUID();
  account.passwordHash = await hashPassword(newPassword, account.salt);
  delete account.resetToken;
  delete account.resetExpires;
  await env.TICKETS.put(`account:${email}`, JSON.stringify(account));

  return jsonResponse({ ok: true });
}
