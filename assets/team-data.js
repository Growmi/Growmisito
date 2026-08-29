/* Elenco delle aree del team GrowMi e di chi ne fa parte.
   assets/interactive.js (initTeamOverlay) legge questa lista per riempire il menu che si apre
   cliccando una card area in chi-siamo.html — stesso principio di events-data.js per il menu
   biglietti: aggiungere/togliere una persona significa modificare solo questo file, niente
   pagine HTML separate da mantenere allineate a mano.

   Campi:
   - name: nome dell'area, mostrato come titolo nel menu
   - lead: breve descrizione dell'area
   - members: elenco persone { name, role, photo } — role tipicamente "Direttore d'area" o
     "Team"; photo è facoltativo (assets/img/team/<slug>.jpg) — chi non ce l'ha ancora mostra
     solo il riquadro sfumato, niente foto rotte */
var GROWMI_TEAM = {
  amm: {
    name: "Amministrazione e Finanza",
    lead: "Chi si occupa dei conti, dell'amministrazione e della sostenibilità economica di GrowMi.",
    members: [
      { name: "Roberta La Giusa", role: "Direttore d'area", photo: "assets/img/team/roberta-la-giusa.jpg" },
      { name: "Alessandro Decollanz", role: "Direttore d'area", photo: "assets/img/team/alessandro-decollanz.jpg" },
      { name: "Colette Buelli", role: "Team", photo: "assets/img/team/colette-buelli.jpg" }
    ]
  },
  artvenue: {
    name: "Artisti & Locali",
    lead: "Chi cerca, seleziona e segue gli artisti emergenti e i locali che ospitano gli eventi GrowMi.",
    members: [
      { name: "Daniela Pezzoni", role: "Direttore d'area", photo: "assets/img/team/daniela-pezzoni.jpg" },
      { name: "Lourdes Gorgoglione", role: "Team", photo: "assets/img/team/lourdes-gorgoglione.jpg" }
    ]
  },
  comms: {
    name: "Comunicazione & Marketing",
    lead: "Chi racconta GrowMi: contenuti, social, storytelling e la voce del progetto verso l'esterno.",
    members: [
      { name: "Carlo Capizzoto", role: "Direttore d'area", photo: "assets/img/team/carlo-capizzoto.jpg" },
      { name: "Alice Amoruso", role: "Direttore d'area", photo: "assets/img/team/alice-amoruso.jpg" },
      { name: "Mihaela Doschinescu", role: "Team", photo: "assets/img/team/mihaela-doschinescu.jpg" },
      { name: "Keiron Metaj", role: "Team", photo: "assets/img/team/keiron-metaj.jpg" }
    ]
  },
  comm: {
    name: "Commerciale",
    lead: "Chi cura le partnership, gli sponsor e le collaborazioni commerciali di GrowMi.",
    members: [
      { name: "Marco Capezzuoli", role: "Direttore d'area", photo: "assets/img/team/marco-capezzuoli.jpg" },
      { name: "Francesco Ghioni", role: "Team", photo: "assets/img/team/francesco-ghioni.jpg", photoPosition: "center 25%" }
    ]
  },
  sw: {
    name: "Software e Piattaforme",
    lead: "Chi sviluppa e mantiene il sito e gli strumenti digitali di GrowMi.",
    members: [
      { name: "Carlo Capizzoto", role: "Direttore d'area", photo: "assets/img/team/carlo-capizzoto.jpg" }
    ]
  }
};
