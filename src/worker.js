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

    return env.ASSETS.fetch(request);
  }
};

// Genera un codice biglietto breve, facile da mostrare/leggere se serve anche a occhio
// (es. se il QR non si legge bene), oltre che come contenuto del QR stesso.
function generateTicketCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
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

      const qrDataUrl = await QRCode.toDataURL(ticketCode, { margin: 1, width: 400 });
      const qrBase64 = qrDataUrl.split(",")[1];

      if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

      await env.TICKETS.put(ticketCode, JSON.stringify({
        email,
        eventName,
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
              <p>Mostra il QR in allegato allo staff all'ingresso.</p>
              <p>Codice biglietto: <strong>${ticketCode}</strong></p>
            `,
            attachments: [{ filename: "biglietto-growmi.png", content: qrBase64 }]
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
