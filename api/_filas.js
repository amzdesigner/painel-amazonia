/*
 * Painel Amazônia Gráfica · filas do quadro de pedidos
 *
 * As filas padrão ficam fixas aqui. O ADM cria filas novas na tela de Pedidos (botão "Filas"):
 * elas ficam na configuração "filas" ({ extras: [{ id, nome, cor, depois }] }) e entram depois da fila escolhida.
 */
export const FILAS_PADRAO = [
  { id: "atendimento", nome: "Atendimento", cor: "#8b5cf6" },
  { id: "designer", nome: "Fila do designer", cor: "#3b82f6" },
  { id: "impressao", nome: "Fila da impressão", cor: "#06b6d4" },
  { id: "acabamento", nome: "Fila do acabamento", cor: "#f59e0b" },
  { id: "costura", nome: "Fila da costura", cor: "#ec4899" },
  { id: "pronto", nome: "Pedido pronto", cor: "#22c55e" },
  { id: "entregue", nome: "Pedido entregue", cor: "#64748b" }
];
export const MAX_EXTRAS = 20;
const idOk = id => typeof id === "string" && /^f_[a-z0-9]{2,24}$/.test(id);

/* confere e arruma o que o ADM mandou salvar; devolve null se não der */
export function limpaFilasCfg(v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.extras)) return null;
  const extras = [], ids = new Set(FILAS_PADRAO.map(f => f.id));
  for (const e of v.extras.slice(0, MAX_EXTRAS)) {
    if (!e || !idOk(e.id) || ids.has(e.id)) continue;
    const nome = String(e.nome || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!nome) continue;
    const cor = /^#[0-9a-fA-F]{6}$/.test(e.cor || "") ? e.cor : "#94a3b8";
    extras.push({ id: e.id, nome, cor, depois: String(e.depois || "") });
    ids.add(e.id);
  }
  extras.forEach(e => { if (!ids.has(e.depois) || e.depois === "entregue" || e.depois === e.id) e.depois = "costura"; });
  return { extras };
}
/* lista completa, na ordem do quadro */
export function montarFilas(cfg) {
  const lista = FILAS_PADRAO.map(f => Object.assign({ padrao: true }, f));
  const extras = (cfg && Array.isArray(cfg.extras) ? cfg.extras : []).slice();
  let mudou = true;
  while (extras.length && mudou) {
    mudou = false;
    for (let i = 0; i < extras.length; i++) {
      const e = extras[i], k = lista.findIndex(f => f.id === e.depois);
      if (k < 0) continue;
      let pos = k + 1;
      while (pos < lista.length && !lista[pos].padrao && lista[pos]._dep === e.depois) pos++;   /* várias depois da mesma fila: mantém a ordem */
      lista.splice(pos, 0, { id: e.id, nome: e.nome, cor: e.cor, depois: e.depois, _dep: e.depois });
      extras.splice(i, 1); i--; mudou = true;
    }
  }
  extras.forEach(e => lista.splice(lista.length - 1, 0, { id: e.id, nome: e.nome, cor: e.cor, depois: e.depois }));
  return lista.map(f => { const o = Object.assign({}, f); delete o._dep; return o; });
}
let cache = null, cacheEm = 0;
export function esquecerFilas() { cache = null; }
/* filas atuais (lê a configuração no banco, guarda por 15 s) */
export async function filasAtuais(sql) {
  if (cache && Date.now() - cacheEm < 15000) return cache;
  let cfg = null;
  try { const [r] = await sql`SELECT valor FROM config WHERE chave = 'filas'`; cfg = r ? r.valor : null; } catch (e) { cfg = null; }
  cache = montarFilas(limpaFilasCfg(cfg)); cacheEm = Date.now();
  return cache;
}
