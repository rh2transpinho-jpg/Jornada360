/* Cadastro da empresa: dados da companhia, unidades, setores, escalas, colaboradores, regras e
 * integrações. Toda função recebe `tenantId` primeiro e filtra por ele — sem exceção.
 *
 * Assíncrono desde a adaptação para hospedagem gratuita (ver server/db/index.js). O SQL é o mesmo
 * nos dois bancos: libSQL fala o dialeto do SQLite, então nenhuma consulta precisou ser reescrita. */
import { consultar, consultarUm, executar } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';

/* ---------------------------------------------------------------- empresa */

export async function obterEmpresa(tenantId) {
  const r = await consultarUm('SELECT * FROM companies WHERE tenant_id = ?', [tenantId]);
  if (!r) return null;
  return { nome: r.nome, cnpj: r.cnpj, identificacao: r.identificacao, logo: r.logo, status: r.status };
}

export async function salvarEmpresa(tenantId, dados) {
  await executar(
    'UPDATE companies SET nome = ?, cnpj = ?, identificacao = ?, logo = ?, status = ? WHERE tenant_id = ?',
    [dados.nome ?? '', dados.cnpj ?? '', dados.identificacao ?? '', dados.logo ?? '', dados.status ?? 'ativa', tenantId],
  );
  /* O nome do tenant acompanha o nome da empresa — é o rótulo mostrado no seletor. */
  await executar('UPDATE tenants SET nome = ? WHERE id = ?', [dados.nome ?? '', tenantId]);
  return obterEmpresa(tenantId);
}

/* ---------------------------------------------------------------- unidades */

export function listarUnidades(tenantId) {
  return consultar('SELECT id, nome, codigo, localizacao FROM units WHERE tenant_id = ? ORDER BY nome', [tenantId]);
}

export async function salvarUnidade(tenantId, u) {
  const id = u.id || novoId('un');
  await executar(
    `INSERT INTO units (id, tenant_id, nome, codigo, localizacao) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, codigo = excluded.codigo, localizacao = excluded.localizacao`,
    [id, tenantId, u.nome, u.codigo ?? '', u.localizacao ?? ''],
  );
  return { id, nome: u.nome, codigo: u.codigo ?? '', localizacao: u.localizacao ?? '' };
}

/* O `AND tenant_id = ?` no DELETE não é redundante: sem ele, alguém que descobrisse o id de uma
 * unidade de outro tenant conseguiria apagá-la. É a proteção contra IDOR no nível da consulta. */
export async function excluirUnidade(tenantId, id) {
  await executar('DELETE FROM units WHERE id = ? AND tenant_id = ?', [id, tenantId]);
}

/* ---------------------------------------------------------------- setores */

export function listarSetores(tenantId) {
  return consultar(
    'SELECT id, nome, unidade_id AS unidadeId, responsavel FROM departments WHERE tenant_id = ? ORDER BY nome',
    [tenantId],
  );
}

export async function salvarSetor(tenantId, d) {
  const id = d.id || novoId('set');
  await executar(
    `INSERT INTO departments (id, tenant_id, nome, unidade_id, responsavel) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, unidade_id = excluded.unidade_id, responsavel = excluded.responsavel`,
    [id, tenantId, d.nome, d.unidadeId ?? null, d.responsavel ?? ''],
  );
  return { id, nome: d.nome, unidadeId: d.unidadeId ?? null, responsavel: d.responsavel ?? '' };
}

export async function excluirSetor(tenantId, id) {
  await executar('DELETE FROM departments WHERE id = ? AND tenant_id = ?', [id, tenantId]);
}

/* ---------------------------------------------------------------- escalas */

/* `entrada`/`saida` são os nomes do domínio (src/domain/Schedule.ts). As colunas do banco usam
 * snake_case por convenção SQL; o mapeamento acontece aqui, e em nenhum outro lugar — o frontend
 * recebe exatamente o formato que já esperava. */
export async function listarEscalas(tenantId) {
  const linhas = await consultar('SELECT * FROM schedules WHERE tenant_id = ? ORDER BY nome', [tenantId]);
  return linhas.map((r) => ({
    id: r.id,
    nome: r.nome,
    entrada: r.horario_inicio,
    saida: r.horario_fim,
    diasTrabalhados: JSON.parse(r.dias_trabalhados),
    folgas: JSON.parse(r.folgas),
    heProgramadaMin: r.he_programada_min,
  }));
}

