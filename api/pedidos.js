/*
 * Painel Amazônia Gráfica · quadro de pedidos (kanban) no banco (Neon Postgres)
 *
 * GET    /api/pedidos               → pedidos ativos (no quadro)
 * GET    /api/pedidos?entregues=1   → últimos pedidos entregues (arquivados)
 * GET    /api/pedidos?id=12&arte=1  → só as artes do pedido: { artes: [{ img, item, material }] }
 *        (as artes vão em POST/PATCH no campo "artes": lista de { img: data URL, item: id do material };
 *         lista vazia remove todas)
 * POST   /api/pedidos               → cria um pedido
 * PATCH  /api/pedidos?id=12         → muda fila, ordem, arquivado e/ou dados
 * DELETE /api/pedidos?id=12         → exclui um pedido
 *
 * Toda chamada precisa estar logada (cabeçalho "x-painel-token", ver api/login.js).
 * Usuários da produção (não ADM): só veem os pedidos que já saíram do atendimento, sem nenhum valor,
 * e só podem mudar a fila / ordem / arquivar (e as miniaturas). Não criam, não editam e não excluem.
 * Toda mudança (de qualquer usuário) vai para a auditoria (api/auditoria.js).
 */
import { neon } from "@neondatabase/serverless";
import { exigirSessao } from "./_auth.js";
import { auditar, NOMES_FILA } from "./_auditoria.js";

function acharUrlBanco() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const chave = Object.keys(env).find(k => /(^|_)DATABASE_URL$/.test(k) && !/UNPOOLED/.test(k))
             || Object.keys(env).find(k => /(^|_)POSTGRES_URL$/.test(k));
  return chave ? env[chave] : "";
}
const URL_BANCO = acharUrlBanco();
const sql = URL_BANCO ? neon(URL_BANCO) : null;

const FILAS = ["atendimento", "designer", "impressao", "acabamento", "costura", "pronto", "entregue"];

