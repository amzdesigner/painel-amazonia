/*
 * Painel Amazônia Gráfica · registro de auditoria (não é rota)
 *
 * Guarda quem fez o quê nos pedidos (e quem entrou no painel), com data e hora do servidor.
 * O registro guarda só os últimos DIAS_AUDITORIA dias: o que for mais velho é apagado sozinho.
 */
export const DIAS_AUDITORIA = 7;

export const NOMES_FILA = {
  atendimento: "Atendimento", designer: "Fila do designer", impressao: "Fila da impressão",
  acabamento: "Fila do acabamento", costura: "Fila da costura", pronto: "Pedido pronto", entregue: "Pedido entregue"
};

let pronto = null;
export function prepararAuditoria(sql) {
  if (!pronto) {
    pronto = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS auditoria (
        id BIGSERIAL PRIMARY KEY,
        quando TIMESTAMPTZ NOT NULL DEFAULT now(),
        usuario TEXT NOT NULL DEFAULT '',
        papel TEXT NOT NULL DEFAULT '',
        acao TEXT NOT NULL DEFAULT '',
        pedido_id BIGINT,
        cliente TEXT NOT NULL DEFAULT '',
        detalhe TEXT NOT NULL DEFAULT ''
      )`;
      await sql`CREATE INDEX IF NOT EXISTS auditoria_quando ON auditoria (quando)`;
      await sql`ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS pedido_numero TEXT NOT NULL DEFAULT ''`;
    })().catch(e => { pronto = null; throw e; });
  }
  return pronto;
}

/* apaga o que passou de 7 dias */
export async function limparAuditoria(sql) {
  await sql`DELETE FROM auditoria WHERE quando < now() - make_interval(days => ${DIAS_AUDITORIA}::int)`;
}

/* grava uma linha; nunca derruba a operação principal se falhar */
export async function auditar(sql, sessao, acao, info) {
  try {
    await prepararAuditoria(sql);
    const i = info || {};
    await sql`INSERT INTO auditoria (usuario, papel, acao, pedido_id, pedido_numero, cliente, detalhe)
      VALUES (${String((sessao && sessao.usuario) || "?").slice(0, 40)}::text, ${String((sessao && sessao.papel) || "").slice(0, 20)}::text,
              ${String(acao).slice(0, 40)}::text, ${i.pedidoId ? Number(i.pedidoId) : null}::bigint, ${String(i.pedidoNumero || "").slice(0, 20)}::text,
              ${String(i.cliente || "").slice(0, 120)}::text, ${String(i.detalhe || "").slice(0, 400)}::text)`;
    if (Math.random() < 0.1) await limparAuditoria(sql);
  } catch (e) { console.error("auditoria:", e); }
}
