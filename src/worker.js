import Stripe from "stripe";
import QRCode from "qrcode";

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

  const raw = await env.TICKETS.get(ticketCode);
  if (!raw) {
    return jsonResponse({ valid: false, reason: "not_found" });
  }

  const ticket = JSON.parse(raw);
  if (ticket.used) {
    return jsonResponse({ valid: false, reason: "already_used", usedAt: ticket.usedAt, email: ticket.email });
  }

  ticket.used = true;
  ticket.usedAt = new Date().toISOString();
  await env.TICKETS.put(ticketCode, JSON.stringify(ticket));

  return jsonResponse({ valid: true, email: ticket.email, eventName: ticket.eventName, tierName: ticket.tierName });
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
    const session = event.data.object;
    const email = session.customer_details?.email;

    if (email) {
      // Per ora un solo evento attivo (The Miseducation of GrowMi, 10 settembre): quando ce ne
      // saranno altri in vendita insieme, va distinto leggendo i metadata del Payment Link.
      const eventName = "The Miseducation of GrowMi";
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

      if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

      await env.TICKETS.put(ticketCode, JSON.stringify({
        email,
        eventName,
        tierName,
        amountTotal: session.amount_total,
        currency: session.currency,
        used: false,
        createdAt: new Date().toISOString(),
        stripeSessionId: session.id
      }));

      if (env.RESEND_API_KEY) {
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
            html: `
              <p>Grazie per il tuo acquisto! Ecco il tuo biglietto per <strong>${eventName}</strong>.</p>
              ${tierName ? `<p>Tipo di biglietto: <strong>${tierName}</strong></p>` : ""}
              <p>Mostra questo QR allo staff all'ingresso (anche solo dal telefono):</p>
              <img src="data:image/svg+xml;base64,${qrBase64}" alt="QR biglietto" width="220" height="220">
              <p>Codice biglietto: <strong>${ticketCode}</strong></p>
            `,
            attachments: [{ filename: "biglietto-growmi.svg", content: qrBase64 }]
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
