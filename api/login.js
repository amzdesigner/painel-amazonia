/*
 * Painel Amazônia Gráfica · login
 *
 * POST /api/login  { usuario, senha }  → { token, usuario, papel, exp }
 * GET  /api/login  (com o cabeçalho x-painel-token) → { usuario, papel } se a sessão ainda vale
 * GET  /api/login?nomes=1 → { nomes: [...] } usuários ativos (botões da tela de login)
 * Entradas e senhas erradas vão para a auditoria.
 */
import { conferirLogin, criarToken, lerSessao, nomesAtivos, papelDe, limpaNome, permissoes, sqlUsuarios as sql } from "./_auth.js";
import { auditar } from "./_auditoria.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.PAINEL_SENHA) return res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." });
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  try {
    if (req.method === "GET") {
      if (req.query && req.query.nomes === "1") return res.status(200).json({ nomes: await nomesAtivos() });
      const s = await lerSessao(req);
      if (!s) return res.status(401).json({ erro: "Sessão expirada. Entre de novo." });
      return res.status(200).json({ usuario: s.usuario, papel: s.papel, perm: { nome: s.nomePapel, abas: s.abas, pedidos: s.pedidos, valores: s.valores, filas: s.filas } });
    }
    if (req.method === "POST") {
      let b = req.body || {};
      if (typeof b === "string") { try { b = JSON.parse(b || "{}"); } catch (e) { b = {}; } }
      const ok = await conferirLogin(b.usuario, b.senha);
      if (!ok) {
        const nome = limpaNome(b.usuario).slice(0, 40);
        const papel = await papelDe(nome);
        if (papel) await auditar(sql, { usuario: nome, papel }, "senha errada", { detalhe: "Tentativa de entrar com senha errada" });
        await new Promise(r => setTimeout(r, 600)); /* atrasa quem tenta adivinhar */
        return res.status(401).json({ erro: "Usuário ou senha incorretos." });
      }
      const perm = await permissoes(ok.papel);
      if (!perm) return res.status(403).json({ erro: "A hierarquia deste usuário foi apagada. Fale com o ADM." });
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
