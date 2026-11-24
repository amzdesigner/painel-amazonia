/*
 * Painel Amazônia Gráfica · hierarquias (só ADM)
 *
 * Uma hierarquia diz o que cada usuário vê no painel:
 *   abas    → abas do menu (visao, ped, rel, prod, mal, os, cli, orc, recibo, calc, aud)
 *   pedidos → "producao" (só move entre as filas a partir do designer) ou "completo" (vê o atendimento, cria e edita)
 *   valores → se vê os valores de venda nos pedidos
 *   filas   → quais filas do quadro de pedidos ele vê (null = todas)
 * A hierarquia ADM é fixa (vê tudo) e não aparece aqui. Usuários e Hierarquia são só do ADM.
 *
 * GET    /api/hierarquias                         → { itens: [...] }
 * POST   /api/hierarquias  { nome, abas, pedidos, valores }  → cria
 * PATCH  /api/hierarquias?id=atendente  { nome?, abas?, pedidos?, valores? }
 * DELETE /api/hierarquias?id=atendente            → só se nenhum usuário usar
 */
import { exigirSessao, prepararUsuarios, sqlUsuarios as sql, listarHierarquias, limpaHierarquia, esquecerHierarquias, ABAS } from "./_auth.js";
import { auditar } from "./_auditoria.js";

const NOMES_ABA = { visao: "Visão geral", ped: "Pedidos", rel: "Relatórios", prod: "Produtos", mal: "Malharia", os: "O.S Camisa",
  cli: "Clientes", orc: "Orçamento", recibo: "Recibo", calc: "Calculadora", aud: "Auditoria" };
const limpaNomeH = v => String(v || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 30);
const idDe = nome => nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
const NOMES_FILA = { atendimento: "Atendimento", designer: "Designer", impressao: "Impressão", acabamento: "Acabamento", costura: "Costura", pronto: "Pronto", entregue: "Entregue" };
const resumo = h => h.abas.map(a => NOMES_ABA[a] || a).join(", ") + (h.abas.includes("ped") ? " · pedidos " + (h.pedidos === "completo" ? "completo" : "produção") + (h.valores ? " com valores" : " sem valores") +
  (h.filas ? " · só as filas: " + h.filas.map(f => NOMES_FILA[f] || f).join(", ") : " · todas as filas") : "");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const sessao = await exigirSessao(req, res, ["adm"]);
  if (!sessao) return;
  const corpo = () => { const b = req.body || {}; if (typeof b === "string") { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } } return b; };
  try {
    await prepararUsuarios();
    if (req.method === "GET") return res.status(200).json({ itens: await listarHierarquias(), abas: ABAS });

    if (req.method === "POST") {
      const b = corpo(), nome = limpaNomeH(b.nome), id = idDe(nome);
      if (!nome || !id || id === "adm") return res.status(400).json({ erro: "Dê um nome para a hierarquia (ex.: ATENDENTE)." });
      const h = limpaHierarquia(b);
      if (!h.abas.length) return res.status(400).json({ erro: "Marque pelo menos uma aba." });
      const l = await sql`INSERT INTO hierarquias (id, nome, abas, pedidos, valores, filas) VALUES (${id}::text, ${nome}::text, ${JSON.stringify(h.abas)}::jsonb, ${h.pedidos}::text, ${h.valores}::boolean, ${h.filas ? JSON.stringify(h.filas) : null}::jsonb)
                          ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (!l.length) return res.status(409).json({ erro: "Já existe uma hierarquia com esse nome." });
      esquecerHierarquias();
      await auditar(sql, sessao, "usuarios", { detalhe: "Criou a hierarquia " + nome + ": " + resumo(h) });
      return res.status(201).json({ id });
    }

    const id = String(req.query.id || "");
    const [atual] = await sql`SELECT * FROM hierarquias WHERE id = ${id}::text`;
    if (!atual) return res.status(404).json({ erro: "Hierarquia não encontrada." });

    if (req.method === "PATCH") {
      const b = corpo();
      const nome = b.nome != null ? limpaNomeH(b.nome) : atual.nome;
      if (!nome) return res.status(400).json({ erro: "Dê um nome para a hierarquia." });
      const h = limpaHierarquia({ abas: b.abas != null ? b.abas : atual.abas, pedidos: b.pedidos != null ? b.pedidos : atual.pedidos, valores: b.valores != null ? b.valores : atual.valores,
        filas: b.filas !== undefined ? b.filas : atual.filas });
      if (!h.abas.length) return res.status(400).json({ erro: "Marque pelo menos uma aba." });
      await sql`UPDATE hierarquias SET nome = ${nome}::text, abas = ${JSON.stringify(h.abas)}::jsonb, pedidos = ${h.pedidos}::text, valores = ${h.valores}::boolean,
                filas = ${h.filas ? JSON.stringify(h.filas) : null}::jsonb, atualizado_em = now()
                WHERE id = ${id}::text`;
      esquecerHierarquias();
      await auditar(sql, sessao, "usuarios", { detalhe: "Mudou a hierarquia " + nome + ": " + resumo(h) });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const [c] = await sql`SELECT count(*)::int AS n FROM usuarios WHERE papel = ${id}::text`;
      if (Number(c.n)) return res.status(400).json({ erro: "Ainda tem " + c.n + (Number(c.n) === 1 ? " usuário" : " usuários") + " nessa hierarquia. Mude a hierarquia deles antes de apagar." });
      await sql`DELETE FROM hierarquias WHERE id = ${id}::text`;
      esquecerHierarquias();
      await auditar(sql, sessao, "usuarios", { detalhe: "Apagou a hierarquia " + atual.nome });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
