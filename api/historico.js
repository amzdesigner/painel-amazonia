/*
 * Painel Amazônia Gráfica · histórico de O.S. e recibos no banco (Neon Postgres)
 *
 * GET    /api/historico                  → lista os últimos registros
 * POST   /api/historico                  → grava O.S., recibo ou orçamento e devolve com o número
 *                                           (O.S./recibo: 001/2026…; orçamento: número informado pelo painel)
 * PATCH  /api/historico?id=123           → atualiza status, cliente, valor, peças, quem, uniforme, dados ou arte
 * GET    /api/historico?id=123&arte=1    → devolve só a imagem da arte (O.S. de camisa)
 * DELETE /api/historico?id=123           → remove um registro
 * DELETE /api/historico?tudo=1&tipo=os   → apaga todos os registros daquele tipo
 *
 * Toda chamada precisa do cabeçalho "x-painel-senha" igual à variável PAINEL_SENHA da Vercel.
 * As tabelas são criadas sozinhas na primeira chamada.
 */
import { neon } from "@neondatabase/serverless";

/* aceita o nome padrão e também nomes com prefixo (ex.: STORAGE_DATABASE_URL, NEON_POSTGRES_URL) */
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
      await sql`CREATE TABLE IF NOT EXISTS historico (
        id         BIGSERIAL PRIMARY KEY,
        tipo       TEXT NOT NULL,
        numero     TEXT NOT NULL,
        cliente    TEXT,
        pagador    TEXT,
        pecas      INTEGER NOT NULL DEFAULT 0,
        valor      NUMERIC(12, 2) NOT NULL DEFAULT 0,
        vias       INTEGER NOT NULL DEFAULT 1,
        quem       TEXT,
        uniforme   BOOLEAN NOT NULL DEFAULT FALSE,
        dados      JSONB,
        criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS historico_criado_em ON historico (criado_em DESC)`;
      /* atualizações de estrutura para bancos já criados */
      await sql`ALTER TABLE historico DROP CONSTRAINT IF EXISTS historico_tipo_check`;
      await sql`ALTER TABLE historico ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'producao'`;
      await sql`ALTER TABLE historico ADD COLUMN IF NOT EXISTS arte TEXT`;
      await sql`CREATE TABLE IF NOT EXISTS contadores (
        tipo    TEXT NOT NULL,
        ano     INTEGER NOT NULL,
        ultimo  INTEGER NOT NULL,
        PRIMARY KEY (tipo, ano)
      )`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

