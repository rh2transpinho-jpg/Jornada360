/* Operação do programa piloto: quais empresas têm acesso, como está o uso de cada uma, e o
 * feedback que elas mandaram.
 *
 * SUSPENDER NÃO É EXCLUIR. Suspender bloqueia o acesso e preserva tudo; excluir apaga em cascata e
 * não tem volta. Numa cobrança controlada à mão, suspender é a única ação aceitável enquanto a
 * conversa com o cliente estiver aberta — e é reversível com um comando. */
import { consultar, consultarUm, executar } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';

export const CATEGORIAS_FEEDBACK = ['erro', 'dificuldade', 'sugestao', 'funcionalidade', 'duvida'];
export const SITUACOES_FEEDBACK = ['aberto', 'lido', 'resolvido', 'descartado'];

export const ROTULO_CATEGORIA = {
  erro: 'Erro',
  dificuldade: 'Dificuldade de uso',
  sugestao: 'Sugestão',
  funcionalidade: 'Funcionalidade solicitada',
  duvida: 'Dúvida',
};

/* ---------------------------------------------------------------- acesso das empresas */

export function situacaoTenant(tenantId) {
  return consultarUm(
    'SELECT status, suspensa_em AS suspensaEm, motivo_suspensao AS motivo FROM tenants WHERE id = ?',
    [tenantId],
  );
}

export async function suspender(tenantId, motivo) {
  await executar('UPDATE tenants SET status = ?, suspensa_em = ?, motivo_suspensao = ? WHERE id = ?',
    ['suspensa', new Date().toISOString(), motivo ?? null, tenantId]);

  /* As sessões abertas dos membros são encerradas: sem isso, quem já estava dentro continuaria
   * trabalhando até o cookie vencer, e a suspensão só valeria de fato horas depois. */
  await executar(
    'DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM memberships WHERE tenant_id = ?)',
    [tenantId],
  );
}

export async function reativar(tenantId) {
  await executar('UPDATE tenants SET status = ?, suspensa_em = NULL, motivo_suspensao = NULL WHERE id = ?',
    ['ativa', tenantId]);
}

export async function anotar(tenantId, nota) {
  await executar('UPDATE tenants SET nota_piloto = ? WHERE id = ?', [nota, tenantId]);
}

/* Panorama de cada empresa: cadastro, volume e ATIVIDADE.
 *
 * A última atividade sai da trilha de auditoria porque é o único registro que só existe quando
 * alguém realmente fez algo — contagem de linhas não distingue uma empresa que trabalha todo dia
 * de uma que importou dados uma vez e nunca mais voltou. É a diferença entre "tem dados" e "está
 * usando", que é justamente o que um piloto precisa saber. */
export function panorama() {
  return consultar(
    `SELECT
       t.id, t.nome, t.environment, t.status, t.criado_em AS criadoEm,
       t.suspensa_em AS suspensaEm, t.motivo_suspensao AS motivoSuspensao, t.nota_piloto AS notaPiloto,
       (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id)   AS usuarios,
       (SELECT COUNT(*) FROM employees e   WHERE e.tenant_id = t.id)   AS colaboradores,
       (SELECT COUNT(*) FROM time_records r WHERE r.tenant_id = t.id)  AS dias,
       (SELECT COUNT(*) FROM pendings p    WHERE p.tenant_id = t.id)   AS pendencias,
       (SELECT COUNT(*) FROM pendings p    WHERE p.tenant_id = t.id
          AND p.status IN ('justificado','aprovado','reprovado'))      AS pendenciasResolvidas,
       (SELECT MAX(a.timestamp) FROM audit_log a WHERE a.tenant_id = t.id) AS ultimaAtividade,
       (SELECT COUNT(*) FROM feedback f WHERE f.tenant_id = t.id AND f.situacao = 'aberto') AS feedbackAberto
     FROM tenants t
     ORDER BY t.criado_em`,
  );
}

/* ---------------------------------------------------------------- feedback */

export async function registrarFeedback(tenantId, { userId, usuario, categoria, mensagem, tela }) {
  const entrada = {
    id: novoId('fbk'),
    categoria,
    mensagem: mensagem.trim(),
    tela: tela ?? '',
    criadoEm: new Date().toISOString(),
  };

  await executar(
    `INSERT INTO feedback (id, tenant_id, user_id, usuario, categoria, mensagem, tela, criado_em, situacao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberto')`,
    [entrada.id, tenantId, userId ?? null, usuario, entrada.categoria, entrada.mensagem, entrada.tela, entrada.criadoEm],
  );

  return entrada;
}

/* O que a própria empresa mandou. Cada uma vê só o seu — é dado dela, sujeito às mesmas regras de
 * isolamento de todo o resto. */
export function listarFeedbackDaEmpresa(tenantId) {
  return consultar(
    `SELECT id, usuario, categoria, mensagem, tela, criado_em AS criadoEm, situacao
     FROM feedback WHERE tenant_id = ? ORDER BY criado_em DESC`,
    [tenantId],
  );
}

/* Visão do operador do piloto, atravessando empresas. Só é alcançável pela CLI, que roda no
 * servidor — não existe rota HTTP para isto, e é intencional: uma rota "ver tudo de todos" seria
 * uma porta permanente de vazamento entre clientes, criada para conveniência de uma fase. */
export function listarTodoFeedback({ situacao = null, categoria = null } = {}) {
  const condicoes = [];
  const valores = [];
  if (situacao) {
    condicoes.push('f.situacao = ?');
    valores.push(situacao);
  }
  if (categoria) {
    condicoes.push('f.categoria = ?');
    valores.push(categoria);
  }
  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  return consultar(
    `SELECT f.id, f.tenant_id AS tenantId, f.categoria, f.mensagem, f.tela, f.criado_em AS criadoEm,
            f.situacao, f.usuario, f.nota_interna AS notaInterna, t.nome AS empresa
     FROM feedback f JOIN tenants t ON t.id = f.tenant_id
     ${onde}
     ORDER BY f.criado_em DESC`,
    valores,
  );
}

export async function atualizarSituacaoFeedback(id, situacao, notaInterna) {
  await executar('UPDATE feedback SET situacao = ?, nota_interna = COALESCE(?, nota_interna) WHERE id = ?',
    [situacao, notaInterna ?? null, id]);
}

/* Quantos relatos por categoria — o número que responde "o que mais incomoda os clientes?", que é
 * a pergunta que o piloto existe para responder. */
export function resumoFeedback() {
  return consultar(
    `SELECT categoria,
            COUNT(*) AS total,
            SUM(CASE WHEN situacao = 'aberto' THEN 1 ELSE 0 END) AS abertos,
            COUNT(DISTINCT tenant_id) AS empresas
     FROM feedback GROUP BY categoria ORDER BY total DESC`,
  );
}
