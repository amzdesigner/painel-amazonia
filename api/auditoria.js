/*
 * Painel Amazônia Gráfica · auditoria (só ADM)
 *
 * GET /api/auditoria            → { itens: [...], dias: 7 }  (mais novos primeiro, últimos 7 dias)
 * GET /api/auditoria?depois=ID  → só o que entrou depois do registro ID (para atualizar em tempo real)
 *
 * Cada item: { id, quando, usuario, papel, acao, pedidoId, cliente, detalhe }
 * O que tem mais de 7 dias é apagado sozinho.
 */
import { neon } from "@neondatabase/serverless";
import { exigirSessao } from "./_auth.js";
import { prepararAuditoria, limparAuditoria, DIAS_AUDITORIA } from "./_auditoria.js";

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
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  if (!(await exigirSessao(req, res, ["aud"]))) return;
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ erro: "Método não permitido." }); }
  try {
    await prepararAuditoria(sql);
    await limparAuditoria(sql);
    const depois = parseInt(req.query.depois, 10) || 0;
    const linhas = depois
      ? await sql`SELECT * FROM auditoria WHERE id > ${depois}::bigint ORDER BY id DESC LIMIT 500`
      : await sql`SELECT * FROM auditoria ORDER BY id DESC LIMIT 5000`;
    return res.status(200).json({
      dias: DIAS_AUDITORIA,
      agora: new Date().toISOString(),
      itens: linhas.map(r => ({
        id: String(r.id), quando: r.quando, usuario: r.usuario, papel: r.papel, acao: r.acao,
        pedidoId: r.pedido_id == null ? "" : String(r.pedido_id), pedidoNumero: r.pedido_numero || "", cliente: r.cliente, detalhe: r.detalhe
      }))
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
