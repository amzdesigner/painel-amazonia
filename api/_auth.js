/*
 * Painel Amazônia Gráfica · usuários, senhas e sessões (login)
 *
 * Não é uma rota: as outras funções da pasta api usam este arquivo para saber quem está logado.
 *
 * Níveis:
 *   "adm"      → vê e faz tudo no painel
 *   "producao" → só a aba PEDIDOS, sem a coluna Atendimento e sem nenhum valor de venda
 *
 * As senhas não ficam escritas aqui: fica só um "resumo" (hash SHA-256 de "amz-painel:USUARIO:senha").
 * Para trocar a senha de alguém, peça a nova versão deste arquivo.
 *
 * O login gera um "token" assinado com a variável PAINEL_SENHA da Vercel; ele vale por SESSAO_HORAS.
 */
import crypto from "node:crypto";

export const USUARIOS = {
  ADM:      { papel: "adm",      hash: "fd495ac390cdff93792dd0acad20aba23bbeaa5ec2a9cff6a78d9cedebd67b6c" },
  GIL:      { papel: "producao", hash: "308b0f977349da22c8cd33fd542bdcd87f2886b2bfc295c01d54a87703f5f745" },
  GENILSON: { papel: "producao", hash: "9ecc922f3c59b88905b8f05d293ee2c8396521e6800d4bcf78b8c56bcfbb4a1c" },
  ANGELO:   { papel: "producao", hash: "b6f4a3b00df01707e4183dd9fbdbfe2e9b712ce9a108140c87bd68cf3067aaa5" },
  SIMRI:    { papel: "producao", hash: "e7b6ccb81fbf9973531ec94b7ee283aea3509afa9bdaf893a9bcdff5fe27d51f" }
};
export const SESSAO_HORAS = 16;

const segredo = () => process.env.PAINEL_SENHA || "";
const b64 = s => Buffer.from(s).toString("base64url");
const assinar = txt => crypto.createHmac("sha256", segredo()).update(txt).digest("base64url");
function igual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* confere usuário e senha; devolve { usuario, papel } ou null */
export function conferirLogin(usuario, senha) {
  const nome = String(usuario || "").trim().toUpperCase();
  const u = USUARIOS[nome];
  if (!u || typeof senha !== "string") return null;
  const h = crypto.createHash("sha256").update("amz-painel:" + nome + ":" + senha).digest("hex");
  return igual(h, u.hash) ? { usuario: nome, papel: u.papel } : null;
}

export function criarToken(usuario, papel) {
  const exp = Date.now() + SESSAO_HORAS * 3600 * 1000;
  const corpo = b64(JSON.stringify({ u: usuario, p: papel, exp }));
  return { token: corpo + "." + assinar(corpo), exp };
}

/* lê o cabeçalho "x-painel-token"; devolve { usuario, papel } ou null (sem login / vencido / falso) */
export function lerSessao(req) {
  if (!segredo()) return null;
  const tk = String(req.headers["x-painel-token"] || "");
  const [corpo, sig] = tk.split(".");
  if (!corpo || !sig || !igual(sig, assinar(corpo))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!d || !d.exp || d.exp < Date.now()) return null;
  const u = USUARIOS[d.u];
  if (!u || u.papel !== d.p) return null; /* usuário removido ou nível trocado: precisa entrar de novo */
  return { usuario: d.u, papel: d.p };
}

/* para as rotas: responde 500/401/403 e devolve null se não puder seguir */
export function exigirSessao(req, res, papeis) {
  if (!segredo()) { res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." }); return null; }
  const s = lerSessao(req);
  if (!s) { res.status(401).json({ erro: "Sessão expirada. Entre de novo." }); return null; }
  if (papeis && !papeis.includes(s.papel)) { res.status(403).json({ erro: "Seu usuário não tem acesso a isso." }); return null; }
  return s;
}
