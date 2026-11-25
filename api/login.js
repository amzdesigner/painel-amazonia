/*
 * Painel Amazônia Gráfica · login
 *
 * POST /api/login  { usuario, senha }  → { token, usuario, papel, exp }
 * GET  /api/login  (com o cabeçalho x-painel-token) → { usuario, papel } se a sessão ainda vale
 * GET  /api/login?equipe=1 → { nomes } usuários ativos que não são ADM (quem faz o acabamento)
 * GET  /api/login?producao=1 (TABLET/produção/ADM logado) → { nomes } usuários da hierarquia PRODUÇÃO
 * Entradas e senhas erradas vão para a auditoria.
 */
import { conferirLogin, criarToken, lerSessao, papelDe, limpaNome, permissoes, sqlUsuarios as sql, prepararUsuarios, USUARIO_TABLET, PAPEL_TABLET, TABLET_HORAS, PERM_TABLET } from "./_auth.js";
import { auditar } from "./_auditoria.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  try {
    if (req.method === "GET") {
      const s = await lerSessao(req);
      if (!s) return res.status(401).json({ erro: "Sessão expirada. Entre de novo." });
      /* equipe (todos os usuários ativos que não são ADM): para marcar quem faz o acabamento */
      if (req.query && req.query.equipe === "1") {
        if (s.somenteVer) return res.status(403).json({ erro: "Sem acesso." });
        await prepararUsuarios();
        const l = await sql`SELECT usuario FROM usuarios WHERE ativo AND papel <> 'adm' ORDER BY usuario`;
        return res.status(200).json({ nomes: l.map(r => r.usuario) });
      }
      /* lista dos usuários da PRODUÇÃO (para o "Trocar usuário" do tablet) */
      if (req.query && req.query.producao === "1") {
        if (!(s.adm || s.papel === "tablet" || s.papel === "producao")) return res.status(403).json({ erro: "Sem acesso." });
        await prepararUsuarios();
        const l = await sql`SELECT usuario FROM usuarios WHERE ativo AND papel = 'producao' ORDER BY usuario`;
        return res.status(200).json({ nomes: l.map(r => r.usuario) });
      }
      return res.status(200).json({ usuario: s.usuario, papel: s.papel, perm: { nome: s.nomePapel, abas: s.abas, pedidos: s.pedidos, valores: s.valores, filas: s.filas, aprovaArte: s.aprovaArte, somenteVer: !!s.somenteVer, verAtendimento: !!s.verAtendimento } });
    }
    if (req.method === "POST") {
      let b = req.body || {};
      if (typeof b === "string") { try { b = JSON.parse(b || "{}"); } catch (e) { b = {}; } }
      /* TABLET (Produção): sem senha, só para ver */
      if (b.tablet === true) {
        const { token, exp } = criarToken(USUARIO_TABLET, PAPEL_TABLET, 1, TABLET_HORAS);
        await auditar(sql, { usuario: USUARIO_TABLET, papel: PAPEL_TABLET }, "entrou", { detalhe: "Entrou como TABLET (Produção), só para ver" });
        return res.status(200).json({ token, exp, usuario: USUARIO_TABLET, papel: PAPEL_TABLET, perm: PERM_TABLET });
      }
      const ok = await conferirLogin(b.usuario, b.senha);
      if (!ok) {
        const nome = limpaNome(b.usuario).slice(0, 40);
        const papel = await papelDe(nome);
        if (papel) await auditar(sql, { usuario: nome, papel }, "senha errada", { detalhe: "Tentativa de entrar com senha errada" });
        await new Promise(r => setTimeout(r, 600)); /* atrasa quem tenta adivinhar */
        return res.status(401).json({ erro: "Usuário ou senha incorretos." });
      }
      /* troca de usuário no tablet: só quem é da hierarquia PRODUÇÃO */
      if (b.soProducao === true && ok.papel !== "producao") return res.status(403).json({ erro: "Por aqui só entram usuários da hierarquia PRODUÇÃO." });
      const perm = await permissoes(ok.papel);
      if (!perm) return res.status(403).json({ erro: "A hierarquia deste usuário foi apagada. Fale com o ADM." });
      if (ok.aprovaArte && !perm.aprovaArte) perm.aprovaArte = true;   /* liberado só para este usuário */
      const { token, exp } = criarToken(ok.usuario, ok.papel, ok.versao);
      await auditar(sql, ok, "entrou", { detalhe: "Entrou no painel" });
      return res.status(200).json({ token, exp, usuario: ok.usuario, papel: ok.papel, perm });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro no banco de dados." });
  }
}
