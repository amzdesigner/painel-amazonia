/*
 * Painel Amazônia Gráfica · filas do quadro de pedidos
 *
 * O ADM edita as filas na tela de Pedidos (botão "Filas"): nome, cor, ordem, criar e apagar.
 * Configuração "filas":
 *   novo formato   { lista: [{ id, nome, cor }] }  → a ordem completa do quadro
 *   formato antigo { extras: [{ id, nome, cor, depois }] } → filas novas depois de uma padrão
 * "atendimento" fica sempre em primeiro (é onde o pedido nasce) e "entregue" sempre em último (arquiva).
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

const PADRAO_IDS = FILAS_PADRAO.map(f => f.id);
const corOk = c => /^#[0-9a-fA-F]{6}$/.test(c || "");
/* novo formato: lista completa, na ordem */
function limpaLista(l) {
  const vistos = new Set(), out = [];
  for (const e of l.slice(0, 40)) {
    if (!e || typeof e.id !== "string" || vistos.has(e.id)) continue;
    if (!PADRAO_IDS.includes(e.id) && !idOk(e.id)) continue;
    const pad = FILAS_PADRAO.find(f => f.id === e.id);
    const nome = String(e.nome || (pad ? pad.nome : "")).replace(/\s+/g, " ").trim().slice(0, 40);
    if (!nome) continue;
    out.push({ id: e.id, nome, cor: corOk(e.cor) ? e.cor : (pad ? pad.cor : "#94a3b8") });
    vistos.add(e.id);
  }
  /* atendimento sempre primeiro, entregue sempre último */
  const primeiro = out.find(f => f.id === "atendimento") || Object.assign({}, FILAS_PADRAO[0]);
  const ultimo = out.find(f => f.id === "entregue") || Object.assign({}, FILAS_PADRAO[FILAS_PADRAO.length - 1]);
  const meio = out.filter(f => f.id !== "atendimento" && f.id !== "entregue");
  return [primeiro].concat(meio, [ultimo]).map(f => ({ id: f.id, nome: f.nome, cor: f.cor }));
}
/* confere e arruma o que o ADM mandou salvar; devolve null se não der */
export function limpaFilasCfg(v) {
  if (v && typeof v === "object" && Array.isArray(v.lista)) return { lista: limpaLista(v.lista) };
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
  if (cfg && Array.isArray(cfg.lista)) return limpaLista(cfg.lista).map(f => Object.assign({ padrao: PADRAO_IDS.includes(f.id) }, f));
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
