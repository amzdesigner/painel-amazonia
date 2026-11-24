/*
 * Painel Amazônia Gráfica · configurações compartilhadas (Neon Postgres)
 *
 * GET  /api/config?chave=malharia   → { valor } (null se ainda não foi salva)
 * chaves aceitas: malharia (tabela de preços) tamanhos_os (tamanhos que vão na O.S.), atualcard (valores da calculadora Atual Card)
 *                 e filas (filas personalizadas do quadro de pedidos, só o ADM grava)
 * PUT  /api/config                  → { chave, valor } grava a configuração
 *
 * Toda chamada precisa estar logada (cabeçalho "x-painel-token", ver api/login.js).
 * Só o usuário ADM tem acesso.
 */
import { neon } from "@neondatabase/serverless";
import { exigirSessao, pode } from "./_auth.js";
import { limpaFilasCfg, esquecerFilas } from "./_filas.js";
/* que abas leem / gravam cada configuração */
const LER = { malharia: ["mal", "orc", "_pedCompleto"], tamanhos_os: ["os", "ped"], atualcard: ["calc"], filas: ["ped", "visao", "rel"] };
/* "_adm": só o ADM grava (as filas do quadro) */
const GRAVAR = { malharia: ["mal"], tamanhos_os: ["os"], atualcard: ["calc"], filas: ["_adm"] };

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
const CHAVES = ["malharia", "tamanhos_os", "atualcard", "filas"];

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
  const sessao = await exigirSessao(req, res, null);
  if (!sessao) return;
  const negado = () => res.status(403).json({ erro: "Seu usuário não tem acesso a isso." });
  try {
    await prepararBanco();
    if (req.method === "GET") {
      const chave = String(req.query.chave || "");
      if (!CHAVES.includes(chave)) return res.status(400).json({ erro: "Chave inválida." });
      const ler = LER[chave].filter(a => a !== "_pedCompleto");
      if (!(pode(sessao, ler) || (LER[chave].includes("_pedCompleto") && sessao.pedidos === "completo" && pode(sessao, ["ped"])))) return negado();
      const [r] = await sql`SELECT valor, atualizado_em FROM config WHERE chave = ${chave}::text`;
      return res.status(200).json({ valor: r ? r.valor : null, atualizado: r ? new Date(r.atualizado_em).toISOString() : null });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (!CHAVES.includes(b.chave)) return res.status(400).json({ erro: "Chave inválida." });
      if (!pode(sessao, GRAVAR[b.chave])) return negado();
      if (!b.valor || typeof b.valor !== "object") return res.status(400).json({ erro: "Valor inválido." });
      if (b.chave === "filas") { b.valor = limpaFilasCfg(b.valor); if (!b.valor) return res.status(400).json({ erro: "Filas inválidas." }); esquecerFilas(); }
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
