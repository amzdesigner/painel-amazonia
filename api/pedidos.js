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
 * PATCH { designer: "CLAYTON" } escolhe quem faz a arte (qualquer usuário com acesso aos pedidos; "" tira).
 *
 * APROVAÇÃO DA ARTE (arte criada ou recriada pela gráfica): o pedido não sai da Fila do designer
 * para a produção enquanto a arte não for aprovada. Uma aprovação basta:
 *   - o cliente aprovou (com o print da conversa), ou
 *   - um revisor (ADM ou hierarquia com "aprova artes", ex.: Gráfica Soares) aprovou — e quem recriou não aprova a própria arte.
 * GET   /api/pedidos?id=12&aprov=1      → { item, imgs: { original, recriada, print } }
 * GET   /api/pedidos?revisar=1          → pedidos com arte esperando revisão (só revisores)
 * PATCH /api/pedidos?id=12&aprov=1  { acao, ... }
 *       acao: imagens {original?, recriada?} · atualizar {recriada} · enviar · aprovar · corrigir {comentario} · cliente {print, recebidoPor}
 *             · reabrir · exigir · dispensar (só ADM)
 */
import { neon } from "@neondatabase/serverless";
import { exigirSessao, pode } from "./_auth.js";
import { auditar, NOMES_FILA } from "./_auditoria.js";
import { filasAtuais } from "./_filas.js";

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
      await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS aprov_img TEXT`;
      /* numeração dos pedidos por ano: 01/2026, 02/2026… (mesma tabela de contadores das O.S.) */
      await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS contadores (tipo TEXT NOT NULL, ano INTEGER NOT NULL, ultimo INTEGER NOT NULL, PRIMARY KEY (tipo, ano))`;
      /* pedidos antigos, sem número: numera pela ordem em que foram criados */
      await sql`
        UPDATE pedidos p SET numero = lpad((x.base + x.n)::text, greatest(2, length((x.base + x.n)::text)), '0') || '/' || x.ano::text
        FROM (
          SELECT s.id, s.ano, s.n, coalesce(c.ultimo, 0) AS base
          FROM (SELECT id, EXTRACT(YEAR FROM criado_em AT TIME ZONE 'America/Manaus')::int AS ano,
                       row_number() OVER (PARTITION BY EXTRACT(YEAR FROM criado_em AT TIME ZONE 'America/Manaus') ORDER BY id) AS n
                FROM pedidos WHERE numero IS NULL) s
          LEFT JOIN contadores c ON c.tipo = 'pedido' AND c.ano = s.ano
        ) x
        WHERE p.id = x.id AND p.numero IS NULL`;
      await sql`
        INSERT INTO contadores (tipo, ano, ultimo)
        SELECT 'pedido', split_part(numero, '/', 2)::int, max(split_part(numero, '/', 1)::int)
        FROM pedidos WHERE numero ~ '^[0-9]+/[0-9]{4}$' GROUP BY 2
        ON CONFLICT (tipo, ano) DO UPDATE SET ultimo = GREATEST(contadores.ultimo, EXCLUDED.ultimo)`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

