// Funzione di controllo: conferma che Cloudflare Pages Functions sta girando davvero.
// Raggiungibile su /api/health una volta pubblicato. Nessuna dipendenza esterna, nessun dato
// sensibile — serve solo a verificare che la pipeline funzioni prima di costruirci sopra.
export async function onRequestGet() {
  return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
    headers: { "Content-Type": "application/json" }
  });
}
