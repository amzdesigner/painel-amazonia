/*
 * Painel Amazônia Gráfica · rascunhos de pedido
 *
 * Ao fechar um pedido novo sem criar, a pessoa pode "Salvar rascunho".
 * Cada rascunho é só de quem salvou: ninguém mais vê (nem o ADM).
 *
 * GET    /api/rascunhos            → { itens: [{ id, resumo, criadoEm, atualizadoEm }] } (os meus, sem as artes)
 * GET    /api/rascunhos?id=5       → { item: { id, dados, fila, artes } }
 * POST   /api/rascunhos  { id?, dados, fila, artes } → cria ou atualiza (o meu) → { id }
 * DELETE /api/rascunhos?id=5       → apaga (o meu)
 */
import { exigirSessao, pode, sqlUsuarios as sql } from "./_auth.js";

const MAX_POR_USUARIO = 30;
const MAX_TXT = 4200000;
let preparado = null;
function preparar() {
  if (!preparado) {
    preparado = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS rascunhos (
        id            BIGSERIAL PRIMARY KEY,
        usuario       TEXT NOT NULL,
        dados         JSONB NOT NULL DEFAULT '{}'::jsonb,
        fila          TEXT,
        artes         TEXT,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS rascunhos_usuario ON rascunhos (usuario, atualizado_em DESC)`;
    })().catch(e => { preparado = null; throw e; });
  }
  return preparado;
}
function resumo(d) {
  d = d || {};
  const itens = Array.isArray(d.itens) ? d.itens : [];
  return {
    cliente: String(d.cliente || "").slice(0, 80),
    material: itens.map(i => i && i.material).filter(Boolean).join(" + ").slice(0, 120) || String(d.material || "").slice(0, 120),
    preco: String(d.preco || ""),
    empresa: d.empresa === "soares" ? "soares" : "amazonia",
    qtdArtes: 0
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const sessao = await exigirSessao(req, res, null);
  if (!sessao) return;
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  if (sessao.somenteVer || !pode(sessao, ["ped"])) return res.status(403).json({ erro: "Sem acesso aos rascunhos." });
  const eu = sessao.usuario;
  const corpo = () => { const b = req.body || {}; if (typeof b === "string") { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } } return b; };
  try {
    await preparar();
    if (req.method === "GET") {
      const id = parseInt(req.query.id, 10);
      if (id) {
        const [r] = await sql`SELECT id, dados, fila, artes, criado_em, atualizado_em FROM rascunhos WHERE id = ${id}::bigint AND usuario = ${eu}::text`;
        if (!r) return res.status(404).json({ erro: "Rascunho não encontrado." });
        let artes = [];
        try { artes = r.artes ? (typeof r.artes === "string" ? JSON.parse(r.artes) : r.artes) : []; } catch (e) { artes = []; }
        return res.status(200).json({ item: { id: String(r.id), dados: r.dados || {}, fila: r.fila || "atendimento", artes } });
      }
      const l = await sql`SELECT id, dados, fila, (artes IS NOT NULL AND artes <> '[]') AS tem_arte, criado_em, atualizado_em
                          FROM rascunhos WHERE usuario = ${eu}::text ORDER BY atualizado_em DESC LIMIT 50`;
      return res.status(200).json({ itens: l.map(r => Object.assign(resumo(r.dados), {
        id: String(r.id), fila: r.fila || "atendimento", temArte: !!r.tem_arte,
        criadoEm: new Date(r.criado_em).toISOString(), atualizadoEm: new Date(r.atualizado_em).toISOString()
      })) });
    }
    if (req.method === "POST") {
      const b = corpo();
      const dados = b.dados && typeof b.dados === "object" ? b.dados : {};
      const fila = String(b.fila || "atendimento").slice(0, 40);
      const artes = Array.isArray(b.artes) ? b.artes.filter(a => a && typeof a.img === "string" && a.img.startsWith("data:image/")).slice(0, 12) : [];
      const txtArtes = JSON.stringify(artes);
      const txtDados = JSON.stringify(dados);
      if (txtDados.length + txtArtes.length > MAX_TXT) return res.status(413).json({ erro: "Rascunho grande demais (muitas artes pesadas)." });
      const id = parseInt(b.id, 10);
      if (id) {
        const [r] = await sql`UPDATE rascunhos SET dados = ${txtDados}::jsonb, fila = ${fila}::text, artes = ${artes.length ? txtArtes : null}::text, atualizado_em = now()
                              WHERE id = ${id}::bigint AND usuario = ${eu}::text RETURNING id`;
        if (r) return res.status(200).json({ id: String(r.id) });
      }
      const [c] = await sql`SELECT count(*)::int AS n FROM rascunhos WHERE usuario = ${eu}::text`;
      if (Number(c.n) >= MAX_POR_USUARIO) return res.status(409).json({ erro: "Você já tem " + MAX_POR_USUARIO + " rascunhos. Apague alguns antes." });
      const [r] = await sql`INSERT INTO rascunhos (usuario, dados, fila, artes) VALUES (${eu}::text, ${txtDados}::jsonb, ${fila}::text, ${artes.length ? txtArtes : null}::text) RETURNING id`;
      return res.status(201).json({ id: String(r.id) });
    }
    if (req.method === "DELETE") {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ erro: "Informe o id." });
      await sql`DELETE FROM rascunhos WHERE id = ${id}::bigint AND usuario = ${eu}::text`;
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
