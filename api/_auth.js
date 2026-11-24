/*
 * Painel Amazônia Gráfica · usuários, senhas e sessões (login)
 *
 * Não é uma rota: as outras funções da pasta api usam este arquivo para saber quem está logado.
 *
 * Níveis (hierarquias):
 *   "adm"      → vê e faz tudo no painel (inclusive usuários e hierarquias) — fixo, não dá para mudar
 *   as outras ficam na tabela "hierarquias" e o ADM monta pela aba USUÁRIOS → HIERARQUIA:
 *     abas    → quais abas do menu a pessoa vê (visao, ped, rel, prod, mal, os, cli, orc, recibo, calc, aud)
 *     pedidos → "producao" (só move entre as filas a partir do designer) ou "completo" (vê o atendimento, cria e edita)
 *     valores → se vê os valores de venda nos pedidos
 *   A primeira hierarquia ("producao" = PRODUÇÃO) vem pronta: só PEDIDOS, modo produção, sem valores.
 *
 * Os usuários ficam no banco (tabela "usuarios"). Na primeira vez, o banco recebe os usuários iniciais abaixo.
 * As senhas nunca ficam guardadas: só um "resumo" (scrypt com sal; os iniciais usam SHA-256).
 *
 * O login gera um "token" assinado com a variável PAINEL_SENHA da Vercel; ele vale por SESSAO_HORAS.
 * Trocar a senha, o nível ou desativar um usuário derruba as sessões abertas dele.
 */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

/* usuários iniciais (só entram no banco se a tabela estiver vazia) */
const INICIAIS = {
  ADM:      { papel: "adm",      hash: "fd495ac390cdff93792dd0acad20aba23bbeaa5ec2a9cff6a78d9cedebd67b6c" },
  GIL:      { papel: "producao", hash: "308b0f977349da22c8cd33fd542bdcd87f2886b2bfc295c01d54a87703f5f745" },
  GENILSON: { papel: "producao", hash: "9ecc922f3c59b88905b8f05d293ee2c8396521e6800d4bcf78b8c56bcfbb4a1c" },
  ANGELO:   { papel: "producao", hash: "b6f4a3b00df01707e4183dd9fbdbfe2e9b712ce9a108140c87bd68cf3067aaa5" },
  SIMRI:    { papel: "producao", hash: "e7b6ccb81fbf9973531ec94b7ee283aea3509afa9bdaf893a9bcdff5fe27d51f" }
};
export const ABAS = ["visao", "ped", "rel", "prod", "mal", "os", "cli", "orc", "recibo", "calc", "aud"];
const PERM_ADM = { nome: "ADM", abas: ABAS.slice(), pedidos: "completo", valores: true };
export const SESSAO_HORAS = 16;

function acharUrlBanco() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const chave = Object.keys(env).find(k => /(^|_)DATABASE_URL$/.test(k) && !/UNPOOLED/.test(k))
             || Object.keys(env).find(k => /(^|_)POSTGRES_URL$/.test(k));
  return chave ? env[chave] : "";
}
const url = acharUrlBanco();
export const sqlUsuarios = url ? neon(url) : null;
const sql = sqlUsuarios;

