// Blocco acquisto biglietti standard, riusabile su qualsiasi pagina evento — sostituisce sia il
// vecchio form Netlify (rotto/scollegato) sia i Payment Link Stripe esterni hardcoded in pagina.
// Flusso in 3 passi, tutto dentro la pagina (nessun redirect esterno):
// 1) scegli la fascia/opzione (visibile subito, stato reale — esaurita o no — dal server)
// 2) compila i tuoi dati (nome/email/consensi), salvati su KV — stesso archivio dei biglietti
// 3) paga con Stripe Embedded Checkout, incorporato qui in pagina
//
// Markup atteso (vedi the-miseducation-of-growmi.html per un esempio completo):
// <div class="event-tickets" data-event="<slug-evento>">
//   <div data-et-tier-list></div>
//   <div data-et-reg-step hidden>
//     <strong data-et-selection-label></strong>
//     <form data-et-reg-form>
//       <input data-et-firstname> <input data-et-lastname>
//       <select data-et-phone-prefix> <input data-et-phone>
//       <input type="email" data-et-email>
//       <input type="checkbox" data-et-photo-consent> <input type="checkbox" data-et-newsletter>
//       <input data-et-coupon> (facoltativo: codice del coupon "5° evento gratis" — se compilato
//         e valido, il prezzo del biglietto diventa €0, controllato sempre lato server)
//       <button type="submit" data-et-reg-submit>...</button>
//       <p data-et-reg-status hidden></p>
//     </form>
//   </div>
//   <div data-et-checkout-wrap hidden><div data-et-checkout-container></div></div>
// </div>
(function(){
  // Chiave pubblicabile Stripe (pk_live_...): è fatta apposta per stare in chiaro nel JS lato
  // client, non è un segreto — è quella pubblica, abbinata alla secret key live già configurata
  // sul Worker.
  var STRIPE_PUBLISHABLE_KEY = "pk_live_51RCPfzAlS0d4FgrwKgoxmfFsPUx1a7pAwn5707zCQ9PhmQYHJ41Ji4sXJt60YpD4IuDkEpUZwZe5YKRMz1lKJxbH00hrAkWQYt";

  function euro(cents){
    return "€" + (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function initOne(root){
    var slug = root.dataset.event;
    var tierList = root.querySelector("[data-et-tier-list]");
    var regStep = root.querySelector("[data-et-reg-step]");
    var selectionLabel = root.querySelector("[data-et-selection-label]");
    var form = root.querySelector("[data-et-reg-form]");
    var status = root.querySelector("[data-et-reg-status]");
    var submitBtn = root.querySelector("[data-et-reg-submit]");
    var checkoutWrap = root.querySelector("[data-et-checkout-wrap]");
    var checkoutContainer = root.querySelector("[data-et-checkout-container]");
    if (!slug || !tierList || !form) return;

    var selectedTierId = null;
    var selectedOptionId = null;

    function renderTiers(data){
      tierList.innerHTML = "";
      data.tiers.forEach(function(tier){
        var row = document.createElement("div");
        // Le tre fasce restano sempre visibili (mai nascoste dalla lista): quella esaurita
        // mostra "Esaurita", quelle future sono visibili ma non selezionabili e senza prezzo
        // (si sblocca prezzo + acquisto solo quando diventano la fascia attiva).
        var optionsHtml;
        if (tier.soldOut) {
          row.className = "et-tier-row et-sold-out";
          optionsHtml = '<span class="et-sold-out-badge">Esaurita</span>';
        } else if (!tier.active) {
          row.className = "et-tier-row et-upcoming";
          optionsHtml = tier.options.map(function(o){
            return '<button type="button" class="et-tier-btn" disabled>' +
              '<span class="et-tier-btn-label">' + o.label + '</span><span class="et-tier-btn-price">&mdash;</span>' +
            '</button>';
          }).join("");
        } else {
          row.className = "et-tier-row";
          optionsHtml = tier.options.map(function(o){
            return '<button type="button" class="et-tier-btn" data-tier="' + tier.id + '" data-option="' + o.id + '" data-selection-label="' +
              (tier.name + " — " + o.label).replace(/"/g, "&quot;") + '">' +
              '<span class="et-tier-btn-label">' + o.label + '</span><span class="et-tier-btn-price">' + euro(o.priceCents) + '</span>' +
            '</button>';
          }).join("");
        }
        row.innerHTML =
          '<div class="et-tier-name">' + tier.name + (tier.sub ? '<small>' + tier.sub + '</small>' : '') + '</div>' +
          '<div class="et-tier-options">' + optionsHtml + '</div>';
        tierList.appendChild(row);
      });
      tierList.querySelectorAll(".et-tier-btn:not(:disabled)").forEach(function(btn){
        btn.addEventListener("click", function(){
          selectTier(btn.dataset.tier, btn.dataset.option, btn.dataset.selectionLabel);
        });
      });
    }

    async function loadTiers(){
      try {
        var res = await fetch("/api/event-tiers?event=" + encodeURIComponent(slug));
        var data = await res.json();
        if (res.ok) renderTiers(data);
      } catch (e) { /* si può riprovare ricaricando la pagina, non blocca il resto */ }
    }

    function selectTier(tierId, optionId, label){
      selectedTierId = tierId;
      selectedOptionId = optionId;
      if (selectionLabel) selectionLabel.textContent = label;
      regStep.hidden = false;
      checkoutWrap.hidden = true;
      checkoutContainer.innerHTML = "";
      regStep.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function startCheckout(registrationId){
      checkoutWrap.hidden = false;
      checkoutContainer.innerHTML = "";
      checkoutWrap.scrollIntoView({ behavior: "smooth", block: "start" });
      try {
        var res = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationId: registrationId, tierId: selectedTierId, optionId: selectedOptionId })
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
      if (!selectedTierId) return;
      submitBtn.disabled = true;
      try {
        var couponInput = form.querySelector("[data-et-coupon]");
        var firstName = form.querySelector("[data-et-firstname]").value.trim();
        var lastName = form.querySelector("[data-et-lastname]").value.trim();
        var phonePrefixEl = form.querySelector("[data-et-phone-prefix]");
        var phonePrefix = phonePrefixEl ? phonePrefixEl.value : "";
        var phoneNumber = form.querySelector("[data-et-phone]").value.trim();
        var res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventSlug: slug,
            name: (firstName + " " + lastName).trim(),
            phone: (phonePrefix + " " + phoneNumber).trim(),
            email: form.querySelector("[data-et-email]").value.trim(),
            termsAccepted: form.querySelector("[data-et-terms]") ? form.querySelector("[data-et-terms]").checked : false,
            photoConsent: form.querySelector("[data-et-photo-consent]").checked,
            newsletterOptin: form.querySelector("[data-et-newsletter]") ? form.querySelector("[data-et-newsletter]").checked : false,
            couponCode: couponInput ? couponInput.value.trim() : ""
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
        form.hidden = true;
        await startCheckout(data.registrationId);
      } catch (e) {
        status.textContent = "Errore di connessione, riprova.";
        status.classList.add("is-error");
        status.hidden = false;
        submitBtn.disabled = false;
      }
    });

    loadTiers();
  }

  document.addEventListener("DOMContentLoaded", function(){
    document.querySelectorAll(".event-tickets[data-event]").forEach(initOne);
  });
})();
