/*
 * Painel Amazônia Gráfica · ativar notificações no aparelho
 *
 * GET    /api/push                     → { ligado, chave, aparelhos } (a chave pública para o navegador)
 * POST   /api/push  { sub, aparelho }  → guarda este aparelho para o usuário logado
 * POST   /api/push?teste=1             → manda uma notificação de teste para os meus aparelhos
 * DELETE /api/push  { endpoint }       → tira este aparelho
 */
import { exigirSessao, prepararUsuarios, sqlUsuarios as sql } from "./_auth.js";
import { chavePublica, pushLigado, enviarPara } from "./_push.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const sessao = await exigirSessao(req, res, null);
  if (!sessao) return;
  if (sessao.somenteVer) return res.status(403).json({ erro: "O TABLET não recebe notificações. Entre com o seu usuário." });
  const corpo = () => { const b = req.body || {}; if (typeof b === "string") { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } } return b; };
  const eu = sessao.usuario;
  try {
    await prepararUsuarios();
    if (req.method === "GET") {
      const [c] = await sql`SELECT count(*)::int AS n FROM push_subs WHERE usuario = ${eu}::text`;
      const [u] = await sql`SELECT notif_filas FROM usuarios WHERE usuario = ${eu}::text`;
      return res.status(200).json({ ligado: pushLigado(), chave: chavePublica(), aparelhos: Number(c.n) || 0, filas: (u && u.notif_filas) || [] });
    }
    if (req.method === "POST" && req.query.teste === "1") {
      const n = await enviarPara(sql, [eu], { titulo: "Teste do Painel Amazônia", corpo: "Se você está vendo isso, as notificações estão funcionando neste aparelho. 👍", url: "/", tag: "teste" });
      return res.status(200).json({ enviados: n });
    }
    if (req.method === "POST") {
      const b = corpo(), s = b.sub || {};
      if (!pushLigado()) return res.status(503).json({ erro: "As notificações ainda não foram configuradas na Vercel (VAPID_PUBLIC / VAPID_PRIVATE)." });
      if (typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ erro: "Aparelho inválido." });
      const aparelho = String(b.aparelho || "").slice(0, 120);
      await sql`INSERT INTO push_subs (endpoint, usuario, chaves, aparelho) VALUES (${s.endpoint}::text, ${eu}::text, ${JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth })}::jsonb, ${aparelho}::text)
                ON CONFLICT (endpoint) DO UPDATE SET usuario = EXCLUDED.usuario, chaves = EXCLUDED.chaves, aparelho = EXCLUDED.aparelho, criado_em = now()`;
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      const b = corpo();
      if (b.endpoint) await sql`DELETE FROM push_subs WHERE endpoint = ${String(b.endpoint)}::text AND usuario = ${eu}::text`;
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
