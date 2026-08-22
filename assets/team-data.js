/* Elenco delle aree del team GrowMi e di chi ne fa parte.
   assets/interactive.js (initTeamOverlay) legge questa lista per riempire il menu che si apre
   cliccando una card area in chi-siamo.html — stesso principio di events-data.js per il menu
   biglietti: aggiungere/togliere una persona significa modificare solo questo file, niente
   pagine HTML separate da mantenere allineate a mano.

   Campi:
   - name: nome dell'area, mostrato come titolo nel menu
   - lead: breve descrizione dell'area
   - members: elenco persone { name, role } — role tipicamente "Direttore d'area" o "Team" */
const GROWMI_TEAM = {
  amm: {
    name: "Amministrazione e Finanza",
    lead: "Chi si occupa dei conti, dell'amministrazione e della sostenibilità economica di GrowMi.",
    members: [
      { name: "Roberta La Giusa", role: "Direttore d'area" },
      { name: "Alessandro Decollanz", role: "Direttore d'area" },
      { name: "Colette Buelli", role: "Team" }
    ]
  },
  artvenue: {
    name: "Artisti & Locali",
    lead: "Chi cerca, seleziona e segue gli artisti emergenti e i locali che ospitano gli eventi GrowMi.",
    members: [
      { name: "Daniela Pezzoni", role: "Direttore d'area" },
      { name: "Lulita Gorgoglione", role: "Team" }
    ]
  },
  comms: {
    name: "Comunicazione & Marketing",
    lead: "Chi racconta GrowMi: contenuti, social, storytelling e la voce del progetto verso l'esterno.",
    members: [
      { name: "Carlo Capizzoto", role: "Direttore d'area" },
      { name: "Alice Amoruso", role: "Direttore d'area" },
      { name: "Mihaela Doschinescu", role: "Team" },
      { name: "Keiron Metaj", role: "Team" }
    ]
  },
  comm: {
    name: "Commerciale",
    lead: "Chi cura le partnership, gli sponsor e le collaborazioni commerciali di GrowMi.",
    members: [
      { name: "Marco Capezzuoli", role: "Direttore d'area" },
      { name: "Francesco Ghioni", role: "Team" }
    ]
  },
  sw: {
    name: "Software e Piattaforme",
    lead: "Chi sviluppa e mantiene il sito e gli strumenti digitali di GrowMi.",
    members: [
      { name: "Carlo Capizzoto", role: "Direttore d'area" }
    ]
  }
};
