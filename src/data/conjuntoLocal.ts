/* Implementação LOCAL do contrato de persistência — o caminho da demonstração.
 *
 * Reaproveita, sem alterar, os repositórios que existem desde a Fase 1. A única coisa que este
 * arquivo acrescenta é a forma assíncrona exigida pelo contrato: as promessas já vêm resolvidas,
 * porque `localStorage` é síncrono.
 *
 * POR QUE A DEMONSTRAÇÃO CONTINUA LOCAL: ela precisa abrir com o servidor desligado, instantânea,
 * sem conta e sem rede — é o que uma apresentação exige. Exigir backend para mostrar o produto
 * transformaria a demo num ponto de falha bem no pior momento possível.
 *
 * O carimbo de versão é ignorado aqui de propósito: não existe concorrência num navegador só. */
import { WorkspaceRepository } from '../repositories/WorkspaceRepository';
import { CompanyRepository } from '../repositories/CompanyRepository';
import { UnitRepository } from '../repositories/UnitRepository';
import { DepartmentRepository } from '../repositories/DepartmentRepository';
import { ScheduleRepository } from '../repositories/ScheduleRepository';
import { EmployeeRepository } from '../repositories/EmployeeRepository';
import { TimeRecordRepository } from '../repositories/TimeRecordRepository';
import { PendingRepository } from '../repositories/PendingRepository';
import { AuditRepository } from '../repositories/AuditRepository';
import { normalizarPapel, novoWorkspace } from '../domain';
import type { ConjuntoRepositorios, DiaBruto, EstadoEmpresa } from './tipos';

function lerDias(empresaId: string): DiaBruto[] {
  return TimeRecordRepository.listDateKeys(empresaId)
    .map((dateKey) => {
      const snapshot = TimeRecordRepository.getSnapshot(empresaId, dateKey);
      if (!snapshot) return null;
      return { dateKey, snapshot, caseState: TimeRecordRepository.getCaseState(empresaId, dateKey) };
    })
    .filter((d): d is DiaBruto => d !== null);
}

export const conjuntoLocal: ConjuntoRepositorios = {
  modo: 'local',

  async carregarTudo(empresaId) {
    const bruto = WorkspaceRepository.getById(empresaId) ?? novoWorkspace(empresaId, 'demo', 'Demonstração');
    /* Normaliza papéis gravados antes de `visualizador` virar `colaborador`. */
    const config = { ...bruto, users: bruto.users.map((u) => ({ ...u, papel: normalizarPapel(u.papel) })) };
    const estado: EstadoEmpresa = {
      config,
      dias: lerDias(empresaId),
      pendencias: PendingRepository.listarPorWorkspace(empresaId),
      auditoria: AuditRepository.list(empresaId),
      versao: '',
      /* Na demonstração não há sessão nem papel — quem está apresentando precisa poder mostrar
       * tudo. Interface nenhuma toma decisão de segurança a partir daqui: no caminho real, quem
       * decide é o servidor. */
      permissoes: [],
      papel: 'administrador',
    };
    return estado;
  },

  async salvarEmpresa(empresaId, company) {
    CompanyRepository.update(empresaId, company);
  },

  async salvarUnidade(empresaId, unidade) {
    UnitRepository.upsert(empresaId, unidade);
  },
  async excluirUnidade(empresaId, id) {
    UnitRepository.remove(empresaId, id);
  },

  async salvarSetor(empresaId, setor) {
    DepartmentRepository.upsert(empresaId, setor);
  },
  async excluirSetor(empresaId, id) {
    DepartmentRepository.remove(empresaId, id);
  },

  async salvarEscala(empresaId, escala) {
    ScheduleRepository.upsert(empresaId, escala);
  },
  async excluirEscala(empresaId, id) {
    ScheduleRepository.remove(empresaId, id);
  },

  async salvarColaborador(empresaId, colaborador) {
    EmployeeRepository.upsert(empresaId, colaborador);
  },
  async excluirColaborador(empresaId, id) {
    EmployeeRepository.remove(empresaId, id);
  },

  async salvarRegras(empresaId, regras, causaOpts) {
    WorkspaceRepository.updateRules(empresaId, regras);
    WorkspaceRepository.updateCausaOpts(empresaId, causaOpts);
  },

  async salvarIntegracao(empresaId, id, status) {
    const ws = WorkspaceRepository.getById(empresaId);
    if (!ws) return;
    WorkspaceRepository.updateIntegrations(
      empresaId,
      ws.integrations.map((i) => (i.id === id ? { ...i, status } : i)),
    );
  },

  /* Gestão de acesso não existe na demonstração: não há contas, não há sessão, e ninguém precisa
   * ser convidado para ver dados fictícios. Devolver listas vazias é a descrição correta desse
   * estado — a aba de Usuários explica isso na tela em vez de mostrar controles que não fariam
   * nada. */
  async listarMembros(empresaId) {
    return (WorkspaceRepository.getById(empresaId)?.users ?? []).map((u) => ({
      id: u.id,
      nome: u.nome,
      email: '',
      papel: u.papel,
    }));
  },
  async adicionarMembro() {
    throw new Error('A demonstração não tem contas de acesso.');
  },
  async alterarPapel() {
    throw new Error('A demonstração não tem contas de acesso.');
  },
  async removerMembro() {
    throw new Error('A demonstração não tem contas de acesso.');
  },
  async listarConvites() {
    return [];
  },
  async criarConvite() {
    throw new Error('A demonstração não tem contas de acesso.');
  },
  async revogarConvite() {
    /* nada a revogar — ver acima */
  },

  async salvarDia(empresaId, dia) {
    TimeRecordRepository.saveSnapshot(empresaId, dia.snapshot);
    for (const [chave, patch] of Object.entries(dia.caseState)) {
      TimeRecordRepository.updateCase(empresaId, dia.dateKey, chave, patch);
    }
  },

  async atualizarCaso(empresaId, dateKey, chaveColaborador, patch) {
    PendingRepository.updateCampo(empresaId, dateKey, chaveColaborador, patch);
  },

  async limparDias(empresaId) {
    const n = TimeRecordRepository.clearAll(empresaId);
    PendingRepository.limparPendencias(empresaId);
    return n;
  },

  async salvarPendencia(empresaId, pendencia) {
    return PendingRepository.criarPendencia(empresaId, pendencia);
  },

  async revisarPendencia(empresaId, id, decisao, observacao) {
    /* No modo local não há sessão: o revisor é rotulado como o ambiente de demonstração, e não
     * como um nome de pessoa que não existe. Inventar um autor aqui seria mentir na trilha. */
    const p = PendingRepository.revisarPendencia(empresaId, id, decisao, 'Demonstração', observacao);
    if (!p) throw new Error('Pendência não encontrada.');
    return p;
  },

  async registrarAuditoria(empresaId, entrada) {
    AuditRepository.add(empresaId, entrada);
  },

  async registrarExportacao(empresaId, relatorio, escopo) {
    AuditRepository.add(empresaId, {
      usuario: 'Demonstração',
      entidade: `Relatório ${relatorio}`,
      acao: 'Relatório exportado',
      valorAnterior: '',
      valorNovo: escopo,
      motivo: '',
    });
  },
};
