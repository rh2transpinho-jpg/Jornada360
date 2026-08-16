/* Recuperação de senha.
 *
 * O token cru existe por um instante — o tempo de montar o e-mail. O banco guarda só o hash.
 *
 * Regras que fazem este fluxo ser seguro, e não apenas conveniente:
 *
 *  - **Uso único.** Um link já usado não vale de novo, mesmo dentro da validade. Sem isso, um link
 *    parado numa caixa de e-mail antiga continuaria abrindo a conta.
 *  - **Validade curta** (30 min). Recuperação de senha é uma janela em que qualquer um com acesso
 *    ao e-mail entra na conta; essa janela precisa ser estreita.
 *  - **Um pedido invalida os anteriores.** Quem pede duas vezes usa o link mais novo; os antigos
 *    morrem na hora.
 *  - **Redefinir encerra todas as sessões.** Se a pessoa está recuperando a senha porque alguém
 *    entrou na conta dela, manter as sessões abertas anularia o esforço. */
import { consultarUm, executar } from '../db/index.js';
import { novoId, gerarToken, hashToken } from '../lib/seguranca.js';

const MINUTOS_VALIDADE = 30;
export const VALIDADE_MINUTOS = MINUTOS_VALIDADE;

export async function criarPedido(userId, origemIp) {
  const agora = new Date();
  const expira = new Date(agora.getTime() + MINUTOS_VALIDADE * 60_000);

  /* Pedidos anteriores da mesma conta são invalidados: só o link mais recente vale. */
  await executar('UPDATE password_resets SET usado_em = ? WHERE user_id = ? AND usado_em IS NULL',
    [agora.toISOString(), userId]);

  const token = gerarToken();
  await executar(
    `INSERT INTO password_resets (id, user_id, token_hash, criado_em, expira_em, origem_ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [novoId('pwr'), userId, hashToken(token), agora.toISOString(), expira.toISOString(), origemIp ?? null],
  );

  return { token, expiraEm: expira.toISOString() };
}

/* Devolve o pedido válido, ou o motivo da recusa. A interface precisa distinguir "link expirado"
 * (peça outro) de "link inválido" (confira o endereço) para orientar a pessoa. */
export async function validarToken(token) {
  if (!token) return { erro: 'invalido' };
  const r = await consultarUm('SELECT * FROM password_resets WHERE token_hash = ?', [hashToken(token)]);
  if (!r) return { erro: 'invalido' };
  if (r.usado_em) return { erro: 'usado' };
  if (new Date(r.expira_em) <= new Date()) return { erro: 'expirado' };
  return { pedido: r };
}

export async function marcarUsado(id) {
  await executar('UPDATE password_resets SET usado_em = ? WHERE id = ?', [new Date().toISOString(), id]);
}

export async function limparExpirados() {
  await executar('DELETE FROM password_resets WHERE expira_em <= ? OR usado_em IS NOT NULL',
    [new Date(Date.now() - 7 * 86400_000).toISOString()]);
}
