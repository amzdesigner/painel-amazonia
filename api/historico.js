/*
 * Painel Amazônia Gráfica · histórico de O.S. e recibos no banco (Neon Postgres)
 *
 * GET    /api/historico           → lista os últimos registros
 * POST   /api/historico           → grava uma O.S. ou recibo e devolve com o número (001/2026…)
 * DELETE /api/historico?id=123    → remove um registro
 * DELETE /api/historico?tudo=1    → apaga todo o histórico
 *
 * Toda chamada precisa do cabeçalho "x-painel-senha" igual à variável PAINEL_SENHA da Vercel.
 * As tabelas são criadas sozinhas na primeira chamada.
 */
import { neon } from "@neondatabase/serverless";

const URL_BANCO = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = URL_BANCO ? neon(URL_BANCO) : null;

let preparado = null;
function prepararBanco() {
  if (!preparado) {
    preparado = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS historico (
        id         BIGSERIAL PRIMARY KEY,
        tipo       TEXT NOT NULL CHECK (tipo IN ('os', 'recibo')),
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

const texto = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const inteiro = v => Math.max(0, Math.min(1e6, parseInt(v, 10) || 0));

function formata(r) {
  return {
    id: String(r.id), tipo: r.tipo, numero: r.numero,
    cliente: r.cliente || "", pagador: r.pagador || "",
    pecas: r.pecas, valor: Number(r.valor), vias: r.vias,
    quem: r.quem || "", time: r.uniforme,
    quando: new Date(r.criado_em).toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)." });
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (req.headers["x-painel-senha"] !== process.env.PAINEL_SENHA) return res.status(401).json({ erro: "Senha incorreta." });

  try {
    await prepararBanco();

    if (req.method === "GET") {
      const linhas = await sql`SELECT * FROM historico ORDER BY criado_em DESC LIMIT 500`;
      return res.status(200).json({ itens: linhas.map(formata) });
    }

    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const tipo = b.tipo === "recibo" ? "recibo" : b.tipo === "os" ? "os" : null;
      if (!tipo) return res.status(400).json({ erro: "Tipo inválido." });
      const valor = Math.max(0, Math.min(1e9, Number(b.valor) || 0));
      const dados = b.dados && typeof b.dados === "object" ? JSON.stringify(b.dados).slice(0, 50000) : null;
      /* número sequencial por ano (fuso de Manaus), gerado junto com a gravação */
      const [linha] = await sql`
        WITH ano AS (SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'America/Manaus')::int AS a),
        c AS (
          INSERT INTO contadores (tipo, ano, ultimo)
          SELECT ${tipo}::text, a, 1 FROM ano
          ON CONFLICT (tipo, ano) DO UPDATE SET ultimo = contadores.ultimo + 1
          RETURNING ultimo, ano
        )
        INSERT INTO historico (tipo, numero, cliente, pagador, pecas, valor, vias, quem, uniforme, dados)
        SELECT ${tipo}::text, lpad(c.ultimo::text, 3, '0') || '/' || c.ano::text,
               ${texto(b.cliente, 120)}::text, ${texto(b.pagador, 120)}::text, ${inteiro(b.pecas)}::int, ${valor}::numeric,
               ${Math.max(1, inteiro(b.vias))}::int, ${texto(b.quem, 80)}::text, ${!!b.time}::boolean, ${dados}::jsonb
        FROM c
        RETURNING *`;
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "DELETE") {
      if (req.query.tudo === "1") {
        await sql`DELETE FROM historico`;
        return res.status(200).json({ ok: true });
      }
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      await sql`DELETE FROM historico WHERE id = ${id}::bigint`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
