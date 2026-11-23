/*
 * Painel Amazônia Gráfica · login
 *
 * POST /api/login  { usuario, senha }  → { token, usuario, papel, exp }
 * GET  /api/login  (com o cabeçalho x-painel-token) → { usuario, papel } se a sessão ainda vale
 * Entradas e senhas erradas vão para a auditoria.
 */
import { neon } from "@neondatabase/serverless";
import { conferirLogin, criarToken, lerSessao, USUARIOS } from "./_auth.js";
import { auditar } from "./_auditoria.js";

function acharUrlBanco() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const chave = Object.keys(env).find(k => /(^|_)DATABASE_URL$/.test(k) && !/UNPOOLED/.test(k))
             || Object.keys(env).find(k => /(^|_)POSTGRES_URL$/.test(k));
  return chave ? env[chave] : "";
}
const url = acharUrlBanco();
const sql = url ? neon(url) : null;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });

  if (req.method === "GET") {
    const s = lerSessao(req);
    if (!s) return res.status(401).json({ erro: "Sessão expirada. Entre de novo." });
    return res.status(200).json(s);
  }
  if (req.method === "POST") {
    let b = req.body || {};
    if (typeof b === "string") { try { b = JSON.parse(b || "{}"); } catch (e) { b = {}; } }
    const ok = conferirLogin(b.usuario, b.senha);
    if (!ok) {
      const nome = String(b.usuario || "").trim().toUpperCase().slice(0, 40);
      if (sql && USUARIOS[nome]) await auditar(sql, { usuario: nome, papel: USUARIOS[nome].papel }, "senha errada", { detalhe: "Tentativa de entrar com senha errada" });
      await new Promise(r => setTimeout(r, 600)); /* atrasa quem tenta adivinhar */
      return res.status(401).json({ erro: "Usuário ou senha incorretos." });
    }
    const { token, exp } = criarToken(ok.usuario, ok.papel);
    if (sql) await auditar(sql, ok, "entrou", { detalhe: "Entrou no painel" });
    return res.status(200).json({ token, exp, usuario: ok.usuario, papel: ok.papel });
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ erro: "Método não permitido." });
}
