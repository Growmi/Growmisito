// Blocco acquisto biglietti standard, riusabile su qualsiasi pagina evento — sostituisce sia il
// vecchio form Netlify (rotto/scollegato) sia i Payment Link Stripe esterni hardcoded in pagina.
// Tutto il pagamento resta dentro al sito via Stripe Embedded Checkout.
//
// Markup atteso (vedi the-miseducation-of-growmi.html per un esempio completo):
// <div class="event-tickets" data-event="<slug-evento>">
//   <form data-et-reg-form>
//     <input data-et-name> <input type="email" data-et-email>
//     <input type="checkbox" data-et-photo-consent> <input type="checkbox" data-et-newsletter>
//     <button type="submit" data-et-reg-submit>...</button>
//     <p data-et-reg-status hidden></p>
//   </form>
//   <p data-et-locked-note>...</p>
//   <div data-et-tier-list class="et-locked"></div>
//   <div data-et-checkout-wrap hidden><div data-et-checkout-container></div></div>
// </div>
(function(){
  // Chiave pubblicabile Stripe (pk_...): è fatta apposta per stare in chiaro nel JS lato client,
  // non è un segreto. TODO Carlo: sostituire con la chiave pubblicabile vera (Stripe Dashboard →
  // Developers → API keys) prima di andare live — con questo placeholder l'Embedded Checkout non
  // si monta.
  var STRIPE_PUBLISHABLE_KEY = "pk_live_REPLACE_WITH_REAL_KEY";

  function euro(cents){
    return "€" + (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function initOne(root){
    var slug = root.dataset.event;
    var form = root.querySelector("[data-et-reg-form]");
    var status = root.querySelector("[data-et-reg-status]");
    var submitBtn = root.querySelector("[data-et-reg-submit]");
    var lockedNote = root.querySelector("[data-et-locked-note]");
    var tierList = root.querySelector("[data-et-tier-list]");
    var checkoutWrap = root.querySelector("[data-et-checkout-wrap]");
    var checkoutContainer = root.querySelector("[data-et-checkout-container]");
    if (!slug || !form || !tierList) return;

    var registrationId = null;

    function renderTiers(data){
      tierList.innerHTML = "";
      data.tiers.forEach(function(tier){
        var row = document.createElement("div");
        row.className = "et-tier-row" + (tier.soldOut ? " et-sold-out" : "");
        var optionsHtml = tier.soldOut
          ? '<span class="et-sold-out-badge">Esaurita</span>'
          : tier.options.map(function(o){
              return '<button type="button" class="et-tier-btn" data-tier="' + tier.id + '" data-option="' + o.id + '"' + (tier.active ? "" : " disabled") + '>' +
                '<span class="et-tier-btn-label">' + o.label + '</span><span class="et-tier-btn-price">' + euro(o.priceCents) + '</span>' +
              '</button>';
            }).join("");
        row.innerHTML =
          '<div class="et-tier-name">' + tier.name + (tier.sub ? '<small>' + tier.sub + '</small>' : '') + '</div>' +
          '<div class="et-tier-options">' + optionsHtml + '</div>';
        tierList.appendChild(row);
      });
      tierList.querySelectorAll(".et-tier-btn:not(:disabled)").forEach(function(btn){
        btn.addEventListener("click", function(){ startCheckout(btn.dataset.tier, btn.dataset.option); });
      });
    }

    async function loadTiers(){
      try {
        var res = await fetch("/api/event-tiers?event=" + encodeURIComponent(slug));
        var data = await res.json();
        if (res.ok) renderTiers(data);
      } catch (e) { /* riprovabile al prossimo submit, non blocca la pagina */ }
    }

    async function startCheckout(tierId, optionId){
      checkoutWrap.hidden = false;
      checkoutContainer.innerHTML = "";
      checkoutWrap.scrollIntoView({ behavior: "smooth", block: "start" });
      try {
        var res = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationId: registrationId, tierId: tierId, optionId: optionId })
        });
        var data = await res.json();
        if (!res.ok) {
          checkoutContainer.textContent = data.error === "fascia esaurita"
            ? "Questa fascia si è appena esaurita — aggiorna la pagina e scegli quella successiva."
            : "Qualcosa è andato storto, riprova.";
          return;
        }
        var stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
        var checkout = await stripe.initEmbeddedCheckout({ clientSecret: data.clientSecret });
        checkout.mount(checkoutContainer);
      } catch (e) {
        checkoutContainer.textContent = "Errore di connessione, riprova.";
      }
    }

    form.addEventListener("submit", async function(e){
      e.preventDefault();
      submitBtn.disabled = true;
      try {
        var res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventSlug: slug,
            name: form.querySelector("[data-et-name]").value.trim(),
            email: form.querySelector("[data-et-email]").value.trim(),
            photoConsent: form.querySelector("[data-et-photo-consent]").checked,
            newsletterOptin: form.querySelector("[data-et-newsletter]") ? form.querySelector("[data-et-newsletter]").checked : false
          })
        });
        var data = await res.json();
        if (!res.ok) {
          status.textContent = data.error || "Controlla i dati inseriti.";
          status.classList.add("is-error");
          status.hidden = false;
          submitBtn.disabled = false;
          return;
        }
        registrationId = data.registrationId;
        tierList.classList.remove("et-locked");
        if (lockedNote) lockedNote.hidden = true;
        form.hidden = true;
        await loadTiers();
      } catch (e) {
        status.textContent = "Errore di connessione, riprova.";
        status.classList.add("is-error");
        status.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function(){
    document.querySelectorAll(".event-tickets[data-event]").forEach(initOne);
  });
})();
