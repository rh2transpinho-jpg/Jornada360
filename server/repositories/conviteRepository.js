/* Convites de acesso a uma empresa.
 *
 * O QUE FUNCIONA: criar o convite, listar, revogar e resgatar. O vínculo (membership) é criado de
 * verdade quando alguém resgata um código válido.
 *
 * O ENVIO por e-mail existe desde a Fase 5 (ver server/lib/email.js). O código continua voltando
 * na resposta mesmo assim: se o e-mail cair no spam ou o endereço estiver errado, o administrador
 * ainda consegue entregar o acesso por outro canal. Depender exclusivamente do e-mail chegar
 * deixaria alguém trancado do lado de fora quando ele não chega.
 *
 * O código é guardado como HASH, pela mesma razão da senha e do token de sessão: vazar o banco não
 * pode entregar credencial utilizável. Ele é mostrado UMA vez, no momento da criação. */
import { consultar, consultarUm, executar } from '../db/index.js';
import { novoId, gerarToken, hashToken } from '../lib/seguranca.js';

export const DIAS_VALIDADE = 7;

export async function criarConvite(tenantId, { email, papel, criadoPor }) {
  const codigo = gerarToken().slice(0, 24);
  const agora = new Date();
  const expira = new Date(agora.getTime() + DIAS_VALIDADE * 86400_000);

  await executar(
    `INSERT INTO invites (id, tenant_id, email, papel, codigo_hash, criado_por, criado_em, expira_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      novoId('inv'), tenantId, email.toLowerCase().trim(), papel, hashToken(codigo),
      criadoPor ?? null, agora.toISOString(), expira.toISOString(),
    ],
  );

  /* O código cru só existe aqui. Quem chamou precisa entregá-lo agora — não há como recuperá-lo. */
  return { codigo, email: email.toLowerCase().trim(), papel, expiraEm: expira.toISOString() };
}

export function listarConvites(tenantId) {
  return consultar(
    `SELECT id, email, papel, criado_em AS criadoEm, expira_em AS expiraEm, aceito_em AS aceitoEm
     FROM invites WHERE tenant_id = ? ORDER BY criado_em DESC`,
    [tenantId],
  );
}

export async function revogarConvite(tenantId, id) {
  await executar('DELETE FROM invites WHERE tenant_id = ? AND id = ? AND aceito_em IS NULL', [tenantId, id]);
}

/* Consulta um convite SEM consumi-lo. Existe para quem ainda não tem conta: o servidor precisa
 * saber para qual e-mail o convite foi emitido antes de criar o usuário, e só então resgatar.
 * Não consome nada — se a criação da conta falhar no meio, o convite continua utilizável. */
export async function consultarConvite(codigo) {
  const c = await consultarUm('SELECT * FROM invites WHERE codigo_hash = ?', [hashToken(codigo || '')]);
  if (!c) return { erro: 'invalido' };
  if (c.aceito_em) return { erro: 'ja_usado' };
  if (new Date(c.expira_em) <= new Date()) return { erro: 'expirado' };
  return { email: c.email, tenantId: c.tenant_id, papel: c.papel };
}

/* Resgata um código. Devolve o convite quando ele é válido, ou o motivo da recusa — a interface
 * precisa distinguir "código errado" de "código vencido" para orientar a pessoa. */
export async function resgatarConvite(codigo, usuario) {
  const c = await consultarUm('SELECT * FROM invites WHERE codigo_hash = ?', [hashToken(codigo || '')]);
  if (!c) return { erro: 'invalido' };
  if (c.aceito_em) return { erro: 'ja_usado' };
  if (new Date(c.expira_em) <= new Date()) return { erro: 'expirado' };

  /* O convite é nominal: aceitar com outra conta permitiria repassar acesso a quem o administrador
   * não escolheu. */
  if (c.email !== usuario.email.toLowerCase().trim()) return { erro: 'outro_email' };

  await executar('UPDATE invites SET aceito_em = ?, aceito_por = ? WHERE id = ?',
    [new Date().toISOString(), usuario.id, c.id]);

  return { tenantId: c.tenant_id, papel: c.papel };
}
