/*
 * Painel Amazônia Gráfica · cadastro de clientes (Neon Postgres)
 *
 * GET    /api/clientes          → lista todos os clientes (ordem alfabética)
 * POST   /api/clientes          → cadastra um cliente
 *        { lote: [...], atualizar: [{ id, ... }] } → importa vários de uma vez (planilha)
 * PATCH  /api/clientes?id=12    → atualiza um cliente
 * DELETE /api/clientes?id=12    → remove um cliente
 * DELETE /api/clientes?tudo=1   → apaga todos os clientes
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
      await sql`CREATE TABLE IF NOT EXISTS clientes (
        id            BIGSERIAL PRIMARY KEY,
        nome          TEXT NOT NULL,
        documento     TEXT,
        dados         JSONB NOT NULL DEFAULT '{}'::jsonb,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS clientes_nome ON clientes (lower(nome))`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

/* campos aceitos no cadastro */
const CAMPOS = ["nome", "tipo", "razao", "fantasia", "cnpj", "cpf", "documento", "ie", "im", "cep", "logradouro", "numero",
  "complemento", "bairro", "cidade", "uf", "tel1", "tel2", "email", "contato", "obs"];
function limpa(b) {
  const o = {};
  CAMPOS.forEach(c => { o[c] = String(b[c] == null ? "" : b[c]).trim().slice(0, c === "obs" ? 2000 : 200); });
  /* CNPJ e CPF ficam separados; "documento" guarda o principal para busca e compatibilidade */
  o.documento = o.cnpj || o.cpf || o.documento;
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
      const linhas = await sql`SELECT * FROM clientes ORDER BY lower(nome) LIMIT 5000`;
      return res.status(200).json({ itens: linhas.map(formata) });
    }

    if (req.method === "POST" && (Array.isArray(corpo().lote) || Array.isArray(corpo().atualizar))) {
      const b = corpo();
      const novos = (b.lote || []).slice(0, 1000).map(limpa).filter(d => d.nome);
      const atual = (b.atualizar || []).slice(0, 1000)
        .map(x => Object.assign(limpa(x), { id: String(parseInt(x && x.id, 10) || "") }))
        .filter(d => d.nome && d.id);
      let criados = [], atualizados = [];
      if (novos.length) {
        criados = await sql`
          INSERT INTO clientes (nome, documento, dados)
          SELECT e->>'nome', e->>'documento', e FROM jsonb_array_elements(${JSON.stringify(novos)}::jsonb) AS e
          RETURNING *`;
      }
      if (atual.length) {
        atualizados = await sql`
          UPDATE clientes AS c SET nome = e->>'nome', documento = e->>'documento', dados = e - 'id', atualizado_em = now()
          FROM jsonb_array_elements(${JSON.stringify(atual)}::jsonb) AS e
          WHERE c.id = (e->>'id')::bigint
          RETURNING c.*`;
      }
      return res.status(200).json({ criados: criados.map(formata), atualizados: atualizados.map(formata) });
    }

    if (req.method === "POST") {
      const d = limpa(corpo());
      if (!d.nome) return res.status(400).json({ erro: "Informe o nome do cliente." });
      const [linha] = await sql`
        INSERT INTO clientes (nome, documento, dados)
        VALUES (${d.nome}::text, ${d.documento}::text, ${JSON.stringify(d)}::jsonb)
        RETURNING *`;
      return res.status(201).json({ item: formata(linha) });
    }

    if (req.method === "PATCH") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      const d = limpa(corpo());
      if (!d.nome) return res.status(400).json({ erro: "Informe o nome do cliente." });
      const [linha] = await sql`
        UPDATE clientes SET nome = ${d.nome}::text, documento = ${d.documento}::text,
               dados = ${JSON.stringify(d)}::jsonb, atualizado_em = now()
        WHERE id = ${id}::bigint
        RETURNING *`;
      if (!linha) return res.status(404).json({ erro: "Cliente não encontrado." });
      return res.status(200).json({ item: formata(linha) });
    }

    if (req.method === "DELETE") {
      if (req.query.tudo === "1") {
        const r = await sql`DELETE FROM clientes RETURNING id`;
        return res.status(200).json({ ok: true, apagados: r.length });
      }
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      await sql`DELETE FROM clientes WHERE id = ${id}::bigint`;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
