/*
 * Painel Amazônia Gráfica · artes originais no Google Drive
 *
 * O arquivo vai DIRETO do navegador para o Google Drive (sem passar pelo servidor nem pelo banco),
 * no tamanho e na qualidade originais. O servidor só:
 *   - guarda a conexão com a conta Google da gráfica (o "refresh token", na tabela config, chave "_drive");
 *   - cria a pasta "PEDIDO #47-2026" dentro da pasta principal e deixa ela aberta para quem tem o link;
 *   - abre a "sessão de envio" do Google e devolve o endereço para o navegador mandar o arquivo.
 *
 * Variáveis na Vercel: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (do Google Cloud, tipo "Aplicativo da Web").
 * Endereço de retorno autorizado no Google Cloud: https://SEU-SITE/api/drive
 *
 * GET    /api/drive                         → { configurado, conectado, conta, pasta }
 * GET    /api/drive?conectar=1&t=TOKEN      → (ADM) leva para o Google para autorizar a conta
 * GET    /api/drive?code=…&state=…          → volta do Google: guarda a conexão e cria a pasta principal
 * POST   /api/drive?enviar=1   { pedidoId, nome, tipo, tamanho } → { url, pasta }  (sessão de envio)
 * POST   /api/drive?concluido=1 { pedidoId, arquivo: { id, nome, tamanho } } → registra no pedido
 * DELETE /api/drive                         → (ADM) desconecta a conta
 */
import crypto from "node:crypto";
import { exigirSessao, lerSessao, sqlUsuarios as sql } from "./_auth.js";
import { auditar } from "./_auditoria.js";

const ESCOPO = "https://www.googleapis.com/auth/drive.file";   /* só enxerga o que o próprio painel criou */
const NOME_RAIZ = "Painel Amazônia Gráfica · Artes originais";
const env = () => ({ id: process.env.GOOGLE_CLIENT_ID || "", segredo: process.env.GOOGLE_CLIENT_SECRET || "" });
const configurado = () => !!(env().id && env().segredo);
const retorno = req => process.env.GOOGLE_REDIRECT_URI || ("https://" + req.headers.host + "/api/drive");

/* "state" assinado: só o ADM que pediu consegue terminar a conexão */
const assinar = t => crypto.createHmac("sha256", (process.env.PAINEL_SENHA || "") + "|drive").update(t).digest("base64url");
function criarEstado(usuario) { const t = Buffer.from(JSON.stringify({ u: usuario, e: Date.now() + 15 * 60e3 })).toString("base64url"); return t + "." + assinar(t); }
function lerEstado(s) {
  const [t, a] = String(s || "").split(".");
  if (!t || !a || assinar(t) !== a) return null;
  try { const o = JSON.parse(Buffer.from(t, "base64url").toString()); return o.e > Date.now() ? o : null; } catch (e) { return null; }
}

let preparado = null;
const preparar = () => preparado || (preparado = sql`CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`.catch(e => { preparado = null; throw e; }));
async function lerCfg() { await preparar(); const [r] = await sql`SELECT valor FROM config WHERE chave = '_drive'`; return r ? r.valor : null; }
async function gravarCfg(v) {
  await preparar();
  if (v == null) await sql`DELETE FROM config WHERE chave = '_drive'`;
  else await sql`INSERT INTO config (chave, valor, atualizado_em) VALUES ('_drive', ${JSON.stringify(v)}::jsonb, now()) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`;
  acesso = null;
}

class ErroDrive extends Error { constructor(msg, status) { super(msg); this.status = status || 502; } }

