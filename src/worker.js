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

  // Due cron distinti (vedi [triggers] in wrangler.toml) — si distinguono da event.cron, non da
  // due funzioni "scheduled" diverse (Cloudflare Workers ne accetta solo una). Ogni job nel suo
  // try/catch, così se uno fallisce gli altri partono comunque — un'eccezione qui non ha nessuno
  // a cui rispondere con un errore (non è una richiesta HTTP), finirebbe solo nei log di Cloudflare.
  async scheduled(event, env, ctx) {
    if (event.cron === "0 10 * * *") {
      try {
        await runScheduledFeedback(env);
      } catch (err) {
        console.log("Errore cron feedback:", err.stack || err.message);
      }
      try {
        await sendKVBackupEmail(env);
      } catch (err) {
        console.log("Errore cron backup:", err.stack || err.message);
      }
    }
    if (event.cron === "*/15 * * * *") {
      try {
        await runScheduledNewsletters(env);
      } catch (err) {
        console.log("Errore cron newsletter programmate:", err.stack || err.message);
      }
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
  // SAMEORIGIN (non DENY): il pannello azienda.html deve poter incorporare le pagine pubbliche in
  // un iframe per l'anteprima "Preview" — blocca comunque l'incorporamento da siti terzi, che è
  // la protezione da clickjacking che conta davvero.
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Rate limiting per IP sulle rotte sensibili (vedi i binding RL_* in wrangler.toml). Ritorna
// una risposta 429 se il limite è superato, altrimenti null (via libera). Se il binding non
// è disponibile (es. ambiente locale senza il binding configurato) non blocca mai.
async function checkRateLimit(env, bindingName, request, label) {
  const binding = env[bindingName];
  if (!binding) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await binding.limit({ key: `${label}:${ip}` });
  if (!success) {
    return jsonResponse({ error: "Troppe richieste, riprova tra un minuto." }, 429);
  }
  return null;
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

    // Endpoint di debug/admin, protetto dalla chiave staff, sola lettura: elenca biglietti e
    // coupon collegati a un'email, per individuare dati di test da ripulire prima di eliminarli
    // con /api/debug-delete-test-data — non cancella mai nulla da solo.
    if (url.pathname === "/api/debug-find-test-data" && request.method === "GET") {
      try {
        const staffKey = request.headers.get("x-staff-key");
        if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) return jsonResponse({ error: "unauthorized" }, 401);
        return await handleDebugFindTestData(request, env);
      } catch (err) {
        console.log("Errore debug-find-test-data:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Endpoint di debug/admin, protetto dalla chiave staff: cancella SOLO le chiavi esatte
    // passate nel body (mai un filtro generico), e solo se iniziano per ticket: o coupon: — da
    // usare dopo aver controllato l'elenco con /api/debug-find-test-data, non alla cieca.
    if (url.pathname === "/api/debug-delete-test-data" && request.method === "POST") {
      try {
        const staffKey = request.headers.get("x-staff-key");
        if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) return jsonResponse({ error: "unauthorized" }, 401);
        return await handleDebugDeleteTestData(request, env);
      } catch (err) {
        console.log("Errore debug-delete-test-data:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Sola lettura, richiede il login aziendale (stessa protezione delle altre rotte del
    // pannello): elenco completo di biglietti/account/loyalty/coupon/feedback esistenti, per una
    // revisione finale prima di un reset totale con /api/debug-wipe-all-data. Volutamente NON
    // protetto dalla chiave staff condivisa dello scanner: un reset distruttivo del genere deve
    // passare da un login individuale, non da una chiave in mano a chiunque fa i check-in.
    if (url.pathname === "/api/debug-list-all-data" && request.method === "GET") {
      try {
        const auth = await requireStaffAccount(request, env);
        if (auth.error) return auth.error;
        return await handleDebugListAllData(request, env);
      } catch (err) {
        console.log("Errore debug-list-all-data:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Richiede il login aziendale + conferma esplicita nel body: azzera biglietti, account
    // clienti, loyalty, coupon, numeri cliente e feedback, per ripartire da zero prima del lancio
    // vero. Non tocca mai gli account staff né la configurazione eventi. Stessa scelta di
    // requireStaffAccount di cui sopra, stesso motivo.
    if (url.pathname === "/api/debug-wipe-all-data" && request.method === "POST") {
      try {
        const auth = await requireStaffAccount(request, env);
        if (auth.error) return auth.error;
        return await handleDebugWipeAllData(request, env);
      } catch (err) {
        console.log("Errore debug-wipe-all-data:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Backup manuale su richiesta, protetto dalla chiave staff — stesso backup del cron
    // giornaliero (vedi sendKVBackupEmail), utile per uno snapshot immediato prima di un'
    // operazione delicata o solo per verificare che l'invio funzioni.
    if (url.pathname === "/api/admin-backup-now" && request.method === "POST") {
      try {
        const staffKey = request.headers.get("x-staff-key");
        if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) return jsonResponse({ error: "unauthorized" }, 401);
        const result = await sendKVBackupEmail(env);
        return jsonResponse(result);
      } catch (err) {
        console.log("Errore admin-backup-now:", err.stack || err.message);
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

    if (url.pathname === "/api/manual-checkin" && request.method === "POST") {
      try {
        return await handleManualCheckin(request, env);
      } catch (err) {
        console.log("Errore manual-checkin:", err.stack || err.message);
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

    if (url.pathname === "/api/events-list" && request.method === "GET") {
      try {
        return await handleEventsList(request, env);
      } catch (err) {
        console.log("Errore events-list:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/event-history" && request.method === "GET") {
      try {
        return await handleEventHistory(request, env);
      } catch (err) {
        console.log("Errore event-history:", err.stack || err.message);
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

    if (url.pathname === "/api/export-attendees" && request.method === "GET") {
      try {
        return await handleExportAttendees(request, env);
      } catch (err) {
        console.log("Errore export-attendees:", err.stack || err.message);
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

    if (url.pathname === "/api/export-feedback" && request.method === "GET") {
      try {
        return await handleExportFeedback(request, env);
      } catch (err) {
        console.log("Errore export-feedback:", err.stack || err.message);
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

    // Sistema newsletter interno (sostituisce MailerLite) — vedi upsertSubscriber più sotto.
    if (url.pathname === "/api/newsletter-subscribe" && request.method === "POST") {
      try {
        return await handleNewsletterSubscribe(request, env);
      } catch (err) {
        console.log("Errore newsletter-subscribe:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/newsletter-unsubscribe" && request.method === "GET") {
      try {
        return await handleNewsletterUnsubscribe(request, env);
      } catch (err) {
        console.log("Errore newsletter-unsubscribe:", err.stack || err.message);
        return new Response("Errore, riprova più tardi.", { status: 500 });
      }
    }
    if (url.pathname === "/api/admin/newsletter-subscribers" && request.method === "GET") {
      try {
        return await handleAdminListNewsletterSubscribers(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-subscribers:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-import-mailerlite" && request.method === "POST") {
      try {
        return await handleAdminImportMailerlite(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-import-mailerlite:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-import-mailerlite-campaigns" && request.method === "POST") {
      try {
        return await handleAdminImportMailerliteCampaigns(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-import-mailerlite-campaigns:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-groups" && request.method === "GET") {
      try {
        return await handleAdminListNewsletterGroups(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-groups GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-groups" && request.method === "POST") {
      try {
        return await handleAdminCreateNewsletterGroup(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-groups POST:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-groups" && request.method === "DELETE") {
      try {
        return await handleAdminDeleteNewsletterGroup(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-groups DELETE:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-subscriber-groups" && request.method === "POST") {
      try {
        return await handleAdminSetSubscriberGroup(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-subscriber-groups:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-campaigns" && request.method === "GET") {
      try {
        return await handleAdminListNewsletterCampaigns(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-campaigns GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-campaigns" && request.method === "POST") {
      try {
        return await handleAdminCreateNewsletterCampaign(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-campaigns POST:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-campaigns" && request.method === "PUT") {
      try {
        return await handleAdminSaveNewsletterCampaign(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-campaigns PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-campaigns" && request.method === "DELETE") {
      try {
        return await handleAdminDeleteNewsletterCampaign(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-campaigns DELETE:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-preview-recipients" && request.method === "POST") {
      try {
        return await handleAdminPreviewNewsletterRecipients(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-preview-recipients:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-send" && request.method === "POST") {
      try {
        return await handleAdminSendNewsletterCampaign(request, env, ctx);
      } catch (err) {
        console.log("Errore admin/newsletter-send:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-send-to-list" && request.method === "POST") {
      try {
        return await handleAdminSendNewsletterCampaignToList(request, env, ctx);
      } catch (err) {
        console.log("Errore admin/newsletter-send-to-list:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-mark-sent" && request.method === "POST") {
      try {
        return await handleAdminMarkNewsletterCampaignSent(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-mark-sent:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-missing-recipients" && request.method === "POST") {
      try {
        return await handleAdminNewsletterMissingRecipients(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-missing-recipients:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/newsletter-track-open" && request.method === "GET") {
      return await handleNewsletterTrackOpen(request, env);
    }
    if (url.pathname === "/api/newsletter-track-click" && request.method === "GET") {
      return await handleNewsletterTrackClick(request, env);
    }
    if (url.pathname === "/api/admin/newsletter-settings" && request.method === "GET") {
      try {
        return await handleAdminGetNewsletterSettings(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-settings GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-settings" && request.method === "PUT") {
      try {
        return await handleAdminSaveNewsletterSettings(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-settings PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/newsletter-preview" && request.method === "POST") {
      try {
        return await handleAdminPreviewNewsletterCampaign(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-preview:", err.stack || err.message);
        return new Response("Errore nell'anteprima: " + err.message, { status: 500 });
      }
    }
    if (url.pathname === "/api/admin/newsletter-import-csv-stats" && request.method === "POST") {
      try {
        return await handleAdminImportCsvStats(request, env);
      } catch (err) {
        console.log("Errore admin/newsletter-import-csv-stats:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/analytics" && request.method === "GET") {
      try {
        return await handleAdminGetAnalytics(request, env);
      } catch (err) {
        console.log("Errore admin/analytics:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Opzioni di default per la domanda "Cosa ti è piaciuto di più" del form feedback generico
    // (feedback.html senza ?slug=, o un evento senza opzioni proprie) — pubblica e di sola
    // lettura, stesso principio di feedbackOptions dentro /api/event-tiers. Con ?form=<id> legge
    // invece le opzioni proprie di quel form distinto (vedi feedbackform:<id> più sotto).
    if (url.pathname === "/api/feedback-liked-options" && request.method === "GET") {
      try {
        if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
        const formId = url.searchParams.get("form");
        if (formId) {
          const form = await getFeedbackFormContent(env, formId);
          return jsonResponse({ options: (form && form.likedOptions) || [] });
        }
        const content = await getPageContent(env, "feedback");
        return jsonResponse({ options: content.likedOptions || [] });
      } catch (err) {
        console.log("Errore feedback-liked-options:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/register" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_CHECKOUT", request, "ticket-register");
      if (rl) return rl;
      try {
        return await handleRegister(request, env);
      } catch (err) {
        console.log("Errore register:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/validate-coupon" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_COUPON", request, "validate-coupon");
      if (rl) return rl;
      try {
        return await handleValidateCoupon(request, env);
      } catch (err) {
        console.log("Errore validate-coupon:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_CHECKOUT", request, "checkout-session");
      if (rl) return rl;
      try {
        return await handleCreateCheckoutSession(request, env);
      } catch (err) {
        console.log("Errore create-checkout-session:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Area personale: registrazione, login, verifica email, recupero password, dati account.
    if (url.pathname === "/api/account/register" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_AUTH", request, "account-register");
      if (rl) return rl;
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
      const rl = await checkRateLimit(env, "RL_AUTH", request, "account-login");
      if (rl) return rl;
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

    if (url.pathname === "/api/staff-account/register" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_AUTH", request, "staff-register");
      if (rl) return rl;
      try {
        return await handleStaffAccountRegister(request, env);
      } catch (err) {
        console.log("Errore staff-account/register:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/staff-account/verify" && request.method === "GET") {
      try {
        return await handleStaffAccountVerify(request, env);
      } catch (err) {
        console.log("Errore staff-account/verify:", err.stack || err.message);
        return new Response("Errore interno: " + err.message, { status: 500 });
      }
    }

    if (url.pathname === "/api/staff-account/login" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_AUTH", request, "staff-login");
      if (rl) return rl;
      try {
        return await handleStaffAccountLogin(request, env);
      } catch (err) {
        console.log("Errore staff-account/login:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/staff-account/logout" && request.method === "POST") {
      try {
        return await handleStaffAccountLogout(request, env);
      } catch (err) {
        console.log("Errore staff-account/logout:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/staff-account/me" && request.method === "GET") {
      try {
        return await handleStaffAccountMe(request, env);
      } catch (err) {
        console.log("Errore staff-account/me:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/dashboard-stats" && request.method === "GET") {
      try {
        return await handleDashboardStats(request, env);
      } catch (err) {
        console.log("Errore dashboard-stats:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/customers-list" && request.method === "GET") {
      try {
        return await handleCustomersList(request, env);
      } catch (err) {
        console.log("Errore customers-list:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/export-customers" && request.method === "GET") {
      try {
        return await handleExportCustomers(request, env);
      } catch (err) {
        console.log("Errore export-customers:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Pannello gestione eventi (sezione aziendale): elenco, creazione, modifica. Stessa
    // autenticazione (account @growmi.it) delle altre rotte /api/admin* e /api/*-customers.
    if (url.pathname === "/api/admin/events" && request.method === "GET") {
      try {
        return await handleAdminListEvents(request, env);
      } catch (err) {
        console.log("Errore admin/events GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/events" && request.method === "POST") {
      try {
        return await handleAdminCreateEvent(request, env);
      } catch (err) {
        console.log("Errore admin/events POST:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/events" && request.method === "PUT") {
      try {
        return await handleAdminUpdateEvent(request, env);
      } catch (err) {
        console.log("Errore admin/events PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Anteprima "a caldo" del form Modifica/Nuovo evento: renderizza la pagina esattamente come
    // farebbe la pubblicazione vera (stesso eventPageHTML), ma dallo stato corrente del form —
    // senza scrivere nulla su KV. Così l'anteprima riflette anche le modifiche non ancora
    // salvate, qualunque campo, invece di dover tenere una copia della logica di rendering
    // duplicata lato client (che andava fuori sincrono ogni volta che si aggiungeva un campo).
    if (url.pathname === "/api/admin/preview-event" && request.method === "POST") {
      try {
        return await handleAdminPreviewEvent(request, env);
      } catch (err) {
        console.log("Errore admin/preview-event:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/upload-image" && request.method === "POST") {
      try {
        return await handleUploadImage(request, env);
      } catch (err) {
        console.log("Errore admin/upload-image:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/delete-image" && request.method === "POST") {
      try {
        return await handleDeleteImage(request, env);
      } catch (err) {
        console.log("Errore admin/delete-image:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/public-events" && request.method === "GET") {
      try {
        return await handlePublicEvents(request, env);
      } catch (err) {
        console.log("Errore public-events:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      try {
        return await handleMedia(request, env);
      } catch (err) {
        console.log("Errore media:", err.stack || err.message);
        return new Response("Errore nel caricare l'immagine", { status: 500 });
      }
    }

    if (url.pathname.startsWith("/evento/") && request.method === "GET") {
      try {
        const handled = await handleEventPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
        // Nessun evento pubblicato con questo slug: passa oltre, cade sul 404 statico normale
        // (vedi not_found_handling in wrangler.toml) invece di inventare una risposta qui.
      } catch (err) {
        console.log("Errore evento page:", err.stack || err.message);
      }
    }

    if (url.pathname === "/api/admin/artists" && request.method === "GET") {
      try {
        return await handleAdminListArtists(request, env);
      } catch (err) {
        console.log("Errore admin/artists GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/artists" && request.method === "POST") {
      try {
        return await handleAdminCreateArtist(request, env);
      } catch (err) {
        console.log("Errore admin/artists POST:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/artists" && request.method === "PUT") {
      try {
        return await handleAdminUpdateArtist(request, env);
      } catch (err) {
        console.log("Errore admin/artists PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/public-artists" && request.method === "GET") {
      try {
        return await handlePublicArtists(request, env);
      } catch (err) {
        console.log("Errore public-artists:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname.startsWith("/artista/") && request.method === "GET") {
      try {
        const handled = await handleArtistPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore artista page:", err.stack || err.message);
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
      const rl = await checkRateLimit(env, "RL_AUTH", request, "account-forgot");
      if (rl) return rl;
      try {
        return await handleAccountForgotPassword(request, env);
      } catch (err) {
        console.log("Errore account/forgot-password:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/account/reset-password" && request.method === "POST") {
      const rl = await checkRateLimit(env, "RL_AUTH", request, "account-reset");
      if (rl) return rl;
      try {
        return await handleAccountResetPassword(request, env);
      } catch (err) {
        console.log("Errore account/reset-password:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/page-content" && request.method === "GET") {
      try {
        return await handleAdminGetPageContent(request, env);
      } catch (err) {
        console.log("Errore admin/page-content GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/page-content" && request.method === "PUT") {
      try {
        return await handleAdminSavePageContent(request, env);
      } catch (err) {
        console.log("Errore admin/page-content PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Form di feedback distinti (oltre al form generico "page:feedback" di sempre): ognuno ha un
    // id, un nome interno per il pannello, i propri testi e le proprie opzioni "cosa ti è
    // piaciuto" — link pubblico /feedback?form=<id>, vedi handleFeedbackPage più sotto.
    if (url.pathname === "/api/admin/feedback-forms" && request.method === "GET") {
      try {
        return await handleAdminListFeedbackForms(request, env);
      } catch (err) {
        console.log("Errore admin/feedback-forms GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/feedback-forms" && request.method === "POST") {
      try {
        return await handleAdminCreateFeedbackForm(request, env);
      } catch (err) {
        console.log("Errore admin/feedback-forms POST:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/feedback-forms" && request.method === "DELETE") {
      try {
        return await handleAdminDeleteFeedbackForm(request, env);
      } catch (err) {
        console.log("Errore admin/feedback-forms DELETE:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/feedback-form-content" && request.method === "GET") {
      try {
        return await handleAdminGetFeedbackForm(request, env);
      } catch (err) {
        console.log("Errore admin/feedback-form-content GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }
    if (url.pathname === "/api/admin/feedback-form-content" && request.method === "PUT") {
      try {
        return await handleAdminSaveFeedbackForm(request, env);
      } catch (err) {
        console.log("Errore admin/feedback-form-content PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if ((url.pathname === "/" || url.pathname === "/index.html") && request.method === "GET") {
      try {
        const handled = await handleHomePage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore home page:", err.stack || err.message);
      }
    }

    // Sia /chi-siamo che /chi-siamo.html: gli asset statici rispondono con un redirect 307
    // dalla forma con estensione a quella senza, quindi entrambe le richieste arrivano davvero
    // nella navigazione reale (i link nel sito usano ancora "chi-siamo.html").
    if ((url.pathname === "/chi-siamo" || url.pathname === "/chi-siamo.html") && request.method === "GET") {
      try {
        const handled = await handleChiSiamoPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore chi-siamo page:", err.stack || err.message);
      }
    }

    if ((url.pathname === "/contatti" || url.pathname === "/contatti.html") && request.method === "GET") {
      try {
        const handled = await handleContattiPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore contatti page:", err.stack || err.message);
      }
    }

    if ((url.pathname === "/loyalty-card" || url.pathname === "/loyalty-card.html") && request.method === "GET") {
      try {
        const handled = await handleLoyaltyCardPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore loyalty-card page:", err.stack || err.message);
      }
    }

    if ((url.pathname === "/art-mall-collab" || url.pathname === "/art-mall-collab.html") && request.method === "GET") {
      try {
        const handled = await handleArtMallCollabPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore art-mall-collab page:", err.stack || err.message);
      }
    }

    if ((url.pathname === "/grow-with-us" || url.pathname === "/grow-with-us.html") && request.method === "GET") {
      try {
        const handled = await handleGrowWithUsPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore grow-with-us page:", err.stack || err.message);
      }
    }

    if ((url.pathname === "/feedback" || url.pathname === "/feedback.html") && request.method === "GET") {
      try {
        const handled = await handleFeedbackPage(request, env);
        if (handled) return await finalizePublicHtmlResponse(request, env, handled, ctx);
      } catch (err) {
        console.log("Errore feedback page:", err.stack || err.message);
      }
    }

    if (url.pathname === "/api/admin/site-theme" && request.method === "GET") {
      try {
        return await handleAdminGetSiteTheme(request, env);
      } catch (err) {
        console.log("Errore admin/site-theme GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/site-theme" && request.method === "PUT") {
      try {
        return await handleAdminSaveSiteTheme(request, env);
      } catch (err) {
        console.log("Errore admin/site-theme PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/legacy-events" && request.method === "GET") {
      try {
        return await handleAdminGetLegacyEvents(request, env);
      } catch (err) {
        console.log("Errore admin/legacy-events GET:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === "/api/admin/legacy-events" && request.method === "PUT") {
      try {
        return await handleAdminSaveLegacyEvents(request, env);
      } catch (err) {
        console.log("Errore admin/legacy-events PUT:", err.stack || err.message);
        return jsonResponse({ error: err.message }, 500);
      }
    }

    const fallthrough = await env.ASSETS.fetch(request);
    if (request.method === "GET") return await finalizePublicHtmlResponse(request, env, fallthrough, ctx);
    return fallthrough;
}

// Registro eventi: fonte di verità server-side per nome/data/location e fasce prezzo con
// capacità. Aggiungere un evento nuovo = aggiungere una voce qui (slug → dati), niente Payment
// Link esterni da creare uno per uno né HTML da riscrivere per il blocco acquisto. Le capacità
// sono numeri semplici: si alzano/abbassano modificandoli qui, nessuna logica da toccare.
// Eventi "di serie": la fonte di verità originale, da codice, di prima che esistesse il pannello
// eventi nell'area aziendale. Restano qui solo come fallback — vedi getEvent() — cosi' l'evento
// già live continua a funzionare esattamente come prima anche se non viene mai toccato dal
// pannello. Un evento creato o modificato dal pannello vive invece in KV (event:<slug>) e da quel
// momento ha sempre la precedenza su quanto scritto qui.
const DEFAULT_EVENTS = {
  "miseducation-2026-09-10": {
    name: "The Miseducation of GrowMi",
    dateDisplay: "Giovedì 10 settembre 2026 · Apertura 19:00",
    dateIso: "2026-09-10",
    location: "Art Mall Milano, Milano",
    teaser: "Una notte dedicata alla cultura hip-hop: graffiti dal vivo, musica e DJ set nel cuore di Milano.",
    // Non ancora annunciato pubblicamente (vedi anche draft:true sull'entry gemella in
    // assets/events-data.js): senza questo, /api/public-events lo mostrerebbe di nuovo perché
    // un evento senza "published" esplicito si considera pubblicato di default.
    published: false,
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

// Un evento creato/modificato dal pannello vive in KV sotto event:<slug> e ha sempre la
// precedenza; se non c'è ancora in KV, cade sul fallback DEFAULT_EVENTS (vedi sopra). Cosi' ogni
// punto del codice che leggeva EVENTS[slug] continua a funzionare identico, solo ora async.
async function getEvent(env, slug) {
  const raw = await env.TICKETS.get(`event:${slug}`);
  if (raw) return JSON.parse(raw);
  return DEFAULT_EVENTS[slug] || null;
}

// Unisce gli slug "di serie" (DEFAULT_EVENTS) con quelli creati/modificati dal pannello (chiavi
// event:* in KV), senza doppioni — serve a chi deve elencare tutti gli eventi esistenti
// (handleEventsList, il pannello eventi) senza sapere a priori dove vive ciascuno.
async function listAllEventSlugs(env) {
  const slugs = new Set(Object.keys(DEFAULT_EVENTS));
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "event:", cursor });
    for (const key of page.keys) slugs.add(key.name.slice("event:".length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return Array.from(slugs);
}

async function findTierOption(env, eventSlug, tierId, optionId) {
  const event = await getEvent(env, eventSlug);
  const tier = event?.tiers.find(function(t){ return t.id === tierId; });
  const option = tier?.options.find(function(o){ return o.id === optionId; });
  if (!event || !tier || !option) return null;
  return { event, tier, option };
}

// Di norma le chiavi sono chiavi R2 ("events/...", "pages/...", ecc.) da far passare per /media/.
// Il pannello Chi siamo però pre-popola i fondatori con le foto statiche già live sul sito (per
// mostrare lo stato reale prima di qualunque modifica): se non vengono ricaricate restano un
// percorso relativo agli asset statici ("assets/img/...") e vanno usate così come sono.
function mediaUrl(key) {
  if (!key) return null;
  if (key.startsWith("http://") || key.startsWith("https://") || key.startsWith("/") || key.startsWith("assets/")) {
    return key;
  }
  return `/media/${key}`;
}

// Un evento senza "published" salvato è nato prima di questo campo (o non è mai stato
// risalvato dal pannello dopo l'aggiunta): si considera pubblicato per non far sparire nulla
// di già live. Solo published:false esplicito lo tiene in bozza.
function isEventPublished(event) {
  return event.published !== false;
}

// Elenco pubblico eventi (nessuna autenticazione: sono gli stessi dati già visibili sul sito)
// per index.html/eventi.html — solo i campi che servono a mostrare una card, mai le fasce/
// prezzi (quelli restano dietro /api/event-tiers, letti solo dalla pagina evento specifica).
async function handlePublicEvents(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const slugs = await listAllEventSlugs(env);
  const events = [];
  for (const slug of slugs) {
    const event = await getEvent(env, slug);
    if (!event || !isEventPublished(event)) continue;
    events.push({
      slug, name: event.name, dateDisplay: event.dateDisplay, dateIso: event.dateIso,
      location: event.location, teaser: event.teaser || "",
      heroImageUrl: mediaUrl(event.heroImageKey), coverImageUrl: mediaUrl(event.coverImageKey),
      coverImagePosition: event.coverPosition || "center", coverImageZoom: event.coverZoom || 1,
      sortOrder: typeof event.sortOrder === "number" ? event.sortOrder : null,
      pageUrl: `/evento/${slug}`
    });
  }
  return jsonResponse({ events });
}

// Header/nav/footer/newsletter-popup identici a quelli già in ogni pagina statica (vedi
// grow-with-us.html) — copiati qui una volta sola così una pagina evento generata dal pannello
// è visivamente indistinguibile dalle altre, senza duplicare template altrove.
function eventPageHTML(event, slug) {
  const darkTheme = event.darkTheme === true;
  const heroImg = event.heroImageKey
    ? `<img class="ed-hero-photo" src="${mediaUrl(event.heroImageKey)}" alt="" style="${photoFramingStyle(event.heroPosition, event.heroZoom)}"><div class="ed-hero-video-overlay"></div>`
    : "";
  // Stessa immagine hero anche nel tema scuro (era caricabile dal pannello ma non veniva mai
  // usata) — sotto la texture a puntini e le strisce diagonali, con un velo scuro sopra così il
  // titolo resta leggibile qualunque sia la foto.
  const darkHeroImg = (darkTheme && event.heroImageKey)
    ? `<img class="ed-dark-hero-photo" src="${mediaUrl(event.heroImageKey)}" alt="" style="${photoFramingStyle(event.heroPosition, event.heroZoom)}">`
    : "";
  // Loghi sponsor, due stili possibili (vedi validateEventPayload):
  // - "stickers": come adesivi agli angoli della copertina (stesso stile già usato su
  //   art-mall-collab.html per i primi due) — le 4 classi .ed-poster-badge* sono in
  //   event-tickets.css, qui vanno solo abbinate in ordine ai loghi caricati. Serve una
  //   copertina caricata (sono posizionati relativamente a .ed-poster-feature), altrimenti non
  //   c'è nulla a cui agganciarli — oltre il quarto logo non c'è più posto, restano nascosti.
  // - "marquee": striscia orizzontale che scorre in loop, indipendente dalla copertina.
  const sponsorLogos = Array.isArray(event.sponsorLogos) ? event.sponsorLogos : [];
  const STICKER_CLASSES = ["ed-poster-badge", "ed-poster-badge-left", "ed-poster-badge-top-right", "ed-poster-badge-top-left"];
  const sponsorStickersHtml = (sponsorLogos.length && event.sponsorDisplay !== "marquee")
    ? sponsorLogos.slice(0, 4).map(function(key, i){
        return `<img class="${STICKER_CLASSES[i]}" src="${mediaUrl(key)}" alt="Sponsor">`;
      }).join("")
    : "";
  const coverBlock = event.coverImageKey
    ? `<section class="ed-section-tight"><div class="wrap"><div class="ed-poster-feature"><img class="ed-poster-img" src="${mediaUrl(event.coverImageKey)}" alt="${event.name}">${sponsorStickersHtml}</div></div></section>`
    : "";
  const sponsorMarqueeHtml = (sponsorLogos.length && event.sponsorDisplay === "marquee")
    ? (function(){
        const imgs = sponsorLogos.map(function(key){ return `<img src="${mediaUrl(key)}" alt="Sponsor">`; }).join("");
        // Il contenuto è duplicato una volta: l'animazione trasla del 50% e riparte, così il loop
        // non ha uno scatto visibile nel punto in cui si "ricongiunge".
        return `<section class="ed-sponsor-marquee"><div class="ed-sponsor-track">${imgs}${imgs}</div></section>`;
      })()
    : "";
  const galleryItems = (event.gallery || []).map(function(key){
    return `<div class="ed-gallery-item"><img src="${mediaUrl(key)}" alt="${event.name}" loading="lazy"></div>`;
  }).join("");
  const galleryBlock = galleryItems
    ? `<section class="ed-section-tight"><div class="wrap"><div class="ed-gallery">${galleryItems}</div></div></section>`
    : "";
  const advisoryBadge = (darkTheme && event.advisoryLabel)
    ? `<div class="ed-advisory"><b>${event.advisoryLabel}</b>${event.advisorySub ? `<span>${event.advisorySub}</span>` : ""}</div>`
    : "";
  // Striscia info (data/apertura/dress code/location) sotto l'hero scuro — vedi
  // the-miseducation-of-growmi.html .mise-infobar, portata qui a parità di grafica. Apertura e
  // dress code compaiono solo se compilati, data e location ci sono sempre (campi obbligatori).
  const infobar = darkTheme ? (function(){
    const d = new Date(event.dateIso + "T00:00:00");
    const dateFmt = isNaN(d.getTime()) ? event.dateIso : `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
    const items = [[`data-i18n="ev1_info_date_label"`, "Data", dateFmt]];
    if (event.doorsTime) items.push([`data-i18n="ev1_info_time_label"`, "Apertura", event.doorsTime]);
    if (event.dressCode) items.push([`data-i18n="ev1_info_dress_label"`, "Dress code", event.dressCode]);
    items.push([`data-i18n="ev1_info_loc_label"`, "Location", event.location]);
    const itemsHtml = items.map(function(it){
      return `<div class="ed-dark-info-item"><span class="lbl" ${it[0]}>${it[1]}</span><span class="val">${it[2]}</span></div>`;
    }).join("");
    return `<section class="ed-dark-infobar"><div class="wrap">${itemsHtml}</div></section>`;
  })() : "";
  // Sezioni extra a blocchi (vedi validateEventPayload/azienda.html) — le fasce "lineup"
  // consecutive vengono raggruppate in un'unica griglia .ed-lineup, esattamente come sulla pagina
  // statica the-miseducation-of-growmi.html; heading/text restano semplici elementi di testo.
  const contentBlocksHtml = (function(){
    const blocks = Array.isArray(event.contentBlocks) ? event.contentBlocks : [];
    if (!blocks.length) return "";
    let html = "";
    let lineupBuffer = [];
    function flushLineup(){
      if (!lineupBuffer.length) return;
      html += `<div class="ed-lineup">${lineupBuffer.join("")}</div>`;
      lineupBuffer = [];
    }
    for (const b of blocks) {
      if (b.type === "lineup") {
        lineupBuffer.push(
          `<div class="ed-lineup-card">` +
            (b.photoKey ? `<div class="ed-lineup-photo"><img src="${mediaUrl(b.photoKey)}" alt="${b.name}" loading="lazy"></div>` : "") +
            (b.role ? `<span class="role"${b.roleColor ? ` style="color:${b.roleColor};"` : ""}>${b.role}</span>` : "") +
            `<h3>${b.name}</h3>` +
            (b.time ? `<span class="time"${b.timeColor ? ` style="color:${b.timeColor};"` : ""}>${b.time}</span>` : "") +
            (b.desc ? `<p>${b.desc}</p>` : "") +
          `</div>`
        );
      } else {
        flushLineup();
        if (b.type === "heading") html += `<div class="ed-head"><h2${b.color ? ` style="color:${b.color};"` : ""}>${b.text}</h2></div>`;
        else if (b.type === "text") html += `<div class="ed-block-text"${b.color ? ` style="color:${b.color};"` : ""}>${b.html}</div>`;
        else if (b.type === "image") html += `<img src="${mediaUrl(b.key)}" alt="" style="width:${b.width}%; display:block; margin:0 auto 28px; border-radius:14px;">`;
        else if (b.type === "button") html += `<p style="text-align:center; margin:28px 0;"><a class="btn coral" href="${b.url}"${b.color ? ` style="background:${b.color}; border-color:${b.color};"` : ""}>${b.label}</a></p>`;
        else if (b.type === "divider") html += `<hr class="ed-block-divider">`;
        else if (b.type === "spacer") html += `<div style="height:${b.height}px;"></div>`;
      }
    }
    flushLineup();
    return `<section class="${darkTheme ? "ed-dark-section" : "ed-section-tight"}"><div class="wrap">${html}</div></section>`;
  })();

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${event.name} — GrowMi</title>
<meta name="description" content="${event.teaser || event.name}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/mailerlite-form.css">
<link rel="stylesheet" href="/assets/redesign.css">
<link rel="stylesheet" href="/assets/interactive.css">
<link rel="stylesheet" href="/assets/event-tickets.css">
${(darkTheme && (event.accentColor || event.accentColor2 || event.bgColor || event.leadColor)) ? `<style>:root{ ${event.accentColor ? `--ed-accent1:${event.accentColor};` : ""} ${event.accentColor2 ? `--ed-accent2:${event.accentColor2};` : ""} ${event.bgColor ? `--ed-bg:${event.bgColor};` : ""} ${event.leadColor ? `--ed-text-muted:${event.leadColor};` : ""} }</style>` : ""}
</head>
<body>

<header>
  <nav class="wrap">
    <a class="logo" href="/index.html"><img src="/assets/img/logo-growmi.png" alt="GrowMi"></a>
    <div class="navlinks">
      <a href="/index.html" data-i18n="nav_home">Home</a>
      <a href="/eventi.html" class="active" data-i18n="nav_eventi">Eventi</a>
      <a href="/artisti.html" data-i18n="nav_artisti">Artisti</a>
      <a href="/loyalty-card.html" data-i18n="nav_loyalty">Loyalty Card</a>
      <a href="/chi-siamo.html" data-i18n="nav_chisiamo">Chi siamo</a>
      <a href="/contatti.html" data-i18n="nav_contatti">Contatti</a>
      <div class="lang-switch mobile-lang-switch">
        <button data-lang="it">IT</button>
        <button data-lang="en">EN</button>
      </div>
    </div>
    <div class="navright">
      <div class="nav-account-wrap">
        <a class="nav-account" href="/area-personale.html" data-i18n="nav_account">Accedi</a>
        <button type="button" class="nav-account-icon" aria-label="Il mio account" aria-haspopup="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
        </button>
        <div class="nav-account-menu"></div>
      </div>
      <div class="lang-switch">
        <button data-lang="it">IT</button>
        <button data-lang="en">EN</button>
      </div>
      <div class="nav-tickets"><a class="btn coral small nav-tickets-toggle" href="/eventi.html" data-i18n="nav_cta" aria-haspopup="true" aria-expanded="false">Biglietti</a><div class="nav-tickets-menu"></div></div>
    </div>
    <button type="button" class="nav-toggle" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </nav>
</header>

${darkTheme ? `
<section class="ed-dark-hero${darkHeroImg ? " has-photo" : ""}${event.textureDots === false ? " no-dots" : ""}${event.textureStripes === false ? " no-stripes" : ""}">
  ${darkHeroImg}
  <div class="wrap ed-dark-wrap">
    ${advisoryBadge}
    <span class="ed-dark-eyebrow" data-i18n="ev1_eyebrow">GrowMi presenta</span>
    <h1 class="ed-dark-title">${event.name}</h1>
    <p class="ed-dark-sub">${event.dateDisplay} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline; text-underline-offset:3px;">${event.location}</a></p>
    ${event.teaser ? `<p class="ed-dark-lead">${event.teaser}</p>` : ""}
    <div class="ed-dark-actions">
      <a class="btn coral" href="#biglietti" data-i18n="ev1_cta_tickets">Vedi i biglietti</a>
      <a class="btn outline on-dark" href="/eventi.html" data-i18n="ev1_cta_back">Tutti gli eventi</a>
    </div>
  </div>
</section>
${infobar}
` : `
<section class="ed-hero" style="padding:110px 0 80px;">
  ${heroImg}
  <div class="wrap ed-wrap">
    <p class="ed-eyebrow">${event.dateDisplay} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline; text-underline-offset:3px;">${event.location}</a></p>
    <h1 style="font-size:clamp(40px,7vw,96px);">${event.name}</h1>
    ${event.teaser ? `<p class="ed-lead">${event.teaser}</p>` : ""}
  </div>
</section>
`}

${coverBlock}

${sponsorMarqueeHtml}

${contentBlocksHtml}

<section class="ed-section-tight" id="biglietti" style="background:${event.ticketBgColor || "var(--purple-deep)"}; color:var(--cream);">
  <div class="wrap">
    <div class="ed-head">
      <p class="ed-eyebrow">Biglietti</p>
      <h2>Prendi il tuo posto</h2>
    </div>
    <div class="event-tickets" data-event="${slug}">
      <div class="et-tier-list" data-et-tier-list></div>
      <div class="et-reg-step" data-et-reg-step hidden>
        <p class="et-reg-step-selection">Hai scelto: <strong data-et-selection-label></strong></p>
        <form class="et-reg-form" data-et-reg-form>
          <div class="et-form-row">
            <input type="text" data-et-firstname placeholder="Nome" required>
            <input type="text" data-et-lastname placeholder="Cognome" required>
          </div>
          <div class="et-form-row">
            <select data-et-phone-prefix>
              <option value="+39">🇮🇹 +39</option>
              <option value="+41">🇨🇭 +41</option>
              <option value="+33">🇫🇷 +33</option>
              <option value="+49">🇩🇪 +49</option>
              <option value="+44">🇬🇧 +44</option>
              <option value="+34">🇪🇸 +34</option>
            </select>
            <input type="tel" data-et-phone placeholder="333 1234567" required>
          </div>
          <input type="email" data-et-email placeholder="Email" required>
          <label><input type="checkbox" data-et-terms required> Accetto termini e condizioni</label>
          <label><input type="checkbox" data-et-photo-consent required> Accetto il trattamento immagini</label>
          <label><input type="checkbox" data-et-newsletter> Iscrivimi alla newsletter</label>
          <input type="text" data-et-coupon placeholder="Codice coupon (facoltativo)" style="text-transform:uppercase;">
          <button type="submit" class="btn coral" data-et-reg-submit>Vai al pagamento</button>
          <p class="et-reg-status" data-et-reg-status hidden></p>
        </form>
      </div>
      <div class="et-checkout-wrap" data-et-checkout-wrap hidden>
        <p class="et-price-breakdown" data-et-checkout-breakdown></p>
        <p class="et-checkout-note">Il prezzo include l'ingresso all'evento nella fascia e opzione scelte. La commissione di transazione copre i costi di elaborazione sicura del pagamento ed è già conteggiata nel totale qui sopra.</p>
        ${event.checkoutNote ? `<p class="et-checkout-note">${event.checkoutNote}</p>` : ""}
        <div data-et-checkout-container></div>
      </div>
    </div>
  </div>
</section>

${galleryBlock}

<section class="ed-cta compact">
  <div class="wrap ed-cta-row">
    <div>
      <p class="ed-eyebrow" data-i18n="nl_eyebrow">Newsletter</p>
      <h2 data-i18n="nl_title">Non perderti i prossimi eventi</h2>
      <p data-i18n="nl_lead">Iscriviti alla newsletter di GrowMi: eventi, artisti e novità via email, senza spam.</p>
    </div>
    <button type="button" class="ed-btn-ghost" data-nl-open data-i18n="nl_submit">Iscrivimi</button>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div><a class="foot-logo" href="/index.html"><img src="/assets/img/logo-growmi.png" alt="GrowMi"></a></div>
      <div>
        <h4 data-i18n="foot_sito">Sito</h4>
        <ul>
          <li><a href="/eventi.html" data-i18n="nav_eventi">Eventi</a></li>
          <li><a href="/artisti.html" data-i18n="nav_artisti">Artisti</a></li>
          <li><a href="/chi-siamo.html" data-i18n="nav_chisiamo">Chi siamo</a></li>
          <li><a href="/loyalty-card.html">Loyalty Card</a></li>
        </ul>
      </div>
      <div>
        <h4 data-i18n="foot_contatti">Contatti</h4>
        <ul>
          <li><a href="mailto:grow.mi@outlook.it">grow.mi@outlook.it</a></li>
          <li><a href="/contatti.html" data-i18n="nav_contatti">Contatti</a></li>
        </ul>
      </div>
      <div>
        <h4 data-i18n="foot_social">Social</h4>
        <ul>
          <li><a href="https://www.instagram.com/growmiii/" target="_blank" rel="noopener">Instagram</a></li>
          <li><a href="https://www.tiktok.com/@growmii_" target="_blank" rel="noopener">TikTok</a></li>
          <li><a href="https://www.youtube.com/@GrowMiii" target="_blank" rel="noopener">YouTube</a></li>
          <li><a href="https://www.linkedin.com/company/growmiagency/" target="_blank" rel="noopener">LinkedIn</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-bottom">
      <span data-i18n="foot_rights">© 2026 GrowMi. Milano.</span>
      <span data-i18n="foot_madewith">Sito in fase di sviluppo</span>
      <a href="/privacy-policy.html" style="color:#B39DC7;">Privacy Policy</a>
    </div>
  </div>
</footer>

<div class="nl-popup" id="nl-popup" hidden>
  <div class="nl-popup-backdrop" data-nl-close></div>
  <div class="nl-popup-card" role="dialog" aria-modal="true">
    <button type="button" class="nl-popup-close" data-nl-close aria-label="Chiudi">&times;</button>
    <p class="eyebrow" data-i18n="nl_eyebrow">Newsletter</p>
    <h4 data-i18n="nl_title">Non perderti i prossimi eventi</h4>
    <p data-i18n="nl_lead">Iscriviti alla newsletter di GrowMi: eventi, artisti e novità via email, senza spam.</p>
    <div class="field"><input type="email" class="nl-email" placeholder="La tua email"></div>
    <button type="button" class="btn coral nl-submit" data-i18n="nl_submit">Iscrivimi</button>
    <p class="nl-fine" data-i18n="nl_fine">Puoi disiscriverti quando vuoi. Per maggiori dettagli, consulta la nostra Privacy Policy.</p>
  </div>
</div>

<script src="/assets/events-data.js"></script>
<script src="/assets/i18n.js"></script>
<script src="/assets/cookie-banner.js"></script>
<script src="/assets/newsletter.js"></script>
<script src="/assets/interactive.js"></script>
<script src="/assets/event-tickets.js"></script>
</body>
</html>`;
}

// Rotta pubblica /evento/<slug>: genera al volo la pagina di un evento creato dal pannello,
// così creare un evento "semplice" non richiede più che uno sviluppatore costruisca una pagina
// HTML apposita. Ritorna null (mai una Response) se non c'è nulla da mostrare, cosi' il
// chiamante può lasciar cadere la richiesta sul normale 404 statico invece di inventarne uno qui.
async function handleEventPage(request, env) {
  if (!env.TICKETS) return null;
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/evento\//, "").replace(/\/$/, "");
  if (!slug) return null;
  const event = await getEvent(env, slug);
  if (!event) return null;
  if (!isEventPublished(event)) {
    // Bozza non pubblicata: normalmente 404, MA il pulsante "Preview pagina evento" del pannello
    // deve poterla vedere prima di pubblicarla — solo con sessione staff valida (mai a un
    // visitatore qualsiasi che indovina lo slug) e solo quando la richiesta arriva davvero
    // dall'anteprima (?_preview=..., già aggiunto da openPreview() nel pannello).
    if (!url.searchParams.has("_preview")) return null;
    const auth = await requireStaffAccount(request, env);
    if (auth.error) return null;
  }
  return new Response(eventPageHTML(event, slug), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

  const { code, eventSlug } = await request.json();
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

  // Scanner "bloccato" su un evento specifico (vedi selezione evento in staff-checkin.html): un
  // biglietto di un altro evento viene rifiutato subito, prima ancora di marcarlo come usato,
  // così lo stesso codice resta valido per lo scanner giusto.
  if (eventSlug && ticket.eventSlug && ticket.eventSlug !== eventSlug) {
    return jsonResponse({ valid: false, reason: "wrong_event", eventName: ticket.eventName });
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
      eventSlug: ticket.eventSlug, tierId: ticket.tierId,
      source: ticket.source || "stripe"
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

// Registra alla porta chi paga in contanti/POS fisico, senza passare da Stripe: crea comunque un
// vero record "ticket:" (già used:true, stessa fascia/prezzo netto già configurati per l'evento —
// niente doppio listino) così finisce automaticamente in incasso, presenti e timbro loyalty
// esattamente come un biglietto online, distinguibile solo dal campo source:"walkin". Stessa
// autenticazione dello scanner (chiave staff condivisa): è un'azione alla porta, deve restare
// veloce quanto uno scan, non serve un login individuale per ogni vendita.
async function handleManualCheckin(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const { eventSlug, tierId, optionId, name, email, wantsCard } = await request.json();
  if (!eventSlug || !tierId || !optionId) {
    return jsonResponse({ error: "evento, fascia e opzione sono obbligatori" }, 400);
  }
  const cleanName = String(name || "").trim().slice(0, 200);
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanName || !cleanEmail || !cleanEmail.includes("@")) {
    return jsonResponse({ error: "nome, cognome ed email sono obbligatori per la vendita in loco" }, 400);
  }

  const found = await findTierOption(env, eventSlug, tierId, optionId);
  if (!found) return jsonResponse({ error: "fascia o opzione non valida per questo evento" }, 400);
  const { event, tier, option } = found;

  const ticketCode = generateTicketCode();
  const now = new Date().toISOString();
  const ticket = {
    email: cleanEmail,
    name: cleanName,
    phone: null,
    eventName: event.name,
    eventDate: event.dateDisplay,
    eventDateIso: event.dateIso,
    eventLocation: event.location,
    tierName: `${tier.name} — ${option.label}`,
    eventSlug,
    tierId,
    optionId,
    termsAccepted: true,
    photoConsent: false,
    newsletterOptin: false,
    amountTotal: option.priceCents,
    currency: "eur",
    used: true,
    usedAt: now,
    createdAt: now,
    stripeSessionId: null,
    source: "walkin"
  };

  await env.TICKETS.put(`ticket:${ticketCode}`, JSON.stringify(ticket), {
    metadata: {
      used: true, name: ticket.name, email: ticket.email, tierName: ticket.tierName,
      usedAt: now, eventName: event.name, eventDateIso: event.dateIso,
      eventSlug, tierId, source: "walkin"
    }
  });

  // Se ha già un account, il timbro scatta come per qualsiasi biglietto online. Se non ce l'ha
  // e alla porta ha chiesto la loyalty card, ne creiamo uno al volo con una password provvisoria
  // (mai scelta da noi né vista in chiaro dopo l'invio) e mandiamo subito l'email — la persona
  // può cambiarla quando vuole dalla sua area personale (c'è già il flusso "password dimenticata").
  let stamps = null;
  let cardCreated = false;
  let customerNumber = null;
  let emailSent = false;

  const existingAccountRaw = await env.TICKETS.get(`account:${cleanEmail}`);
  if (existingAccountRaw) {
    stamps = await addLoyaltyStamp(env, cleanEmail, { eventName: event.name, ticketCode, stampedAt: now });
  } else if (wantsCard) {
    const tempPassword = generateTempPassword();
    const salt = crypto.randomUUID();
    const passwordHash = await hashPassword(tempPassword, salt);
    customerNumber = await nextSequentialCustomerNumber(env);

    await env.TICKETS.put(`account:${cleanEmail}`, JSON.stringify({
      email: cleanEmail, name: cleanName, passwordHash, salt,
      // Raccolta di persona dallo staff alla porta: l'email è già "verificata" nei fatti,
      // niente giro di conferma via link come per l'autoregistrazione online.
      emailVerified: true, verifyToken: null,
      customerNumber, physicalCardClaimed: false,
      createdAt: now,
      profile: {
        customerType: null, title: null, firstName: null, lastName: null,
        birthDay: null, birthMonth: null, birthYear: null,
        gender: null, birthCountry: null, birthCity: null,
        newsletterOptin: false
      }
    }));
    await env.TICKETS.put(`customernum:${customerNumber}`, cleanEmail);

    // Il biglietto appena creato è già used:true ma l'account non esisteva ancora quando lo
    // abbiamo scritto: backfillLoyaltyFromTickets lo ritrova e dà il primo timbro, invece di
    // richiamare addLoyaltyStamp che a quel punto avrebbe trovato "nessun account" e fatto nulla.
    await backfillLoyaltyFromTickets(env, cleanEmail);
    const loyaltyRaw = await env.TICKETS.get(`loyalty:${cleanEmail}`);
    stamps = loyaltyRaw ? JSON.parse(loyaltyRaw).stamps : 1;
    cardCreated = true;

    const origin = new URL(request.url).origin;
    await sendAccountEmail(env, {
      to: cleanEmail,
      subject: "La tua loyalty card GrowMi è pronta!",
      html: buildAccountEmailHTML({
        title: `Ciao ${cleanName.split(" ")[0] || ""}!`,
        lead: `Ti abbiamo creato un account GrowMi con la tua loyalty card — numero cliente <strong>${customerNumber}</strong>. Password provvisoria: <strong>${tempPassword}</strong>. Ti consigliamo di cambiarla al primo accesso dalla tua area personale.`,
        buttonLabel: "Accedi alla tua area personale",
        buttonUrl: `${origin}/area-personale`
      })
    });
    emailSent = !!env.RESEND_API_KEY;
  }

  return jsonResponse({
    ok: true, ticketCode, name: ticket.name, tierName: ticket.tierName, priceCents: option.priceCents,
    stamps, reward3: stamps === 3, reward5: stamps === 5,
    cardCreated, customerNumber, emailSent
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

  const url = new URL(request.url);
  const eventSlug = url.searchParams.get("event");

  let total = 0;
  let checkedIn = 0;
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if (eventSlug && key.metadata?.eventSlug !== eventSlug) continue;
      total++;
      if (key.metadata?.used) checkedIn++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ total, checkedIn });
}

// Elenco eventi per il menu dello scanner (staff-checkin.html): stessa fonte di verità già usata
// per prezzi/fasce (DEFAULT_EVENTS + quelli creati dal pannello in KV), zero manutenzione — ogni
// evento nuovo compare qui da solo, che sia di serie o creato dal pannello.
async function handleEventsList(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const slugs = await listAllEventSlugs(env);
  const events = [];
  for (const slug of slugs) {
    const event = await getEvent(env, slug);
    if (event) events.push({ slug, name: event.name, dateDisplay: event.dateDisplay });
  }
  return jsonResponse({ events });
}

// Storico completo di UN evento: venduti, entrati, quanti degli entrati hanno una loyalty card, e
// quanti premi (3°/5° evento) sono scattati proprio grazie a un timbro preso a questo evento.
// L'ultimo dato non è indicizzato da nessuna parte: va ricostruito leggendo ogni loyalty:* e
// guardando, nello storico timbri di ognuno, se il timbro che ha fatto scattare quota 3 o 5 porta
// il nome di questo evento — accettabile per una vista di sola consultazione, non il check-in vero
// e proprio (quello resta O(1) per singola scansione, vedi handleCheckin).
async function handleEventHistory(request, env) {
  const staffKey = request.headers.get("x-staff-key");
  if (!env.STAFF_KEY || staffKey !== env.STAFF_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const url = new URL(request.url);
  const eventSlug = url.searchParams.get("event");
  const event = eventSlug ? await getEvent(env, eventSlug) : null;
  if (!eventSlug || !event) return jsonResponse({ error: "evento non valido" }, 400);

  let sold = 0;
  let checkedIn = 0;
  let withLoyaltyCard = 0;
  let cursor = undefined;
  const accountCache = new Map();
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if (key.metadata?.eventSlug !== eventSlug) continue;
      sold++;
      if (!key.metadata?.used) continue;
      checkedIn++;
      const email = (key.metadata.email || "").toLowerCase();
      if (!email) continue;
      if (!accountCache.has(email)) {
        const raw = await env.TICKETS.get(`account:${email}`);
        accountCache.set(email, !!raw);
      }
      if (accountCache.get(email)) withLoyaltyCard++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let reward3Given = 0;
  let reward5Given = 0;
  cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "loyalty:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const loyalty = JSON.parse(raw);
      const history = loyalty.history || [];
      // history[2] (indice 2, 3° timbro) e history[4] (indice 4, 5° timbro) sono i timbri che
      // hanno sbloccato ciascun premio — se sono di questo evento, il premio è "nato" qui.
      if (history[2] && history[2].eventName === event.name) reward3Given++;
      if (history[4] && history[4].eventName === event.name) reward5Given++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ eventSlug, eventName: event.name, sold, checkedIn, withLoyaltyCard, reward3Given, reward5Given });
}

// Elenco di chi è entrato davvero (per la pagina staff-attendees.html), letto dalla metadata
// delle chiavi già entrate — nessuna lettura dei singoli biglietti, veloce anche con centinaia
// di persone. Stessa chiave staff dello scanner.
async function handleAttendees(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
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
          eventName: key.metadata.eventName || null,
          eventSlug: key.metadata.eventSlug || null,
          source: key.metadata.source === "walkin" ? "walkin" : "stripe"
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

// Esporta in CSV (si apre diretto in Excel/Numbers) TUTTI i biglietti venduti — non solo chi è
// entrato — più le persone registrate sul sito che non hanno mai comprato nulla, così lo staff ha
// in un unico file: acquisti, presenze reali, chi ha un account/loyalty card e chi no. Legge il
// singolo ticket per intero (non solo la metadata) perché il telefono non è indicizzato nella
// metadata del check-in — accettabile per un export manuale, non è una rotta ad alto traffico.
function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleExportAttendees(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const tickets = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) tickets.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const emailsWithTickets = new Set(tickets.map(function(t){ return (t.email || "").toLowerCase(); }));

  const accounts = [];
  cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "account:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) accounts.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const accountByEmail = new Map();
  for (const account of accounts) {
    if (account.email) accountByEmail.set(account.email.toLowerCase(), account);
  }

  const rows = [[
    "Nome", "Email", "Telefono", "Evento", "Fascia", "Origine", "Data acquisto", "Entrato",
    "Data check-in", "Account registrato", "Numero cliente", "Carta fisica riscattata", "Newsletter"
  ]];

  for (const t of tickets) {
    const account = t.email ? accountByEmail.get(t.email.toLowerCase()) : null;
    rows.push([
      t.name, t.email, t.phone, t.eventName, t.tierName, t.source === "walkin" ? "In loco" : "Online",
      t.createdAt ? new Date(t.createdAt).toLocaleString("it-IT") : "",
      t.used ? "Sì" : "No",
      t.usedAt ? new Date(t.usedAt).toLocaleString("it-IT") : "",
      account ? "Sì" : "No",
      account?.customerNumber || "",
      account?.physicalCardClaimed ? "Sì" : "No",
      account?.newsletterOptin || t.newsletterOptin ? "Sì" : "No"
    ]);
  }

  // Persone registrate sul sito ma senza nessun biglietto — altrimenti non comparirebbero mai
  // nell'export, dato che sopra si parte sempre dai biglietti.
  for (const account of accounts) {
    if (!account.email || emailsWithTickets.has(account.email.toLowerCase())) continue;
    rows.push([
      account.name, account.email, "", "", "", "", "", "No", "",
      "Sì", account.customerNumber || "", account.physicalCardClaimed ? "Sì" : "No",
      account.newsletterOptin ? "Sì" : "No"
    ]);
  }

  const csv = "﻿" + rows.map(function(row){ return row.map(csvEscape).join(","); }).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="growmi-partecipanti.csv"'
    }
  });
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
        attendees.push({ name: m.name, email: m.email, eventName: m.eventName, eventSlug: m.eventSlug });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return attendees;
}

// Costruisce il link al form di feedback nativo del sito (feedback.html), con l'evento già
// precompilato nell'URL — non serve più che qualcuno crei/incolli un Google Form a mano.
function buildFeedbackUrl(env, eventName, eventSlug) {
  const base = env.SITE_URL || "https://growmisito.grow-mi.workers.dev";
  const slugPart = eventSlug ? `&slug=${encodeURIComponent(eventSlug)}` : "";
  return `${base}/feedback?event=${encodeURIComponent(eventName || "GrowMi")}${slugPart}`;
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
          html: buildFeedbackEmailHTML({ name: a.name, eventName: a.eventName || "GrowMi", feedbackFormUrl: buildFeedbackUrl(env, a.eventName, a.eventSlug) })
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
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
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
  if (!rating || rating < 1 || rating > 10) {
    return jsonResponse({ error: "valutazione mancante o non valida" }, 400);
  }

  // likedOptions: selezioni dalle checkbox configurate sull'evento (vedi feedbackOptions in
  // validateEventPayload), incluso un eventuale "Altro: <testo>" — popolato solo se il form ha
  // trovato le opzioni dell'evento (ha ricevuto uno slug valido). Se il form è caduto sul
  // fallback testuale (link senza slug, o evento senza opzioni configurate), resta vuoto e si
  // usa ancora il vecchio campo libero "liked" — nessuna rottura per i link già inviati.
  const likedOptions = Array.isArray(body.likedOptions)
    ? body.likedOptions.map(function(o){ return String(o || "").slice(0, 200); }).filter(Boolean).slice(0, 20)
    : [];

  const id = crypto.randomUUID();
  await env.TICKETS.put(`feedback:${id}`, JSON.stringify({
    formId: String(body.formId || "").slice(0, 80) || null,
    eventName: String(body.eventName || "").slice(0, 200) || null,
    name: String(body.name || "").slice(0, 200) || null,
    email: String(body.email || "").slice(0, 200) || null,
    age: Number.isInteger(Number(body.age)) && Number(body.age) > 0 && Number(body.age) < 120 ? Number(body.age) : null,
    university: String(body.university || "").slice(0, 200) || null,
    foundVia: String(body.foundVia || "").slice(0, 300) || null,
    rating,
    likedOptions,
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
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
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

// Stesso principio di handleExportAttendees: esporta tutte le risposte feedback in CSV, si apre
// diretto in Excel/Numbers.
async function handleExportFeedback(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
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

  const rows = [[
    "Nome", "Email", "Età", "Università", "Come ha trovato GrowMi", "Evento", "Valutazione (1-10)", "Consiglierebbe GrowMi",
    "Cosa è piaciuto", "Cosa migliorare", "Altro", "Data invio"
  ]];
  for (const r of responses) {
    rows.push([
      r.name, r.email, r.age, r.university, r.foundVia, r.eventName, r.rating, r.wouldRecommend ? "Sì" : "No",
      (r.likedOptions && r.likedOptions.length) ? r.likedOptions.join("; ") : r.liked, r.improve, r.comments,
      r.submittedAt ? new Date(r.submittedAt).toLocaleString("it-IT") : ""
    ]);
  }

  const csv = "﻿" + rows.map(function(row){ return row.map(csvEscape).join(","); }).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="growmi-feedback.csv"'
    }
  });
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
      events.get(m.eventName).attendees.push({ name: m.name, email: m.email, eventName: m.eventName, eventSlug: m.eventSlug });
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

// Prefissi con dati veri e duraturi da salvare nel backup. Esclude di proposito: session:/
// staffsession: (token di login effimeri, si rigenerano da soli), evt:/feedback_sent: (marker
// interni di dedup, non dati), registration: (esiste solo tra form e pagamento riuscito, viene
// cancellata appena il webhook Stripe conferma — se esiste ancora è un acquisto abbandonato).
const BACKUP_PREFIXES = ["ticket:", "account:", "staffaccount:", "loyalty:", "coupon:", "customernum:", "physicalcard:", "feedback:", "event:"];

// Scarica per intero ogni prefisso in BACKUP_PREFIXES (list() dà solo le chiavi, serve una get()
// per ogni valore) più il contatore progressivo dei numeri cliente. Ritorna un oggetto pronto per
// JSON.stringify, organizzato per prefisso così un ripristino manuale sa subito dove rimettere
// ogni voce (env.TICKETS.put(chiave, valore) per ciascuna riga).
async function buildKVBackup(env) {
  const dump = {};
  for (const prefix of BACKUP_PREFIXES) {
    const records = {};
    let cursor = undefined;
    do {
      const page = await env.TICKETS.list({ prefix, cursor });
      for (const key of page.keys) {
        const value = await env.TICKETS.get(key.name);
        if (value !== null) records[key.name] = value;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    dump[prefix] = records;
  }
  const counterRaw = await env.TICKETS.get("config:nextCustomerNumber");
  if (counterRaw !== null) dump["config:nextCustomerNumber"] = counterRaw;
  return dump;
}

// Manda il backup completo via email (allegato JSON) a info@growmi.it: fuori dall'account
// Cloudflare, cosi' un problema con KV o con l'account non si porta via anche il backup. Usata
// sia dal cron giornaliero sia dall'endpoint manuale /api/admin-backup-now.
async function sendKVBackupEmail(env) {
  if (!env.TICKETS || !env.RESEND_API_KEY) return { ok: false, reason: "binding mancante" };

  const dump = await buildKVBackup(env);
  const counts = {};
  for (const prefix of BACKUP_PREFIXES) counts[prefix] = Object.keys(dump[prefix]).length;

  const json = JSON.stringify(dump, null, 2);
  const base64 = Buffer.from(json).toString("base64");
  const today = new Date().toISOString().slice(0, 10);

  const summaryRows = Object.entries(counts).map(([prefix, n]) => `<li>${prefix} ${n}</li>`).join("");
  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "GrowMi <noreply@growmi.it>",
      to: "info@growmi.it",
      subject: `Backup dati GrowMi — ${today}`,
      html: `<p>Backup automatico del database in allegato (JSON).</p><ul>${summaryRows}</ul>`,
      attachments: [{ filename: `growmi-backup-${today}.json`, content: base64 }]
    })
  });

  if (!resendRes.ok) {
    console.log("Errore invio backup:", resendRes.status, await resendRes.text());
    return { ok: false, counts };
  }
  return { ok: true, counts };
}

// Sola lettura: elenca ogni ticket: e coupon: collegato a un'email, con i dati utili a decidere
// se sono da eliminare (evento, importo, data, se già usati) — mai una cancellazione, solo un
// elenco su cui poi si chiama handleDebugDeleteTestData con le chiavi esatte da togliere.
async function handleDebugFindTestData(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const url = new URL(request.url);
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return jsonResponse({ error: "email obbligatoria" }, 400);

  const tickets = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      if ((key.metadata?.email || "").toLowerCase() === email) {
        const raw = await env.TICKETS.get(key.name);
        const t = raw ? JSON.parse(raw) : null;
        tickets.push({ key: key.name, eventName: t?.eventName, tierName: t?.tierName, amountTotal: t?.amountTotal, createdAt: t?.createdAt, used: t?.used });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const coupons = [];
  cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "coupon:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      const c = raw ? JSON.parse(raw) : null;
      if (c && String(c.email || "").toLowerCase() === email) {
        coupons.push({ key: key.name, used: c.used, createdAt: c.createdAt, expiresAt: c.expiresAt });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({ tickets, coupons });
}

// Cancella SOLO le chiavi esatte passate in body.keys, e solo se iniziano per ticket: o coupon:
// (mai account:, staffaccount: o altro, qualunque cosa contenga l'array) — pensato per essere
// chiamato con l'elenco ottenuto da handleDebugFindTestData, mai con un filtro generico che
// potrebbe far sparire dati veri per sbaglio.
async function handleDebugDeleteTestData(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const allowedPrefixes = ["ticket:", "coupon:"];
  const deleted = [];
  for (const key of keys) {
    if (typeof key === "string" && allowedPrefixes.some(function(p){ return key.startsWith(p); })) {
      await env.TICKETS.delete(key);
      deleted.push(key);
    }
  }
  return jsonResponse({ ok: true, deleted });
}

// Prefissi con dati di "vendite/attività" azzerabili per ripartire da zero prima del lancio vero
// — esclude di proposito staffaccount: (i login veri della sezione aziendale, mai da toccare) ed
// event: (configurazione eventi, non dati di vendita).
const WIPE_PREFIXES = ["ticket:", "account:", "loyalty:", "coupon:", "customernum:", "physicalcard:", "feedback:"];

// Sola lettura: elenco completo di ogni voce in WIPE_PREFIXES, per una revisione visiva finale
// prima di un reset completo — mai usato per decidere cosa cancellare, solo per vedere cosa c'è.
async function handleDebugListAllData(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const result = {};
  for (const prefix of WIPE_PREFIXES) {
    const entries = [];
    let cursor = undefined;
    do {
      const page = await env.TICKETS.list({ prefix, cursor });
      for (const key of page.keys) {
        const raw = await env.TICKETS.get(key.name);
        // customernum: non è JSON, è la mail salvata come stringa pura (vedi
        // nextSequentialCustomerNumber/handleClaimPhysicalCard) — il parse fallirebbe.
        let value = raw;
        try { value = raw ? JSON.parse(raw) : null; } catch (e) { /* resta la stringa grezza */ }
        entries.push({ key: key.name, value });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    result[prefix] = entries;
  }
  return jsonResponse(result);
}

// Reset completo: cancella OGNI voce in WIPE_PREFIXES più il contatore numeri cliente (torna al
// suo default 251 semplicemente sparendo, vedi nextSequentialCustomerNumber). Richiede
// {"confirm":"AZZERA"} nel body, non basta chiamare l'endpoint per sbaglio — pensato per essere
// usato una volta sola prima del lancio vero, dopo aver rivisto l'elenco con
// handleDebugListAllData. Non tocca mai staffaccount: (i login veri) né event:.
async function handleDebugWipeAllData(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  if (body.confirm !== "AZZERA") {
    return jsonResponse({ error: 'per confermare manda {"confirm":"AZZERA"} nel body' }, 400);
  }
  const deletedCounts = {};
  for (const prefix of WIPE_PREFIXES) {
    let count = 0;
    let cursor = undefined;
    do {
      const page = await env.TICKETS.list({ prefix, cursor });
      for (const key of page.keys) {
        await env.TICKETS.delete(key.name);
        count++;
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    deletedCounts[prefix] = count;
  }
  await env.TICKETS.delete("config:nextCustomerNumber");
  return jsonResponse({ ok: true, deletedCounts });
}

// Tariffa Stripe "UE premium" (2,8% + 0,25€) usata per calcolare la maggiorazione da aggiungere
// al prezzo netto configurato nel pannello eventi: la commissione reale che Stripe trattiene
// varia da carta a carta (UE standard, UE premium, extra-UE...), quindi questa è una stima fissa
// scelta apposta più alta della tariffa UE standard, cosi' nella maggior parte dei casi l'incasso
// netto resta uguale o superiore al prezzo configurato, mai inferiore.
const STRIPE_FEE_PERCENT = 0.028;
const STRIPE_FEE_FIXED_CENTS = 25;
// Tetto voluto sulla maggiorazione mostrata al cliente: oltre questa cifra la percentuale
// smetterebbe di sembrare giustificabile su un biglietto caro, quindi la commissione non supera
// mai 1€ anche se il calcolo pieno (percentuale + fisso) darebbe di più — sui biglietti più
// costosi l'incasso netto può quindi scendere leggermente sotto il prezzo configurato.
const STRIPE_FEE_CAP_CENTS = 100;

// Dato un prezzo netto (quanto vogliamo incassare davvero), calcola il prezzo lordo da
// addebitare al cliente perché, dopo che Stripe trattiene la sua commissione (percentuale sul
// lordo + fisso), resti il più vicino possibile a netCents nelle nostre tasche — senza mai
// superare il tetto di STRIPE_FEE_CAP_CENTS. Arrotondato per eccesso quando non tocca il tetto
// (meglio un centesimo in più che uno in meno). Un prezzo netto di 0 (biglietto gratuito/coupon)
// non genera nessuna commissione: Stripe non addebita nulla su una transazione a importo zero.
function addStripeFee(netCents) {
  if (!netCents || netCents <= 0) return { grossCents: 0, feeCents: 0 };
  const rawGrossCents = Math.ceil((netCents + STRIPE_FEE_FIXED_CENTS) / (1 - STRIPE_FEE_PERCENT));
  const feeCents = Math.min(rawGrossCents - netCents, STRIPE_FEE_CAP_CENTS);
  return { grossCents: netCents + feeCents, feeCents };
}

// Stato reale delle fasce prezzo di un evento: conta i biglietti già venduti per fascia
// leggendo la metadata KV (stesso pattern di handleStats/handleAttendees, una sola lista invece
// di una GET per biglietto) e lo confronta con la capacità nel registro EVENTS. La fascia attiva
// è la prima non esaurita; il client non decide mai da solo cosa è disponibile.
async function handleEventTiers(request, env) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("event");
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const event = await getEvent(env, slug);
  if (!event) return jsonResponse({ error: "evento non trovato" }, 404);

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
  // Calcolate in ordine (non con .map indipendente) perché lo stato "cascade" di una fascia deve
  // poter guardare il soldOut già calcolato della fascia precedente nell'array.
  const soldOutById = {};
  const tiers = [];
  for (let ti = 0; ti < event.tiers.length; ti++) {
    const t = event.tiers[ti];
    const prevTier = event.tiers[ti - 1];
    const sold = soldByTier[t.id] || 0;
    const status = t.status || "auto";
    // "soldout"/"comingsoon" sono decisioni manuali dello staff e vincono sempre — sia sul calcolo
    // automatico da capienza sia sulla finestra di vendita oraria qui sotto. "cascade" tiene la
    // fascia visibile-ma-non-acquistabile finché quella precedente non risulta esaurita; una volta
    // sbloccata si comporta come "auto" (capienza + eventuale finestra oraria). Solo quando lo
    // stato è "auto" (anche dopo lo sblocco di una "cascade") si guarda anche a
    // availableFrom/availableUntil (se impostati): prima dell'apertura vendite la fascia è visibile
    // ma non acquistabile, dopo la chiusura è "esaurita" — utile per aprire/chiudere le vendite di
    // una fascia da sola, senza dover tornare nel pannello a un'ora precisa per spuntarla a mano.
    let soldOut, forceUpcoming;
    if (status === "soldout") {
      soldOut = true; forceUpcoming = false;
    } else if (status === "comingsoon") {
      soldOut = false; forceUpcoming = true;
    } else if (status === "cascade" && prevTier && !soldOutById[prevTier.id]) {
      soldOut = false; forceUpcoming = true;
    } else {
      const now = new Date();
      const notYetOpen = t.availableFrom && now < new Date(t.availableFrom);
      const alreadyClosed = t.availableUntil && now > new Date(t.availableUntil);
      if (notYetOpen) { soldOut = false; forceUpcoming = true; }
      else if (alreadyClosed) { soldOut = true; forceUpcoming = false; }
      else { soldOut = sold >= t.capacity; forceUpcoming = false; }
    }
    // Una fascia pubblicata senza ancora un prezzo deciso (opzioni salvate con prezzo vuoto, vedi
    // validateEventPayload) non è mai vendibile, qualunque sia lo stato/finestra oraria impostati —
    // si può pubblicare la pagina prima di sapere i prezzi, mostrando "Presto in vendita" finché
    // non si torna a compilarli.
    const hasPricedOption = t.options.some(function(o){ return o.priceCents !== null && o.priceCents !== undefined; });
    if (!hasPricedOption) { soldOut = false; forceUpcoming = true; }
    soldOutById[t.id] = soldOut;
    const active = !soldOut && !forceUpcoming && !activeAssigned;
    if (active) activeAssigned = true;
    // priceCents resta il prezzo netto configurato nel pannello (quanto vogliamo incassare);
    // grossCents/feeCents sono calcolati qui cosi' il sito mostra sempre a schermo lo stesso
    // prezzo che poi verrà davvero addebitato al checkout — mai due numeri diversi. Un'opzione
    // senza prezzo ancora deciso non compare mai come bottone acquistabile, anche se il resto
    // della fascia è attiva (es. "Solo ingresso" già prezzato, "+ Birra e panzerotto" ancora no).
    const options = t.options.filter(function(o){ return o.priceCents !== null && o.priceCents !== undefined; }).map(function(o){
      const fee = addStripeFee(o.priceCents);
      return { id: o.id, label: o.label, priceCents: o.priceCents, feeCents: fee.feeCents, grossCents: fee.grossCents };
    });
    tiers.push({ id: t.id, name: t.name, sub: t.sub, options, soldOut, active });
  }

  return jsonResponse({ eventName: event.name, tiers, allSoldOut: !activeAssigned, feedbackOptions: event.feedbackOptions || [] });
}

// ============================================================================
// Sistema newsletter interno (sostituisce MailerLite) — un record per persona in
// "subscriber:<email>". Due concetti tenuti volutamente separati:
// - eventGroups/manualGroups: SEGMENTAZIONE, a cosa è associata la persona (quali eventi ha
//   comprato, quali gruppi manuali le sono stati assegnati) — si aggiorna sempre, anche se non
//   ha mai dato consenso marketing, perché è solo organizzazione interna dei contatti.
// - newsletterOptin: il vero PERMESSO a ricevere email di marketing — resta sempre una scelta
//   esplicita della persona (checkbox al momento dell'iscrizione/acquisto), mai impostato a
//   true solo perché è entrata in un gruppo. Le email si mandano solo a chi ha newsletterOptin
//   true, indipendentemente dai gruppi di cui fa parte.
// ============================================================================
function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function upsertSubscriber(env, opts) {
  if (!env.TICKETS) return null;
  const email = String(opts.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) return null;
  const key = `subscriber:${email}`;
  const raw = await env.TICKETS.get(key);
  const existing = raw ? JSON.parse(raw) : null;
  const eventGroups = new Set(existing?.eventGroups || []);
  if (opts.eventSlug) eventGroups.add(opts.eventSlug);
  const record = {
    email,
    name: (opts.name && String(opts.name).trim()) ? String(opts.name).trim().slice(0, 200) : (existing?.name || null),
    newsletterOptin: opts.newsletterOptin === true ? true : !!existing?.newsletterOptin,
    siteSignup: opts.siteSignup === true ? true : !!existing?.siteSignup,
    eventGroups: Array.from(eventGroups),
    manualGroups: existing?.manualGroups || [],
    unsubscribed: existing?.unsubscribed || false,
    unsubscribeToken: existing?.unsubscribeToken || crypto.randomUUID(),
    // opts.stats (es. importato da MailerLite) prende il posto di quello che c'è solo se dice
    // "ho numeri più alti" per ciascun campo — un'email mandata da questo sistema DOPO
    // l'importazione non deve mai vedersi azzerare il contatore da un reimport successivo.
    stats: opts.stats ? {
      sent: Math.max(opts.stats.sent || 0, existing?.stats?.sent || 0),
      opens: Math.max(opts.stats.opens || 0, existing?.stats?.opens || 0),
      clicks: Math.max(opts.stats.clicks || 0, existing?.stats?.clicks || 0)
    } : (existing?.stats || { sent: 0, opens: 0, clicks: 0 }),
    source: existing?.source || opts.source || "unknown",
    createdAt: existing?.createdAt || opts.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await env.TICKETS.put(key, JSON.stringify(record));
  return record;
}

// Form popup del sito (assets/newsletter.js intercetta il submit e chiama questa rotta invece
// di mandare il form direttamente a MailerLite).
async function handleNewsletterSubscribe(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  if (!isValidEmail(body.email)) return jsonResponse({ error: "email non valida" }, 400);
  await upsertSubscriber(env, { email: body.email, name: body.name, siteSignup: true, newsletterOptin: true, source: "site-popup" });
  return jsonResponse({ ok: true });
}

// Link "disiscriviti" obbligatorio in ogni email inviata (vedi buildNewsletterEmailHtml) — token
// invece dell'email in chiaro nell'URL, non richiede login.
async function handleNewsletterUnsubscribe(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return new Response("Link non valido.", { status: 400 });
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "subscriber:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const sub = JSON.parse(raw);
      if (sub.unsubscribeToken === token) {
        sub.unsubscribed = true;
        sub.newsletterOptin = false;
        sub.updatedAt = new Date().toISOString();
        await env.TICKETS.put(key.name, JSON.stringify(sub));
        return new Response(
          "<!DOCTYPE html><html lang=\"it\"><head><meta charset=\"UTF-8\"><title>Disiscritto — GrowMi</title></head><body style=\"font-family:sans-serif; max-width:480px; margin:80px auto; text-align:center; color:#1E0C2C;\"><h1>Fatto.</h1><p>Non riceverai più email da GrowMi. Se cambi idea, puoi iscriverti di nuovo dal sito quando vuoi.</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return new Response("Link non valido o già usato.", { status: 404 });
}

async function handleAdminListNewsletterSubscribers(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const subscribers = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "subscriber:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) subscribers.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  subscribers.sort(function(a, b){ return (b.createdAt || "").localeCompare(a.createdAt || ""); });
  return jsonResponse({ subscribers });
}

// Importa gli iscritti già presenti su MailerLite (paginazione a cursore dell'API v2) — non
// tocca/cancella nulla su MailerLite, legge soltanto. Idempotente: si può rilanciare senza
// creare doppioni (upsertSubscriber fa merge su email).
async function handleAdminImportMailerlite(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.MAILERLITE_API_KEY) return jsonResponse({ error: "MAILERLITE_API_KEY non configurato" }, 400);
  let imported = 0;
  let cursor = null;
  let guard = 0;
  do {
    const url = new URL("https://connect.mailerlite.com/api/subscribers");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${env.MAILERLITE_API_KEY}`, "Accept": "application/json" } });
    if (!res.ok) return jsonResponse({ error: "MailerLite ha risposto " + res.status, imported }, 502);
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    for (const s of list) {
      if (!s.email) continue;
      // Come per le campagne, MailerLite non è documentato con certezza su questi nomi di campo
      // per gli iscritti — provo diversi alias possibili, 0 se nessuno combacia.
      const stats = {
        sent: s.sent_count || s.sent || (s.stats && (s.stats.sent || s.stats.sent_count)) || 0,
        opens: s.opens_count || s.open_count || s.opened_count || (s.stats && (s.stats.opens_count || s.stats.open_count || s.stats.opened_count)) || 0,
        clicks: s.clicks_count || s.click_count || s.clicked_count || (s.stats && (s.stats.clicks_count || s.stats.click_count || s.stats.clicked_count)) || 0
      };
      await upsertSubscriber(env, {
        email: s.email,
        name: (s.fields && (s.fields.name || s.fields.full_name)) || null,
        siteSignup: true,
        newsletterOptin: s.status === "active",
        source: "mailerlite-import",
        stats: (stats.sent || stats.opens || stats.clicks) ? stats : null
      });
      imported++;
    }
    cursor = (data.meta && data.meta.next_cursor) || null;
    guard++;
  } while (cursor && guard < 50);
  return jsonResponse({ ok: true, imported });
}

// Import da file CSV esportato a mano da MailerLite (pannello iscritti → esporta) invece che
// dall'API — più affidabile dei nomi di campo indovinati in handleAdminImportMailerlite perché i
// nomi delle colonne (Subscriber/Sent/Opens/Clicks/Subscribed) sono quelli che si vedono
// nell'export vero. Il parsing del CSV/TSV avviene lato client (azienda.html), qui arriva già
// come JSON — stesso merge "prendi il numero più alto" di upsertSubscriber, quindi si può
// rilanciare più volte senza rischi.
async function handleAdminImportCsvStats(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const rows = Array.isArray(body.subscribers) ? body.subscribers : [];
  let imported = 0, skipped = 0;
  for (const row of rows) {
    if (!isValidEmail(row.email)) { skipped++; continue; }
    const stats = {
      sent: Number(row.sent) || 0,
      opens: Number(row.opens) || 0,
      clicks: Number(row.clicks) || 0
    };
    let createdAt = null;
    if (row.subscribedAt) {
      const parsed = new Date(row.subscribedAt);
      if (!isNaN(parsed.getTime())) createdAt = parsed.toISOString();
    }
    await upsertSubscriber(env, {
      email: row.email,
      siteSignup: true,
      newsletterOptin: true,
      source: "mailerlite-csv",
      stats,
      createdAt
    });
    imported++;
  }
  return jsonResponse({ ok: true, imported, skipped });
}

// Storico campagne già inviate su MailerLite (testo, oggetto, statistiche) — salvate come
// newslettercampaign:mailerlite-<id> con status "sent" fin da subito: sono storia, non bozze da
// poter re-inviare per sbaglio. I nomi esatti dei campi statistiche possono variare secondo la
// versione dell'account MailerLite — presi con più alias possibili, 0 se nessuno combacia
// (meglio un numero a zero visibile che un errore che blocca tutto l'import).
async function handleAdminImportMailerliteCampaigns(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.MAILERLITE_API_KEY) return jsonResponse({ error: "MAILERLITE_API_KEY non configurato" }, 400);
  let imported = 0;
  let cursor = null;
  let guard = 0;
  do {
    const url = new URL("https://connect.mailerlite.com/api/campaigns");
    url.searchParams.set("filter[status]", "sent");
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${env.MAILERLITE_API_KEY}`, "Accept": "application/json" } });
    if (!res.ok) return jsonResponse({ error: "MailerLite ha risposto " + res.status, imported }, 502);
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    for (const c of list) {
      const id = `mailerlite-${c.id}`;
      const email0 = (c.emails && c.emails[0]) || {};
      const stats = c.stats || {};
      const campaign = {
        id,
        name: c.name || email0.subject || "Newsletter importata",
        eventSlug: null,
        subject: email0.subject || c.name || "",
        bodyHtml: email0.content || email0.html || "<p><em>Contenuto non disponibile dall'importazione — solo oggetto e statistiche.</em></p>",
        targetGroups: [],
        status: "sent",
        createdAt: c.created_at || new Date().toISOString(),
        sentAt: c.finished_at || c.created_at || null,
        recipientCount: stats.sent || stats.recipients_count || stats.total_recipients || 0,
        openCount: stats.opened_count || stats.opens_count || stats.open_count || 0,
        clickCount: stats.clicked_count || stats.clicks_count || stats.click_count || 0,
        importedFromMailerlite: true
      };
      await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
      imported++;
    }
    cursor = (data.meta && data.meta.next_cursor) || null;
    guard++;
  } while (cursor && guard < 50);
  return jsonResponse({ ok: true, imported });
}

async function handleAdminListNewsletterGroups(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const groups = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "newslettergroup:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) groups.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  groups.sort(function(a, b){ return (a.name || "").localeCompare(b.name || ""); });
  return jsonResponse({ groups });
}

async function handleAdminCreateNewsletterGroup(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const name = String(body.name || "").trim().slice(0, 100);
  if (!name) return jsonResponse({ error: "nome obbligatorio" }, 400);
  const emailType = String(body.emailType || "").trim().slice(0, 100);
  const id = slugify(name).slice(0, 40) || crypto.randomUUID().slice(0, 8);
  const group = { id, name, emailType, createdAt: new Date().toISOString() };
  await env.TICKETS.put(`newslettergroup:${id}`, JSON.stringify(group));
  return jsonResponse({ ok: true, group });
}

async function handleAdminDeleteNewsletterGroup(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const id = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  await env.TICKETS.delete(`newslettergroup:${id}`);
  return jsonResponse({ ok: true });
}

// Aggiunge/rimuove UN iscritto da UN gruppo manuale — usato dalla tabella iscritti del pannello.
async function handleAdminSetSubscriberGroup(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  const groupId = String(body.groupId || "").trim();
  const remove = body.action === "remove";
  if (!isValidEmail(email) || !groupId) return jsonResponse({ error: "email o gruppo non validi" }, 400);
  const raw = await env.TICKETS.get(`subscriber:${email}`);
  if (!raw) return jsonResponse({ error: "iscritto non trovato" }, 404);
  const sub = JSON.parse(raw);
  const groups = new Set(sub.manualGroups || []);
  if (remove) groups.delete(groupId); else groups.add(groupId);
  sub.manualGroups = Array.from(groups);
  sub.updatedAt = new Date().toISOString();
  await env.TICKETS.put(`subscriber:${email}`, JSON.stringify(sub));
  return jsonResponse({ ok: true, subscriber: sub });
}

// ============================================================================
// Campagne newsletter — "newslettercampaign:<id>". Un target è una lista di stringhe:
// "all" | "site-signup" | "event:<slug>" | "group:<groupId>" — un iscritto la riceve se
// combacia con ALMENO UNO dei target scelti (OR), ma SOLO se ha ancora newsletterOptin true e
// non si è disiscritto: i gruppi sono solo segmentazione, non un permesso a mandare email.
// ============================================================================
function subscriberMatchesTarget(sub, target) {
  if (target === "all") return true;
  if (target === "site-signup") return !!sub.siteSignup;
  if (target.indexOf("event:") === 0) return (sub.eventGroups || []).includes(target.slice(6));
  if (target.indexOf("group:") === 0) return (sub.manualGroups || []).includes(target.slice(6));
  return false;
}

async function resolveCampaignRecipients(env, targetGroups) {
  const targets = Array.isArray(targetGroups) && targetGroups.length ? targetGroups : ["all"];
  const recipients = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "subscriber:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const sub = JSON.parse(raw);
      if (!sub.newsletterOptin || sub.unsubscribed) continue;
      if (targets.some(function(t){ return subscriberMatchesTarget(sub, t); })) recipients.push(sub);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return recipients;
}

// Risolve una lista di email specifiche in oggetti iscritto — usato per riprovare solo chi era
// rimasto in sospeso (pendingRecipients) o per un invio manuale a una lista (recupero incidenti).
// Ri-controlla optin/disiscrizione al momento della chiamata (potrebbero essere cambiati nel
// frattempo), non si fida della lista da sola.
async function resolveRecipientsByEmail(env, emails) {
  const recipients = [];
  for (const email of emails) {
    const raw = await env.TICKETS.get(`subscriber:${String(email).trim().toLowerCase()}`);
    if (!raw) continue;
    const sub = JSON.parse(raw);
    if (!sub.newsletterOptin || sub.unsubscribed) continue;
    recipients.push(sub);
  }
  return recipients;
}

function newsletterBaseUrl(env) {
  return env.SITE_URL || "https://growmisito.grow-mi.workers.dev";
}

// Link usati nell'intestazione e nel footer del modello standard — un solo posto da modificare
// dal pannello (card "Link nelle email"), non dentro ogni singola newsletter. I social restano
// identici per tutte le email (per scelta di Carlo), ma restano comunque modificabili qui invece
// che scritti a mano nel codice.
const NEWSLETTER_DEFAULT_SETTINGS = {
  address: "Milano, Italia",
  aboutUrl: "/chi-siamo",
  instagramUrl: "https://www.instagram.com/growmiii/",
  tiktokUrl: "https://www.tiktok.com/@growmii_",
  linkedinUrl: "https://www.linkedin.com/company/growmiagency/"
};

async function getNewsletterSettings(env) {
  if (!env.TICKETS) return NEWSLETTER_DEFAULT_SETTINGS;
  const raw = await env.TICKETS.get("newsletter:settings");
  if (!raw) return NEWSLETTER_DEFAULT_SETTINGS;
  try {
    return Object.assign({}, NEWSLETTER_DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (err) {
    return NEWSLETTER_DEFAULT_SETTINGS;
  }
}

async function handleAdminGetNewsletterSettings(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  return jsonResponse({ settings: await getNewsletterSettings(env) });
}

async function handleAdminSaveNewsletterSettings(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const settings = {
    address: String(body.address || "").trim().slice(0, 200) || NEWSLETTER_DEFAULT_SETTINGS.address,
    aboutUrl: String(body.aboutUrl || "").trim().slice(0, 400) || NEWSLETTER_DEFAULT_SETTINGS.aboutUrl,
    instagramUrl: String(body.instagramUrl || "").trim().slice(0, 400) || NEWSLETTER_DEFAULT_SETTINGS.instagramUrl,
    tiktokUrl: String(body.tiktokUrl || "").trim().slice(0, 400) || NEWSLETTER_DEFAULT_SETTINGS.tiktokUrl,
    linkedinUrl: String(body.linkedinUrl || "").trim().slice(0, 400) || NEWSLETTER_DEFAULT_SETTINGS.linkedinUrl
  };
  await env.TICKETS.put("newsletter:settings", JSON.stringify(settings));
  return jsonResponse({ ok: true, settings });
}

// Bozza automatica: nome/data/luogo/teaser dell'evento già dentro un template pronto, l'admin
// aggiunge solo foto e ritocca il testo se vuole (vedi handleAdminCreateNewsletterCampaign).
function autoDraftHtmlFromEvent(event) {
  const url = `EVENT_URL_PLACEHOLDER`; // sostituito con l'URL vero lato client, dove si conosce già lo slug
  return `<p>Ciao,</p><p>${event.teaser || "Ti aspettiamo al prossimo evento GrowMi!"}</p>` +
    `<p><strong>${event.name}</strong><br>${event.dateDisplay || ""}${event.location ? " · " + event.location : ""}</p>` +
    `<p><a href="${url}">Scopri di più e prendi il biglietto</a></p>`;
}

// Modello standard GrowMi — logo + menu, foto hero (facoltativa, inquadrabile come le altre foto
// del sito), titolo grande, testo libero, bottone se ce n'è uno nel testo, footer viola con
// social e disiscrizione. Avvolge il contenuto che l'admin scrive nell'editor, così l'editor
// stesso resta pulito (solo messaggio + titolo + foto, niente logo/footer da ricreare ogni
// volta) e il modello resta identico per ogni newsletter, automatica o manuale: per cambiarlo
// basta questa funzione, non ogni bozza già salvata.
function newsletterStandardTemplateHtml(opts){
  const base = opts.base;
  const settings = opts.settings || NEWSLETTER_DEFAULT_SETTINGS;
  const aboutHref = /^https?:\/\//i.test(settings.aboutUrl) ? settings.aboutUrl : `${base}${settings.aboutUrl}`;
  const heroImg = opts.heroImageUrl
    ? `<img src="${opts.heroImageUrl}" alt="" style="width:100%; display:block; border-radius:14px; object-position:${opts.heroImagePosition || "center"}; margin-bottom:28px;">`
    : "";
  const title = opts.title ? `<h1 style="font-family:Arial,sans-serif; font-size:28px; font-weight:800; color:#1E0C2C; text-align:center; margin-bottom:20px;">${opts.title}</h1>` : "";
  return `<div style="max-width:560px; margin:0 auto; font-family:Arial,sans-serif; background:#FBF6F0; border-radius:20px; overflow:hidden;">` +
    `<div style="padding:32px 28px 8px;">` +
      `<div style="text-align:center; padding-bottom:20px;">` +
        `<img src="${base}/assets/img/logo-growmi.png" alt="GrowMi" style="height:34px;">` +
      `</div>` +
      `<div style="text-align:center; padding-bottom:28px; font-size:13px;">` +
        `<a href="${aboutHref}" style="color:#1E0C2C; text-decoration:none; margin:0 12px;">Chi siamo</a>` +
        `<a href="${settings.instagramUrl}" style="color:#1E0C2C; text-decoration:none; margin:0 12px;">Instagram</a>` +
        `<a href="${settings.tiktokUrl}" style="color:#1E0C2C; text-decoration:none; margin:0 12px;">TikTok</a>` +
      `</div>` +
      heroImg +
      title +
      `<div style="font-size:15px; color:#1E0C2C; line-height:1.6;">${opts.trackedBody}</div>` +
    `</div>` +
    `<div style="background:#2C0943; color:#fff; padding:28px; margin-top:16px;">` +
      `<table role="presentation" width="100%"><tr>` +
        `<td style="vertical-align:top;">` +
          `<p style="font-weight:700; margin-bottom:6px;">GrowMi</p>` +
          `<p style="font-size:12px; color:#C9BFE0; margin-bottom:14px;">${settings.address}</p>` +
          `<a href="${settings.instagramUrl}" style="color:#fff; text-decoration:none; margin-right:10px; font-size:12px;">Instagram</a>` +
          `<a href="${settings.tiktokUrl}" style="color:#fff; text-decoration:none; margin-right:10px; font-size:12px;">TikTok</a>` +
          `<a href="${settings.linkedinUrl}" style="color:#fff; text-decoration:none; font-size:12px;">LinkedIn</a>` +
        `</td>` +
        `<td style="vertical-align:top; text-align:right; font-size:12px; color:#C9BFE0;">` +
          `<p>Ricevi questa email perché sei iscritto alla newsletter di GrowMi.</p>` +
          `<a href="${opts.unsubUrl}" style="color:#fff; text-decoration:underline;">Disiscriviti</a>` +
        `</td>` +
      `</tr></table>` +
    `</div>` +
  `</div>`;
}

// Bottone (link stilizzato come un pulsante) da inserire nel testo dal pannello — vedi anche
// "+ Bottone" nell'editor della newsletter. Riconosciuto qui solo per convertire il colore in
// coral come il resto del sito quando arriva "as-is" dal contenteditable (già coral di suo,
// questa funzione serve più che altro a isolare lo stile in un solo posto).
// Le immagini caricate dal pannello (hero, o inserite nel corpo del testo/nei blocchi del
// builder) hanno un src relativo ("/media/<key>") lato composer — corretto lì perché si apre
// nella stessa pagina admin, ma un client email (Gmail, Outlook...) non ha nessun documento a cui
// il percorso sia relativo, quindi l'immagine risulterebbe rotta. Riscrive in assoluto prima
// dell'invio o dell'anteprima.
function absolutizeMediaUrls(html, base) {
  return String(html || "").replace(/src="\/media\//g, `src="${base}/media/`);
}

function buildTrackedEmailHtml(bodyHtml, campaignId, subscriber, env, extra) {
  const base = newsletterBaseUrl(env);
  const e = encodeURIComponent(subscriber.email);
  const trackedBody = absolutizeMediaUrls(bodyHtml, base).replace(/href="(https?:\/\/[^"]+)"/g, function(match, url){
    return `href="${base}/api/newsletter-track-click?c=${encodeURIComponent(campaignId)}&e=${e}&url=${encodeURIComponent(url)}"`;
  });
  const pixel = `<img src="${base}/api/newsletter-track-open?c=${encodeURIComponent(campaignId)}&e=${e}" width="1" height="1" alt="" style="display:block;border:0;">`;
  const unsubUrl = `${base}/newsletter-unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`;
  // Assoluto, non relativo: mediaUrl() da solo torna "/media/<key>", che non risolve dentro un
  // client email (nessun documento/base a cui è relativo) — qui invece serve funzionare in Gmail ecc.
  const heroImageUrl = extra && extra.heroImageKey ? `${base}${mediaUrl(extra.heroImageKey)}` : null;
  return newsletterStandardTemplateHtml({
    base, trackedBody, unsubUrl, heroImageUrl,
    heroImagePosition: extra && extra.heroImagePosition,
    title: extra && extra.title,
    settings: extra && extra.settings
  }) + pixel;
}

// Crea da sola una bozza di newsletter appena si salva un evento NUOVO (vedi
// handleAdminCreateEvent) — zero click in più: l'admin la trova già pronta in "Campagne", con
// testo/oggetto precompilati come per il flusso manuale "Lega a un evento", aggiunge solo le
// foto e la manda quando vuole. Non tocca nulla se una bozza per questo evento esiste già
// (es. l'admin l'ha creata a mano prima di salvare l'evento).
async function autoCreateDraftCampaignForEvent(env, slug, event) {
  try {
    const page = await env.TICKETS.list({ prefix: "newslettercampaign:" });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const existing = JSON.parse(raw);
      if (existing.eventSlug === slug) return; // già ce n'è una, non duplicarla
    }
    const id = crypto.randomUUID();
    const campaign = {
      id, name: `Newsletter — ${event.name}`, eventSlug: slug,
      subject: event.name, title: event.name,
      bodyHtml: autoDraftHtmlFromEvent(event).replace("EVENT_URL_PLACEHOLDER", `${newsletterBaseUrl(env)}/evento/${slug}`),
      // Foto già pronta: riusa la copertina/hero dell'evento se c'è, così la bozza automatica ha
      // subito una vera immagine invece di restare vuota finché l'admin non ne carica una.
      heroImageKey: event.coverImageKey || event.heroImageKey || null,
      heroImagePosition: event.heroPosition || "center",
      targetGroups: [`event:${slug}`],
      status: "draft", createdAt: new Date().toISOString(), sentAt: null, scheduledAt: null,
      recipientCount: 0, openCount: 0, clickCount: 0
    };
    await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  } catch (err) {
    console.log("Errore bozza newsletter automatica per evento", slug, err.stack || err.message);
  }
}

async function handleAdminListNewsletterCampaigns(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const campaigns = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "newslettercampaign:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (raw) campaigns.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  campaigns.sort(function(a, b){ return (b.createdAt || "").localeCompare(a.createdAt || ""); });
  return jsonResponse({ campaigns });
}

async function handleAdminCreateNewsletterCampaign(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const name = String(body.name || "").trim().slice(0, 200) || "Nuova newsletter";
  const id = crypto.randomUUID();
  let subject = String(body.subject || "").trim().slice(0, 200);
  let title = String(body.title || "").trim().slice(0, 200);
  let bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.slice(0, 20000) : "";
  let heroImageKey = (body.heroImageKey && String(body.heroImageKey).trim()) || null;
  let heroImagePosition = String(body.heroImagePosition || "center").trim().slice(0, 30);
  let eventSlug = null;
  let targetGroups = [];
  if (body.eventSlug) {
    const event = await getEvent(env, String(body.eventSlug));
    if (event) {
      eventSlug = String(body.eventSlug);
      if (!subject) subject = event.name;
      if (!title) title = event.name;
      if (!bodyHtml) bodyHtml = autoDraftHtmlFromEvent(event).replace("EVENT_URL_PLACEHOLDER", `${newsletterBaseUrl(env)}/evento/${eventSlug}`);
      if (!heroImageKey) heroImageKey = event.coverImageKey || event.heroImageKey || null;
      targetGroups = [`event:${eventSlug}`];
    }
  }
  const campaign = {
    id, name, eventSlug, subject, title, bodyHtml, heroImageKey, heroImagePosition,
    // Struttura a blocchi del builder (vedi azienda.html) — bodyHtml resta comunque la fonte di
    // verità per l'invio/anteprima (calcolato dal client con blocksToHtml), blocks serve solo a
    // poter riaprire la campagna nel builder così com'era, invece di dover ripartire da un unico
    // blocco "legacy" col solo HTML già renderizzato.
    blocks: Array.isArray(body.blocks) ? body.blocks : null,
    targetGroups: Array.isArray(body.targetGroups) && body.targetGroups.length ? body.targetGroups : targetGroups,
    status: "draft", createdAt: new Date().toISOString(), sentAt: null, scheduledAt: null,
    recipientCount: 0, openCount: 0, clickCount: 0
  };
  await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  return jsonResponse({ ok: true, campaign });
}

async function handleAdminSaveNewsletterCampaign(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const raw = await env.TICKETS.get(`newslettercampaign:${id}`);
  if (!raw) return jsonResponse({ error: "campagna non trovata" }, 404);
  const campaign = JSON.parse(raw);
  if (campaign.status === "sent") return jsonResponse({ error: "questa newsletter è già stata inviata, non è più modificabile" }, 400);
  campaign.name = String(body.name || campaign.name || "").trim().slice(0, 200);
  campaign.subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 200) : campaign.subject;
  campaign.title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : campaign.title;
  campaign.bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.slice(0, 20000) : campaign.bodyHtml;
  if (Array.isArray(body.blocks)) campaign.blocks = body.blocks;
  if (Object.prototype.hasOwnProperty.call(body, "heroImageKey")) {
    campaign.heroImageKey = (body.heroImageKey && String(body.heroImageKey).trim()) || null;
  }
  if (typeof body.heroImagePosition === "string") campaign.heroImagePosition = body.heroImagePosition.trim().slice(0, 30);
  if (Array.isArray(body.targetGroups)) campaign.targetGroups = body.targetGroups;
  // Programmazione: un datetime-local valido pianifica l'invio (status "scheduled", se ne
  // occupa il cron ogni 15 minuti — vedi runScheduledNewsletters). Stringa vuota/assente riporta
  // a bozza normale, senza toccare lo status se non è stato passato il campo affatto (salvataggi
  // "solo testo" non devono disprogrammare per sbaglio una campagna già programmata).
  if (Object.prototype.hasOwnProperty.call(body, "scheduledAt")) {
    if (body.scheduledAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.scheduledAt)) {
      campaign.scheduledAt = body.scheduledAt;
      campaign.status = "scheduled";
    } else {
      campaign.scheduledAt = null;
      if (campaign.status === "scheduled") campaign.status = "draft";
    }
  }
  await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  return jsonResponse({ ok: true, campaign });
}

async function handleAdminDeleteNewsletterCampaign(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const id = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  await env.TICKETS.delete(`newslettercampaign:${id}`);
  return jsonResponse({ ok: true });
}

async function handleAdminPreviewNewsletterRecipients(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const recipients = await resolveCampaignRecipients(env, body.targetGroups);
  return jsonResponse({ count: recipients.length });
}

// Anteprima della bozza così com'è nel composer, senza salvarla né inviarla — usa lo stesso
// modello standard/link/impostazioni di un invio vero, ma senza tracking (nessun destinatario
// reale) e con un link disiscrizione finto (# ) dato che non c'è nessun iscritto per cui generarlo.
async function handleAdminPreviewNewsletterCampaign(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  const body = await request.json();
  const base = newsletterBaseUrl(env);
  const settings = await getNewsletterSettings(env);
  const heroImageUrl = body.heroImageKey ? `${base}${mediaUrl(body.heroImageKey)}` : null;
  const html = newsletterStandardTemplateHtml({
    base, settings, heroImageUrl,
    heroImagePosition: body.heroImagePosition,
    title: body.title,
    trackedBody: absolutizeMediaUrls(body.bodyHtml || "", base),
    unsubUrl: "#"
  });
  const safeTitle = String(body.subject || "Anteprima newsletter").replace(/[<>&]/g, function(c){ return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"; });
  return new Response(
    `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>${safeTitle}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0; padding:32px 16px; background:#EFE7DC;">${html}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// Invio vero e proprio — condiviso tra la rotta manuale ("Invia adesso") e il cron che manda le
// campagne programmate (vedi runScheduledNewsletters). Il chiamante ha già controllato che la
// campagna esista e non sia già stata inviata.
// overrideRecipients (facoltativo): se passato, si manda SOLO a questa lista invece di
// ricalcolare i destinatari dai targetGroups — usato per riprovare solo chi era rimasto in sospeso
// (campaign.pendingRecipients) o per un invio manuale a una lista di email specifiche (recupero da
// un incidente), senza mai reinviare a chi ha già ricevuto questa campagna con successo.
async function sendNewsletterCampaignNow(env, campaign, overrideRecipients) {
  const id = campaign.id;
  const recipients = overrideRecipients || await resolveCampaignRecipients(env, campaign.targetGroups);
  const settings = await getNewsletterSettings(env);
  let sent = 0, failed = 0;
  const pending = [];
  // Un 429 di Resend (limite di velocità O tetto del piano esaurito) significa che OGNI invio
  // successivo fallirebbe comunque — continuare a provare brucia solo tempo e riempie i log.
  // Ci si ferma subito, si tiene da parte chi non è stato ancora tentato, e si riprova più tardi
  // (vedi runScheduledNewsletters, ogni 15 minuti prova anche le campagne "partial").
  let rateLimited = false;
  for (let i = 0; i < recipients.length; i++) {
    const sub = recipients[i];
    if (rateLimited) { pending.push(sub.email); continue; }
    try {
      const html = buildTrackedEmailHtml(campaign.bodyHtml, id, sub, env, {
        title: campaign.title, heroImageKey: campaign.heroImageKey, heroImagePosition: campaign.heroImagePosition, settings
      });
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "GrowMi <noreply@growmi.it>", to: sub.email, subject: campaign.subject, html })
      });
      if (res.ok) {
        sent++;
        sub.stats = sub.stats || { sent: 0, opens: 0, clicks: 0 };
        sub.stats.sent++;
        await env.TICKETS.put(`subscriber:${sub.email}`, JSON.stringify(sub));
        // Marcatore per-campagna/per-email (mai usato per l'invio, solo per poter rispondere in
        // futuro a "chi non ha ricevuto la campagna X" — cosa che oggi non è possibile ricostruire
        // per gli invii fatti prima di questo campo).
        await env.TICKETS.put(`nlsent:${id}:${sub.email}`, "1");
      } else if (res.status === 429) {
        failed++;
        rateLimited = true;
        pending.push(sub.email);
        console.log("Resend: limite raggiunto, invio messo in pausa per", campaign.id, await res.text());
      } else {
        failed++;
        console.log("Resend newsletter error:", res.status, await res.text());
      }
    } catch (e) {
      failed++;
      console.log("Errore invio newsletter a", sub.email, e.message);
    }
    // Pausa tra un invio e l'altro (non dopo l'ultimo) — riduce la probabilità di innescare un
    // limite di velocità al secondo, a parte quello giornaliero del piano che questo non evita.
    if (!rateLimited && i < recipients.length - 1) {
      await new Promise(function(resolve){ setTimeout(resolve, 150); });
    }
  }
  campaign.pendingRecipients = pending;
  campaign.status = pending.length ? "partial" : "sent";
  campaign.sentAt = new Date().toISOString();
  campaign.scheduledAt = pending.length ? campaign.scheduledAt : null;
  campaign.recipientCount = (campaign.recipientCount || 0) + sent;
  await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  return { sent, failed, total: recipients.length, pending: pending.length };
}

// Cron ogni 15 minuti (vedi [triggers] in wrangler.toml): manda le campagne con status
// "scheduled" il cui orario è arrivato. Un job alla volta con un piccolo margine di ritardo
// accettabile (fino a ~15 minuti) — va benissimo per una newsletter, non serve precisione al
// secondo.
async function runScheduledNewsletters(env) {
  if (!env.TICKETS || !env.RESEND_API_KEY) return;
  const now = new Date();
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "newslettercampaign:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const campaign = JSON.parse(raw);
      // "partial": un invio precedente si è fermato per un limite di Resend con qualcuno ancora
      // in sospeso (vedi sendNewsletterCampaignNow) — si riprova automaticamente, senza bisogno
      // che l'admin clicchi niente, esattamente come per il tetto giornaliero che si libera da
      // solo il giorno dopo.
      if (campaign.status === "partial" && Array.isArray(campaign.pendingRecipients) && campaign.pendingRecipients.length) {
        try {
          const pendingSubs = await resolveRecipientsByEmail(env, campaign.pendingRecipients);
          if (pendingSubs.length) await sendNewsletterCampaignNow(env, campaign, pendingSubs);
        } catch (err) {
          console.log("Errore riprova invio newsletter", campaign.id, err.stack || err.message);
        }
        continue;
      }
      if (campaign.status !== "scheduled" || !campaign.scheduledAt) continue;
      if (new Date(campaign.scheduledAt) > now) continue;
      try {
        await sendNewsletterCampaignNow(env, campaign);
      } catch (err) {
        console.log("Errore invio programmato newsletter", campaign.id, err.stack || err.message);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// Manda in background (ctx.waitUntil) invece di far aspettare la richiesta HTTP del pannello fino
// alla fine del loop — con tanti destinatari (~200) l'invio uno per uno con la pausa tra un
// invio e l'altro può durare più della finestra di esecuzione di una richiesta normale, col rischio
// che il Worker venga interrotto PRIMA di salvare lo stato finale della campagna: le email
// partivano comunque (successo lato Resend) ma il pannello restava fermo a "Bozza" per sempre,
// esattamente quello che è successo con l'invio che ha scoperto questo bug. Lo stato "sending" si
// vede subito, il risultato vero arriva quando la lista si ricarica.
async function handleAdminSendNewsletterCampaign(request, env, ctx) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const raw = await env.TICKETS.get(`newslettercampaign:${id}`);
  if (!raw) return jsonResponse({ error: "campagna non trovata" }, 404);
  const campaign = JSON.parse(raw);
  if (campaign.status === "sent" || campaign.status === "sending") return jsonResponse({ error: "già inviata (o invio già in corso)" }, 400);
  if (!campaign.subject || !campaign.bodyHtml) return jsonResponse({ error: "oggetto e testo obbligatori prima di inviare" }, 400);

  // "partial": un invio precedente si è fermato a metà (limite di Resend) — questo pulsante deve
  // riprovare SOLO chi è rimasto in sospeso, mai rifare l'invio completo (rimanderebbe la stessa
  // newsletter anche a chi l'ha già ricevuta).
  const recipients = (campaign.status === "partial" && Array.isArray(campaign.pendingRecipients) && campaign.pendingRecipients.length)
    ? await resolveRecipientsByEmail(env, campaign.pendingRecipients)
    : await resolveCampaignRecipients(env, campaign.targetGroups);

  campaign.status = "sending";
  await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  ctx.waitUntil(sendNewsletterCampaignNow(env, campaign, recipients).catch(function(err){
    console.log("Errore invio newsletter (background)", id, err.stack || err.message);
  }));
  return jsonResponse({ ok: true, started: true, total: recipients.length });
}

// Recupero manuale: manda questa campagna a una lista di email specifiche, indipendentemente
// dallo status (anche se già "sent") — per quando Resend ha fallito degli invii che il sistema non
// aveva ancora modo di tracciare uno per uno (vedi nlsent: aggiunto dopo), e la lista di chi non
// ha ricevuto arriva da fuori (es. il pannello di Resend stesso).
async function handleAdminSendNewsletterCampaignToList(request, env, ctx) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const raw = await env.TICKETS.get(`newslettercampaign:${id}`);
  if (!raw) return jsonResponse({ error: "campagna non trovata" }, 404);
  const campaign = JSON.parse(raw);
  if (!campaign.subject || !campaign.bodyHtml) return jsonResponse({ error: "questa campagna non ha ancora oggetto/testo" }, 400);
  const emails = Array.isArray(body.emails) ? body.emails.filter(function(e){ return isValidEmail(e); }).slice(0, 500) : [];
  if (!emails.length) return jsonResponse({ error: "nessuna email valida nella lista" }, 400);
  const recipients = await resolveRecipientsByEmail(env, emails);
  if (!recipients.length) return jsonResponse({ error: "nessuno di questi indirizzi risulta iscritto con consenso attivo" }, 400);
  // In background per lo stesso motivo del pulsante "Invia adesso" — vedi handleAdminSendNewsletterCampaign.
  // sendNewsletterCampaignNow calcola già status/pendingRecipients/salvataggio in base a QUESTO
  // tentativo (chi di questa lista è passato, chi no) quando finisce.
  ctx.waitUntil(sendNewsletterCampaignNow(env, campaign, recipients).catch(function(err){
    console.log("Errore invio newsletter a lista (background)", id, err.stack || err.message);
  }));
  return jsonResponse({ ok: true, started: true, requested: emails.length, matched: recipients.length });
}

// Riparazione manuale: una campagna può restare bloccata su "Bozza" (o "sending") anche se le
// email sono già davvero partite — succedeva quando il Worker veniva interrotto per timeout PRIMA
// di salvare lo stato finale (il bug che ha causato tutto questo: vedi handleAdminSendNewsletterCampaign
// più sopra, ora corretto). Segna solo lo stato, non manda nessuna email — usato quando l'admin ha
// già la conferma altrove (es. il pannello di Resend) che è stata inviata davvero.
async function handleAdminMarkNewsletterCampaignSent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const raw = await env.TICKETS.get(`newslettercampaign:${id}`);
  if (!raw) return jsonResponse({ error: "campagna non trovata" }, 404);
  const campaign = JSON.parse(raw);
  campaign.status = "sent";
  campaign.sentAt = campaign.sentAt || new Date().toISOString();
  campaign.scheduledAt = null;
  await env.TICKETS.put(`newslettercampaign:${id}`, JSON.stringify(campaign));
  return jsonResponse({ ok: true, campaign });
}

// Confronta chi DOVEVA ricevere questa campagna (risolto dai targetGroups salvati, come per un
// invio vero) con una lista di email già consegnate (incollata da fuori, es. l'export "Delivered"
// di Resend) — utile per gli invii precedenti a nlsent: quando il sistema non teneva ancora questo
// dato da solo. Il risultato (chi manca) è pensato per essere incollato direttamente in "Invia a
// lista".
async function handleAdminNewsletterMissingRecipients(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const raw = await env.TICKETS.get(`newslettercampaign:${id}`);
  if (!raw) return jsonResponse({ error: "campagna non trovata" }, 404);
  const campaign = JSON.parse(raw);
  const delivered = new Set(
    (Array.isArray(body.delivered) ? body.delivered : [])
      .map(function(e){ return String(e || "").trim().toLowerCase(); })
      .filter(Boolean)
  );
  const recipients = await resolveCampaignRecipients(env, campaign.targetGroups);
  const missing = recipients.filter(function(r){ return !delivered.has(r.email); }).map(function(r){ return r.email; });
  return jsonResponse({ ok: true, total: recipients.length, deliveredCount: delivered.size, missing });
}

// Pixel 1x1 trasparente (GIF più corto possibile in base64) — ogni apertura reale carica questa
// immagine, l'endpoint conta solo la PRIMA apertura per coppia campagna/iscritto (stesso
// principio "unique opens" degli altri tool di email marketing, non un contatore grezzo di hit).
const TRACKING_PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), function(c){ return c.charCodeAt(0); });

async function handleNewsletterTrackOpen(request, env) {
  const pixelResponse = function(){
    return new Response(TRACKING_PIXEL_GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" } });
  };
  if (!env.TICKETS) return pixelResponse();
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("c");
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  if (!campaignId || !isValidEmail(email)) return pixelResponse();
  try {
    const subRaw = await env.TICKETS.get(`subscriber:${email}`);
    if (subRaw) {
      const sub = JSON.parse(subRaw);
      const openedKey = `nlopen:${campaignId}:${email}`;
      const alreadyOpened = await env.TICKETS.get(openedKey);
      if (!alreadyOpened) {
        await env.TICKETS.put(openedKey, "1");
        sub.stats = sub.stats || { sent: 0, opens: 0, clicks: 0 };
        sub.stats.opens++;
        await env.TICKETS.put(`subscriber:${email}`, JSON.stringify(sub));
        const campRaw = await env.TICKETS.get(`newslettercampaign:${campaignId}`);
        if (campRaw) {
          const camp = JSON.parse(campRaw);
          camp.openCount = (camp.openCount || 0) + 1;
          await env.TICKETS.put(`newslettercampaign:${campaignId}`, JSON.stringify(camp));
        }
      }
    }
  } catch (e) { /* il pixel deve comunque tornare, mai bloccare l'apertura dell'email */ }
  return pixelResponse();
}

async function handleNewsletterTrackClick(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url") || "/";
  if (!env.TICKETS) return Response.redirect(target, 302);
  const campaignId = url.searchParams.get("c");
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  try {
    if (campaignId && isValidEmail(email)) {
      const subRaw = await env.TICKETS.get(`subscriber:${email}`);
      if (subRaw) {
        const sub = JSON.parse(subRaw);
        sub.stats = sub.stats || { sent: 0, opens: 0, clicks: 0 };
        sub.stats.clicks++;
        await env.TICKETS.put(`subscriber:${email}`, JSON.stringify(sub));
      }
      const campRaw = await env.TICKETS.get(`newslettercampaign:${campaignId}`);
      if (campRaw) {
        const camp = JSON.parse(campRaw);
        camp.clickCount = (camp.clickCount || 0) + 1;
        await env.TICKETS.put(`newslettercampaign:${campaignId}`, JSON.stringify(camp));
      }
    }
  } catch (e) { /* il redirect deve comunque avvenire, mai bloccare il click */ }
  return Response.redirect(target, 302);
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

  if (!await getEvent(env, eventSlug)) return jsonResponse({ error: "evento non valido" }, 400);
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

  // Segmentazione (gruppo dell'evento) sempre, consenso marketing solo se ha spuntato la
  // casella — vedi upsertSubscriber più sopra sul perché sono tenuti separati.
  await upsertSubscriber(env, { email, name, eventSlug, newsletterOptin, source: "ticket-checkout" });

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

  const found = await findTierOption(env, registration.eventSlug, tierId, optionId);
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

  // La maggiorazione commissione Stripe si applica qui, all'ultimo momento prima di addebitare:
  // cosi' l'importo pagato è sempre coerente con quello mostrato sul sito (stessa addStripeFee()
  // usata da handleEventTiers) e un coupon (priceCents 0) non genera mai nessuna commissione.
  const { grossCents } = addStripeFee(priceCents);

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
        unit_amount: grossCents,
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
      const found = await findTierOption(env, eventSlug, tierId, optionId);
      const eventInfo = found?.event || await getEvent(env, eventSlug);

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
        stripeSessionId: session.id,
        source: "stripe"
      }), { metadata: { used: false, eventSlug, tierId, email, eventName, eventDateIso, tierName, source: "stripe" } });

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

// Password provvisoria per account creati alla porta (vendita in loco + loyalty card): alfabeto
// senza caratteri ambigui (0/O, 1/l/I) così è leggibile se qualcuno la deve ridettare a voce,
// 10 caratteri casuali via Web Crypto — sopra il minimo di 8 richiesto da handleAccountRegister.
function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

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

// ============================================================================
// Account aziendale (sezione staff con dati sensibili — presenti/feedback): login vero con
// mail @growmi.it + password, separato dagli account cliente (account:<email>) e dalla chiave
// staff condivisa dello scanner (quella resta invariata per staff-checkin.html). Stessi
// meccanismi di sicurezza già collaudati per gli account cliente (PBKDF2, sessione via cookie
// httpOnly, verifica email), solo prefissi/cookie diversi per tenerli separati.
// ============================================================================

const STAFF_EMAIL_DOMAIN = "@growmi.it";

function staffSessionCookieHeader(token, maxAgeSeconds) {
  return `growmi_staff_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
function clearStaffSessionCookieHeader() {
  return "growmi_staff_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}
async function getStaffSessionEmail(request, env) {
  const cookies = parseCookies(request);
  const token = cookies["growmi_staff_session"];
  if (!token) return null;
  const raw = await env.TICKETS.get(`staffsession:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (new Date(session.expiresAt) < new Date()) {
    await env.TICKETS.delete(`staffsession:${token}`);
    return null;
  }
  return session.email;
}
// Usata da ogni endpoint della sezione aziendale al posto del controllo "X-Staff-Key": richiede
// una sessione valida invece di una password condivisa, restituisce l'email o una risposta 401
// pronta da ritornare subito.
async function requireStaffAccount(request, env) {
  const email = await getStaffSessionEmail(request, env);
  if (!email) return { error: jsonResponse({ error: "non autenticato" }, 401) };
  return { email };
}

async function handleStaffAccountRegister(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 200);

  if (!email.endsWith(STAFF_EMAIL_DOMAIN)) {
    return jsonResponse({ error: `serve una mail ${STAFF_EMAIL_DOMAIN}` }, 400);
  }
  if (!name) return jsonResponse({ error: "il nome è obbligatorio" }, 400);
  if (password.length < 8) return jsonResponse({ error: "la password deve avere almeno 8 caratteri" }, 400);
  if (await env.TICKETS.get(`staffaccount:${email}`)) {
    return jsonResponse({ error: "esiste già un account con questa email" }, 409);
  }

  const salt = crypto.randomUUID();
  const passwordHash = await hashPassword(password, salt);
  const verifyToken = crypto.randomUUID();

  await env.TICKETS.put(`staffaccount:${email}`, JSON.stringify({
    email, name, passwordHash, salt, emailVerified: false, verifyToken,
    createdAt: new Date().toISOString()
  }));

  const origin = new URL(request.url).origin;
  const verifyUrl = `${origin}/api/staff-account/verify?token=${verifyToken}`;
  await sendAccountEmail(env, {
    to: email,
    subject: "Conferma il tuo account aziendale — GrowMi",
    html: buildAccountEmailHTML({
      title: `Ciao ${name.split(" ")[0] || ""}!`,
      lead: "Conferma la tua email per attivare l'accesso alla sezione aziendale di GrowMi.",
      buttonLabel: "Conferma email",
      buttonUrl: verifyUrl
    })
  });

  return jsonResponse({ ok: true, message: "Controlla la tua email per confermare l'account." });
}

async function handleStaffAccountVerify(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response(accountStatusPageHTML("Link non valido", "Manca il codice di conferma."), { headers: { "Content-Type": "text/html" }, status: 400 });
  }

  let cursor = undefined;
  let found = null;
  do {
    const page = await env.TICKETS.list({ prefix: "staffaccount:", cursor });
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

  return new Response(accountStatusPageHTML("Email confermata!", "Il tuo account aziendale è attivo. Ora puoi accedere alla sezione aziendale."), { headers: { "Content-Type": "text/html" } });
}

async function handleStaffAccountLogin(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return jsonResponse({ error: "email e password sono obbligatorie" }, 400);

  const raw = await env.TICKETS.get(`staffaccount:${email}`);
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
  await env.TICKETS.put(`staffsession:${token}`, JSON.stringify({ email, expiresAt }));

  return new Response(JSON.stringify({ ok: true, name: account.name, email }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": staffSessionCookieHeader(token, 30 * 24 * 60 * 60) }
  });
}

async function handleStaffAccountLogout(request, env) {
  const cookies = parseCookies(request);
  const token = cookies["growmi_staff_session"];
  if (token) await env.TICKETS.delete(`staffsession:${token}`);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearStaffSessionCookieHeader() }
  });
}

async function handleStaffAccountMe(request, env) {
  const email = await getStaffSessionEmail(request, env);
  if (!email) return jsonResponse({ error: "non autenticato" }, 401);
  const raw = await env.TICKETS.get(`staffaccount:${email}`);
  if (!raw) return jsonResponse({ error: "account non trovato" }, 404);
  const account = JSON.parse(raw);
  return jsonResponse({ email: account.email, name: account.name });
}

// Numeri chiave per la dashboard aziendale: incasso, biglietti, account/newsletter, feedback.
// Un solo giro di KV.list per ogni prefisso invece di più chiamate separate dal frontend.
async function handleDashboardStats(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  // ?event=<slug> facoltativo: se presente, tutti i numeri sono ristretti a quell'evento invece
  // che al totale di sempre. "totale" resta il default (nessun parametro) — vedi
  // az-dashboard-event-filter nel pannello.
  const url = new URL(request.url);
  const eventSlug = url.searchParams.get("event") || null;
  const event = eventSlug ? await getEvent(env, eventSlug) : null;

  let ticketsSold = 0, ticketsCheckedIn = 0, revenueCents = 0;
  const revenueBySource = { stripe: 0, walkin: 0 };
  const ticketsBySource = { stripe: 0, walkin: 0 };
  // Email di chi ha almeno un biglietto per l'evento filtrato — serve sotto per ristrettere anche
  // account/newsletter a "chi ha comprato per QUESTO evento" invece che al totale di sempre.
  const emailsInEvent = new Set();
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const t = JSON.parse(raw);
      if (eventSlug && t.eventSlug !== eventSlug) continue;
      const source = t.source === "walkin" ? "walkin" : "stripe";
      ticketsSold++;
      if (t.used) ticketsCheckedIn++;
      revenueCents += Number(t.amountTotal) || 0;
      ticketsBySource[source]++;
      revenueBySource[source] += Number(t.amountTotal) || 0;
      if (t.email) emailsInEvent.add(String(t.email).toLowerCase());
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let accountsTotal = 0, newsletterSubscribers = 0;
  cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "account:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const a = JSON.parse(raw);
      if (eventSlug && !emailsInEvent.has(String(a.email || "").toLowerCase())) continue;
      accountsTotal++;
      if (a.profile?.newsletterOptin) newsletterSubscribers++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let feedbackCount = 0, ratingSum = 0;
  cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "feedback:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const f = JSON.parse(raw);
      // Il feedback è collegato solo per nome evento (vedi feedback.html), non per slug: se lo
      // slug filtrato non risolve a un evento vero, il feedback resta fuori dal filtro.
      if (eventSlug && (!event || f.eventName !== event.name)) continue;
      feedbackCount++;
      ratingSum += Number(f.rating) || 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return jsonResponse({
    eventSlug, eventName: event ? event.name : null,
    revenueCents, ticketsSold, ticketsCheckedIn, revenueBySource, ticketsBySource,
    accountsTotal, newsletterSubscribers,
    feedbackCount, avgRating: feedbackCount ? Math.round((ratingSum / feedbackCount) * 10) / 10 : null
  });
}

// Elenco ricercabile di tutti gli account cliente (loyalty card), con il conteggio timbri di
// ciascuno — pensato per staff-customers.html, non per volumi enormi (va bene per una startup
// alle prime centinaia/migliaia di clienti, oltre valuteremo la paginazione).
async function handleCustomersList(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  // Email -> eventi per cui ha almeno un biglietto (comprato o no ancora usato) — solo dalla
  // metadata dei ticket, senza leggerne il corpo, per poter filtrare il pannello Clienti per
  // evento (una persona può avere biglietti per più eventi diversi).
  const eventsByEmail = new Map();
  let tCursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor: tCursor });
    for (const key of page.keys) {
      const m = key.metadata;
      if (!m?.email || !m.eventSlug) continue;
      const email = String(m.email).toLowerCase();
      if (!eventsByEmail.has(email)) eventsByEmail.set(email, new Map());
      eventsByEmail.get(email).set(m.eventSlug, m.eventName || m.eventSlug);
    }
    tCursor = page.list_complete ? undefined : page.cursor;
  } while (tCursor);

  const customers = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "account:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const a = JSON.parse(raw);
      const loyaltyRaw = await env.TICKETS.get(`loyalty:${a.email}`);
      const loyalty = loyaltyRaw ? JSON.parse(loyaltyRaw) : null;
      const eventsMap = eventsByEmail.get(String(a.email || "").toLowerCase());
      const events = eventsMap ? Array.from(eventsMap, function(entry){ return { slug: entry[0], name: entry[1] }; }) : [];
      customers.push({
        name: a.name, email: a.email, createdAt: a.createdAt,
        customerNumber: a.customerNumber || null,
        physicalCardClaimed: !!a.physicalCardClaimed,
        newsletterOptin: !!a.profile?.newsletterOptin,
        stamps: loyalty?.stamps || 0,
        events: events
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  customers.sort(function(a, b){ return (a.name || "").localeCompare(b.name || ""); });
  return jsonResponse({ customers });
}

async function handleExportCustomers(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const customers = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "account:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const a = JSON.parse(raw);
      const loyaltyRaw = await env.TICKETS.get(`loyalty:${a.email}`);
      const loyalty = loyaltyRaw ? JSON.parse(loyaltyRaw) : null;
      customers.push([
        a.name, a.email, a.createdAt ? new Date(a.createdAt).toLocaleString("it-IT") : "",
        a.customerNumber || "", a.physicalCardClaimed ? "Sì" : "No",
        a.profile?.newsletterOptin ? "Sì" : "No", loyalty?.stamps || 0
      ]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const rows = [["Nome", "Email", "Registrato il", "Numero cliente", "Carta fisica", "Newsletter", "Timbri"]].concat(customers);
  const csv = "﻿" + rows.map(function(row){ return row.map(csvEscape).join(","); }).join("\r\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="growmi-clienti.csv"' }
  });
}

// Trasforma un'etichetta libera in un id sicuro da usare in URL/chiavi KV (minuscolo, solo
// lettere/numeri/trattini) — usato per generare slug evento e id di fascia/opzione quando il
// pannello non ne manda uno esplicito.
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Per ogni fascia/opzione dell'evento, quanti biglietti sono già stati venduti — serve alla
// validazione delle modifiche (handleAdminUpdateEvent): non si può abbassare la capienza sotto i
// biglietti già venduti, né togliere una fascia/opzione che ha già vendite.
async function countSoldByTierOption(env, eventSlug) {
  const byTier = {};
  const byTierOption = {};
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "ticket:", cursor });
    for (const key of page.keys) {
      const m = key.metadata;
      if (m?.eventSlug !== eventSlug || !m.tierId) continue;
      byTier[m.tierId] = (byTier[m.tierId] || 0) + 1;
      if (m.optionId) {
        const k = `${m.tierId}:${m.optionId}`;
        byTierOption[k] = (byTierOption[k] || 0) + 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { byTier, byTierOption };
}

// Valida e normalizza il payload di un evento mandato dal pannello (creazione o modifica).
// existingTiers è l'array di fasce già salvate (null se è una creazione): serve a proteggere id
// di fascia/opzione già usati da biglietti venduti, cosi' una modifica non può mai invalidare
// silenziosamente uno storico di vendita esistente. Ritorna { ok:true, event } oppure
// { ok:false, error }.
function validateEventPayload(body, existingTiers, sold) {
  const name = String(body.name || "").trim().slice(0, 200);
  const dateDisplay = String(body.dateDisplay || "").trim().slice(0, 200);
  const dateIso = String(body.dateIso || "").trim();
  const location = String(body.location || "").trim().slice(0, 200);
  const teaser = String(body.teaser || "").trim().slice(0, 500);

  if (!name) return { ok: false, error: "il nome dell'evento è obbligatorio" };
  if (!dateDisplay) return { ok: false, error: "la data da mostrare (es. \"Giovedì 10 settembre · Apertura 19:00\") è obbligatoria" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || isNaN(new Date(dateIso).getTime())) {
    return { ok: false, error: "data evento non valida (formato AAAA-MM-GG)" };
  }
  if (!location) return { ok: false, error: "il luogo è obbligatorio" };

  const inputTiers = Array.isArray(body.tiers) ? body.tiers : [];
  if (!inputTiers.length) return { ok: false, error: "serve almeno una fascia biglietti" };

  const existingTierIds = new Set((existingTiers || []).map(function(t){ return t.id; }));
  const existingOptionIds = {}; // tierId -> Set(optionId)
  (existingTiers || []).forEach(function(t){
    existingOptionIds[t.id] = new Set(t.options.map(function(o){ return o.id; }));
  });

  const seenTierIds = new Set();
  const tiers = [];
  for (const rawTier of inputTiers) {
    const tierName = String(rawTier.name || "").trim().slice(0, 200);
    if (!tierName) return { ok: false, error: "ogni fascia deve avere un nome" };
    let tierId = String(rawTier.id || "").trim() || slugify(tierName);
    if (!/^[a-z0-9-]+$/.test(tierId)) return { ok: false, error: `id fascia non valido: "${tierId}"` };
    if (seenTierIds.has(tierId)) return { ok: false, error: `id fascia duplicato: "${tierId}"` };
    seenTierIds.add(tierId);

    const capacity = parseInt(rawTier.capacity, 10);
    if (!Number.isInteger(capacity) || capacity < 1) {
      return { ok: false, error: `capienza non valida per la fascia "${tierName}"` };
    }
    const soldForTier = sold.byTier[tierId] || 0;
    if (capacity < soldForTier) {
      return { ok: false, error: `la fascia "${tierName}" ha già ${soldForTier} biglietti venduti: non puoi impostare una capienza inferiore` };
    }

    const inputOptions = Array.isArray(rawTier.options) ? rawTier.options : [];
    if (!inputOptions.length) return { ok: false, error: `la fascia "${tierName}" deve avere almeno un'opzione` };

    const seenOptionIds = new Set();
    const options = [];
    for (const rawOption of inputOptions) {
      const label = String(rawOption.label || "").trim().slice(0, 200);
      if (!label) return { ok: false, error: `ogni opzione della fascia "${tierName}" deve avere un'etichetta` };
      let optionId = String(rawOption.id || "").trim() || slugify(label);
      if (!/^[a-z0-9-]+$/.test(optionId)) return { ok: false, error: `id opzione non valido: "${optionId}"` };
      if (seenOptionIds.has(optionId)) return { ok: false, error: `id opzione duplicato nella fascia "${tierName}": "${optionId}"` };
      seenOptionIds.add(optionId);

      // Prezzo facoltativo: si può pubblicare la pagina con le fasce/opzioni già definite ma senza
      // ancora sapere quanto costeranno — un'opzione senza prezzo resta visibile ma mai vendibile
      // (vedi handleEventTiers) finché non si torna a compilarlo.
      let priceCents = null;
      if (rawOption.priceCents !== null && rawOption.priceCents !== undefined && rawOption.priceCents !== "") {
        priceCents = parseInt(rawOption.priceCents, 10);
        if (!Number.isInteger(priceCents) || priceCents < 0) {
          return { ok: false, error: `prezzo non valido per "${label}" (in centesimi, es. 1200 = 12,00€)` };
        }
      }
      options.push({ id: optionId, label, priceCents });
    }

    // Un'opzione già venduta non può sparire dalla fascia: invaliderebbe i biglietti già emessi
    // con quell'id. Si può rinominare/ricaricare di prezzo, ma non rimuovere.
    if (existingOptionIds[tierId]) {
      for (const oldOptionId of existingOptionIds[tierId]) {
        const soldKey = `${tierId}:${oldOptionId}`;
        if ((sold.byTierOption[soldKey] || 0) > 0 && !seenOptionIds.has(oldOptionId)) {
          return { ok: false, error: `non puoi rimuovere l'opzione "${oldOptionId}" dalla fascia "${tierName}": ha già vendite` };
        }
      }
    }

    // Stato manuale della fascia (facoltativo, default "auto" = comportamento di sempre: esaurita
    // solo quando la capienza è raggiunta, attiva la prima non esaurita in ordine). "soldout" forza
    // "Esaurita" indipendentemente dalla capienza; "comingsoon" la mostra visibile ma non ancora
    // acquistabile (utile prima che i biglietti siano davvero in vendita); "cascade" la tiene
    // visibile-ma-non-acquistabile finché la fascia precedente (in ordine) non risulta esaurita, poi
    // si comporta come "auto" — vedi handleEventTiers.
    const status = ["auto", "soldout", "comingsoon", "cascade"].includes(rawTier.status) ? rawTier.status : "auto";
    // Finestra di vendita facoltativa (solo quando status è "auto"): datetime ISO da un <input
    // type="datetime-local">, validati ma tenuti così come sono (il confronto con "adesso" si fa
    // al momento di servire /api/event-tiers, non qui — un salvataggio fatto oggi deve restare
    // valido anche tra un mese). Stringa vuota/non valida = nessun limite su quel lato.
    const availableFrom = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawTier.availableFrom || "") ? rawTier.availableFrom : null;
    const availableUntil = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawTier.availableUntil || "") ? rawTier.availableUntil : null;
    tiers.push({ id: tierId, name: tierName, sub: String(rawTier.sub || "").trim().slice(0, 200), capacity, options, status, availableFrom, availableUntil });
  }

  // Stessa protezione, a livello di fascia intera: non si può far sparire una fascia che ha già
  // venduto biglietti (capiterebbe rimuovendola dal payload invece di modificarla).
  for (const oldTierId of existingTierIds) {
    if ((sold.byTier[oldTierId] || 0) > 0 && !seenTierIds.has(oldTierId)) {
      return { ok: false, error: `non puoi rimuovere la fascia "${oldTierId}": ha già biglietti venduti` };
    }
  }

  // Opzioni "cosa ti è piaciuto" mostrate come checkbox sul form di feedback pubblico (vedi
  // feedback.html + handleEventTiers) — facoltative: se vuote, il form ricade sul testo libero.
  const inputFeedbackOptions = Array.isArray(body.feedbackOptions) ? body.feedbackOptions : [];
  const seenFeedbackOptions = new Set();
  const feedbackOptions = [];
  for (const raw of inputFeedbackOptions) {
    const label = String(raw || "").trim().slice(0, 150);
    if (!label || seenFeedbackOptions.has(label)) continue;
    seenFeedbackOptions.add(label);
    feedbackOptions.push(label);
    if (feedbackOptions.length >= 15) break;
  }

  // Immagini (chiavi R2, mai URL assolute: si costruiscono con /media/<key> al momento di
  // servirle) e stato di pubblicazione. Un evento senza "published" nel payload nasce bozza —
  // non compare né su /api/public-events né su /evento/<slug> finché lo staff non lo pubblica
  // esplicitamente dal pannello.
  const heroImageKey = String(body.heroImageKey || "").trim() || null;
  const heroPosition = String(body.heroPosition || "center").trim().slice(0, 30);
  const heroZoom = clampImageZoom(body.heroZoom);
  const coverImageKey = String(body.coverImageKey || "").trim() || null;
  const coverPosition = String(body.coverPosition || "center").trim().slice(0, 30);
  const coverZoom = clampImageZoom(body.coverZoom);
  const gallery = Array.isArray(body.gallery)
    ? body.gallery.map(function(k){ return String(k || "").trim(); }).filter(Boolean).slice(0, 40)
    : [];
  const published = body.published === true;

  // Posizione manuale nella griglia pubblica: numero facoltativo, più basso = più in alto/prima
  // (vince sull'ordine per data, ma solo tra chi ce l'ha impostato — gli altri seguono nell'ordine
  // di sempre). Stesso campo/stessa logica degli artisti.
  // Number(null) è 0 (un valore reale, "prima di tutti"), quindi null/undefined/stringa vuota
  // vanno esclusi PRIMA della conversione, non dopo, altrimenti "nessuna posizione" diventerebbe
  // per sbaglio "posizione zero".
  const sortOrder = (body.sortOrder === null || body.sortOrder === undefined || body.sortOrder === "")
    ? null
    : (Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : null);

  // Tema "scuro" opzionale (checkbox nel pannello) + badge advisory + sezioni extra a blocchi
  // (vedi assets/event-tickets.css .ed-dark-* ed eventPageHTML) — stesso concetto del builder a
  // blocchi delle newsletter: contentBlocks viene salvato così com'è (staff già autenticato, stesso
  // livello di fiducia di bodyHtml delle newsletter) e renderizzato lato server a ogni richiesta.
  const darkTheme = body.darkTheme === true;
  const advisoryLabel = String(body.advisoryLabel || "").trim().slice(0, 60);
  const advisorySub = String(body.advisorySub || "").trim().slice(0, 100);
  const doorsTime = String(body.doorsTime || "").trim().slice(0, 30);
  const dressCode = String(body.dressCode || "").trim().slice(0, 60);
  // Colori accento del tema scuro (glitch titolo, bordo hero, orario lineup) — facoltativi,
  // ricadono sul rosso/blu originali se non impostati o non un colore esadecimale valido (mai
  // passare un valore non validato dentro un <style>, anche se qui è solo staff autenticato).
  const isHex = function(v){ return /^#[0-9a-fA-F]{6}$/.test(String(v || "")); };
  const accentColor = isHex(body.accentColor) ? body.accentColor : "";
  const accentColor2 = isHex(body.accentColor2) ? body.accentColor2 : "";
  const bgColor = isHex(body.bgColor) ? body.bgColor : "";
  const leadColor = isHex(body.leadColor) ? body.leadColor : "";
  const ticketBgColor = isHex(body.ticketBgColor) ? body.ticketBgColor : "";
  // Nota facoltativa mostrata al momento del checkout, sotto la scomposizione prezzo — pensata
  // per ripetere lì informazioni già dette altrove in pagina (es. cosa include un'opzione food),
  // proprio quando il cliente sta per pagare. Vuota = resta il testo generico di sempre.
  const checkoutNote = String(body.checkoutNote || "").trim().slice(0, 500);
  // Loghi sponsor: lista libera (come gallery) + stile di visualizzazione. "stickers" li mette
  // come adesivi sulla copertina (le prime 4 posizioni definite in CSS, serve una copertina
  // caricata); "marquee" è una striscia che scorre in loop, indipendente dalla copertina.
  const sponsorLogos = Array.isArray(body.sponsorLogos)
    ? body.sponsorLogos.map(function(k){ return String(k || "").trim(); }).filter(Boolean).slice(0, 12)
    : [];
  const sponsorDisplay = body.sponsorDisplay === "marquee" ? "marquee" : "stickers";
  // Texture di sfondo dell'hero scuro (puntini + strisce diagonali) — attive di default (comportamento
  // di sempre), disattivabili singolarmente. Non hanno effetto se c'è una foto hero caricata (vedi
  // .has-photo in event-tickets.css), contano solo per il fallback senza foto.
  const textureDots = body.textureDots !== false;
  const textureStripes = body.textureStripes !== false;
  const inputBlocks = Array.isArray(body.contentBlocks) ? body.contentBlocks : [];
  const contentBlocks = [];
  for (const raw of inputBlocks) {
    if (contentBlocks.length >= 30) break;
    const type = String((raw && raw.type) || "");
    if (type === "lineup") {
      const name = String(raw.name || "").trim().slice(0, 100);
      if (!name) continue;
      contentBlocks.push({
        type: "lineup",
        role: String(raw.role || "").trim().slice(0, 60),
        name,
        time: String(raw.time || "").trim().slice(0, 100),
        desc: String(raw.desc || "").trim().slice(0, 500),
        photoKey: String(raw.photoKey || "").trim() || null,
        roleColor: isHex(raw.roleColor) ? raw.roleColor : null,
        timeColor: isHex(raw.timeColor) ? raw.timeColor : null
      });
    } else if (type === "heading") {
      const text = String(raw.text || "").trim().slice(0, 200);
      if (text) contentBlocks.push({ type: "heading", text, color: isHex(raw.color) ? raw.color : null });
    } else if (type === "text") {
      // html invece di semplice testo: stessa editor con grassetto/corsivo/sottolineato/link del
      // builder newsletter, salvato così com'è (staff autenticato, stessa fiducia di bodyHtml).
      const html = String(raw.html || "").trim().slice(0, 3000);
      if (html) contentBlocks.push({ type: "text", html, color: isHex(raw.color) ? raw.color : null });
    } else if (type === "image") {
      const key = String(raw.key || "").trim();
      if (!key) continue;
      const width = [100, 50, 33].includes(Number(raw.width)) ? Number(raw.width) : 100;
      contentBlocks.push({ type: "image", key, width });
    } else if (type === "button") {
      const label = String(raw.label || "").trim().slice(0, 60);
      const btnUrl = String(raw.url || "").trim().slice(0, 300);
      if (!label || !btnUrl) continue;
      contentBlocks.push({ type: "button", label, url: btnUrl, color: isHex(raw.color) ? raw.color : null });
    } else if (type === "divider") {
      contentBlocks.push({ type: "divider" });
    } else if (type === "spacer") {
      const height = Number.isFinite(Number(raw.height)) ? Math.min(120, Math.max(8, Number(raw.height))) : 24;
      contentBlocks.push({ type: "spacer", height });
    }
  }

  return { ok: true, event: { name, dateDisplay, dateIso, location, teaser, tiers, feedbackOptions, heroImageKey, heroPosition, heroZoom, coverImageKey, gallery, published, sortOrder, darkTheme, advisoryLabel, advisorySub, doorsTime, dressCode, accentColor, accentColor2, bgColor, leadColor, ticketBgColor, textureDots, textureStripes, contentBlocks, coverPosition, coverZoom, checkoutNote, sponsorLogos, sponsorDisplay } };
}

// image/gif incluso apposta per le newsletter: un GIF animato è l'unico modo che parte da solo e
// va in loop in praticamente ogni client email (un <video> vero viene quasi sempre bloccato) — un
// GIF è comunque solo un'immagine, quindi il blocco "Immagine" del builder lo gestisce già uguale.
const IMAGE_CONTENT_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const VIDEO_CONTENT_TYPES = { "video/mp4": "mp4" };
const MEDIA_CONTENT_TYPES = Object.assign({}, IMAGE_CONTENT_TYPES, VIDEO_CONTENT_TYPES);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Un GIF convertito da uno screen recording può pesare molto più di un video mp4 compresso a
// parità di durata (nessuna vera compressione inter-frame) — tetto alzato per questo.
// 100MB è vicino al limite di richiesta di Cloudflare Workers stesso: oltre, il caricamento
// fallirebbe comunque prima di arrivare qui, un tetto più alto non servirebbe a niente.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
// Namespace di chiavi R2 ammessi per upload/cancellazione da pannello — "events/" e "artists/"
// per contenuti legati a uno slug, "site/" solo per le fixedKey (es. hero di default).
const MEDIA_KEY_PREFIXES = ["events/", "artists/", "pages/"];

// Carica un'immagine su R2 per un evento (hero, copertina o una foto di galleria) — o, con
// fixedKey, sovrascrive sempre la stessa chiave (usato per l'immagine hero di default di tutto
// il sito: cambiando il file dietro la stessa chiave, ogni pagina che la referenzia si aggiorna
// da sola, senza toccare CSS/HTML). Le chiavi generate includono un suffisso casuale così un
// hero/copertina sostituiti non sovrascrivono mai il file vecchio (niente cache stantia sui
// client che l'avevano già scaricato) — il record evento viene semplicemente aggiornato a
// puntare alla chiave nuova, quella vecchia resta orfana su R2 (accettabile, storage economico).
async function handleUploadImage(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.EVENT_IMAGES) throw new Error("Binding R2 'EVENT_IMAGES' non configurato");

  const form = await request.formData();
  const file = form.get("file");
  const purpose = String(form.get("purpose") || "gallery");
  const slug = String(form.get("slug") || "").trim();
  const fixedKey = String(form.get("fixedKey") || "").trim();
  // "events" (default) o "artists" — nessun altro namespace ammesso da qui, vedi MEDIA_KEY_PREFIXES.
  const kind = String(form.get("kind") || "events");

  if (!(file instanceof File)) return jsonResponse({ error: "nessun file ricevuto" }, 400);
  const ext = MEDIA_CONTENT_TYPES[file.type];
  if (!ext) return jsonResponse({ error: "formato non supportato (solo JPEG, PNG, WEBP, GIF, MP4)" }, 400);
  const isVideo = !!VIDEO_CONTENT_TYPES[file.type];
  // Un GIF animato pesa molto più di una foto ferma (è di fatto un video ricompresso) — stesso
  // tetto di un video vero, non quello di un'immagine statica.
  const isAnimatedGif = file.type === "image/gif";
  const maxBytes = (isVideo || isAnimatedGif) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > maxBytes) {
    return jsonResponse({ error: `file troppo grande (max ${Math.round(maxBytes / 1024 / 1024)}MB)` }, 400);
  }

  let key;
  if (fixedKey) {
    if (!/^[a-z0-9/_-]+$/.test(fixedKey)) return jsonResponse({ error: "fixedKey non valida" }, 400);
    key = fixedKey;
  } else {
    if (!slug) return jsonResponse({ error: "slug mancante" }, 400);
    const namespace = ["artists", "pages"].includes(kind) ? kind : "events";
    key = `${namespace}/${slug}/${purpose}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  }

  await env.EVENT_IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return jsonResponse({ ok: true, key, url: `/media/${key}` });
}

// Rimuove un'immagine da R2 — usata quando lo staff toglie un'immagine dalla galleria/hero/
// copertina di un evento prima di risalvare. Ristretto al prefisso "events/" così non si può
// usare per cancellare a caso altre chiavi (es. l'hero di default del sito).
async function handleDeleteImage(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.EVENT_IMAGES) throw new Error("Binding R2 'EVENT_IMAGES' non configurato");

  const { key } = await request.json();
  if (!key || typeof key !== "string" || !MEDIA_KEY_PREFIXES.some(function(p){ return key.startsWith(p); })) {
    return jsonResponse({ error: "chiave non valida" }, 400);
  }
  await env.EVENT_IMAGES.delete(key);
  return jsonResponse({ ok: true });
}

// Serve i file caricati su R2 — pubblico, nessuna autenticazione (sono immagini di eventi
// pubblici). Cache lunga: le chiavi generate da handleUploadImage includono un suffisso
// casuale e non vengono mai sovrascritte, quindi il contenuto dietro una chiave non cambia mai
// (eccetto per le fixedKey come l'hero di default — lì la cache lunga è un compromesso
// accettato: un cambio richiede eventualmente qualche minuto per propagarsi agli edge cache).
async function handleMedia(request, env) {
  if (!env.EVENT_IMAGES) return new Response("Not found", { status: 404 });
  const key = new URL(request.url).pathname.replace(/^\/media\//, "");
  const object = await env.EVENT_IMAGES.get(key);
  if (object) {
    // Le chiavi "site/*" sono a posto fisso e sovrascrivibili in place (es. l'immagine hero di
    // default, ricaricabile in ogni momento dal pannello "Grafica sito"): cache breve, non
    // immutabile — altrimenti un nuovo caricamento non si vedrebbe per fino a un anno. Le chiavi
    // events/artists/pages invece sono sempre nuove a ogni upload, quindi restano davvero immutabili.
    const isFixedSiteAsset = key.startsWith("site/");
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Cache-Control": isFixedSiteAsset ? "public, max-age=300" : "public, max-age=31536000, immutable"
      }
    });
  }
  // Nessuna immagine caricata dal pannello per l'hero di default: si serve quella già presente
  // nel sito come asset statico, così /media/site/default-hero-image funziona da subito, senza
  // bisogno di una migrazione manuale — stesso principio "nessun valore salvato = resta il
  // default" usato in tutto il resto del pannello.
  if (key === "site/default-hero-image") {
    const fallbackUrl = new URL("/assets/img/hero/default-hero.jpg", request.url);
    const fallbackRes = await env.ASSETS.fetch(new Request(fallbackUrl, request));
    if (fallbackRes.ok) {
      return new Response(fallbackRes.body, {
        headers: {
          "Content-Type": fallbackRes.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "public, max-age=300"
        }
      });
    }
  }
  return new Response("Not found", { status: 404 });
}

// Elenco completo eventi per il pannello aziendale (dettaglio pieno, non solo nome/data come
// /api/events-list che serve solo lo scanner) — include quanti biglietti sono già venduti per
// fascia, cosi' l'interfaccia può disabilitare/spiegare i campi non più modificabili.
async function handleAdminListEvents(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const slugs = await listAllEventSlugs(env);
  const events = [];
  for (const slug of slugs) {
    const event = await getEvent(env, slug);
    if (!event) continue;
    const sold = await countSoldByTierOption(env, slug);
    events.push({ slug, ...event, soldByTier: sold.byTier });
  }
  events.sort(function(a, b){ return a.dateIso < b.dateIso ? -1 : 1; });
  return jsonResponse({ events });
}

// Crea un evento nuovo: genera lo slug da nome+data (con suffisso numerico se già esistente) e
// salva direttamente in KV — da quel momento ha sempre la precedenza su DEFAULT_EVENTS (che tanto
// non lo conosce nemmeno). Nessun biglietto può esisterci già, quindi validazione senza vincoli
// di "vendite pregresse" (sold sempre a zero).
async function handleAdminCreateEvent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const validated = validateEventPayload(body, null, { byTier: {}, byTierOption: {} });
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);

  const dateIso = validated.event.dateIso;
  let baseSlug = slugify(body.slug || `${validated.event.name}-${dateIso}`);
  if (!baseSlug) baseSlug = `evento-${dateIso}`;
  let slug = baseSlug;
  let suffix = 2;
  while (await getEvent(env, slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }

  await env.TICKETS.put(`event:${slug}`, JSON.stringify(validated.event));
  await autoCreateDraftCampaignForEvent(env, slug, validated.event);
  return jsonResponse({ ok: true, slug, event: validated.event });
}

// Modifica un evento esistente (di serie o già creato dal pannello): la validazione blocca
// qualunque cambio che invaliderebbe biglietti già venduti (vedi validateEventPayload). Lo slug
// non cambia mai qui — rinominare l'evento vuol dire cambiare il campo "name", non l'URL/slug.
async function handleAdminUpdateEvent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const slug = String(body.slug || "").trim();
  const existing = slug ? await getEvent(env, slug) : null;
  if (!existing) return jsonResponse({ error: "evento non trovato" }, 404);

  const sold = await countSoldByTierOption(env, slug);
  const validated = validateEventPayload(body, existing.tiers, sold);
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);

  await env.TICKETS.put(`event:${slug}`, JSON.stringify(validated.event));
  return jsonResponse({ ok: true, slug, event: validated.event });
}

// Renderizza l'HTML della pagina evento dallo stato corrente del form del pannello, senza mai
// scrivere su KV — usato dal pulsante "Preview" per vedere le modifiche non ancora salvate.
// Nessun controllo sui biglietti già venduti (non stiamo scrivendo nulla, non serve). Con lo
// slug di un evento già esistente, il widget biglietti lato client fa comunque la sua normale
// fetch a /api/event-tiers e mostra i dati REALMENTE salvati (capienza/venduti) — solo il resto
// della pagina (testi, tema, blocchi, colori) riflette lo stato non salvato del form.
async function handleAdminPreviewEvent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;

  const body = await request.json();
  const validated = validateEventPayload(body, null, { byTier: {}, byTierOption: {} });
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);

  const slug = String(body.slug || "").trim() || "anteprima";
  const html = eventPageHTML(validated.event, slug);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================================================
// Artisti: stesso pattern degli eventi — record KV (prefisso "artist:"), immagini/video su R2
// (stesso bucket EVENT_IMAGES, namespace di chiavi "artists/<slug>/..."), pagina pubblica
// generata al volo su /artista/<slug>, gate "published" identico a isEventPublished().
// ============================================================================

async function getArtist(env, slug) {
  const raw = await env.TICKETS.get(`artist:${slug}`);
  return raw ? JSON.parse(raw) : null;
}

async function listAllArtistSlugs(env) {
  const slugs = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "artist:", cursor });
    for (const key of page.keys) slugs.push(key.name.slice("artist:".length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return slugs;
}

function isArtistPublished(artist) {
  return artist.published !== false;
}

// bio/media sono a blocchi liberi (aggiungi/rimuovi/riordina dal pannello) invece che campi
// fissi: le 9 pagine artista esistenti hanno tutte una struttura diversa (chi ha 1 clip, chi 3,
// chi mischia video e foto), un numero fisso di campi non ci sarebbe mai stato bene.
// Zoom dell'inquadratura di una foto: 1 = adattata come sempre (object-fit:cover), più alto =
// più ravvicinata. Clampato a un intervallo ragionevole così un valore corrotto/inatteso dal
// client non produce mai un ingrandimento assurdo in pagina.
function clampImageZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, n));
}

// CSS inline per "sposta/ingrandisci" su un <img> con object-fit:cover: object-position sposta
// l'inquadratura dentro il riquadro (già usato prima di avere lo zoom), transform:scale ingrandisce
// mantenendo l'immagine ritagliata dal riquadro. zoom=1 non aggiunge transform, così un'immagine
// mai toccata resta identica a prima (nessuna regressione visiva).
function photoFramingStyle(position, zoom) {
  const z = clampImageZoom(zoom);
  const pos = `object-position:${position || "center"};`;
  return z > 1 ? `${pos} transform:scale(${z});` : pos;
}

function validateArtistPayload(body) {
  const name = String(body.name || "").trim().slice(0, 200);
  const role = String(body.role || "").trim().slice(0, 100);
  if (!name) return { ok: false, error: "il nome è obbligatorio" };
  if (!role) return { ok: false, error: "il ruolo (es. \"DJ\", \"Cantante\") è obbligatorio" };

  const cardImageKey = String(body.cardImageKey || "").trim() || null;
  const cardImagePosition = String(body.cardImagePosition || "center").trim().slice(0, 30);
  const cardImageZoom = clampImageZoom(body.cardImageZoom);

  const heroType = ["video", "image", "none"].includes(body.heroType) ? body.heroType : "none";
  const heroKey = heroType === "none" ? null : (String(body.heroKey || "").trim() || null);
  const heroPosition = String(body.heroPosition || "center").trim().slice(0, 30);
  const heroZoom = clampImageZoom(body.heroZoom);

  const bio = Array.isArray(body.bio)
    ? body.bio.map(function(p){ return String(p || "").trim().slice(0, 4000); }).filter(Boolean).slice(0, 20)
    : [];

  const inputMedia = Array.isArray(body.media) ? body.media : [];
  const media = [];
  for (const raw of inputMedia) {
    const type = raw && raw.type === "video" ? "video" : "image";
    const key = raw && String(raw.key || "").trim();
    if (!key) continue;
    media.push({
      type, key,
      position: String((raw && raw.position) || "center").trim().slice(0, 30),
      zoom: clampImageZoom(raw && raw.zoom)
    });
    if (media.length >= 20) break;
  }

  const published = body.published === true;

  // Posizione manuale nella griglia pubblica: numero facoltativo, più basso = più in alto/prima.
  // Chi non ne ha uno segue semplicemente dopo quelli ordinati, nell'ordine di sempre — non serve
  // assegnarlo a tutti gli artisti per usarlo su un paio.
  // Number(null) è 0 (un valore reale, "prima di tutti"), quindi null/undefined/stringa vuota
  // vanno esclusi PRIMA della conversione, non dopo, altrimenti "nessuna posizione" diventerebbe
  // per sbaglio "posizione zero".
  const sortOrder = (body.sortOrder === null || body.sortOrder === undefined || body.sortOrder === "")
    ? null
    : (Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : null);

  return { ok: true, artist: { name, role, cardImageKey, cardImagePosition, cardImageZoom, heroType, heroKey, heroPosition, heroZoom, bio, media, published, sortOrder } };
}

async function handleAdminListArtists(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const slugs = await listAllArtistSlugs(env);
  const artists = [];
  for (const slug of slugs) {
    const artist = await getArtist(env, slug);
    if (artist) artists.push({ slug, ...artist });
  }
  artists.sort(function(a, b){ return a.name.localeCompare(b.name); });
  return jsonResponse({ artists });
}

async function handleAdminCreateArtist(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const validated = validateArtistPayload(body);
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);

  let baseSlug = slugify(body.slug || validated.artist.name);
  if (!baseSlug) baseSlug = "artista";
  let slug = baseSlug;
  let suffix = 2;
  while (await getArtist(env, slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }

  await env.TICKETS.put(`artist:${slug}`, JSON.stringify(validated.artist));
  return jsonResponse({ ok: true, slug, artist: validated.artist });
}

async function handleAdminUpdateArtist(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");

  const body = await request.json();
  const slug = String(body.slug || "").trim();
  const existing = slug ? await getArtist(env, slug) : null;
  if (!existing) return jsonResponse({ error: "artista non trovato" }, 404);

  const validated = validateArtistPayload(body);
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);

  await env.TICKETS.put(`artist:${slug}`, JSON.stringify(validated.artist));
  return jsonResponse({ ok: true, slug, artist: validated.artist });
}

// Elenco pubblico per la griglia in artisti.html — solo i campi che servono a una card.
async function handlePublicArtists(request, env) {
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const slugs = await listAllArtistSlugs(env);
  const artists = [];
  for (const slug of slugs) {
    const artist = await getArtist(env, slug);
    if (!artist || !isArtistPublished(artist)) continue;
    artists.push({
      slug, name: artist.name, role: artist.role,
      cardImageUrl: mediaUrl(artist.cardImageKey), cardImagePosition: artist.cardImagePosition,
      cardImageZoom: typeof artist.cardImageZoom === "number" ? artist.cardImageZoom : 1,
      sortOrder: typeof artist.sortOrder === "number" ? artist.sortOrder : null,
      pageUrl: `/artista/${slug}`
    });
  }
  // Chi ha una posizione manuale va prima, in quell'ordine; il resto segue in ordine alfabetico
  // (comportamento di sempre, prima che esistesse questo campo).
  artists.sort(function(a, b){
    const oa = a.sortOrder === null ? Infinity : a.sortOrder;
    const ob = b.sortOrder === null ? Infinity : b.sortOrder;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
  return jsonResponse({ artists });
}

function artistPageHTML(artist, slug) {
  const heroInner = artist.heroType === "video"
    ? `<video class="ed-hero-video" autoplay muted loop playsinline><source src="${mediaUrl(artist.heroKey)}" type="video/mp4"></video><div class="ed-hero-video-overlay"></div>`
    : artist.heroType === "image"
      ? `<img class="ed-hero-photo" src="${mediaUrl(artist.heroKey)}" alt="" style="${photoFramingStyle(artist.heroPosition, artist.heroZoom)}"><div class="ed-hero-video-overlay"></div>`
      : "";
  const bioHTML = artist.bio.map(function(p){
    return `<p style="font-size:16.5px; margin-bottom:20px;">${p}</p>`;
  }).join("");
  const mediaHTML = artist.media.map(function(m){
    return m.type === "video"
      ? `<video controls playsinline style="width:100%; border-radius:14px; display:block; background:#000; margin-bottom:14px;"><source src="${mediaUrl(m.key)}" type="video/mp4"></video>`
      : `<img src="${mediaUrl(m.key)}" alt="${artist.name}" style="width:100%; border-radius:14px; display:block; margin-bottom:14px; object-position:${m.position};">`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${artist.name} — Artisti GrowMi</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
<link rel="stylesheet" href="/assets/mailerlite-form.css">
<link rel="stylesheet" href="/assets/redesign.css">
<link rel="stylesheet" href="/assets/interactive.css">
</head>
<body>

<header>
  <nav class="wrap">
    <a class="logo" href="/index.html"><img src="/assets/img/logo-growmi.png" alt="GrowMi"></a>
    <div class="navlinks">
      <a href="/index.html" data-i18n="nav_home">Home</a>
      <a href="/eventi.html" data-i18n="nav_eventi">Eventi</a>
      <a href="/artisti.html" class="active" data-i18n="nav_artisti">Artisti</a>
      <a href="/loyalty-card.html" data-i18n="nav_loyalty">Loyalty Card</a>
      <a href="/chi-siamo.html" data-i18n="nav_chisiamo">Chi siamo</a>
      <a href="/contatti.html" data-i18n="nav_contatti">Contatti</a>
      <div class="lang-switch mobile-lang-switch">
        <button data-lang="it">IT</button>
        <button data-lang="en">EN</button>
      </div>
    </div>
    <div class="navright">
      <div class="nav-account-wrap">
        <a class="nav-account" href="/area-personale.html" data-i18n="nav_account">Accedi</a>
        <button type="button" class="nav-account-icon" aria-label="Il mio account" aria-haspopup="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
        </button>
        <div class="nav-account-menu"></div>
      </div>
      <div class="lang-switch">
        <button data-lang="it">IT</button>
        <button data-lang="en">EN</button>
      </div>
      <div class="nav-tickets"><a class="btn coral small nav-tickets-toggle" href="/eventi.html" data-i18n="nav_cta" aria-haspopup="true" aria-expanded="false">Biglietti</a><div class="nav-tickets-menu"></div></div>
    </div>
    <button type="button" class="nav-toggle" aria-label="Menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </nav>
</header>

<section class="ed-hero" style="padding:110px 0 80px; position:relative; overflow:hidden;">
  ${heroInner}
  <div class="wrap ed-wrap">
    <span class="ed-eyebrow">Artista GrowMi</span>
    <h1 style="font-size:clamp(36px,6vw,76px);">${artist.name}</h1>
    <p class="ed-lead">${artist.role}</p>
  </div>
</section>

<section class="ed-section-tight">
  <div class="wrap" style="max-width:980px;">
    ${artist.cardImageKey ? `<div class="ed-card-media" style="aspect-ratio:16/10; margin-bottom:32px;"><img src="${mediaUrl(artist.cardImageKey)}" alt="${artist.name}" style="${photoFramingStyle(artist.cardImagePosition, artist.cardImageZoom)}"></div>` : ""}
    <div style="display:flex; gap:44px; flex-wrap:wrap; align-items:flex-start;">
      <div style="flex:1 1 380px; min-width:280px;">${bioHTML}</div>
      <div style="flex:1 1 340px; min-width:260px; max-width:480px;">${mediaHTML}</div>
    </div>
  </div>
</section>

<section class="ed-cta compact">
  <div class="wrap ed-cta-row">
    <div>
      <p class="ed-eyebrow" data-i18n="nl_eyebrow">Newsletter</p>
      <h2 data-i18n="nl_title">Non perderti i prossimi eventi</h2>
      <p data-i18n="nl_lead">Iscriviti alla newsletter di GrowMi: eventi, artisti e novità via email, senza spam.</p>
    </div>
    <button type="button" class="ed-btn-ghost" data-nl-open data-i18n="nl_submit">Iscrivimi</button>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div><a class="foot-logo" href="/index.html"><img src="/assets/img/logo-growmi.png" alt="GrowMi"></a></div>
      <div>
        <h4 data-i18n="foot_sito">Sito</h4>
        <ul>
          <li><a href="/eventi.html" data-i18n="nav_eventi">Eventi</a></li>
          <li><a href="/artisti.html" data-i18n="nav_artisti">Artisti</a></li>
          <li><a href="/chi-siamo.html" data-i18n="nav_chisiamo">Chi siamo</a></li>
          <li><a href="/loyalty-card.html">Loyalty Card</a></li>
        </ul>
      </div>
      <div>
        <h4 data-i18n="foot_contatti">Contatti</h4>
        <ul>
          <li><a href="mailto:grow.mi@outlook.it">grow.mi@outlook.it</a></li>
          <li><a href="/contatti.html" data-i18n="nav_contatti">Contatti</a></li>
        </ul>
      </div>
      <div>
        <h4 data-i18n="foot_social">Social</h4>
        <ul>
          <li><a href="https://www.instagram.com/growmiii/" target="_blank" rel="noopener">Instagram</a></li>
          <li><a href="https://www.tiktok.com/@growmii_" target="_blank" rel="noopener">TikTok</a></li>
          <li><a href="https://www.youtube.com/@GrowMiii" target="_blank" rel="noopener">YouTube</a></li>
          <li><a href="https://www.linkedin.com/company/growmiagency/" target="_blank" rel="noopener">LinkedIn</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-bottom">
      <span data-i18n="foot_rights">© 2026 GrowMi. Milano.</span>
      <span data-i18n="foot_madewith">Sito in fase di sviluppo</span>
      <a href="/privacy-policy.html" style="color:#B39DC7;">Privacy Policy</a>
    </div>
  </div>
</footer>

<div class="nl-popup" id="nl-popup" hidden>
  <div class="nl-popup-backdrop" data-nl-close></div>
  <div class="nl-popup-card" role="dialog" aria-modal="true">
    <button type="button" class="nl-popup-close" data-nl-close aria-label="Chiudi">&times;</button>
    <p class="eyebrow" data-i18n="nl_eyebrow">Newsletter</p>
    <h4 data-i18n="nl_title">Non perderti i prossimi eventi</h4>
    <p data-i18n="nl_lead">Iscriviti alla newsletter di GrowMi: eventi, artisti e novità via email, senza spam.</p>
    <div class="field"><input type="email" class="nl-email" placeholder="La tua email"></div>
    <button type="button" class="btn coral nl-submit" data-i18n="nl_submit">Iscrivimi</button>
    <p class="nl-fine" data-i18n="nl_fine">Puoi disiscriverti quando vuoi. Per maggiori dettagli, consulta la nostra Privacy Policy.</p>
  </div>
</div>

<script src="/assets/events-data.js"></script>
<script src="/assets/i18n.js"></script>
<script src="/assets/cookie-banner.js"></script>
<script src="/assets/newsletter.js"></script>
<script src="/assets/interactive.js"></script>
</body>
</html>`;
}

async function handleArtistPage(request, env) {
  if (!env.TICKETS) return null;
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/artista\//, "").replace(/\/$/, "");
  if (!slug) return null;
  const artist = await getArtist(env, slug);
  if (!artist) return null;
  if (!isArtistPublished(artist)) {
    // Stesso principio della preview eventi (vedi handleEventPage) — bozza visibile solo allo
    // staff loggato dall'anteprima del pannello, mai a un visitatore qualsiasi.
    if (!url.searchParams.has("_preview")) return null;
    const auth = await requireStaffAccount(request, env);
    if (auth.error) return null;
  }
  return new Response(artistPageHTML(artist, slug), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================================================
// Pagine fisse (home, e in futuro chi-siamo/contatti/carta-fedeltà): a differenza di eventi/
// artisti (liste di elementi ripetibili con un template generato da zero) queste sono pagine
// uniche disegnate su misura — riscriverle da zero rischierebbe di rompere elementi come il
// triangolo SVG della home. Invece si usa HTMLRewriter per sovrascrivere solo i nodi marcati
// con data-cms="<chiave>" (testo) o data-cms-src="<chiave>" (src immagine) dentro l'HTML
// statico esistente — se una chiave non ha un valore salvato, il nodo resta quello di sempre.
// ============================================================================

async function getPageContent(env, page) {
  const raw = await env.TICKETS.get(`page:${page}`);
  return raw ? JSON.parse(raw) : { fields: {}, extraSections: [] };
}

// fields è una mappa libera chiave->stringa (i nomi delle chiavi li definisce il markup della
// pagina coi suoi data-cms, non serve un elenco fisso lato server) — solo dimensione e conteggio
// sono limitati, nessuna whitelist di chiavi: è comunque dietro login staff, e chiavi non
// riconosciute da nessun data-cms nella pagina semplicemente non hanno effetto.
function validatePageContentPayload(body) {
  const inputFields = body.fields && typeof body.fields === "object" ? body.fields : {};
  const fields = {};
  let count = 0;
  for (const k of Object.keys(inputFields)) {
    if (count >= 60) break;
    const key = String(k).slice(0, 80);
    const value = String(inputFields[k] || "").slice(0, 4000);
    if (value) fields[key] = value;
    count++;
  }

  const inputSections = Array.isArray(body.extraSections) ? body.extraSections : [];
  const extraSections = [];
  for (const raw of inputSections) {
    const type = raw && raw.type === "image" ? "image" : "text";
    if (type === "text") {
      const title = String((raw && raw.title) || "").trim().slice(0, 200);
      const body_ = String((raw && raw.body) || "").trim().slice(0, 4000);
      if (!title && !body_) continue;
      extraSections.push({ type, title, body: body_ });
    } else {
      const key = raw && String(raw.key || "").trim();
      if (!key) continue;
      extraSections.push({ type, key, caption: String((raw && raw.caption) || "").trim().slice(0, 200) });
    }
    if (extraSections.length >= 20) break;
  }

  // "founders" (usato oggi solo da chi-siamo, "Fondatori"): array facoltativo — assente/undefined
  // vuol dire "non ancora personalizzato, mostra i due fondatori statici della pagina", un
  // array vuoto invece vuol dire esplicitamente "nessun fondatore da mostrare" (staff l'ha
  // svuotato apposta). Stessa logica di generalità di extraSections: qualunque pagina futura
  // con una lista di persone (es. carta fedeltà?) può riusarlo senza modifiche qui.
  let founders;
  if (Array.isArray(body.founders)) {
    founders = [];
    for (const raw of body.founders) {
      const name = String((raw && raw.name) || "").trim().slice(0, 200);
      if (!name) continue;
      founders.push({
        name,
        role: String((raw && raw.role) || "").trim().slice(0, 200),
        photoKey: (raw && String(raw.photoKey || "").trim()) || null,
        photoPosition: String((raw && raw.photoPosition) || "center").trim().slice(0, 30),
        photoZoom: clampImageZoom(raw && raw.photoZoom)
      });
      if (founders.length >= 12) break;
    }
  }

  // "heroSlides" (usato oggi solo dalla home): foto aggiuntive per la slideshow dell'hero, oltre
  // alle 3 di sempre — mai una sostituzione, solo aggiunte in coda. Assente/undefined o array
  // vuoto hanno lo stesso effetto (nessuna foto extra), quindi qui non serve la stessa distinzione
  // fatta per "founders".
  let heroSlides;
  if (Array.isArray(body.heroSlides)) {
    heroSlides = [];
    for (const raw of body.heroSlides) {
      const key = String(raw || "").trim();
      if (!key) continue;
      heroSlides.push(key);
      if (heroSlides.length >= 10) break;
    }
  }

  // "teamAreas" (usato oggi solo da chi-siamo, "Staff"): stessa logica di generalità/undefined di
  // founders — assente vuol dire "mostra le aree statiche della pagina", un array (anche vuoto)
  // le sovrascrive. Una area è {key, name, lead, countLabel, iconKey, members:[{name, role, photoKey}]}.
  let teamAreas;
  if (Array.isArray(body.teamAreas)) {
    teamAreas = [];
    for (const raw of body.teamAreas) {
      const name = String((raw && raw.name) || "").trim().slice(0, 100);
      if (!name) continue;
      const inputMembers = Array.isArray(raw && raw.members) ? raw.members : [];
      const members = [];
      for (const m of inputMembers) {
        const mName = String((m && m.name) || "").trim().slice(0, 200);
        if (!mName) continue;
        members.push({
          name: mName,
          role: String((m && m.role) || "").trim().slice(0, 200),
          photoKey: (m && String(m.photoKey || "").trim()) || null
        });
        if (members.length >= 20) break;
      }
      teamAreas.push({
        key: String((raw && raw.key) || "").trim().slice(0, 40) || `area-${teamAreas.length + 1}`,
        name,
        lead: String((raw && raw.lead) || "").trim().slice(0, 300),
        countLabel: String((raw && raw.countLabel) || "").trim().slice(0, 40),
        iconKey: (raw && String(raw.iconKey || "").trim()) || null,
        members
      });
      if (teamAreas.length >= 12) break;
    }
  }

  // "likedOptions" (usato oggi solo dal form feedback generico, "Cosa ti è piaciuto di più"):
  // stessa logica di generalità/undefined di heroSlides — l'elenco di opzioni checkbox mostrato
  // quando il form non ha uno slug evento con opzioni proprie (vedi /api/feedback-liked-options
  // e feedback.html). "Altro" con campo libero è sempre aggiunto in coda lato client, non va
  // salvato qui.
  let likedOptions;
  if (Array.isArray(body.likedOptions)) {
    likedOptions = [];
    for (const raw of body.likedOptions) {
      const label = String(raw || "").trim().slice(0, 120);
      if (!label) continue;
      likedOptions.push(label);
      if (likedOptions.length >= 12) break;
    }
  }

  // "gallery" (usato oggi solo dalle pagine evento "storiche", es. grow-with-us): stessa logica
  // di generalità/undefined di founders/heroSlides — assente vuol dire "mostra la galleria fissa
  // già nell'HTML", un array (anche vuoto) la sostituisce del tutto. A differenza di heroSlides
  // non è un'aggiunta ma una sostituzione, perché qui la galleria statica non è "sempre presente
  // più le foto extra" ma un'unica lista che lo staff deve poter curare (aggiungere/togliere/
  // sostituire singole foto).
  let gallery;
  if (Array.isArray(body.gallery)) {
    gallery = [];
    for (const raw of body.gallery) {
      const key = String(raw || "").trim();
      if (!key) continue;
      gallery.push(key);
      if (gallery.length >= 24) break;
    }
  }

  const content = { fields, extraSections };
  if (founders !== undefined) content.founders = founders;
  if (heroSlides !== undefined) content.heroSlides = heroSlides;
  if (teamAreas !== undefined) content.teamAreas = teamAreas;
  if (likedOptions !== undefined) content.likedOptions = likedOptions;
  if (gallery !== undefined) content.gallery = gallery;
  return { ok: true, content };
}

async function handleAdminGetPageContent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const page = String(new URL(request.url).searchParams.get("page") || "").trim();
  if (!page) return jsonResponse({ error: "pagina mancante" }, 400);
  return jsonResponse({ page, content: await getPageContent(env, page) });
}

async function handleAdminSavePageContent(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const page = String(body.page || "").trim();
  if (!page) return jsonResponse({ error: "pagina mancante" }, 400);
  const validated = validatePageContentPayload(body);
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);
  await env.TICKETS.put(`page:${page}`, JSON.stringify(validated.content));
  return jsonResponse({ ok: true, page, content: validated.content });
}

// HTML delle sezioni extra aggiunte dal pannello — SEMPRE inserite in un unico punto fisso
// (#home-extra-sections, appena prima della newsletter) mai dentro l'hero o il triangolo, così
// il design curato di quelle sezioni non può mai essere alterato da un blocco aggiunto a mano.
function extraSectionsHTML(sections) {
  return (sections || []).map(function(s){
    if (s.type === "image") {
      return `<section class="ed-section-tight"><div class="wrap"><img src="${mediaUrl(s.key)}" alt="${s.caption || ""}" style="width:100%; border-radius:16px; display:block;">${s.caption ? `<p class="meta" style="margin-top:12px; text-align:center;">${s.caption}</p>` : ""}</div></section>`;
    }
    return `<section class="ed-section-tight"><div class="wrap"><div class="ed-head"><h2>${s.title}</h2></div>${s.body ? `<p>${s.body}</p>` : ""}</div></section>`;
  }).join("");
}

class CmsTextHandler {
  constructor(fields) { this.fields = fields; }
  element(el) {
    const key = el.getAttribute("data-cms");
    const value = key && this.fields[key];
    if (value) el.setInnerContent(value);
  }
}
// framingStyles (facoltativo): stessa chiave dell'immagine -> stringa CSS già pronta
// (photoFramingStyle), per le foto data-cms-src con una posizione/zoom salvati insieme alla
// chiave (es. "hero.slide1.position"/"hero.slide1.zoom" nello stesso record di campi).
class CmsSrcHandler {
  constructor(fields, framingStyles) { this.fields = fields; this.framingStyles = framingStyles || {}; }
  element(el) {
    const key = el.getAttribute("data-cms-src");
    const value = key && this.fields[key];
    if (value) {
      el.setAttribute("src", value);
      // Alcune immagini (es. la foto hero facoltativa di chi-siamo/contatti) partono "hidden" nel
      // markup statico finché non vengono personalizzate — appena c'è un valore salvato vanno
      // rimostrate. Nessun effetto sulle altre pagine, che non usano l'attributo hidden qui.
      el.removeAttribute("hidden");
    }
    const style = key && this.framingStyles[key];
    if (style) el.setAttribute("style", style);
  }
}
class ExtraSectionsHandler {
  constructor(html) { this.html = html; }
  element(el) { if (this.html) el.setInnerContent(this.html, { html: true }); }
}
// Sostituisce interamente il contenuto di un nodo (es. la griglia fondatori) SOLO quando il
// campo è stato esplicitamente personalizzato — undefined lascia intatte le card statiche già
// nell'HTML, un array (anche vuoto) le rimpiazza con quanto salvato dal pannello.
class ReplaceContentHandler {
  constructor(html) { this.html = html; }
  element(el) { if (this.html !== null) el.setInnerContent(this.html, { html: true }); }
}
// Aggiunge HTML in coda ai figli già presenti in un nodo, senza toccarli — usato per le foto
// extra della slideshow hero (si aggiungono alle 3 di sempre, non le sostituiscono).
class AppendContentHandler {
  constructor(html) { this.html = html; }
  element(el) { if (this.html) el.append(this.html, { html: true }); }
}

function foundersHTML(founders){
  return founders.map(function(f){
    const photo = f.photoKey
      ? `<img src="${mediaUrl(f.photoKey)}" alt="${f.name}" loading="lazy" style="${photoFramingStyle(f.photoPosition, f.photoZoom)}">`
      : "";
    return `<div class="team-card"><div class="team-photo">${photo}</div><h3>${f.name}</h3><p class="role">${f.role || ""}</p></div>`;
  }).join("");
}

function heroSlidesHTML(keys){
  return keys.map(function(key){
    return `<div class="ed-hero-slide"><img src="${mediaUrl(key)}" alt=""></div>`;
  }).join("");
}

// Galleria foto di una pagina evento "storica" (oggi solo grow-with-us — vedi ".ed-gallery" nel
// suo HTML) — stesso markup .ed-gallery-item della versione statica, così sostituendo il
// contenuto del nodo la resa visiva non cambia, cambiano solo le foto.
function galleryHTML(keys){
  return keys.map(function(key){
    return `<div class="ed-gallery-item"><img src="${mediaUrl(key)}" alt="" loading="lazy"></div>`;
  }).join("");
}

// Inserisce HTML SUBITO DOPO un nodo (come fratello successivo, non dentro) — usato per iniettare
// lo script con i dati del team appena dopo <script src="assets/team-data.js">, così sovrascrive
// la variabile globale GROWMI_TEAM prima che initTeamOverlay() (interactive.js, a fondo pagina)
// la legga.
class InsertAfterHandler {
  constructor(html) { this.html = html; }
  element(el) { if (this.html) el.after(this.html, { html: true }); }
}

function teamAreaGridHTML(areas){
  return areas.map(function(area){
    const icon = area.iconKey ? `<img src="${mediaUrl(area.iconKey)}" alt="" loading="lazy">` : "";
    return `<div class="team-area-item" data-team-area="${area.key}"><button type="button" class="ed-card team-area-trigger"><div class="ed-card-media">${icon}</div><span class="tag">${area.countLabel || ""}</span><h3>${area.name}</h3></button><div class="team-area-panel" hidden></div></div>`;
  }).join("");
}

// GROWMI_TEAM (assets/team-data.js, dichiarata "var" apposta) viene sovrascritta con i dati
// salvati dal pannello — stessa forma che interactive.js/initTeamOverlay() già si aspetta
// (member.photo, non photoKey: qui si risolve subito con mediaUrl()).
function teamOverrideScriptHTML(areas){
  const data = {};
  for (const area of areas) {
    data[area.key] = {
      name: area.name,
      lead: area.lead || "",
      members: area.members.map(function(m){
        return { name: m.name, role: m.role || "", photo: m.photoKey ? mediaUrl(m.photoKey) : undefined };
      })
    };
  }
  // Precauzione contro un valore testuale che contenga "</script>" e chiuderebbe il tag prima del
  // previsto — non serve altro escaping, il contenuto resta comunque solo dati letti come JSON.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script>GROWMI_TEAM = ${json};</script>`;
}

// Applica gli override SOLO se ce n'è almeno uno salvato — altrimenti la risposta statica passa
// invariata, zero lavoro in più per il caso comune (nessuna pagina fissa ancora personalizzata).
// anchors: { extraSections: "#id", replace: [{ selector, data: array|undefined, render }],
// append: [{ selector, data: array|undefined, render }],
// insertAfter: [{ selector, data: array|undefined, render }] } — replace sostituisce interamente
// il contenuto del nodo (es. i fondatori), append aggiunge in coda senza toccare l'esistente (es.
// le foto extra della slideshow hero), insertAfter inserisce un fratello subito dopo il nodo (es.
// lo script con i dati del team, dopo <script src="team-data.js">). Stesso meccanismo per ogni
// pagina fissa, cambia solo cosa viene passato qui.
async function applyPageOverrides(response, content, anchors) {
  const hasFields = content.fields && Object.keys(content.fields).length > 0;
  const hasExtra = content.extraSections && content.extraSections.length > 0;
  const replaceTargets = (anchors.replace || []).filter(function(r){ return r.data !== undefined; });
  const appendTargets = (anchors.append || []).filter(function(r){ return r.data && r.data.length > 0; });
  const insertAfterTargets = (anchors.insertAfter || []).filter(function(r){ return r.data !== undefined; });
  if (!hasFields && !hasExtra && !replaceTargets.length && !appendTargets.length && !insertAfterTargets.length) return response;

  // Le chiavi immagine (quelle marcate data-cms-src nell'HTML, es. "hero.slide1") contengono una
  // chiave R2, mai un URL diretto — vanno sempre risolte con mediaUrl() prima di iniettarle.
  // Riconosciute per pattern (finiscono per "slideN" o ".image") invece di un elenco fisso, così
  // vale anche per le future pagine senza dover toccare questa funzione.
  const imageFields = {};
  const textFields = {};
  // Posizione/zoom di una foto data-cms-src (facoltativi): stessi valori del pannello artisti/
  // eventi, salvati come due campi in più con lo stesso nome della chiave immagine più
  // ".position"/".zoom" — non finiscono mai in textFields perché non c'è nessun data-cms con
  // quella chiave esatta nell'HTML, restano solo dati di supporto per costruire lo style qui sotto.
  const framingStyles = {};
  for (const k of Object.keys(content.fields || {})) {
    if (/slide\d+$/.test(k) || /\.image$/.test(k)) {
      imageFields[k] = mediaUrl(content.fields[k]);
      const position = content.fields[`${k}.position`];
      const zoom = content.fields[`${k}.zoom`];
      if (position || zoom) framingStyles[k] = photoFramingStyle(position, zoom ? Number(zoom) : 1);
    } else {
      textFields[k] = content.fields[k];
    }
  }

  let rewriter = new HTMLRewriter()
    .on("[data-cms]", new CmsTextHandler(textFields))
    .on("[data-cms-src]", new CmsSrcHandler(imageFields, framingStyles));
  if (anchors.extraSections) {
    rewriter = rewriter.on(anchors.extraSections, new ExtraSectionsHandler(extraSectionsHTML(content.extraSections)));
  }
  for (const r of replaceTargets) {
    rewriter = rewriter.on(r.selector, new ReplaceContentHandler(r.render(r.data)));
  }
  for (const a of appendTargets) {
    rewriter = rewriter.on(a.selector, new AppendContentHandler(a.render(a.data)));
  }
  for (const ia of insertAfterTargets) {
    rewriter = rewriter.on(ia.selector, new InsertAfterHandler(ia.render(ia.data)));
  }
  return rewriter.transform(response);
}

// buildAnchors(content) riceve il contenuto già letto una sola volta da KV — evita una seconda
// lettura solo per costruire gli anchor "replace" (es. i fondatori) che dipendono dallo stesso record.
async function handleFixedPageRoute(request, env, page, buildAnchors) {
  if (!env.TICKETS) return null;
  const res = await env.ASSETS.fetch(request);
  if (!res.ok) return res;
  const content = await getPageContent(env, page);
  return applyPageOverrides(res, content, buildAnchors(content));
}

async function handleHomePage(request, env) {
  return handleFixedPageRoute(request, env, "home", function(content){
    return {
      extraSections: "#home-extra-sections",
      replace: [],
      append: [{ selector: ".ed-hero-slideshow", data: content.heroSlides, render: heroSlidesHTML }]
    };
  });
}

async function handleChiSiamoPage(request, env) {
  return handleFixedPageRoute(request, env, "chi-siamo", function(content){
    return {
      extraSections: "#cs-extra-sections",
      replace: [
        { selector: "#cs-founders-grid", data: content.founders, render: foundersHTML },
        { selector: "#team-area-grid", data: content.teamAreas, render: teamAreaGridHTML }
      ],
      insertAfter: [
        { selector: 'script[src$="team-data.js"]', data: content.teamAreas, render: teamOverrideScriptHTML }
      ]
    };
  });
}

async function handleContattiPage(request, env) {
  return handleFixedPageRoute(request, env, "contatti", function(){
    return { extraSections: "#ct-extra-sections", replace: [] };
  });
}

async function handleLoyaltyCardPage(request, env) {
  return handleFixedPageRoute(request, env, "loyalty-card", function(){
    return { extraSections: "#loy-extra-sections", replace: [] };
  });
}

// Pagine dei singoli eventi "storici" (assets/events-data.js — vedi anche site:legacy-events più
// sotto per titolo/data/luogo/copertina della CARD): stesso pattern data-cms delle altre pagine
// fisse, per il contenuto vero e proprio DENTRO la pagina dell'evento.
async function handleArtMallCollabPage(request, env) {
  return handleFixedPageRoute(request, env, "art-mall-collab", function(){
    return { extraSections: "#ev-extra-sections", replace: [] };
  });
}
async function handleGrowWithUsPage(request, env) {
  return handleFixedPageRoute(request, env, "grow-with-us", function(content){
    return {
      extraSections: "#ev-extra-sections",
      replace: [{ selector: ".ed-gallery", data: content.gallery, render: galleryHTML }]
    };
  });
}

// Form di feedback: pagina a sé (niente header/footer/style.css del resto del sito), le domande
// sono testo fisso salvo le opzioni "cosa ti è piaciuto", caricate lato client da
// /api/event-tiers (se c'è un evento con opzioni proprie) o da /api/feedback-liked-options
// (default configurabili dal pannello) — vedi getPageContent/likedOptions più sotto. Niente
// sezioni extra qui: è un form strutturato, non una pagina di contenuto.
//
// Con ?form=<id> nell'URL, il form NON è più quello generico ("page:feedback") ma uno dei form
// distinti creati dal pannello Feedback (feedbackform:<id> — proprio testo e proprie opzioni
// "cosa ti è piaciuto", pensato per essere condiviso con un link a sé, es. per un singolo
// evento con domande diverse dal solito). Id sconosciuto o non passato = form generico di
// sempre, per non rompere link già in giro.
async function handleFeedbackPage(request, env) {
  const url = new URL(request.url);
  const formId = url.searchParams.get("form");
  if (formId) {
    if (!env.TICKETS) return null;
    const res = await env.ASSETS.fetch(request);
    if (!res.ok) return res;
    const form = await getFeedbackFormContent(env, formId);
    if (!form) return res;
    return applyPageOverrides(res, { fields: form.fields || {}, extraSections: [] }, { replace: [] });
  }
  return handleFixedPageRoute(request, env, "feedback", function(){
    return { replace: [] };
  });
}

// Form di feedback distinti (oltre a quello generico "page:feedback"): stesso principio di
// generalità delle altre entità KV con id (eventi/artisti) — {id, name (etichetta interna per il
// pannello, mai mostrata al pubblico), fields (stessa forma di page:feedback.fields),
// likedOptions, createdAt}. Il link pubblico è /feedback?form=<id>.
async function getFeedbackFormContent(env, id) {
  const raw = await env.TICKETS.get(`feedbackform:${id}`);
  return raw ? JSON.parse(raw) : null;
}

function validateFeedbackFormFields(body) {
  const inputFields = body.fields && typeof body.fields === "object" ? body.fields : {};
  const fields = {};
  let count = 0;
  for (const k of Object.keys(inputFields)) {
    if (count >= 60) break;
    const key = String(k).slice(0, 80);
    const value = String(inputFields[k] || "").slice(0, 4000);
    if (value) fields[key] = value;
    count++;
  }
  const likedOptions = [];
  if (Array.isArray(body.likedOptions)) {
    for (const raw of body.likedOptions) {
      const label = String(raw || "").trim().slice(0, 120);
      if (!label) continue;
      likedOptions.push(label);
      if (likedOptions.length >= 12) break;
    }
  }
  return { fields, likedOptions };
}

async function handleAdminListFeedbackForms(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const forms = [];
  let cursor = undefined;
  do {
    const page = await env.TICKETS.list({ prefix: "feedbackform:", cursor });
    for (const key of page.keys) {
      const raw = await env.TICKETS.get(key.name);
      if (!raw) continue;
      const f = JSON.parse(raw);
      forms.push({ id: f.id, name: f.name, createdAt: f.createdAt });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  forms.sort(function(a, b){ return (b.createdAt || "").localeCompare(a.createdAt || ""); });
  return jsonResponse({ forms });
}

async function handleAdminCreateFeedbackForm(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const name = String(body.name || "").trim().slice(0, 200);
  if (!name) return jsonResponse({ error: "nome obbligatorio" }, 400);
  let base = slugify(name).slice(0, 40) || "form";
  let id = base;
  let n = 2;
  while (await env.TICKETS.get(`feedbackform:${id}`)) {
    id = `${base}-${n}`;
    n++;
  }
  const record = { id, name, fields: {}, likedOptions: [], createdAt: new Date().toISOString() };
  await env.TICKETS.put(`feedbackform:${id}`, JSON.stringify(record));
  return jsonResponse({ ok: true, form: record });
}

async function handleAdminGetFeedbackForm(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const id = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const form = await getFeedbackFormContent(env, id);
  if (!form) return jsonResponse({ error: "form non trovato" }, 404);
  return jsonResponse({ form });
}

async function handleAdminSaveFeedbackForm(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const id = String(body.id || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  const existingRaw = await env.TICKETS.get(`feedbackform:${id}`);
  if (!existingRaw) return jsonResponse({ error: "form non trovato" }, 404);
  const existing = JSON.parse(existingRaw);
  const { fields, likedOptions } = validateFeedbackFormFields(body);
  const name = String(body.name || "").trim().slice(0, 200) || existing.name;
  const record = { id, name, fields, likedOptions, createdAt: existing.createdAt };
  await env.TICKETS.put(`feedbackform:${id}`, JSON.stringify(record));
  return jsonResponse({ ok: true, form: record });
}

async function handleAdminDeleteFeedbackForm(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const id = String(new URL(request.url).searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: "id mancante" }, 400);
  await env.TICKETS.delete(`feedbackform:${id}`);
  return jsonResponse({ ok: true });
}

// ============================================================================
// Tema del sito (font + colori): a differenza delle pagine fisse sopra, questo non è il
// contenuto di UNA pagina ma un tema GLOBALE applicato a tutte le pagine pubbliche insieme,
// tramite un'unica coppia di variabili CSS iniettate in ogni <head>. I colori passano già quasi
// ovunque per le variabili CSS di assets/style.css, quindi basta sovrascriverle. I font invece
// sono una selezione curata di coppie titolo/testo pronte all'uso (non testo libero), per
// evitare che l'admin scelga un font mai caricato e rompa la grafica.
// ============================================================================

const FONT_PAIRS = {
  default: {
    label: "Predefinito — Space Grotesk + Inter",
    headingFamily: "'Space Grotesk', sans-serif",
    bodyFamily: "'Inter', system-ui, sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&display=swap"
  },
  elegante: {
    label: "Elegante — Playfair Display + Inter",
    headingFamily: "'Playfair Display', serif",
    bodyFamily: "'Inter', system-ui, sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600;700&display=swap"
  },
  calda: {
    label: "Calda — Fraunces + Karla",
    headingFamily: "'Fraunces', serif",
    bodyFamily: "'Karla', sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=Karla:wght@400;500;600;700&display=swap"
  },
  bold: {
    label: "Bold — Archivo Black + Work Sans",
    headingFamily: "'Archivo Black', sans-serif",
    bodyFamily: "'Work Sans', sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Work+Sans:wght@400;500;600;700&display=swap"
  },
  tech: {
    label: "Tech — Sora + Source Sans 3",
    headingFamily: "'Sora', sans-serif",
    bodyFamily: "'Source Sans 3', sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Source+Sans+3:wght@400;500;600;700&display=swap"
  },
  minimal: {
    label: "Minimal — DM Serif Display + DM Sans",
    headingFamily: "'DM Serif Display', serif",
    bodyFamily: "'DM Sans', sans-serif",
    googleFontsHref: "https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap"
  }
};

// Chiave del pannello -> variabile CSS reale. Solo i 6 colori "brand": i token strutturali
// (--ink, --grey, --cream, --line, usati per il contrasto testo/sfondo) restano fissi, non sono
// esposti qui — modificarli rischierebbe di rompere la leggibilità su tutto il sito.
const THEME_COLOR_KEYS = {
  purpleDeep: "--purple-deep",
  purpleDeeper: "--purple-deeper",
  lilac: "--lilac",
  coral: "--coral",
  yellow: "--yellow",
  magenta: "--magenta"
};

// Dimensione (moltiplicatore, non px) e peso per ognuno dei 5 elementi tipografici che il
// pannello espone — vedi assets/style.css per come i moltiplicatori si applicano ai clamp()
// esistenti invece di sovrascriverli con un valore fisso.
const THEME_TYPE_SCALE_KEYS = {
  h1Scale: "--h1-scale", h2Scale: "--h2-scale", h3Scale: "--h3-scale",
  pScale: "--p-scale", eyebrowScale: "--eyebrow-scale"
};
const THEME_TYPE_WEIGHT_KEYS = {
  h1Weight: "--h1-weight", h2Weight: "--h2-weight", h3Weight: "--h3-weight",
  pWeight: "--p-weight", eyebrowWeight: "--eyebrow-weight"
};
const THEME_ALLOWED_WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

async function getSiteTheme(env) {
  const raw = await env.TICKETS.get("site:theme");
  return raw ? JSON.parse(raw) : {};
}

// I colori arrivano come stringa libera dal color picker: si accetta solo l'esadecimale valido,
// qualunque altro valore viene scartato in silenzio (l'admin resta sul colore precedente, niente
// CSS rotto da un valore inatteso).
function validateSiteThemePayload(body) {
  const theme = {};
  const fontPairKey = body && String(body.fontPairKey || "").trim();
  if (fontPairKey && FONT_PAIRS[fontPairKey]) theme.fontPairKey = fontPairKey;

  const inputColors = body && body.colors && typeof body.colors === "object" ? body.colors : {};
  const colors = {};
  for (const key of Object.keys(THEME_COLOR_KEYS)) {
    const value = inputColors[key];
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) {
      colors[key] = value.trim();
    }
  }
  if (Object.keys(colors).length) theme.colors = colors;

  const inputType = body && body.typography && typeof body.typography === "object" ? body.typography : {};
  const typography = {};
  for (const key of Object.keys(THEME_TYPE_SCALE_KEYS)) {
    const value = Number(inputType[key]);
    if (Number.isFinite(value) && value >= 0.7 && value <= 1.6) typography[key] = value;
  }
  for (const key of Object.keys(THEME_TYPE_WEIGHT_KEYS)) {
    const value = Number(inputType[key]);
    if (THEME_ALLOWED_WEIGHTS.includes(value)) typography[key] = value;
  }
  if (Object.keys(typography).length) theme.typography = typography;

  // Sfondo hero di default (site/default-hero-image, dietro ogni pagina senza una sua foto/video):
  // stessa posizione/zoom di artisti/eventi/home, ma applicate a un layer CSS (.ed-hero::before)
  // invece che a un <img>, perché lì lo sfondo è un CSS background, non un tag immagine.
  const inputHeroBg = body && body.heroBackground && typeof body.heroBackground === "object" ? body.heroBackground : {};
  const heroBackground = {};
  if (typeof inputHeroBg.position === "string" && inputHeroBg.position.trim()) {
    heroBackground.position = inputHeroBg.position.trim().slice(0, 30);
  }
  if (inputHeroBg.zoom !== null && inputHeroBg.zoom !== undefined && inputHeroBg.zoom !== "") {
    heroBackground.zoom = clampImageZoom(inputHeroBg.zoom);
  }
  if (Object.keys(heroBackground).length) theme.heroBackground = heroBackground;

  // Trasparenza del velo scuro sopra foto/video/slideshow di OGNI hero del sito (non solo lo
  // sfondo di default) — 1 = come oggi, 0 = nessun velo, fino a 2 = molto più scuro. Un solo
  // moltiplicatore condiviso da .ed-hero::after/.ed-hero-video-overlay/.ed-hero-slideshow-overlay,
  // che partono da opacità diverse tra loro ma restano proporzionate quando si scala il valore.
  if (body.heroOverlayOpacity !== null && body.heroOverlayOpacity !== undefined && body.heroOverlayOpacity !== "") {
    const overlayOpacity = Number(body.heroOverlayOpacity);
    if (Number.isFinite(overlayOpacity)) {
      theme.heroOverlayOpacity = Math.max(0, Math.min(2, overlayOpacity));
    }
  }

  return { ok: true, theme };
}

async function handleAdminGetSiteTheme(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const theme = await getSiteTheme(env);
  // Include famiglie e link Google Fonts (non solo l'etichetta): servono al pannello per mostrare
  // un'anteprima dal vivo di ogni coppia di font prima di scegliere/salvare.
  const fontPairs = Object.keys(FONT_PAIRS).map(function(key){
    const fp = FONT_PAIRS[key];
    return { key, label: fp.label, headingFamily: fp.headingFamily, bodyFamily: fp.bodyFamily, googleFontsHref: fp.googleFontsHref };
  });
  return jsonResponse({
    theme, fontPairs,
    colorKeys: Object.keys(THEME_COLOR_KEYS),
    typeScaleKeys: Object.keys(THEME_TYPE_SCALE_KEYS),
    typeWeightKeys: Object.keys(THEME_TYPE_WEIGHT_KEYS),
    allowedWeights: THEME_ALLOWED_WEIGHTS
  });
}

async function handleAdminSaveSiteTheme(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const validated = validateSiteThemePayload(body);
  // Fuso con quanto già salvato, non sovrascritto per intero: il pannello ha sezioni indipendenti
  // (font/colori, tipografia, sfondo hero di default) che pubblicano una alla volta — un PUT con
  // solo "heroBackground" non deve cancellare fontPairKey/colors/typography già salvati altrove,
  // e viceversa. Ogni chiave di primo livello presente nella richiesta sostituisce comunque per
  // intero quella salvata (stesso comportamento di "Ripristina colori" che deve poter tornare ai
  // valori di default), solo le chiavi ASSENTI restano quelle di prima.
  const existing = await getSiteTheme(env);
  const merged = Object.assign({}, existing, validated.theme);
  await env.TICKETS.put("site:theme", JSON.stringify(merged));
  return jsonResponse({ ok: true, theme: merged });
}

class ThemeHeadHandler {
  constructor(styleBlock) { this.styleBlock = styleBlock; }
  element(el) { if (this.styleBlock) el.append(this.styleBlock, { html: true }); }
}
class ThemeFontsLinkHandler {
  constructor(href) { this.href = href; }
  element(el) { if (this.href) el.setAttribute("href", this.href); }
}

function buildThemeStyleBlock(theme, fontPair) {
  const decls = [];
  if (fontPair) {
    decls.push(`--font-heading:${fontPair.headingFamily}`);
    decls.push(`--font-body:${fontPair.bodyFamily}`);
  }
  if (theme.colors) {
    for (const key of Object.keys(theme.colors)) {
      const cssVar = THEME_COLOR_KEYS[key];
      if (cssVar) decls.push(`${cssVar}:${theme.colors[key]}`);
    }
  }
  if (theme.typography) {
    for (const key of Object.keys(theme.typography)) {
      const cssVar = THEME_TYPE_SCALE_KEYS[key] || THEME_TYPE_WEIGHT_KEYS[key];
      if (cssVar) decls.push(`${cssVar}:${theme.typography[key]}`);
    }
  }
  if (theme.heroBackground) {
    if (theme.heroBackground.position) decls.push(`--hero-bg-position:${theme.heroBackground.position}`);
    if (theme.heroBackground.zoom) decls.push(`--hero-bg-zoom:${theme.heroBackground.zoom}`);
  }
  if (theme.heroOverlayOpacity !== undefined) decls.push(`--hero-overlay-opacity:${theme.heroOverlayOpacity}`);
  if (!decls.length) return "";
  return `<style id="site-theme-overrides">:root{${decls.join(";")}}</style>`;
}

async function applySiteTheme(response, theme) {
  const fontPair = theme.fontPairKey && theme.fontPairKey !== "default" ? FONT_PAIRS[theme.fontPairKey] : null;
  const hasColors = theme.colors && Object.keys(theme.colors).length > 0;
  const hasTypography = theme.typography && Object.keys(theme.typography).length > 0;
  const hasHeroBg = theme.heroBackground && Object.keys(theme.heroBackground).length > 0;
  const hasOverlayOpacity = theme.heroOverlayOpacity !== undefined;
  if (!fontPair && !hasColors && !hasTypography && !hasHeroBg && !hasOverlayOpacity) return response;
  const styleBlock = buildThemeStyleBlock(theme, fontPair);
  let rewriter = new HTMLRewriter().on("head", new ThemeHeadHandler(styleBlock));
  if (fontPair) {
    // Tutte le pagine caricano lo stesso identico <link> Google Fonts di default: lo si
    // individua dal suo href (contiene sempre "Space", il font di default) invece di dover
    // aggiungere un id in ogni file HTML del sito.
    rewriter = rewriter.on('link[href*="fonts.googleapis.com/css2?family=Space"]', new ThemeFontsLinkHandler(fontPair.googleFontsHref));
  }
  return rewriter.transform(response);
}

// Pagine su cui il tema pubblico NON si applica: azienda.html ha un proprio tema fisso da
// pannello admin (non deve dipendere dal tema del sito pubblico), le pagine staff-* sono
// strumenti operativi interni.
function isPublicThemedPath(pathname) {
  if (pathname === "/azienda.html" || pathname === "/azienda") return false;
  const last = pathname.split("/").pop() || "";
  if (last.startsWith("staff-")) return false;
  return true;
}

// Punto unico di uscita per ogni risposta HTML pubblica (statica o generata dal Worker): applica
// il tema salvato, se presente. Senza tema salvato la risposta torna invariata (pass-through).
// ============================================================================
// Eventi "storici" (assets/events-data.js): 3 voci scritte a mano, ognuna con la propria pagina
// HTML su misura (art-mall-collab.html, grow-with-us.html, the-miseducation-of-growmi.html) — da
// prima che esistesse il pannello Eventi con vendita biglietti (KV + /evento/<slug>). Non sono
// collegate al KV in nessun modo: senza questo sistema non c'era modo di modificarle dal
// pannello. Stessa tecnica già usata per assets/team-data.js — GROWMI_EVENTS dichiarata "var"
// apposta, un override viene iniettato subito dopo il suo <script> e sovrascrive solo i campi
// salvati (titolo, data, luogo, copertina), mai gli slug/url/draft che sono legati al codice.
async function getLegacyEventsOverride(env) {
  const raw = await env.TICKETS.get("site:legacy-events");
  return raw ? JSON.parse(raw) : {};
}

function validateLegacyEventsPayload(body) {
  const inputOverrides = body && body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const overrides = {};
  for (const slug of Object.keys(inputOverrides).slice(0, 20)) {
    const raw = inputOverrides[slug];
    const entry = {};
    if (raw && raw.title) entry.title = String(raw.title).trim().slice(0, 150);
    if (raw && raw.tag) entry.tag = String(raw.tag).trim().slice(0, 80);
    if (raw && raw.location) entry.location = String(raw.location).trim().slice(0, 150);
    if (raw && raw.dateIso) entry.dateIso = String(raw.dateIso).trim().slice(0, 10);
    if (raw && raw.coverKey) entry.coverKey = String(raw.coverKey).trim();
    if (raw && raw.sortOrder !== null && raw.sortOrder !== undefined && raw.sortOrder !== "") {
      const sortOrderRaw = Number(raw.sortOrder);
      if (Number.isFinite(sortOrderRaw)) entry.sortOrder = sortOrderRaw;
    }
    if (Object.keys(entry).length) overrides[String(slug).trim().slice(0, 60)] = entry;
  }
  return { ok: true, overrides };
}

async function handleAdminGetLegacyEvents(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  return jsonResponse({ overrides: await getLegacyEventsOverride(env) });
}

async function handleAdminSaveLegacyEvents(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const body = await request.json();
  const validated = validateLegacyEventsPayload(body);
  await env.TICKETS.put("site:legacy-events", JSON.stringify(validated.overrides));
  return jsonResponse({ ok: true, overrides: validated.overrides });
}

function legacyEventsOverrideScriptHTML(overrides) {
  const resolved = {};
  for (const slug of Object.keys(overrides)) {
    const o = overrides[slug];
    const entry = {};
    if (o.title) entry.title = o.title;
    if (o.tag) entry.tag = o.tag;
    if (o.location) entry.location = o.location;
    if (o.dateIso) entry.date = o.dateIso;
    if (o.coverKey) entry.cover = mediaUrl(o.coverKey);
    if (typeof o.sortOrder === "number") entry.sortOrder = o.sortOrder;
    resolved[slug] = entry;
  }
  const json = JSON.stringify(resolved).replace(/</g, "\\u003c");
  return `<script>(function(){var o=${json};if(typeof GROWMI_EVENTS!=="undefined"){GROWMI_EVENTS.forEach(function(ev){var e=o[ev.slug];if(e)Object.keys(e).forEach(function(k){ev[k]=e[k];});});}})();</script>`;
}

async function applyLegacyEventsOverride(response, overrides) {
  if (!overrides || !Object.keys(overrides).length) return response;
  const html = legacyEventsOverrideScriptHTML(overrides);
  return new HTMLRewriter().on('script[src$="events-data.js"]', new InsertAfterHandler(html)).transform(response);
}

// Un record al giorno per tutto il sito ({total, pages:{<path>: count}}) — un read-modify-write
// per visita, senza lock: sotto carico concorrente molto alto un incremento potrebbe perdersi, ma
// per un sito di queste dimensioni serve un numero indicativo, non una precisione da fatturazione.
// Tetto di percorsi distinti per non far crescere il record all'infinito con traffico bot/scanner
// che genera URL a caso — oltre il tetto il totale continua comunque a salire.
const ANALYTICS_MAX_PATHS_PER_DAY = 200;
// Campionamento: si traccia solo 1 visita su 4 (a caso) invece di ognuna, e si moltiplica per 4 in
// lettura (handleAdminGetAnalytics) — stessa stima nel pannello, ma un quarto delle scritture KV.
// Il tetto gratuito di Cloudflare KV (1.000 scritture/giorno, condiviso con tutto il resto del
// sito: biglietti, iscrizioni, sessioni...) è per l'intero account, non solo per l'analytics —
// prima di questo campionamento, il traffico reale del sito da solo poteva avvicinarcisi.
const ANALYTICS_SAMPLE_RATE = 0.25;
async function trackPageView(env, pathname) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `analytics:day:${day}`;
    const raw = await env.TICKETS.get(key);
    const rec = raw ? JSON.parse(raw) : { total: 0, pages: {} };
    // Marca il record come "campionato" — i giorni scritti PRIMA che esistesse il campionamento
    // (o mai toccati oggi) non hanno questo campo, e in lettura NON vanno moltiplicati per 4: sono
    // già un conteggio vero. Senza questa distinzione, un giorno vecchio da 72 visite reali
    // risultava mostrato come 288 (72×4) — bug scoperto proprio da un numero che non tornava.
    rec.sampled = true;
    rec.total = (rec.total || 0) + 1;
    if (rec.pages[pathname] !== undefined || Object.keys(rec.pages).length < ANALYTICS_MAX_PATHS_PER_DAY) {
      rec.pages[pathname] = (rec.pages[pathname] || 0) + 1;
    }
    await env.TICKETS.put(key, JSON.stringify(rec));
  } catch (err) {
    console.log("Errore tracking analytics:", err.stack || err.message);
  }
}

// Legge gli ultimi N giorni (letture dirette per chiave — N è piccolo, nessun bisogno di list())
// e aggrega le pagine più viste su tutto il range richiesto.
async function handleAdminGetAnalytics(request, env) {
  const auth = await requireStaffAccount(request, env);
  if (auth.error) return auth.error;
  if (!env.TICKETS) throw new Error("Binding KV 'TICKETS' non configurato");
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days"), 10) || 30, 1), 90);

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const records = await Promise.all(dates.map(function(date){ return env.TICKETS.get(`analytics:day:${date}`); }));
  const pageTotals = {};
  // Riscalato SOLO sui giorni marcati "sampled" (vedi trackPageView) — un giorno vecchio, scritto
  // prima che esistesse il campionamento, è già un conteggio vero e non va moltiplicato per 4.
  const daysOut = dates.map(function(date, i){
    const rec = records[i] ? JSON.parse(records[i]) : { total: 0, pages: {} };
    const scale = rec.sampled ? (1 / ANALYTICS_SAMPLE_RATE) : 1;
    for (const path of Object.keys(rec.pages || {})) {
      pageTotals[path] = (pageTotals[path] || 0) + Math.round(rec.pages[path] * scale);
    }
    return { date, total: Math.round((rec.total || 0) * scale) };
  });

  const topPages = Object.keys(pageTotals)
    .map(function(path){ return { path, count: pageTotals[path] }; })
    .sort(function(a, b){ return b.count - a.count; })
    .slice(0, 15);

  return jsonResponse({ days: daysOut, topPages });
}

async function finalizePublicHtmlResponse(request, env, response, ctx) {
  if (!env.TICKETS || !response) return response;
  const url = new URL(request.url);
  if (!isPublicThemedPath(url.pathname)) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  if (response.ok && request.method === "GET" && ctx && Math.random() < ANALYTICS_SAMPLE_RATE) {
    ctx.waitUntil(trackPageView(env, url.pathname));
  }
  try {
    const [theme, legacyEventsOverride] = await Promise.all([getSiteTheme(env), getLegacyEventsOverride(env)]);
    let out = await applySiteTheme(response, theme);
    out = await applyLegacyEventsOverride(out, legacyEventsOverride);
    return out;
  } catch (err) {
    console.log("Errore tema sito:", err.stack || err.message);
    return response;
  }
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

  // Chi possiede una carta fisica l'ha ricevuta di persona all'evento del 4 giugno 2026: il
  // timbro per quell'evento non è mai stato dato perché il sistema digitale non esisteva ancora,
  // quindi lo aggiungiamo ora, al momento del collegamento carta-account. ticketCode sintetico
  // (univoco per numero carta) solo per riusare la stessa dedup logic di addLoyaltyStamp.
  await addLoyaltyStamp(env, email, {
    eventName: "GrowMi — 4 giugno 2026",
    ticketCode: `physcard-${cardNumber}`,
    stampedAt: "2026-06-04T00:00:00.000Z"
  });

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