const CAMPOS = ["cliente", "clienteId", "contato", "telefone", "material", "produtoId", "precoUnit", "descricao", "medidas",
  "quantidade", "preco", "prazo", "prioridade", "atendente", "obs", "qtdArtes",
  /* de qual gráfica é o pedido: "amazonia" ou "soares" */
  "empresa",
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
/* ---------- aprovação da arte ---------- */
const ARTES_CRIADAS = ["criar", "recriar", "zero"];
const MAX_IMG_APROV = 2500000;
function exigeAuto(d) {
  return (d.itens || []).some(i => { try { const c = typeof i.camisa === "string" ? JSON.parse(i.camisa || "null") : i.camisa; return !!c && ARTES_CRIADAS.includes(c.arte); } catch (e) { return false; } });
}
/* guarda (ou cria) o estado da aprovação ao salvar o pedido */
function aprovAoSalvar(antes, d) {
  const auto = exigeAuto(d);
  if (antes && typeof antes === "object") {
    const a = JSON.parse(JSON.stringify(antes));
    a.auto = auto; a.exige = !a.dispensada && (auto || !!a.manual);
    return a;
  }
  return auto ? { exige: true, auto: true, manual: false, status: "pendente", historico: [] } : undefined;
}
const bloqueiaFila = (aprov, fila) => !!(aprov && aprov.exige && aprov.status !== "aprovada" && fila !== "atendimento" && fila !== "designer");
const MSG_BLOQ = "A arte deste pedido foi criada/recriada e ainda não foi aprovada. Aprove a arte antes de mandar para a produção.";
function imgsAprov(txt) { if (!txt) return {}; if (typeof txt === "object") return Object.assign({}, txt); try { return JSON.parse(txt) || {}; } catch (e) { return {}; } }

/* tira tudo que é valor de venda (para quem não é ADM) */
const CAMPOS_VALOR = ["preco", "precoUnit", "metodoPag", "condPag", "entrada", "pagoEm", "restantePago", "restantePagoEm", "restanteMetodo"];
function semValores(p) {
  CAMPOS_VALOR.forEach(c => { delete p[c]; });
  if (Array.isArray(p.itens)) p.itens = p.itens.map(it => {
    const i = Object.assign({}, it); delete i.preco; delete i.precoUnit;
    if (i.camisa) {
      try { const c = typeof i.camisa === "string" ? JSON.parse(i.camisa) : i.camisa; delete c.unit; delete c.valor; delete c.taxaArte; i.camisa = JSON.stringify(c); }
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
let nomesExtras = {};
const nomeFila = f => nomesExtras[f] || NOMES_FILA[f] || f;
function formata(r) {
  return Object.assign({}, r.dados || {}, {
    id: String(r.id), numero: r.numero || String(r.id), fila: r.fila, ordem: Number(r.ordem), arquivado: r.arquivado,
    temArte: r.tem_arte != null ? !!r.tem_arte : !!r.arte,
    miniaturas: minisDoBanco(r.miniatura),
    criado: new Date(r.criado_em).toISOString(), atualizado: new Date(r.atualizado_em).toISOString()
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  const sessao = await exigirSessao(req, res, ["ped", "visao", "rel"]);
  if (!sessao) return;
  /* "adm" aqui = acesso completo aos pedidos (vê o atendimento, cria, edita, exclui) */
  const adm = sessao.adm || (sessao.pedidos === "completo" && sessao.abas.includes("ped"));
  const veValores = sessao.adm || sessao.valores;
  /* filas do quadro que essa pessoa vê (hierarquia); produção nunca vê o atendimento */
  const veFila = f => (sessao.adm || !sessao.filas || sessao.filas.includes(f)) && (adm || sessao.verAtendimento || f !== "atendimento");
  /* TABLET (Produção): só vê */
  if (sessao.somenteVer && req.method !== "GET") return res.status(403).json({ erro: "O TABLET só mostra os pedidos. Toque em “Trocar usuário” e entre com o seu usuário para mexer." });
  /* quem revisa e aprova artes: ADM ou hierarquia com "aprova artes" (ex.: Gráfica Soares) */
  const revisor = sessao.adm || !!sessao.aprovaArte;
  /* filas atuais (padrão + as criadas pelo ADM) */
  const listaFilas = await filasAtuais(sql);
  const FILAS = listaFilas.map(f => f.id);
  nomesExtras = {}; listaFilas.forEach(f => { nomesExtras[f.id] = f.nome; });

  try {
    await prepararBanco();
    const corpo = () => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));

    if (!adm && req.method !== "GET" && req.method !== "PATCH") return res.status(403).json({ erro: "Seu usuário não pode criar nem excluir pedidos." });
    if (req.method !== "GET" && !pode(sessao, ["ped"])) return res.status(403).json({ erro: "Seu usuário não tem acesso aos pedidos." });
    const saida = veValores ? formata : r => semValores(formata(r));

    if (req.method === "GET") {
      if (req.query.relatorio === "1" && !pode(sessao, ["rel"])) return res.status(403).json({ erro: "Seu usuário não tem acesso aos relatórios." });
      /* relatório: pedidos com pagamento (entrada/à vista ou restante) no período, arquivados inclusive */
      if (req.query.relatorio === "1") {
        const de = String(req.query.de || "").slice(0, 10), ate = String(req.query.ate || de).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return res.status(400).json({ erro: "Datas inválidas." });
        const linhas = await sql`SELECT id, numero, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
          FROM pedidos
          WHERE (dados->>'pagoEm' BETWEEN ${de}::text AND ${ate}::text) OR (dados->>'restantePagoEm' BETWEEN ${de}::text AND ${ate}::text)
          ORDER BY criado_em LIMIT 3000`;
        return res.status(200).json({ itens: linhas.map(formata) });
      }
      if (req.query.revisar === "1") {
        if (!revisor) return res.status(403).json({ erro: "Seu usuário não revisa artes." });
        const linhas = await sql`SELECT id, numero, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
          FROM pedidos WHERE NOT arquivado AND dados->'aprov'->>'status' = 'revisao' ORDER BY atualizado_em LIMIT 200`;
        return res.status(200).json({ itens: linhas.map(saida) });
      }
      if (req.query.aprov === "1") {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ erro: "Informe o id." });
        const [r] = await sql`SELECT id, numero, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte, aprov_img
          FROM pedidos WHERE id = ${id}::bigint`;
        if (!r || !(veFila(r.fila) || revisor)) return res.status(404).json({ erro: "Pedido não encontrado." });
        return res.status(200).json({ item: saida(r), imgs: imgsAprov(r.aprov_img) });
      }
      if (req.query.arte === "1") {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ erro: "Informe o id." });
        const [r] = await sql`SELECT arte, fila FROM pedidos WHERE id = ${id}::bigint`;
        if (!r || !veFila(r.fila)) return res.status(404).json({ erro: "Pedido não encontrado." });
        return res.status(200).json({ artes: artesDoBanco(r.arte) });
      }
      /* a lista não traz as imagens, só se o pedido tem arte */
      const linhas = req.query.entregues === "1"
        ? await sql`SELECT id, numero, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
                    FROM pedidos WHERE arquivado ORDER BY atualizado_em DESC LIMIT 200`
        : await sql`SELECT id, numero, fila, ordem, arquivado, dados, criado_em, atualizado_em, miniatura, (arte IS NOT NULL) AS tem_arte
                    FROM pedidos WHERE NOT arquivado ORDER BY fila, ordem LIMIT 2000`;
      /* produção não vê a coluna de atendimento (vendas) */
      return res.status(200).json({ itens: linhas.filter(r => veFila(r.fila)).map(saida) });
    }

    if (req.method === "POST") {
      const b = corpo();
      const d = limpa(b);
      if (!d.cliente) return res.status(400).json({ erro: "Informe o cliente." });
      const fila = FILAS.includes(b.fila) ? b.fila : "atendimento";
      const ap = aprovAoSalvar(null, d); if (ap) d.aprov = ap;
      if (bloqueiaFila(d.aprov, fila)) return res.status(409).json({ erro: MSG_BLOQ, bloqueio: "arte" });
      const ordem = Number.isFinite(Number(b.ordem)) ? Number(b.ordem) : Date.now();
      const arte = lerArtes(b);
      if (arte === false) return res.status(400).json({ erro: "Artes inválidas ou pesadas demais (máx. 12 imagens)." });
      const mini = lerMiniatura(b);
      if (mini === false) return res.status(400).json({ erro: "Miniatura inválida." });
      /* número sequencial por ano (fuso de Manaus): 01/2026, 02/2026… */
      const [linha] = await sql`
        WITH ano AS (SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'America/Manaus')::int AS a),
        c AS (
          INSERT INTO contadores (tipo, ano, ultimo)
          SELECT 'pedido', a, 1 FROM ano
          ON CONFLICT (tipo, ano) DO UPDATE SET ultimo = contadores.ultimo + 1
          RETURNING ultimo, ano
        )
        INSERT INTO pedidos (fila, ordem, dados, arte, miniatura, numero)
        SELECT ${fila}::text, ${ordem}::float8, ${JSON.stringify(d)}::jsonb, ${arte || null}::text, ${mini || null}::text,
               lpad(c.ultimo::text, greatest(2, length(c.ultimo::text)), '0') || '/' || c.ano::text
        FROM c
        RETURNING *`;
      await auditar(sql, sessao, "criou", { pedidoId: linha.id, pedidoNumero: linha.numero, cliente: d.cliente, detalhe: "Em " + nomeFila(fila) + (d.material ? " · " + d.material : "") });
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "PATCH" && req.query.aprov === "1") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const b = corpo();
      const [atual] = await sql`SELECT fila, arquivado, dados, numero, aprov_img FROM pedidos WHERE id = ${id}::bigint`;
      if (!atual || !(veFila(atual.fila) || revisor)) return res.status(404).json({ erro: "Pedido não encontrado." });
      const d = atual.dados || {};
      const a = d.aprov && typeof d.aprov === "object" ? JSON.parse(JSON.stringify(d.aprov)) : { exige: false, auto: false, manual: false, status: "pendente", historico: [] };
      const imgs = imgsAprov(atual.aprov_img);
      const eu = sessao.usuario, agora = new Date().toISOString();
      const hist = (acao, texto) => { a.historico = (a.historico || []).concat([{ acao, usuario: eu, em: agora, texto: texto || "" }]).slice(-60); };
      const erro = (st, msg) => res.status(st).json({ erro: msg });
      const imgBoa = v => typeof v === "string" && imgOk(v) && v.length <= MAX_IMG_APROV;
      let mexeImgs = false, detalhe = "";
      switch (String(b.acao || "")) {
        case "imagens": {
          if (a.status === "aprovada") return erro(409, "A arte já foi aprovada. Use “Nova versão” para trocar a arte.");
          if (a.status === "revisao") return erro(409, "A arte está em revisão: as imagens ficam travadas até o revisor aprovar ou pedir correção.");
          for (const k of ["original", "recriada"]) if (b[k] !== undefined) {
            if (b[k] === null || b[k] === "") delete imgs[k];
            else if (!imgBoa(b[k])) return erro(400, "Imagem inválida ou pesada demais.");
            else imgs[k] = b[k];
            mexeImgs = true;
          }
          a.temOriginal = !!imgs.original; a.temRecriada = !!imgs.recriada;
          detalhe = "Anexou a arte " + (b.recriada !== undefined && b.original !== undefined ? "original e a recriada" : b.recriada !== undefined ? "recriada" : "original do cliente");
          hist("imagens", detalhe);
          break;
        }
        case "atualizar": {   /* troca a arte recriada (nova versão): volta para revisão */
          if (!imgBoa(b.recriada)) return erro(400, "Imagem inválida ou pesada demais.");
          const eraAprov = a.status === "aprovada";
          imgs.recriada = b.recriada; if (eraAprov) delete imgs.print; mexeImgs = true;
          ["via", "aprovadoPor", "aprovadoEm", "recebidoPor"].forEach(k => delete a[k]);
          a.temRecriada = true; a.temOriginal = !!imgs.original; a.comentario = "";
          a.versao = (Number(a.versao) || 0) + 1;
          if (a.exige && imgs.original) { a.status = "revisao"; a.autor = eu; a.enviadoEm = agora; }
          else if (a.exige) a.status = "pendente";
          detalhe = "Atualizou a arte recriada (versão " + a.versao + ")" + (eraAprov ? "; a aprovação anterior deixou de valer" : "") + (a.status === "revisao" ? " e mandou para revisão" : "");
          hist("atualizar", "Versão " + a.versao + (eraAprov ? " (aprovação anterior cancelada)" : ""));
          break;
        }
        case "enviar":
          if (!a.exige) return erro(400, "Esse pedido não precisa de aprovação de arte.");
          if (!imgs.original || !imgs.recriada) return erro(400, "Coloque a arte que o cliente enviou e a arte recriada antes de mandar para revisão.");
          if (a.status === "aprovada") return erro(409, "A arte já foi aprovada.");
          a.status = "revisao"; a.autor = eu; a.enviadoEm = agora; a.versao = (Number(a.versao) || 0) + 1; a.comentario = "";
          detalhe = "Mandou a arte recriada para revisão (versão " + a.versao + ")"; hist("enviar", "Versão " + a.versao);
          break;
        case "aprovar":
          if (!revisor) return erro(403, "Só o ADM ou quem aprova artes (ex.: Gráfica Soares) pode aprovar.");
          if (a.status !== "revisao") return erro(409, "Essa arte não está esperando revisão.");
          if (a.autor && a.autor === eu) return erro(403, "Quem recriou a arte não pode aprovar a própria arte. Peça para outro revisor.");
          Object.assign(a, { status: "aprovada", via: "revisao", aprovadoPor: eu, aprovadoEm: agora, comentario: String(b.comentario || "").slice(0, 500) });
          detalhe = "Aprovou a arte recriada para produção (revisão)"; hist("aprovar", a.comentario);
          break;
        case "corrigir": {
          if (!revisor) return erro(403, "Só o ADM ou quem aprova artes pode pedir correção.");
          if (a.status !== "revisao") return erro(409, "Essa arte não está esperando revisão.");
          if (a.autor && a.autor === eu) return erro(403, "Quem recriou a arte não pode revisar a própria arte.");
          const c = String(b.comentario || "").trim().slice(0, 500);
          if (!c) return erro(400, "Escreva o que precisa corrigir.");
          Object.assign(a, { status: "correcao", comentario: c, revisadoPor: eu, revisadoEm: agora });
          detalhe = "Pediu correção na arte: " + c; hist("corrigir", c);
          break;
        }
        case "cliente": {
          if (!a.exige) return erro(400, "Esse pedido não precisa de aprovação de arte.");
          if (a.status === "aprovada") return erro(409, "A arte já foi aprovada.");
          if (!imgs.original || !imgs.recriada) return erro(400, "Coloque a arte que o cliente enviou e a arte recriada antes de registrar a aprovação do cliente.");
          if (!imgBoa(b.print)) return erro(400, "Cole o print da conversa em que o cliente aprovou.");
          imgs.print = b.print; mexeImgs = true;
          const quem = String(b.recebidoPor || eu).trim().toUpperCase().slice(0, 40) || eu;
          Object.assign(a, { status: "aprovada", via: "cliente", aprovadoPor: eu, aprovadoEm: agora, recebidoPor: quem, comentario: String(b.comentario || "").slice(0, 500) });
          if (!a.autor) a.autor = eu;
          detalhe = "Registrou a aprovação do cliente (print anexado; recebida por " + quem + ")"; hist("cliente", "Recebida por " + quem);
          break;
        }
        case "reabrir":
          if (a.status !== "aprovada" && a.status !== "correcao") return erro(409, "Não há aprovação para reabrir.");
          if (a.status === "aprovada") { delete imgs.print; mexeImgs = true; }
          ["via", "aprovadoPor", "aprovadoEm", "recebidoPor"].forEach(k => delete a[k]);
          a.status = "pendente"; a.comentario = "";
          detalhe = "Abriu uma nova versão da arte (a aprovação anterior deixou de valer)"; hist("reabrir");
          break;
        case "exigir":
          if (!adm) return erro(403, "Seu usuário não pode mudar isso.");
          a.manual = true; a.dispensada = false; a.exige = true; if (!a.status) a.status = "pendente";
          detalhe = "Marcou a arte como recriada (precisa de aprovação)"; hist("exigir");
          break;
        case "dispensar":
          if (!sessao.adm) return erro(403, "Só o ADM pode dispensar a aprovação.");
          a.dispensada = true; a.exige = false; a.manual = false;
          detalhe = "Dispensou a aprovação da arte"; hist("dispensar", String(b.comentario || "").slice(0, 300));
          break;
        default: return erro(400, "Ação inválida.");
      }
      const novos = Object.assign({}, d, { aprov: a });
      const txtImgs = JSON.stringify(imgs);
      if (txtImgs.length > MAX_IMG_APROV * 3 + 1000) return erro(413, "Imagens pesadas demais.");
      const [linha] = await sql`UPDATE pedidos SET dados = ${JSON.stringify(novos)}::jsonb,
          aprov_img = CASE WHEN ${mexeImgs}::boolean THEN ${txtImgs}::text ELSE aprov_img END, atualizado_em = now()
        WHERE id = ${id}::bigint RETURNING *`;
      await auditar(sql, sessao, "arte", { pedidoId: id, pedidoNumero: linha.numero, cliente: d.cliente || "", detalhe });
      return res.status(200).json({ item: saida(linha) });
    }

    if (req.method === "PATCH") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const b = corpo();
      const fila = b.fila == null ? null : (FILAS.includes(b.fila) ? b.fila : undefined);
      if (fila === undefined) return res.status(400).json({ erro: "Fila inválida." });
      const [atual] = await sql`SELECT fila, arquivado, ordem, dados FROM pedidos WHERE id = ${id}::bigint`;
      if (!atual || !veFila(atual.fila)) return res.status(404).json({ erro: "Pedido não encontrado." });
      if (!adm) {
        /* produção: só move entre as filas de produção, muda a ordem, arquiva e atualiza miniaturas */
        if (b.dados != null || b.artes !== undefined || b.arte !== undefined) return res.status(403).json({ erro: "Seu usuário não pode editar o pedido." });
        /* (designer pode: ver abaixo) */
        if (fila === "atendimento") return res.status(403).json({ erro: "Seu usuário não pode mandar pedidos para o atendimento." });
        if (atual.fila === "atendimento") return res.status(404).json({ erro: "Pedido não encontrado." });
      }
      const ordem = b.ordem == null || !Number.isFinite(Number(b.ordem)) ? null : Number(b.ordem);
      const arquivado = b.arquivado == null ? null : !!b.arquivado;
      let dados = null;
      const antesDados = atual.dados || {};
      if (b.dados && typeof b.dados === "object") {
        const d = limpa(b.dados);
        if (!d.cliente) return res.status(400).json({ erro: "Informe o cliente." });
        if (antesDados.designer && d.designer == null) d.designer = antesDados.designer;   /* editar o pedido não apaga o designer */
        const ap = aprovAoSalvar(antesDados.aprov, d); if (ap) d.aprov = ap;               /* a aprovação só muda pelas ações próprias */
        dados = JSON.stringify(d);
      }
      /* designer da arte */
      const mexeDesigner = b.designer !== undefined;
      const designer = mexeDesigner ? String(b.designer || "").trim().toUpperCase().slice(0, 40) : "";
      if (mexeDesigner && !dados) dados = JSON.stringify(Object.assign({}, antesDados, { designer }));
      else if (mexeDesigner) dados = JSON.stringify(Object.assign(JSON.parse(dados), { designer }));
      /* arte criada/recriada sem aprovação: não vai para a produção */
      const aprovFinal = dados ? JSON.parse(dados).aprov : antesDados.aprov;
      if (fila && fila !== atual.fila && bloqueiaFila(aprovFinal, fila)) return res.status(409).json({ erro: MSG_BLOQ, bloqueio: "arte" });
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
      if (fila && fila !== atual.fila) await auditar(sql, sessao, "moveu", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: nomeFila(atual.fila) + " → " + nomeFila(fila) });
      if (arquivado === true && !atual.arquivado) await auditar(sql, sessao, "arquivou", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: "Saiu do quadro (" + nomeFila(linha.fila) + ")" });
      if (arquivado === false && atual.arquivado) await auditar(sql, sessao, "desarquivou", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: "Voltou para " + nomeFila(linha.fila) });
      if (dados) { const m = oQueMudou(dAntes, dDepois); if (m.length) await auditar(sql, sessao, "editou", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: "Mudou: " + m.join(", ") }); }
      if (mexeDesigner && designer !== (antesDados.designer || ""))
        await auditar(sql, sessao, "designer", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: designer ? "Designer da arte: " + designer + (antesDados.designer ? " (era " + antesDados.designer + ")" : "") : "Tirou o designer (" + antesDados.designer + ")" });
      if (mexeArte) await auditar(sql, sessao, "artes", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: "Trocou as artes do pedido" });
      if (ordem != null && !(fila && fila !== atual.fila) && arquivado == null && Number(atual.ordem) !== ordem)
        await auditar(sql, sessao, "reordenou", { pedidoId: id, pedidoNumero: linha.numero, cliente: cli, detalhe: "Mudou a posição em " + nomeFila(linha.fila) });
      return res.status(200).json({ item: saida(linha) });
    }

    if (req.method === "DELETE") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const [apagado] = await sql`DELETE FROM pedidos WHERE id = ${id}::bigint RETURNING fila, dados, numero`;
      if (apagado) await auditar(sql, sessao, "excluiu", { pedidoId: id, pedidoNumero: apagado.numero, cliente: (apagado.dados || {}).cliente || "", detalhe: "Estava em " + nomeFila(apagado.fila) });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