const segredo = () => process.env.PAINEL_SENHA || "";
const b64 = s => Buffer.from(s).toString("base64url");
const assinar = txt => crypto.createHmac("sha256", segredo()).update(txt).digest("base64url");
function igual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- tabela de usuários ---------- */
let pronto = null;
export function prepararUsuarios() {
  if (!sql) return Promise.reject(new Error("sem banco"));
  if (!pronto) {
    pronto = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS usuarios (
        usuario       TEXT PRIMARY KEY,
        papel         TEXT NOT NULL DEFAULT 'producao',
        algo          TEXT NOT NULL DEFAULT 'scrypt',
        sal           TEXT NOT NULL DEFAULT '',
        hash          TEXT NOT NULL,
        ativo         BOOLEAN NOT NULL DEFAULT TRUE,
        versao        INTEGER NOT NULL DEFAULT 1,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        ultimo_login  TIMESTAMPTZ
      )`;
      await sql`CREATE TABLE IF NOT EXISTS hierarquias (
        id            TEXT PRIMARY KEY,
        nome          TEXT NOT NULL,
        abas          JSONB NOT NULL DEFAULT '[]'::jsonb,
        pedidos       TEXT NOT NULL DEFAULT 'producao',
        valores       BOOLEAN NOT NULL DEFAULT FALSE,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await sql`INSERT INTO hierarquias (id, nome, abas, pedidos, valores) VALUES ('producao', 'PRODUÇÃO', '["ped"]'::jsonb, 'producao', false)
                ON CONFLICT (id) DO NOTHING`;
      const [c] = await sql`SELECT count(*)::int AS n FROM usuarios`;
      if (!c || !Number(c.n)) {
        for (const [u, d] of Object.entries(INICIAIS)) {
          await sql`INSERT INTO usuarios (usuario, papel, algo, sal, hash) VALUES (${u}::text, ${d.papel}::text, 'sha256', '', ${d.hash}::text)
                    ON CONFLICT (usuario) DO NOTHING`;
        }
      }
    })().catch(e => { pronto = null; throw e; });
  }
  return pronto;
}

export const limpaNome = v => String(v || "").trim().toUpperCase().replace(/\s+/g, " ");
export const nomeValido = u => /^[A-Z0-9À-Ý][A-Z0-9À-Ý ._-]{1,19}$/.test(u);
export const senhaValida = s => typeof s === "string" && s.length >= 4 && s.length <= 64;

export function gerarHash(senha) {
  const sal = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, sal, 32).toString("hex");
  return { algo: "scrypt", sal, hash };
}
function confere(linha, senha) {
  if (linha.algo === "sha256") {
    const h = crypto.createHash("sha256").update("amz-painel:" + linha.usuario + ":" + senha).digest("hex");
    return igual(h, linha.hash);
  }
  const h = crypto.scryptSync(senha, linha.sal, 32).toString("hex");
  return igual(h, linha.hash);
}

/* ---------- hierarquias ---------- */
export function limpaHierarquia(b) {
  const abas = Array.isArray(b.abas) ? [...new Set(b.abas.filter(a => ABAS.includes(a)))] : [];
  return { abas, pedidos: b.pedidos === "completo" ? "completo" : "producao", valores: !!b.valores };
}
export async function listarHierarquias() {
  await prepararUsuarios();
  const l = await sql`SELECT h.*, (SELECT count(*)::int FROM usuarios u WHERE u.papel = h.id) AS usuarios FROM hierarquias h ORDER BY h.nome`;
  return l.map(h => ({ id: h.id, nome: h.nome, abas: Array.isArray(h.abas) ? h.abas : [], pedidos: h.pedidos, valores: h.valores, usuarios: Number(h.usuarios) || 0 }));
}
const cacheH = new Map();
export async function permissoes(papel) {
  if (papel === "adm") return PERM_ADM;
  const c = cacheH.get(papel);
  if (c && c.ate > Date.now()) return c.p;
  await prepararUsuarios();
  const [h] = await sql`SELECT * FROM hierarquias WHERE id = ${papel}::text`;
  const p = h ? { nome: h.nome, abas: Array.isArray(h.abas) ? h.abas : [], pedidos: h.pedidos, valores: h.valores } : null;
  cacheH.set(papel, { p, ate: Date.now() + 15000 });
  return p;
}
export function esquecerHierarquias() { cacheH.clear(); }
export async function papelExiste(papel) { return papel === "adm" || !!(await permissoes(papel)); }

/* a sessão pode usar alguma destas abas? (ADM pode tudo) */
export const pode = (s, abas) => !!s && (s.adm || (abas || []).some(a => s.abas.includes(a)));

/* lista de nomes ativos (para os botões da tela de login) */
export async function nomesAtivos() {
  await prepararUsuarios();
  const l = await sql`SELECT usuario FROM usuarios WHERE ativo ORDER BY (papel = 'adm') DESC, usuario`;
  return l.map(r => r.usuario);
}