const TIPOS = ["os", "recibo", "orcamento", "venda"];
const STATUS = ["producao", "pronta", "entregue"];
const texto = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const inteiro = v => Math.max(0, Math.min(1e6, parseInt(v, 10) || 0));
/* arte da O.S.: undefined = não mexe · "" = remove · data URL de imagem = grava */
const ARTE_MAX = 3500000;
function lerArte(v) {
  if (v === undefined || v === null) return { mexe: false, valor: null };
  if (v === "") return { mexe: true, valor: null };
  if (typeof v !== "string" || v.length > ARTE_MAX || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return { erro: true };
  return { mexe: true, valor: v };
}

function formata(r) {
  return {
    id: String(r.id), tipo: r.tipo, numero: r.numero,
    cliente: r.cliente || "", pagador: r.pagador || "",
    pecas: r.pecas, valor: Number(r.valor), vias: r.vias,
    quem: r.quem || "", time: r.uniforme,
    status: r.status || "producao",
    entrega: (r.dados && r.dados.entregar) || "",
    dados: r.tipo === "orcamento" || r.tipo === "os" || r.tipo === "venda" ? (r.dados || null) : undefined,
    temArte: !!(r.tem_arte || r.arte),
    quando: new Date(r.criado_em).toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (req.headers["x-painel-senha"] !== process.env.PAINEL_SENHA) return res.status(401).json({ erro: "Senha incorreta." });

  try {
    await prepararBanco();

    if (req.method === "GET") {
      if (req.query.arte === "1") {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ erro: "Informe o id." });
        const [linha] = await sql`SELECT arte FROM historico WHERE id = ${id}::bigint`;
        if (!linha) return res.status(404).json({ erro: "Registro não encontrado." });
        return res.status(200).json({ arte: linha.arte || "" });
      }
      const linhas = await sql`
        SELECT id, tipo, numero, cliente, pagador, pecas, valor, vias, quem, uniforme, dados, criado_em, status,
               (arte IS NOT NULL) AS tem_arte
        FROM historico ORDER BY criado_em DESC LIMIT 500`;
      return res.status(200).json({ itens: linhas.map(formata) });
    }

    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : null;
      if (!tipo) return res.status(400).json({ erro: "Tipo inválido." });
      const valor = Math.max(0, Math.min(1e9, Number(b.valor) || 0));
      const dados = b.dados && typeof b.dados === "object" ? JSON.stringify(b.dados) : null;
      if (dados && dados.length > 200000) return res.status(413).json({ erro: "Registro grande demais." });
      const arte = lerArte(b.arte);
      if (arte.erro) return res.status(413).json({ erro: "Imagem da arte inválida ou grande demais." });
      /* orçamento: usa o número que já vem do painel (continua a numeração da gráfica) */
      if (tipo === "orcamento") {
        const numero = texto(b.numero, 30);
        if (!numero) return res.status(400).json({ erro: "Informe o número do orçamento." });
        const [linha] = await sql`
          INSERT INTO historico (tipo, numero, cliente, pagador, pecas, valor, vias, quem, uniforme, dados)
          VALUES ('orcamento', ${numero}::text, ${texto(b.cliente, 120)}::text, '', 0, ${valor}::numeric, 1,
                  ${texto(b.quem, 80)}::text, false, ${dados}::jsonb)
          RETURNING *`;
        return res.status(201).json({ item: formata(linha) });
      }
      /* número sequencial por ano (fuso de Manaus), gerado junto com a gravação */
      const [linha] = await sql`
        WITH ano AS (SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'America/Manaus')::int AS a),
        c AS (
          INSERT INTO contadores (tipo, ano, ultimo)
          SELECT ${tipo}::text, a, 1 FROM ano
          ON CONFLICT (tipo, ano) DO UPDATE SET ultimo = contadores.ultimo + 1
          RETURNING ultimo, ano
        )
        INSERT INTO historico (tipo, numero, cliente, pagador, pecas, valor, vias, quem, uniforme, dados, arte)
        SELECT ${tipo}::text, lpad(c.ultimo::text, 3, '0') || '/' || c.ano::text,
               ${texto(b.cliente, 120)}::text, ${texto(b.pagador, 120)}::text, ${inteiro(b.pecas)}::int, ${valor}::numeric,
               ${Math.max(1, inteiro(b.vias))}::int, ${texto(b.quem, 80)}::text, ${!!b.time}::boolean, ${dados}::jsonb,
               ${arte.valor}::text
        FROM c
        RETURNING *`;
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "PATCH") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const status = b.status == null ? null : (STATUS.includes(b.status) ? b.status : undefined);
      if (status === undefined) return res.status(400).json({ erro: "Status inválido." });
      const cliente = b.cliente == null ? null : texto(b.cliente, 120);
      const valor = b.valor == null ? null : Math.max(0, Math.min(1e9, Number(b.valor) || 0));
      const pecas = b.pecas == null ? null : inteiro(b.pecas);
      const quem = b.quem == null ? null : texto(b.quem, 80);
      const uniforme = b.time == null ? null : !!b.time;
      const dados = b.dados && typeof b.dados === "object" ? JSON.stringify(b.dados) : null;
      if (dados && dados.length > 200000) return res.status(413).json({ erro: "Registro grande demais." });
      const arte = lerArte(b.arte);
      if (arte.erro) return res.status(413).json({ erro: "Imagem da arte inválida ou grande demais." });
      const [linha] = await sql`
        UPDATE historico SET
          status   = COALESCE(${status}::text, status),
          cliente  = COALESCE(${cliente}::text, cliente),
          valor    = COALESCE(${valor}::numeric, valor),
          pecas    = COALESCE(${pecas}::int, pecas),
          quem     = COALESCE(${quem}::text, quem),
          uniforme = COALESCE(${uniforme}::boolean, uniforme),
          dados    = COALESCE(${dados}::jsonb, dados),
          arte     = CASE WHEN ${arte.mexe}::boolean THEN ${arte.valor}::text ELSE arte END
        WHERE id = ${id}::bigint
        RETURNING id, tipo, numero, cliente, pagador, pecas, valor, vias, quem, uniforme, dados, criado_em, status,
                  (arte IS NOT NULL) AS tem_arte`;
      if (!linha) return res.status(404).json({ erro: "Registro não encontrado." });
      return res.status(200).json({ item: formata(linha) });
    }

    if (req.method === "DELETE") {
      if (req.query.tudo === "1") {
        const tipo = TIPOS.includes(req.query.tipo) ? req.query.tipo : null;
        if (!tipo) return res.status(400).json({ erro: "Informe o tipo para apagar." });
        await sql`DELETE FROM historico WHERE tipo = ${tipo}::text`;
        return res.status(200).json({ ok: true });
      }
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      await sql`DELETE FROM historico WHERE id = ${id}::bigint`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
