/*
 * Painel Amazônia Gráfica · versão publicada
 *
 * GET /api/versao → { versao }   (o vercel.json manda para /api/config?__versao=1)
 * A Vercel coloca o código do commit em cada publicação (VERCEL_GIT_COMMIT_SHA).
 * O painel aberto pergunta isso de tempos em tempos: se mudou, mostra o aviso
 * "Atualização disponível — Recarregar".
 */
export function versaoHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || "";
  return res.status(200).json({ versao: v ? String(v).slice(0, 40) : null });
}