/* confere usuário e senha; devolve { usuario, papel, versao } ou null */
export async function conferirLogin(usuario, senha) {
  const nome = limpaNome(usuario);
  if (!nome || typeof senha !== "string") return null;
  await prepararUsuarios();
  const [u] = await sql`SELECT * FROM usuarios WHERE usuario = ${nome}::text AND ativo`;
  if (!u || !confere(u, senha)) return null;
  /* senha antiga (SHA-256) passa para o formato mais forte no primeiro login */
  if (u.algo === "sha256") {
    const n = gerarHash(senha);
    await sql`UPDATE usuarios SET algo = ${n.algo}::text, sal = ${n.sal}::text, hash = ${n.hash}::text WHERE usuario = ${nome}::text`;
  }
  await sql`UPDATE usuarios SET ultimo_login = now() WHERE usuario = ${nome}::text`;
  return { usuario: u.usuario, papel: u.papel, versao: Number(u.versao) || 1 };
}

/* papel de um nome (para registrar senha errada na auditoria) */
export async function papelDe(usuario) {
  try {
    await prepararUsuarios();
    const [u] = await sql`SELECT papel FROM usuarios WHERE usuario = ${limpaNome(usuario)}::text`;
    return u ? u.papel : null;
  } catch (e) { return null; }
}

export function criarToken(usuario, papel, versao) {
  const exp = Date.now() + SESSAO_HORAS * 3600 * 1000;
  const corpo = b64(JSON.stringify({ u: usuario, p: papel, v: versao || 1, exp }));
  return { token: corpo + "." + assinar(corpo), exp };
}

/* usuário ainda vale? (guarda a resposta por alguns segundos para não consultar o banco a cada clique) */
const cache = new Map();
async function usuarioAtual(nome) {
  const c = cache.get(nome);
  if (c && c.ate > Date.now()) return c.u;
  await prepararUsuarios();
  const [u] = await sql`SELECT usuario, papel, ativo, versao FROM usuarios WHERE usuario = ${nome}::text`;
  cache.set(nome, { u: u || null, ate: Date.now() + 15000 });
  return u || null;
}
export function esquecerCache(nome) { if (nome) cache.delete(nome); else cache.clear(); }

/* lê o cabeçalho "x-painel-token"; devolve { usuario, papel } ou null (sem login / vencido / falso / usuário mudou) */
export async function lerSessao(req) {
  if (!segredo() || !sql) return null;
  const tk = String(req.headers["x-painel-token"] || "");
  const [corpo, sig] = tk.split(".");
  if (!corpo || !sig || !igual(sig, assinar(corpo))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8")); } catch (e) { return null; }
  if (!d || !d.exp || d.exp < Date.now()) return null;
  const u = await usuarioAtual(d.u);
  if (!u || !u.ativo || u.papel !== d.p || (Number(u.versao) || 1) !== (d.v || 1)) return null;
  const perm = await permissoes(u.papel);
  if (!perm) return null;
  return { usuario: d.u, papel: d.p, adm: d.p === "adm", nomePapel: perm.nome, abas: perm.abas, pedidos: perm.pedidos, valores: perm.valores };
}

/* para as rotas: responde 500/401/403 e devolve null se não puder seguir.
   "abas": a sessão precisa ter pelo menos uma delas (ADM sempre pode); ["adm"] = só ADM; null = qualquer pessoa logada */
export async function exigirSessao(req, res, abas) {
  if (!segredo()) { res.status(500).json({ erro: "Falta configurar PAINEL_SENHA na Vercel." }); return null; }
  if (!sql) { res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" }); return null; }
  let s;
  try { s = await lerSessao(req); } catch (e) { console.error(e); res.status(500).json({ erro: "Erro no banco de dados." }); return null; }
  if (!s) { res.status(401).json({ erro: "Sessão expirada. Entre de novo." }); return null; }
  const ok = !abas || s.adm || (!(abas.length === 1 && abas[0] === "adm") && pode(s, abas));
  if (!ok) { res.status(403).json({ erro: "Seu usuário não tem acesso a isso." }); return null; }
  return s;
}