export async function salvarEscala(tenantId, s) {
  const id = s.id || novoId('esc');
  await executar(
    `INSERT INTO schedules (id, tenant_id, nome, horario_inicio, horario_fim, dias_trabalhados, folgas, he_programada_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, horario_inicio = excluded.horario_inicio,
       horario_fim = excluded.horario_fim, dias_trabalhados = excluded.dias_trabalhados,
       folgas = excluded.folgas, he_programada_min = excluded.he_programada_min`,
    [
      id, tenantId, s.nome, s.entrada ?? '', s.saida ?? '',
      JSON.stringify(s.diasTrabalhados ?? []), JSON.stringify(s.folgas ?? []), s.heProgramadaMin ?? 0,
    ],
  );
  return { ...s, id };
}

export async function excluirEscala(tenantId, id) {
  await executar('DELETE FROM schedules WHERE id = ? AND tenant_id = ?', [id, tenantId]);
}

/* ---------------------------------------------------------------- colaboradores */

export function listarColaboradores(tenantId) {
  return consultar(
    `SELECT id, nome, matricula, cargo, setor_id AS setorId, unidade_id AS unidadeId, status, escala_id AS escalaId
     FROM employees WHERE tenant_id = ? ORDER BY nome`,
    [tenantId],
  );
}

export async function salvarColaborador(tenantId, e) {
  const id = e.id || novoId('col');
  await executar(
    `INSERT INTO employees (id, tenant_id, nome, matricula, cargo, setor_id, unidade_id, status, escala_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET nome = excluded.nome, matricula = excluded.matricula, cargo = excluded.cargo,
       setor_id = excluded.setor_id, unidade_id = excluded.unidade_id, status = excluded.status, escala_id = excluded.escala_id`,
    [id, tenantId, e.nome, e.matricula ?? '', e.cargo ?? '', e.setorId ?? null, e.unidadeId ?? null, e.status ?? 'ativo', e.escalaId ?? null],
  );
  return { ...e, id };
}

export async function excluirColaborador(tenantId, id) {
  await executar('DELETE FROM employees WHERE id = ? AND tenant_id = ?', [id, tenantId]);
}

/* ---------------------------------------------------------------- regras */

export async function obterRegras(tenantId) {
  const r = await consultarUm('SELECT * FROM workspace_rules WHERE tenant_id = ?', [tenantId]);
  if (!r) return null;
  return {
    regras: {
      toleranceMin: r.tolerance_min,
      dailyGoalMin: r.daily_goal_min,
      recurrenceLimit: r.recurrence_limit,
      intervalMinMin: r.interval_min_min,
      interjourneyMinHours: r.interjourney_min_hours,
      prazoPadraoDias: r.prazo_padrao_dias,
      alertaAntecedenciaDias: r.alerta_antecedencia_dias,
    },
    causaOpts: JSON.parse(r.causa_opts),
  };
}

export async function salvarRegras(tenantId, { regras, causaOpts }) {
  await executar(
    `UPDATE workspace_rules SET tolerance_min = ?, daily_goal_min = ?, recurrence_limit = ?,
       interval_min_min = ?, interjourney_min_hours = ?, prazo_padrao_dias = ?,
       alerta_antecedencia_dias = ?, causa_opts = ?
     WHERE tenant_id = ?`,
    [
      regras.toleranceMin, regras.dailyGoalMin, regras.recurrenceLimit, regras.intervalMinMin,
      regras.interjourneyMinHours, regras.prazoPadraoDias, regras.alertaAntecedenciaDias,
      JSON.stringify(causaOpts ?? []), tenantId,
    ],
  );
  return obterRegras(tenantId);
}

/* ---------------------------------------------------------------- integrações */

export function listarIntegracoes(tenantId) {
  return consultar('SELECT id, tipo, nome, status FROM integration_configs WHERE tenant_id = ?', [tenantId]);
}

export async function salvarIntegracao(tenantId, i) {
  await executar('UPDATE integration_configs SET status = ? WHERE id = ? AND tenant_id = ?', [i.status, i.id, tenantId]);
  const todas = await listarIntegracoes(tenantId);
  return todas.find((x) => x.id === i.id) ?? null;
}
