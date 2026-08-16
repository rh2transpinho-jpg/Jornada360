/* Auditoria server-side.
 *
 * A diferença crítica em relação à versão local: o AUTOR vem da sessão autenticada
 * (`req.usuario`), não de um campo que o cliente preenche. Na versão em localStorage, qualquer
 * um com acesso ao console podia gravar uma entrada em nome de outra pessoa — o que anula o
 * propósito de uma trilha de auditoria.
 *
 * Falha ao auditar NÃO derruba a operação: se a gravação da trilha quebrasse um "salvar setor",
 * o sistema ficaria inoperante por causa do log. O erro vai para o log do servidor. */
import { registrarAuditoria } from '../repositories/operacaoRepository.js';

/* `async` porque a gravação passou a ser assíncrona. Quem chama normalmente NÃO espera: a trilha
 * não pode atrasar a resposta da operação que ela descreve. O `catch` embutido garante que uma
 * promessa rejeitada aqui não vire erro não tratado no processo. */
export async function auditar(req, { entidade, acao, valorAnterior, valorNovo, motivo }) {
  try {
    return await registrarAuditoria(req.tenantId, {
      userId: req.usuario.id,
      usuario: req.usuario.nome,
      entidade,
      acao,
      valorAnterior: valorAnterior != null ? String(valorAnterior) : '',
      valorNovo: valorNovo != null ? String(valorNovo) : '',
      motivo: motivo ?? '',
    });
  } catch (e) {
    console.error('[jornada360] falha ao registrar auditoria:', e);
    return null;
  }
}
