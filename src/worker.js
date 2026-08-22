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

// Template dell'email di conferma acquisto: stile a "card" scura sui colori GrowMi (viola,
// corallo, giallo), stessa impostazione grafica delle altre email automatiche già in uso
// (intestazione con emoji, elenco puntato con i dati in grassetto). È un template vero e
// proprio — cambiano solo i dati passati (evento, fascia, nome, codice), non va toccato per
// ogni evento nuovo.
// Costruito con tabelle (non <div>) e attributo bgcolor oltre allo style: Outlook (desktop e
// molte caselle @outlook.it/@hotmail) usa il motore di rendering di Word, che ignora quasi
// tutto il CSS moderno sui <div> ma capisce bene le tabelle HTML — è lo standard per le email
// che devono restare leggibili ovunque, non solo su Gmail/Apple Mail.
function buildTicketEmailHTML({ name, eventName, tierName, ticketCode, qrBase64 }) {
  const greeting = name ? `Ciao ${name.split(" ")[0]},` : "Ciao,";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FBF6F0" style="background:#FBF6F0;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" bgcolor="#2C0943" style="background:#2C0943; border-radius:20px; max-width:480px;">
        <tr>
          <td style="padding:32px 28px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="font-size:22px; font-weight:bold; color:#FDC631; padding-bottom:4px;">&#127915; Il tuo biglietto &egrave; confermato!</td></tr>
              <tr><td style="font-size:15px; color:#FBF6F0; padding-top:16px;">${greeting}</td></tr>
              <tr><td style="font-size:15px; line-height:1.5; color:#FBF6F0; padding-top:8px; padding-bottom:20px;">Grazie per il tuo acquisto! Sei dentro per:</td></tr>
              <tr><td style="font-size:20px; font-weight:bold; color:#FBF6F0; padding-bottom:20px;">${eventName}</td></tr>
              <tr><td style="border-top:1px solid #5C3E75; font-size:1px; line-height:1px;">&nbsp;</td></tr>
              <tr><td style="font-size:14px; font-weight:bold; color:#FDC631; padding-top:20px; padding-bottom:10px;">&#128203; Dettagli biglietto:</td></tr>
              <tr><td style="font-size:14.5px; color:#FBF6F0; padding-bottom:6px;">&bull; Nome: <strong>${name || "&mdash;"}</strong></td></tr>
              ${tierName ? `<tr><td style="font-size:14.5px; color:#FBF6F0; padding-bottom:6px;">&bull; Tipo: <strong>${tierName}</strong></td></tr>` : ""}
              <tr><td style="font-size:14.5px; color:#FBF6F0; padding-bottom:20px;">&bull; Codice biglietto: <strong>${ticketCode}</strong></td></tr>
              <tr><td style="font-size:14px; color:#FBF6F0; padding-bottom:12px;">Mostra questo QR allo staff all'ingresso (basta il telefono):</td></tr>
              <tr>
                <td align="center" bgcolor="#FFFFFF" style="background:#FFFFFF; border-radius:12px; padding:16px;">
                  <img src="data:image/svg+xml;base64,${qrBase64}" alt="QR biglietto" width="200" height="200" style="display:block; border:0;">
                </td>
              </tr>
              <tr><td style="font-size:14px; color:#FBF6F0; padding-top:24px;">Keep growing &#127793;</td></tr>
              <tr><td style="font-size:13px; color:#C9BCD6; padding-top:2px;">Il team GrowMi</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `;
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

  return jsonResponse({ valid: true, email: ticket.email, name: ticket.name, eventName: ticket.eventName, tierName: ticket.tierName });
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
      // Il nome evento si legge dai metadata del Payment Link Stripe usato per l'acquisto
      // (chiave "event", da impostare quando si crea il Payment Link per un nuovo evento —
      // Stripe → Payment Links → il link → Advanced → Metadata). Se non è impostato (es. i
      // Payment Link già esistenti del 10 settembre, creati prima di questa modifica), resta
      // sull'evento attuale come prima: nessuna rottura per quelli già in vendita.
      const eventName = session.metadata?.event || "The Miseducation of GrowMi";
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

      await env.TICKETS.put(ticketCode, JSON.stringify({
        email,
        name: customerName,
        eventName,
        tierName,
        amountTotal: session.amount_total,
        currency: session.currency,
        used: false,
        createdAt: new Date().toISOString(),
        stripeSessionId: session.id
      }));
      // Segna l'evento Stripe come gestito solo ORA che il biglietto esiste davvero su KV:
      // cosi' se il Worker si interrompe prima di questo punto, un eventuale nuovo tentativo di
      // Stripe riesce comunque a creare il biglietto, invece di essere scartato come "già fatto"
      // quando in realtà non è mai stato completato.
      await env.TICKETS.put(dedupeKey, ticketCode);

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
            html: buildTicketEmailHTML({ name: customerName, eventName, tierName, ticketCode, qrBase64 }),
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
