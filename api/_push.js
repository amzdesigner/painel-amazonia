/*
 * Painel Amazônia Gráfica · notificações no celular (Web Push)
 *
 * Precisa de duas variáveis na Vercel (Settings → Environment Variables):
 *   VAPID_PUBLIC  e  VAPID_PRIVATE   (o par de chaves de notificação)
 * Sem elas, nada é enviado e o resto do painel funciona normal.
 *
 * Quem recebe: em Usuários, o ADM marca as filas que avisam cada pessoa (coluna usuarios.notif_filas).
 * Cada pessoa ativa as notificações no próprio aparelho (tabela push_subs).
 */
import webpush from "web-push";

const PUB = process.env.VAPID_PUBLIC || "", PRIV = process.env.VAPID_PRIVATE || "";
let pronto = false;
function preparar() {
  if (pronto || !PUB || !PRIV) return pronto;
  webpush.setVapidDetails(process.env.VAPID_EMAIL || "mailto:contato@amazoniagrafica.com.br", PUB, PRIV);
  pronto = true;
  return pronto;
}
export const chavePublica = () => PUB;
export const pushLigado = () => !!(PUB && PRIV);

/* envia para todos os aparelhos de uma lista de usuários; apaga aparelhos que não existem mais */
export async function enviarPara(sql, usuarios, msg) {
  if (!preparar() || !usuarios.length) return 0;
  const subs = await sql`SELECT endpoint, chaves FROM push_subs WHERE usuario = ANY(${usuarios}::text[])`;
  if (!subs.length) return 0;
  const corpo = JSON.stringify(msg);
  let ok = 0;
  await Promise.race([
    Promise.allSettled(subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: typeof s.chaves === "string" ? JSON.parse(s.chaves) : s.chaves }, corpo, { TTL: 6 * 3600, urgency: "high" });
        ok++;
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { try { await sql`DELETE FROM push_subs WHERE endpoint = ${s.endpoint}::text`; } catch (x) {} }
        else console.error("push falhou", (e && (e.statusCode || e.code || e.message)) || e);
      }
    })),
    new Promise(r => setTimeout(r, 6000))          /* não segura o pedido por muito tempo */
  ]);
  return ok;
}

/* um pedido chegou numa fila: avisa quem marcou essa fila (menos quem mexeu) */
export async function avisarFila(sql, pedido, fila, nomeFila, quem) {
  try {
    if (!pushLigado()) return;
    const l = await sql`SELECT usuario FROM usuarios WHERE ativo AND notif_filas IS NOT NULL AND notif_filas ? ${fila}::text AND usuario <> ${quem || ""}::text`;
    if (!l.length) return;
    const d = pedido.dados || {};
    const itens = Array.isArray(d.itens) ? d.itens : [];
    const mat = itens.map(i => i && i.material).filter(Boolean).join(" + ") || d.material || "";
    await enviarPara(sql, l.map(r => r.usuario), {
      titulo: "Pedido #" + (pedido.numero || pedido.id) + " → " + nomeFila,
      corpo: [d.cliente, mat].filter(Boolean).join(" · ").slice(0, 160) + (d.prioridade === "urgente" ? " · URGENTE" : ""),
      url: "/?pedido=" + pedido.id,
      tag: "pedido-" + pedido.id
    });
  } catch (e) { console.error("avisarFila", e); }
}