/* token de acesso (dura ~1 h); renova com o refresh token guardado */
let acesso = null;
async function tokenAcesso() {
  if (acesso && acesso.ate > Date.now() + 60e3) return acesso.token;
  const cfg = await lerCfg();
  if (!cfg || !cfg.refresh) throw new ErroDrive("O Google Drive ainda não foi conectado. Peça ao ADM para conectar em Usuários → Google Drive.", 409);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env().id, client_secret: env().segredo, refresh_token: cfg.refresh, grant_type: "refresh_token" })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant") throw new ErroDrive("A conexão com o Google Drive expirou ou foi removida. O ADM precisa conectar de novo.", 409);
    throw new ErroDrive("O Google recusou a conexão (" + (j.error || r.status) + ").");
  }
  acesso = { token: j.access_token, ate: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return acesso.token;
}
async function g(metodo, url, corpo, extra) {
  const r = await fetch(url, { method: metodo, headers: Object.assign({ Authorization: "Bearer " + await tokenAcesso(), "Content-Type": "application/json; charset=UTF-8" }, extra || {}), body: corpo == null ? undefined : JSON.stringify(corpo) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 404) throw new ErroDrive("nao-achou", 404);
    throw new ErroDrive("Erro do Google Drive: " + ((j.error && j.error.message) || r.status));
  }
  return r;
}
const API = "https://www.googleapis.com/drive/v3/files";
async function criarPasta(nome, pai, aberta) {
  const r = await g("POST", API + "?fields=id,webViewLink&supportsAllDrives=true", { name: nome, mimeType: "application/vnd.google-apps.folder", parents: pai ? [pai] : undefined });
  const f = await r.json();
  if (aberta) await g("POST", API + "/" + f.id + "/permissions?supportsAllDrives=true", { role: "reader", type: "anyone" });
  return { id: f.id, link: f.webViewLink || ("https://drive.google.com/drive/folders/" + f.id) };
}
async function pastaExiste(id) {
  try { const r = await g("GET", API + "/" + id + "?fields=id,trashed&supportsAllDrives=true"); const f = await r.json(); return !f.trashed; }
  catch (e) { if (e.status === 404) return false; throw e; }
}
async function garantirRaiz() {
  const cfg = await lerCfg();
  if (cfg.raiz && cfg.raiz.id && await pastaExiste(cfg.raiz.id)) return cfg.raiz;
  cfg.raiz = await criarPasta(NOME_RAIZ, null, false);
  await gravarCfg(cfg);
  return cfg.raiz;
}
const nomePasta = numero => "PEDIDO #" + String(numero || "").replace(/\//g, "-");

/* pasta do pedido: cria na primeira vez e guarda em dados.drive */
async function pastaDoPedido(id) {
  const [p] = await sql`SELECT id, numero, dados FROM pedidos WHERE id = ${id}`;
  if (!p) throw new ErroDrive("Pedido não encontrado.", 404);
  const d = p.dados || {};
  if (d.drive && d.drive.pastaId && await pastaExiste(d.drive.pastaId)) return { pedido: p, drive: d.drive };
  const raiz = await garantirRaiz();
  const pasta = await criarPasta(nomePasta(p.numero), raiz.id, true);
  const drive = { pastaId: pasta.id, link: pasta.link, arquivos: [] };
  await sql`UPDATE pedidos SET dados = jsonb_set(dados, '{drive}', ${JSON.stringify(drive)}::jsonb, true) WHERE id = ${id}`;
  return { pedido: p, drive };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!sql) return res.status(500).json({ erro: "Banco não configurado (falta DATABASE_URL)" });
  const q = req.query || {};
  const corpo = () => { const b = req.body || {}; if (typeof b === "string") { try { return JSON.parse(b || "{}"); } catch (e) { return {}; } } return b; };
  try {
    /* ---- volta do Google (navegação, sem token no cabeçalho) ---- */
    if (req.method === "GET" && (q.code || q.error)) {
      const est = lerEstado(q.state);
      const voltar = msg => { res.statusCode = 302; res.setHeader("Location", "/?drive=" + encodeURIComponent(msg)); res.end(); };
      if (!est) return voltar("erro:O pedido de conexão expirou. Tente de novo.");
      if (q.error) return voltar("erro:A conta Google não autorizou (" + q.error + ").");
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: String(q.code), client_id: env().id, client_secret: env().segredo, redirect_uri: retorno(req), grant_type: "authorization_code" })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.refresh_token) return voltar("erro:" + (j.refresh_token === undefined && r.ok ? "O Google não mandou a autorização permanente. Remova o acesso do painel em myaccount.google.com/permissions e conecte de novo." : "O Google recusou (" + (j.error || r.status) + ")."));
      acesso = { token: j.access_token, ate: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
      let conta = "";
      try { const a = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { Authorization: "Bearer " + j.access_token } }); conta = ((await a.json()).user || {}).emailAddress || ""; } catch (e) {}
      await gravarCfg({ refresh: j.refresh_token, conta, por: est.u, em: new Date().toISOString() });
      acesso = { token: j.access_token, ate: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
      await garantirRaiz();
      return voltar("ok");
    }

    /* ---- ADM: ir para o Google ---- */
    if (req.method === "GET" && q.conectar) {
      req.headers["x-painel-token"] = String(q.t || "");
      const s = await lerSessao(req);
      if (!s || !s.adm) { res.statusCode = 302; res.setHeader("Location", "/?drive=" + encodeURIComponent("erro:Só o ADM pode conectar o Google Drive.")); return res.end(); }
      if (!configurado()) { res.statusCode = 302; res.setHeader("Location", "/?drive=" + encodeURIComponent("erro:Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Vercel.")); return res.end(); }
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.search = new URLSearchParams({ client_id: env().id, redirect_uri: retorno(req), response_type: "code", scope: ESCOPO, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: criarEstado(s.usuario) }).toString();
      res.statusCode = 302; res.setHeader("Location", u.toString()); return res.end();
    }

    const sessao = await exigirSessao(req, res, ["ped"]);
    if (!sessao) return;

    if (req.method === "GET") {
      const cfg = configurado() ? await lerCfg() : null;
      return res.status(200).json({ configurado: configurado(), conectado: !!(cfg && cfg.refresh), conta: (cfg && cfg.conta) || "", pasta: sessao.adm && cfg && cfg.raiz ? cfg.raiz.link : "", retorno: sessao.adm ? retorno(req) : "" });
    }
    if (req.method === "DELETE") {
      if (!sessao.adm) return res.status(403).json({ erro: "Só o ADM pode desconectar o Google Drive." });
      const cfg = await lerCfg();
      if (cfg && cfg.refresh) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(cfg.refresh), { method: "POST" }); } catch (e) {} }
      await gravarCfg(null);
      await auditar(sql, sessao, "drive", { detalhe: "Desconectou o Google Drive" });
      return res.status(200).json({ ok: true });
    }
    if (req.method === "POST") {
      if (sessao.somenteVer) return res.status(403).json({ erro: "O TABLET só visualiza. Entre com o seu usuário." });
      if (!configurado()) return res.status(409).json({ erro: "O Google Drive ainda não foi configurado na Vercel (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)." });
      const b = corpo(), id = Number(b.pedidoId);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ erro: "Pedido inválido." });

      if (q.enviar) {
        const nome = String(b.nome || "arquivo").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 200) || "arquivo";
        const tamanho = Number(b.tamanho) || 0;
        const { drive } = await pastaDoPedido(id);
        const extra = { "X-Upload-Content-Type": String(b.tipo || "application/octet-stream") };
        if (tamanho > 0) extra["X-Upload-Content-Length"] = String(tamanho);
        if (req.headers.origin) extra.Origin = req.headers.origin;   /* deixa o navegador mandar o arquivo direto ao Google */
        const r = await g("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size", { name: nome, parents: [drive.pastaId] }, extra);
        const url = r.headers.get("location");
        if (!url) throw new ErroDrive("O Google não abriu a sessão de envio.");
        return res.status(200).json({ url, pasta: drive.link });
      }
      if (q.concluido) {
        const a = b.arquivo || {};
        const item = { id: String(a.id || "").slice(0, 100), nome: String(a.nome || "").slice(0, 200), tamanho: Number(a.tamanho) || 0, por: sessao.usuario, em: new Date().toISOString() };
        const [p] = await sql`SELECT numero, dados FROM pedidos WHERE id = ${id}`;
        if (!p) return res.status(404).json({ erro: "Pedido não encontrado." });
        const d = (p.dados && p.dados.drive) || {};
        const arquivos = (Array.isArray(d.arquivos) ? d.arquivos : []).filter(x => x.id !== item.id).concat(item).slice(-200);
        const drive = Object.assign({}, d, { arquivos });
        await sql`UPDATE pedidos SET dados = jsonb_set(dados, '{drive}', ${JSON.stringify(drive)}::jsonb, true), atualizado_em = now() WHERE id = ${id}`;
        await auditar(sql, sessao, "drive", { pedidoId: String(id), pedidoNumero: p.numero, cliente: p.dados && p.dados.cliente, detalhe: "Enviou ao Google Drive: " + item.nome });
        return res.status(200).json({ drive });
      }
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ erro: "Método não permitido." });
  } catch (e) {
    if (e instanceof ErroDrive) return res.status(e.status === 404 ? 502 : e.status).json({ erro: e.message === "nao-achou" ? "Não achei a pasta no Google Drive." : e.message });
    console.error(e);
    return res.status(500).json({ erro: "Erro no servidor do Google Drive." });
  }
}
