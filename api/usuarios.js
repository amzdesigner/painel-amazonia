/*
 * Painel Amazônia Gráfica · usuários (só ADM)
 *
 * GET    /api/usuarios                      → { itens: [{ usuario, papel, ativo, criadoEm, ultimoLogin }] }
 * POST   /api/usuarios  { usuario, senha, papel }          → cria
 * PATCH  /api/usuarios?usuario=GIL  { senha?, papel?, ativo? } → troca senha / nível / ativa ou desativa
 * DELETE /api/usuarios?usuario=GIL                         → apaga
 *
 * Proteções: sempre fica pelo menos um ADM ativo, e ninguém apaga, desativa ou rebaixa a si mesmo.
 * Tudo vai para a auditoria.
 */
import {
  exigirSessao, prepararUsuarios, sqlUsuarios as sql, limpaNome, nomeValido, senhaValida, gerarHash, esquecerCache, permissoes, papelExiste, listarHierarquias
} from "./_auth.js";
import { auditar } from "./_auditoria.js";

const nomePapel = async p => p === "adm" ? "ADM" : ((await permissoes(p)) || {}).nome || p;
const formata = r => ({
  usuario: r.usuario, papel: r.papel, ativo: r.ativo, aprovaArte: !!r.aprova_arte,
  criadoEm: r.criado_em ? new Date(r.criado_em).toISOString() : "",
  ultimoLogin: r.ultimo_login ? new Date(r.ultimo_login).toISOString() : ""
});

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const sessao = await exigirSessao(req, res, ["adm"]);
  if (!sessao) return;
  const corpo = () => { const b = req.body || {}; if (typeof b === "string") { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } } return b; };
  try {
    await prepararUsuarios();
    const admsAtivos = async () => { const [c] = await sql`SELECT count(*)::int AS n FROM usuarios WHERE papel = 'adm' AND ativo`; return Number(c.n) || 0; };

    if (req.method === "GET") {
      const l = await sql`SELECT * FROM usuarios ORDER BY (papel = 'adm') DESC, usuario`;
      return res.status(200).json({ itens: l.map(formata), eu: sessao.usuario, hierarquias: await listarHierarquias() });
    }

    if (req.method === "POST") {
      const b = corpo();
      const usuario = limpaNome(b.usuario), papel = String(b.papel || "producao");
      if (!(await papelExiste(papel))) return res.status(400).json({ erro: "Hierarquia inválida." });
      if (!nomeValido(usuario)) return res.status(400).json({ erro: "Nome de usuário inválido. Use de 2 a 20 letras ou números." });
      if (!senhaValida(b.senha)) return res.status(400).json({ erro: "A senha precisa ter pelo menos 4 caracteres." });
      const h = gerarHash(b.senha);
      const l = await sql`INSERT INTO usuarios (usuario, papel, algo, sal, hash) VALUES (${usuario}::text, ${papel}::text, ${h.algo}::text, ${h.sal}::text, ${h.hash}::text)
                          ON CONFLICT (usuario) DO NOTHING RETURNING *`;
      if (!l.length) return res.status(409).json({ erro: "Já existe um usuário com esse nome." });
      await auditar(sql, sessao, "usuarios", { detalhe: "Criou o usuário " + usuario + " (" + await nomePapel(papel) + ")" });
      return res.status(201).json({ item: formata(l[0]) });
    }

    const alvo = limpaNome(req.query.usuario);
    if (!alvo) return res.status(400).json({ erro: "Informe o usuário." });
    const [atual] = await sql`SELECT * FROM usuarios WHERE usuario = ${alvo}::text`;
    if (!atual) return res.status(404).json({ erro: "Usuário não encontrado." });
    const euMesmo = alvo === sessao.usuario;

    if (req.method === "PATCH") {
      const b = corpo();
      const mud = [];
      let papel = atual.papel, ativo = atual.ativo, h = null;
      if (b.papel != null) {
        if (!(await papelExiste(String(b.papel)))) return res.status(400).json({ erro: "Hierarquia inválida." });
        if (b.papel !== atual.papel) {
          if (euMesmo) return res.status(400).json({ erro: "Você não pode mudar o seu próprio nível." });
          if (atual.papel === "adm" && atual.ativo && await admsAtivos() <= 1) return res.status(400).json({ erro: "Precisa ficar pelo menos um ADM." });
          papel = String(b.papel); mud.push("hierarquia para " + await nomePapel(papel));
        }
      }
      if (b.ativo != null && !!b.ativo !== atual.ativo) {
        if (euMesmo) return res.status(400).json({ erro: "Você não pode desativar o seu próprio usuário." });
        if (!b.ativo && atual.papel === "adm" && await admsAtivos() <= 1) return res.status(400).json({ erro: "Precisa ficar pelo menos um ADM ativo." });
        ativo = !!b.ativo; mud.push(ativo ? "reativou" : "desativou");
      }
      let aprova = !!atual.aprova_arte;
      if (b.aprovaArte != null && !!b.aprovaArte !== aprova) { aprova = !!b.aprovaArte; mud.push(aprova ? "liberou aprovar artes" : "tirou aprovar artes"); }
      if (b.senha != null) {
        if (!senhaValida(b.senha)) return res.status(400).json({ erro: "A senha precisa ter pelo menos 4 caracteres." });
        h = gerarHash(b.senha); mud.push("trocou a senha");
      }
      if (!mud.length) return res.status(200).json({ item: formata(atual) });
      /* só mudou o "aprova artes": não derruba a sessão dele */
      if (mud.length === 1 && b.aprovaArte != null && aprova !== !!atual.aprova_arte) {
        const [l1] = await sql`UPDATE usuarios SET aprova_arte = ${aprova}::boolean, atualizado_em = now() WHERE usuario = ${alvo}::text RETURNING *`;
        esquecerCache(alvo);
        await auditar(sql, sessao, "usuarios", { detalhe: "Usuário " + alvo + ": " + mud.join(", ") });
        return res.status(200).json({ item: formata(l1) });
      }
      /* versao + 1: as sessões abertas desse usuário caem (ele entra de novo com a senha/nível novos) */
      const [l] = h
        ? await sql`UPDATE usuarios SET papel = ${papel}::text, ativo = ${ativo}::boolean, algo = ${h.algo}::text, sal = ${h.sal}::text, hash = ${h.hash}::text, aprova_arte = ${aprova}::boolean,
                    versao = versao + ${euMesmo ? 0 : 1}::int, atualizado_em = now() WHERE usuario = ${alvo}::text RETURNING *`
        : await sql`UPDATE usuarios SET papel = ${papel}::text, ativo = ${ativo}::boolean, aprova_arte = ${aprova}::boolean, versao = versao + 1, atualizado_em = now()
                    WHERE usuario = ${alvo}::text RETURNING *`;
      esquecerCache(alvo);
      await auditar(sql, sessao, "usuarios", { detalhe: "Usuário " + alvo + ": " + mud.join(", ") });
      return res.status(200).json({ item: formata(l) });
    }

    if (req.method === "DELETE") {
      if (euMesmo) return res.status(400).json({ erro: "Você não pode apagar o seu próprio usuário." });
      if (atual.papel === "adm" && atual.ativo && await admsAtivos() <= 1) return res.status(400).json({ erro: "Precisa ficar pelo menos um ADM." });
      await sql`DELETE FROM usuarios WHERE usuario = ${alvo}::text`;
      esquecerCache(alvo);
      await auditar(sql, sessao, "usuarios", { detalhe: "Apagou o usuário " + alvo });
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
