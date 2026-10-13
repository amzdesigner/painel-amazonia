/*
 * Painel Amazônia Gráfica · configurações compartilhadas (Neon Postgres)
 *
 * GET  /api/config?chave=malharia   → { valor } (null se ainda não foi salva)
 * chaves aceitas: malharia (tabela de preços) e tamanhos_os (tamanhos que vão na O.S.)
 * PUT  /api/config                  → { chave, valor } grava a configuração
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
const CHAVES = ["malharia", "tamanhos_os"];

let preparado = null;
function prepararBanco() {
  if (!preparado) {
    preparado = sql`CREATE TABLE IF NOT EXISTS config (
        chave         TEXT PRIMARY KEY,
        valor         JSONB NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`.catch(e => { preparado = null; throw e; });
  }
  return preparado;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (req.headers["x-painel-senha"] !== process.env.PAINEL_SENHA) return res.status(401).json({ erro: "Senha incorreta." });
  try {
    await prepararBanco();
    if (req.method === "GET") {
      const chave = String(req.query.chave || "");
      if (!CHAVES.includes(chave)) return res.status(400).json({ erro: "Chave inválida." });
      const [r] = await sql`SELECT valor, atualizado_em FROM config WHERE chave = ${chave}::text`;
      return res.status(200).json({ valor: r ? r.valor : null, atualizado: r ? new Date(r.atualizado_em).toISOString() : null });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!CHAVES.includes(b.chave)) return res.status(400).json({ erro: "Chave inválida." });
      if (!b.valor || typeof b.valor !== "object") return res.status(400).json({ erro: "Valor inválido." });
      const txt = JSON.stringify(b.valor);
      if (txt.length > 200000) return res.status(413).json({ erro: "Configuração grande demais." });
      const [r] = await sql`
        INSERT INTO config (chave, valor, atualizado_em) VALUES (${b.chave}::text, ${txt}::jsonb, now())
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()
        RETURNING valor, atualizado_em`;
      return res.status(200).json({ valor: r.valor, atualizado: new Date(r.atualizado_em).toISOString() });
    }
    res.setHeader("Allow", "GET, PUT, POST");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
