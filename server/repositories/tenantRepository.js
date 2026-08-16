/* Repositórios do backend.
 *
 * REGRA ABSOLUTA DESTE ARQUIVO E DE TODOS OS IRMÃOS: toda consulta que toca dado empresarial
 * recebe `tenantId` como PRIMEIRO parâmetro e o usa no WHERE. Não existe função aqui que devolva
 * dado sem filtrar por tenant.
 *
 * O `tenantId` nunca vem do corpo da requisição — vem da sessão autenticada, resolvido pelo
 * middleware (ver middlewares/autenticar.js). É a diferença entre "o cliente pediu o tenant X" e
 * "este usuário tem acesso ao tenant X".
 *
 * TUDO É ASSÍNCRONO desde a adaptação para hospedagem gratuita: o banco passou a poder estar do
 * outro lado da rede (Turso). O SQL não mudou — só a forma de esperá-lo. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';

/* Defaults neutros — os MESMOS de src/domain/Rules.ts. Duplicados aqui de propósito: o backend
 * não pode importar do frontend (bundles diferentes), e um cliente criado via API precisa nascer
 * idêntico a um criado localmente. Qualquer mudança tem que ser feita nos dois lugares — está
 * anotado em ambos e coberto por teste. */
export const REGRAS_PADRAO = {
  toleranceMin: 10,
  dailyGoalMin: 0,
  recurrenceLimit: 5,
  intervalMinMin: 60,
  interjourneyMinHours: 11,
  prazoPadraoDias: 3,
  alertaAntecedenciaDias: 1,
};

export const CAUSAS_PADRAO = ['Autorizado antecipadamente', 'Escala desatualizada', 'Erro de registro', 'Outro'];

const INTEGRACOES_PADRAO = [
  { tipo: 'excel_csv', nome: 'Importação Excel/CSV', status: 'configurado' },
  { tipo: 'cobli', nome: 'Cobli (rastreamento)', status: 'nao_configurado' },
  { tipo: 'ponto', nome: 'Sistema de ponto (API/exportação)', status: 'nao_configurado' },
  { tipo: 'api', nome: 'API genérica', status: 'nao_configurado' },
];

/* Cria o tenant e TUDO que uma empresa precisa para existir, numa transação só. Se qualquer
 * passo falhar, nada é gravado — sem meia empresa órfã no banco.
 *
 * `environment` é sempre 'real' por padrão: 'demo' só é usado pelo seed de demonstração, que é um
 * caminho separado e explícito. */
export function criarTenant({ nome, environment = 'real', criadoPorUserId, papel = 'administrador' }) {
  return emTransacao(async (db) => {
    const agora = new Date().toISOString();
    const tenantId = novoId('ten');

    await db.executar('INSERT INTO tenants (id, nome, environment, criado_em, config_versao) VALUES (?, ?, ?, ?, ?)',
      [tenantId, nome, environment, agora, agora]);

    await db.executar('INSERT INTO companies (tenant_id, nome) VALUES (?, ?)', [tenantId, nome]);

    await db.executar(
      `INSERT INTO workspace_rules
       (tenant_id, tolerance_min, daily_goal_min, recurrence_limit, interval_min_min,
        interjourney_min_hours, prazo_padrao_dias, alerta_antecedencia_dias, causa_opts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        REGRAS_PADRAO.toleranceMin,
        REGRAS_PADRAO.dailyGoalMin,
        REGRAS_PADRAO.recurrenceLimit,
        REGRAS_PADRAO.intervalMinMin,
        REGRAS_PADRAO.interjourneyMinHours,
        REGRAS_PADRAO.prazoPadraoDias,
        REGRAS_PADRAO.alertaAntecedenciaDias,
        JSON.stringify(CAUSAS_PADRAO),
      ],
    );

    for (const i of INTEGRACOES_PADRAO) {
      await db.executar('INSERT INTO integration_configs (id, tenant_id, tipo, nome, status) VALUES (?, ?, ?, ?, ?)',
        [novoId('int'), tenantId, i.tipo, i.nome, i.status]);
    }

    if (criadoPorUserId) {
      await db.executar('INSERT INTO memberships (id, user_id, tenant_id, papel, criado_em) VALUES (?, ?, ?, ?, ?)',
        [novoId('mem'), criadoPorUserId, tenantId, papel, agora]);
    }

    return { id: tenantId, nome, environment, criadoEm: agora };
  });
}

export function buscarTenant(tenantId) {
  return consultarUm('SELECT * FROM tenants WHERE id = ?', [tenantId]);
}

/* Tenants que um usuário pode acessar, com o papel dele em cada um. É a única fonte de "onde
 * este usuário pode entrar" — nenhuma rota aceita um tenant que não venha daqui. */
export function tenantsDoUsuario(userId) {
  /* `status` viaja junto para que a interface possa EXPLICAR uma empresa suspensa em vez de
   * fazê-la sumir da lista. Uma empresa que desaparece parece defeito; uma empresa marcada
   * como suspensa é uma informação. */
  return consultar(
    `SELECT t.id, t.nome, t.environment, t.status, m.papel
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = ?
     ORDER BY t.criado_em ASC`,
    [userId],
  );
}

/* Devolve o papel do usuário NAQUELE tenant, ou null se ele não tem acesso.
 * É a verificação que sustenta todo o isolamento: sem membership, não há acesso. */
export async function papelNoTenant(userId, tenantId) {
  const r = await consultarUm('SELECT papel FROM memberships WHERE user_id = ? AND tenant_id = ?', [userId, tenantId]);
  return r?.papel ?? null;
}

/* Carimbo de versão do cadastro. Muda a cada gravação em qualquer coleção do cadastro; é o que
 * `conflitoDeVersao` compara para recusar uma sobrescrita cega (ver middlewares). */
export async function versaoConfig(tenantId) {
  const r = await consultarUm('SELECT config_versao FROM tenants WHERE id = ?', [tenantId]);
  return r?.config_versao ?? '';
}

export async function tocarConfig(tenantId) {
  const agora = `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 8)}`;
  await executar('UPDATE tenants SET config_versao = ? WHERE id = ?', [agora, tenantId]);
  return agora;
}

export async function renomearTenant(tenantId, nome) {
  await executar('UPDATE tenants SET nome = ? WHERE id = ?', [nome, tenantId]);
}

export async function adicionarMembro(tenantId, userId, papel) {
  await executar(
    `INSERT INTO memberships (id, user_id, tenant_id, papel, criado_em) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, tenant_id) DO UPDATE SET papel = excluded.papel`,
    [novoId('mem'), userId, tenantId, papel, new Date().toISOString()],
  );
}

export function listarMembros(tenantId) {
  return consultar(
    `SELECT u.id, u.nome, u.email, m.papel
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = ? ORDER BY u.nome`,
    [tenantId],
  );
}

export async function removerMembro(tenantId, userId) {
  await executar('DELETE FROM memberships WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
}

/* Quantos administradores a empresa ainda tem. Usado para impedir que o último seja removido ou
 * rebaixado — uma empresa sem administrador fica sem ninguém capaz de gerir acesso, e recuperar
 * isso exigiria intervenção manual no banco. */
export async function contarAdministradores(tenantId) {
  const r = await consultarUm("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND papel = 'administrador'", [tenantId]);
  return Number(r?.n ?? 0);
}

/* Exclui o tenant. O `ON DELETE CASCADE` do schema apaga tudo que pertence a ele — é a versão
 * server-side da limpeza que `workspaceService.excluirWorkspace` faz no frontend. */
export async function excluirTenant(tenantId) {
  await executar('DELETE FROM tenants WHERE id = ?', [tenantId]);
}
