/*
 * Painel Amazônia Gráfica · cadastro de produtos com preço pronto (Neon Postgres)
 *
 * GET    /api/produtos          → lista todos os produtos (ordem alfabética)
 * POST   /api/produtos          → cadastra um produto
 * PATCH  /api/produtos?id=12    → atualiza um produto
 * DELETE /api/produtos?id=12    → remove um produto
 *
 * Toda chamada precisa do cabeçalho "x-painel-senha" igual à variável PAINEL_SENHA da Vercel.
 */
import { neon } from "@neondatabase/serverless";

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
      await sql`CREATE TABLE IF NOT EXISTS produtos (
        id            BIGSERIAL PRIMARY KEY,
        nome          TEXT NOT NULL,
        dados         JSONB NOT NULL DEFAULT '{}'::jsonb,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS produtos_nome ON produtos (lower(nome))`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

/* campos aceitos no cadastro */
const CAMPOS = ["nome", "material", "tamanho", "unidade", "preco", "prazo", "descricao", "obs"];
function limpa(b) {
  const o = {};
  CAMPOS.forEach(c => { o[c] = String(b[c] == null ? "" : b[c]).trim().slice(0, c === "obs" || c === "descricao" ? 2000 : 200); });
  const p = Number(String(o.preco).replace(",", "."));
  o.preco = Number.isFinite(p) && p >= 0 ? p.toFixed(2) : "";
  return o;
}
function formata(r) {
  return Object.assign({}, r.dados || {}, {
    id: String(r.id), nome: r.nome,
    criado: new Date(r.criado_em).toISOString(), atualizado: new Date(r.atualizado_em).toISOString()
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (req.headers["x-painel-senha"] !== process.env.PAINEL_SENHA) return res.status(401).json({ erro: "Senha incorreta." });

  try {
    await prepararBanco();
    const corpo = () => (typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}));

    if (req.method === "GET") {
      const linhas = await sql`SELECT * FROM produtos ORDER BY lower(nome) LIMIT 5000`;
      return res.status(200).json({ itens: linhas.map(formata) });
    }

    if (req.method === "POST") {
      const d = limpa(corpo());
      if (!d.nome) return res.status(400).json({ erro: "Informe o nome do produto." });
      const [linha] = await sql`
        INSERT INTO produtos (nome, dados)
        VALUES (${d.nome}::text, ${JSON.stringify(d)}::jsonb)
        RETURNING *`;
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "PATCH") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const d = limpa(corpo());
      if (!d.nome) return res.status(400).json({ erro: "Informe o nome do produto." });
      const [linha] = await sql`
        UPDATE produtos SET nome = ${d.nome}::text,
               dados = ${JSON.stringify(d)}::jsonb, atualizado_em = now()
        WHERE id = ${id}::bigint
        RETURNING *`;
      if (!linha) return res.status(404).json({ erro: "Produto não encontrado." });
      return res.status(200).json({ item: formata(linha) });
    }

    if (req.method === "DELETE") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      await sql`DELETE FROM produtos WHERE id = ${id}::bigint`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