let preparado = null;
function prepararBanco() {
  if (!preparado) {
    preparado = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS pedidos (
        id            BIGSERIAL PRIMARY KEY,
        fila          TEXT NOT NULL DEFAULT 'atendimento',
        ordem         DOUBLE PRECISION NOT NULL DEFAULT 0,
        arquivado     BOOLEAN NOT NULL DEFAULT FALSE,
        dados         JSONB NOT NULL DEFAULT '{}'::jsonb,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS pedidos_ativos ON pedidos (arquivado, fila, ordem)`;
      await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS arte TEXT`;
      await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS miniatura TEXT`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

const CAMPOS = ["cliente", "clienteId", "contato", "telefone", "material", "produtoId", "precoUnit", "descricao", "medidas",
  "quantidade", "preco", "prazo", "prioridade", "atendente", "obs", "qtdArtes",
  /* pagamento */
  "metodoPag", "condPag", "entrada", "pagoEm", "restantePago", "restantePagoEm", "restanteMetodo"];
/* cada material do pedido */
const ITEM_CAMPOS = ["uid", "camisa", "material", "produtoId", "precoUnit", "descricao", "medidas", "quantidade", "preco"];
function limpa(b) {
  const o = {};
  CAMPOS.forEach(c => { o[c] = String(b[c] == null ? "" : b[c]).trim().slice(0, c === "obs" || c === "descricao" ? 3000 : 200); });
  if (!["normal", "urgente"].includes(o.prioridade)) o.prioridade = "normal";
  if (Array.isArray(b.itens)) {
    o.itens = b.itens.slice(0, 60).filter(it => it && typeof it === "object").map(it => {
      const i = {};
      ITEM_CAMPOS.forEach(c => { i[c] = String(it[c] == null ? "" : it[c]).trim().slice(0, c === "camisa" ? 4000 : c === "descricao" ? 1000 : 200); });
      return i;
    });
  }
  return o;
}
/* artes: lista de imagens (data URL jpeg/png), cada uma ligada a um material do pedido.
   Guardadas como JSON na coluna "arte". undefined = não mexe; null = remove; false = inválido */
const MAX_ARTES = 4000000, MAX_QTD_ARTES = 12;
const imgOk = v => typeof v === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v);
function lerArtes(b) {
  let lista = b.artes;
  if (lista === undefined && b.arte !== undefined) lista = b.arte ? [{ img: b.arte, item: "" }] : []; /* formato antigo */
  if (lista === undefined) return undefined;
  if (!Array.isArray(lista)) return false;
  if (!lista.length) return null;
  if (lista.length > MAX_QTD_ARTES) return false;
  const limpas = lista.map(a => ({
    img: a && a.img, item: String((a && a.item) || "").slice(0, 60), material: String((a && a.material) || "").slice(0, 200)
  }));
  if (!limpas.every(a => imgOk(a.img))) return false;
  const txt = JSON.stringify(limpas);
  return txt.length > MAX_ARTES ? false : txt;
}
/* aceita também o formato antigo (uma imagem só, sem lista) */
function artesDoBanco(txt) {
  if (!txt) return [];
  if (txt.startsWith("[")) { try { return JSON.parse(txt); } catch (e) { return []; } }
  return [{ img: txt, item: "", material: "" }];
}
/* miniaturas das artes (pequenas), para o card do quadro passar de uma para outra.
   Guardadas como JSON na coluna "miniatura": [{ img, rotulo }] */
const MAX_MINI = 90000, MAX_MINIS = 600000;
function lerMiniatura(b) {
  let lista = b.miniaturas;
  if (lista === undefined && b.miniatura !== undefined) lista = b.miniatura ? [{ img: b.miniatura, rotulo: "" }] : [];
  if (lista === undefined) return undefined;
  if (!Array.isArray(lista) || lista.length > MAX_QTD_ARTES) return false;
  if (!lista.length) return null;
  const limpas = lista.map(m => ({ img: m && m.img, rotulo: String((m && m.rotulo) || "").slice(0, 200) }));
  if (!limpas.every(m => imgOk(m.img) && m.img.length <= MAX_MINI)) return false;
  const txt = JSON.stringify(limpas);
  return txt.length > MAX_MINIS ? false : txt;
}
function minisDoBanco(txt) {
  if (!txt) return [];
  if (txt.startsWith("[")) { try { return JSON.parse(txt); } catch (e) { return []; } }
  return [{ img: txt, rotulo: "" }];
}
/* tira tudo que é valor de venda (para quem não é ADM) */
const CAMPOS_VALOR = ["preco", "precoUnit", "metodoPag", "condPag", "entrada", "pagoEm", "restantePago", "restantePagoEm", "restanteMetodo"];
function semValores(p) {
  CAMPOS_VALOR.forEach(c => { delete p[c]; });
  if (Array.isArray(p.itens)) p.itens = p.itens.map(it => {
    const i = Object.assign({}, it); delete i.preco; delete i.precoUnit;
    if (i.camisa) {
      try { const c = typeof i.camisa === "string" ? JSON.parse(i.camisa) : i.camisa; delete c.unit; delete c.valor; i.camisa = JSON.stringify(c); }
      catch (e) { i.camisa = ""; }
    }
    return i;
  });
  return p;
}
/* o que mudou nos dados do pedido (para a auditoria) */
const ROTULOS = { cliente: "cliente", contato: "contato", telefone: "telefone", itens: "materiais", prazo: "prazo", prioridade: "prioridade",
  preco: "valor", atendente: "atendente", obs: "observação", metodoPag: "forma de pagamento", condPag: "condição de pagamento",
  entrada: "entrada", pagoEm: "data do pagamento", restantePago: "restante", restanteMetodo: "forma do restante" };
function oQueMudou(antes, depois) {
  const a = antes || {}, d = depois || {};
  return Object.keys(ROTULOS).filter(k => JSON.stringify(a[k] ?? "") !== JSON.stringify(d[k] ?? "")).map(k => ROTULOS[k]);
}
const nomeFila = f => NOMES_FILA[f] || f;
function formata(r) {
  return Object.assign({}, r.dados || {}, {
    id: String(r.id), numero: String(r.id), fila: r.fila, ordem: Number(r.ordem), arquivado: r.arquivado,
    temArte: r.tem_arte != null ? !!r.tem_arte : !!r.arte,
    miniaturas: minisDoBanco(r.miniatura),
    criado: new Date(r.criado_em).toISOString(), atualizado: new Date(r.atualizado_em).toISOString()
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  const sessao = exigirSessao(req, res, ["adm", "producao"]);
  if (!sessao) return;
  const adm = sessao.papel === "adm";

  try {
    await prepararBanco();
    const corpo = () => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));

    if (!adm && req.method !== "GET" && req.method !== "PATCH") return res.status(403).json({ erro: "Seu usuário não pode criar nem excluir pedidos." });
    const saida = adm ? formata : r => semValores(formata(r));

    if (req.method === "GET") {
      if (!adm && req.query.relatorio === "1") return res.status(403).json({ erro: "Seu usuário não tem acesso aos relatórios." });
      /* relatório: pedidos com pagamento (entrada/à vista ou restante) no período, arquivados inclusive */
      if (req.query.relatorio === "1") {
        const de = String(req.query.de || "").slice(0, 10), ate = String(req.query.ate || de).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return res.status(400).json({ erro: "Datas inválidas." });
        const linhas = await sql`SELECT id, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
          FROM pedidos
          WHERE (dados->>'pagoEm' BETWEEN ${de}::text AND ${ate}::text) OR (dados->>'restantePagoEm' BETWEEN ${de}::text AND ${ate}::text)
          ORDER BY criado_em LIMIT 3000`;
        return res.status(200).json({ itens: linhas.map(formata) });
      }
      if (req.query.arte === "1") {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ erro: "Informe o id." });
        const [r] = await sql`SELECT arte, fila FROM pedidos WHERE id = ${id}::bigint`;
        if (!r || (!adm && r.fila === "atendimento")) return res.status(404).json({ erro: "Pedido não encontrado." });
        return res.status(200).json({ artes: artesDoBanco(r.arte) });
      }
      /* a lista não traz as imagens, só se o pedido tem arte */
      const linhas = req.query.entregues === "1"
        ? await sql`SELECT id, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
                    FROM pedidos WHERE arquivado ORDER BY atualizado_em DESC LIMIT 200`
        : await sql`SELECT id, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
                    FROM pedidos WHERE NOT arquivado ORDER BY fila, ordem LIMIT 2000`;
      /* produção não vê a coluna de atendimento (vendas) */
      return res.status(200).json({ itens: linhas.filter(r => adm || r.fila !== "atendimento").map(saida) });
    }

    if (req.method === "POST") {
      const b = corpo();
      const d = limpa(b);
      if (!d.cliente) return res.status(400).json({ erro: "Informe o cliente." });
      const fila = FILAS.includes(b.fila) ? b.fila : "atendimento";
      const ordem = Number.isFinite(Number(b.ordem)) ? Number(b.ordem) : Date.now();
      const arte = lerArtes(b);
      if (arte === false) return res.status(400).json({ erro: "Artes inválidas ou pesadas demais (máx. 12 imagens)." });
      const mini = lerMiniatura(b);
      if (mini === false) return res.status(400).json({ erro: "Miniatura inválida." });
      const [linha] = await sql`
        INSERT INTO pedidos (fila, ordem, dados, arte, miniatura)
        VALUES (${fila}::text, ${ordem}::float8, ${JSON.stringify(d)}::jsonb, ${arte || null}::text, ${mini || null}::text)
        RETURNING *`;
      await auditar(sql, sessao, "criou", { pedidoId: linha.id, cliente: d.cliente, detalhe: "Em " + nomeFila(fila) + (d.material ? " · " + d.material : "") });
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "PATCH") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const b = corpo();
      const fila = b.fila == null ? null : (FILAS.includes(b.fila) ? b.fila : undefined);
      if (fila === undefined) return res.status(400).json({ erro: "Fila inválida." });
      const [atual] = await sql`SELECT fila, arquivado, ordem, dados FROM pedidos WHERE id = ${id}::bigint`;
      if (!atual) return res.status(404).json({ erro: "Pedido não encontrado." });
      if (!adm) {
        /* produção: só move entre as filas de produção, muda a ordem, arquiva e atualiza miniaturas */
        if (b.dados != null || b.artes !== undefined || b.arte !== undefined) return res.status(403).json({ erro: "Seu usuário não pode editar o pedido." });
        if (fila === "atendimento") return res.status(403).json({ erro: "Seu usuário não pode mandar pedidos para o atendimento." });
        if (atual.fila === "atendimento") return res.status(404).json({ erro: "Pedido não encontrado." });
      }
      const ordem = b.ordem == null || !Number.isFinite(Number(b.ordem)) ? null : Number(b.ordem);
      const arquivado = b.arquivado == null ? null : !!b.arquivado;
      let dados = null;
      if (b.dados && typeof b.dados === "object") {
        const d = limpa(b.dados);
        if (!d.cliente) return res.status(400).json({ erro: "Informe o cliente." });
        dados = JSON.stringify(d);
      }
      const arte = lerArtes(b);
      if (arte === false) return res.status(400).json({ erro: "Artes inválidas ou pesadas demais (máx. 12 imagens)." });
      const mexeArte = arte !== undefined;
      const mini = lerMiniatura(b);
      if (mini === false) return res.status(400).json({ erro: "Miniatura inválida." });
      const mexeMini = mini !== undefined;
      const [linha] = await sql`
        UPDATE pedidos SET
          arte      = CASE WHEN ${mexeArte}::boolean THEN ${arte || null}::text ELSE arte END,
          miniatura = CASE WHEN ${mexeMini}::boolean THEN ${mini || null}::text ELSE miniatura END,
          fila      = COALESCE(${fila}::text, fila),
          ordem     = COALESCE(${ordem}::float8, ordem),
          arquivado = COALESCE(${arquivado}::boolean, arquivado),
          dados     = COALESCE(${dados}::jsonb, dados),
          atualizado_em = now()
        WHERE id = ${id}::bigint
        RETURNING *`;
      if (!linha) return res.status(404).json({ erro: "Pedido não encontrado." });

      /* auditoria: o que essa pessoa fez */
      const dAntes = atual.dados || {}, dDepois = linha.dados || {};
      const cli = dDepois.cliente || dAntes.cliente || "";
      if (fila && fila !== atual.fila) await auditar(sql, sessao, "moveu", { pedidoId: id, cliente: cli, detalhe: nomeFila(atual.fila) + " → " + nomeFila(fila) });
      if (arquivado === true && !atual.arquivado) await auditar(sql, sessao, "arquivou", { pedidoId: id, cliente: cli, detalhe: "Saiu do quadro (" + nomeFila(linha.fila) + ")" });
      if (arquivado === false && atual.arquivado) await auditar(sql, sessao, "desarquivou", { pedidoId: id, cliente: cli, detalhe: "Voltou para " + nomeFila(linha.fila) });
      if (dados) { const m = oQueMudou(dAntes, dDepois); if (m.length) await auditar(sql, sessao, "editou", { pedidoId: id, cliente: cli, detalhe: "Mudou: " + m.join(", ") }); }
      if (mexeArte) await auditar(sql, sessao, "artes", { pedidoId: id, cliente: cli, detalhe: "Trocou as artes do pedido" });
      if (ordem != null && !(fila && fila !== atual.fila) && arquivado == null && Number(atual.ordem) !== ordem)
        await auditar(sql, sessao, "reordenou", { pedidoId: id, cliente: cli, detalhe: "Mudou a posição em " + nomeFila(linha.fila) });
      return res.status(200).json({ item: saida(linha) });
    }

    if (req.method === "DELETE") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const [apagado] = await sql`DELETE FROM pedidos WHERE id = ${id}::bigint RETURNING fila, dados`;
      if (apagado) await auditar(sql, sessao, "excluiu", { pedidoId: id, cliente: (apagado.dados || {}).cliente || "", detalhe: "Estava em " + nomeFila(apagado.fila) });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
