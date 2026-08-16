/* Implementação REMOTA do contrato de persistência — o caminho da empresa real.
 *
 * O tenant vai sempre na URL e NUNCA no corpo: quem valida o acesso é o servidor, comparando o id
 * pedido com as memberships da sessão. Mandar o tenant no corpo seria pedir ao backend para
 * confiar no cliente — exatamente o que ele recusa fazer (ver server/middlewares).
 *
 * O carimbo de versão viaja no cabeçalho `x-versao`. Quando alguém gravou no meio do caminho, a
 * resposta é 409 e o `ErroApi` chega ao formulário com tipo `conflito`, que a interface transforma
 * em "recarregue" em vez de "tente de novo". */
import { api } from '../api/client';
import type { Company, Department, Employee, IntegrationConfig, Pendencia, Rules, Schedule, Unit, UserAccess, WorkspaceConfig } from '../domain';
import { normalizarPapel, regrasPadrao } from '../domain';
import type { AuditEntry } from '../repositories/AuditRepository';
import type { ConjuntoRepositorios, Convite, ConviteCriado, DiaBruto, EstadoEmpresa, Membro } from './tipos';

function base(empresaId: string): string {
  return `/api/tenants/${encodeURIComponent(empresaId)}`;
}

interface CadastroRemoto {
  id: string;
  nome: string;
  criadoEm?: string;
  environment: 'real' | 'demo';
  papel: string;
  permissoes: string[];
  versao: string;
  company: Company;
  units: Unit[];
  departments: Department[];
  schedules: Schedule[];
  employees: Employee[];
  integrations: IntegrationConfig[];
  users: { id: string; nome: string; email: string; papel: string }[];
  rules: Rules;
  causaOpts: string[];
}

/* Traduz o cadastro do servidor para o `WorkspaceConfig` que as telas já consomem há três fases.
 * É aqui — e só aqui — que o formato da API encosta no formato do domínio. Nenhuma tela precisou
 * mudar por causa desta camada. */
function paraWorkspaceConfig(c: CadastroRemoto): WorkspaceConfig {
  return {
    id: c.id,
    criadoEm: c.criadoEm ?? '',
    environment: c.environment,
    company: c.company,
    units: c.units,
    departments: c.departments,
    schedules: c.schedules,
    employees: c.employees,
    causaOpts: c.causaOpts,
    /* `regrasPadrao()` antes das regras do servidor: um campo novo em `Rules` que o banco ainda não
     * tenha ganha o default em vez de chegar `undefined` na tela. Mesmo padrão do repositório
     * local desde a Fase 1. */
    rules: { ...regrasPadrao(), ...c.rules },
    integrations: c.integrations,
    users: c.users.map((u): UserAccess => ({ id: u.id, nome: u.nome, papel: normalizarPapel(u.papel) })),
  };
}

export function criarConjuntoRemoto(): ConjuntoRepositorios {
  return {
    modo: 'remoto',

    async carregarTudo(empresaId) {
      /* Quatro chamadas em paralelo, não em sequência: são independentes, e encadeá-las somaria
       * quatro idas à rede antes da primeira tela aparecer. */
      const [cadastro, dias, pendencias, auditoria] = await Promise.all([
        api.get<CadastroRemoto>(base(empresaId)),
        api.get<DiaBruto[]>(`${base(empresaId)}/dias?completo=1`),
        api.get<Pendencia[]>(`${base(empresaId)}/pendencias`),
        /* Auditoria exige permissão própria: quem não pode lê-la ainda assim precisa abrir o
         * sistema. Uma trilha vazia aqui significa "você não vê isto", e a tela de Auditoria diz
         * isso explicitamente — não finge que a empresa não tem histórico. */
        api.get<AuditEntry[]>(`${base(empresaId)}/auditoria`).catch(() => [] as AuditEntry[]),
      ]);

      const estado: EstadoEmpresa = {
        config: paraWorkspaceConfig(cadastro),
        dias,
        pendencias,
        auditoria,
        versao: cadastro.versao ?? '',
        permissoes: cadastro.permissoes ?? [],
        papel: cadastro.papel,
      };
      return estado;
    },

    salvarEmpresa: (empresaId, company, versao) =>
      api.put<void>(`${base(empresaId)}/empresa`, company, { versao }).then(() => undefined),

    salvarUnidade: (empresaId, unidade, versao) =>
      api.post<void>(`${base(empresaId)}/unidades`, unidade, { versao }).then(() => undefined),
    excluirUnidade: (empresaId, id, versao) =>
      api.delete<void>(`${base(empresaId)}/unidades/${encodeURIComponent(id)}`, { versao }).then(() => undefined),

    salvarSetor: (empresaId, setor, versao) =>
      api.post<void>(`${base(empresaId)}/setores`, setor, { versao }).then(() => undefined),
    excluirSetor: (empresaId, id, versao) =>
      api.delete<void>(`${base(empresaId)}/setores/${encodeURIComponent(id)}`, { versao }).then(() => undefined),

    salvarEscala: (empresaId, escala, versao) =>
      api.post<void>(`${base(empresaId)}/escalas`, escala, { versao }).then(() => undefined),
    excluirEscala: (empresaId, id, versao) =>
      api.delete<void>(`${base(empresaId)}/escalas/${encodeURIComponent(id)}`, { versao }).then(() => undefined),

    salvarColaborador: (empresaId, colaborador, versao) =>
      api.post<void>(`${base(empresaId)}/colaboradores`, colaborador, { versao }).then(() => undefined),
    excluirColaborador: (empresaId, id, versao) =>
      api.delete<void>(`${base(empresaId)}/colaboradores/${encodeURIComponent(id)}`, { versao }).then(() => undefined),

    salvarRegras: (empresaId, regras, causaOpts, versao) =>
      api.put<void>(`${base(empresaId)}/regras`, { regras, causaOpts }, { versao }).then(() => undefined),

    salvarIntegracao: (empresaId, id, status, versao) =>
      api.put<void>(`${base(empresaId)}/integracoes/${encodeURIComponent(id)}`, { status }, { versao }).then(() => undefined),

    /* A lista de membros já vem no cadastro (`carregarTudo`); este método existe para quem
     * precisar dela isoladamente, sem recarregar a empresa inteira. */
    listarMembros: (empresaId) => api.get<CadastroRemoto>(base(empresaId)).then((c): Membro[] => c.users),
    adicionarMembro: (empresaId, email, papel) =>
      api.post<void>(`${base(empresaId)}/membros`, { email, papel }).then(() => undefined),
    alterarPapel: (empresaId, userId, papel) =>
      api.put<void>(`${base(empresaId)}/membros/${encodeURIComponent(userId)}`, { papel }).then(() => undefined),
    removerMembro: (empresaId, userId) =>
      api.delete<void>(`${base(empresaId)}/membros/${encodeURIComponent(userId)}`).then(() => undefined),

    listarConvites: (empresaId) => api.get<Convite[]>(`${base(empresaId)}/convites`),
    criarConvite: (empresaId, email, papel) =>
      api.post<ConviteCriado>(`${base(empresaId)}/convites`, { email, papel }),
    revogarConvite: (empresaId, id) =>
      api.delete<void>(`${base(empresaId)}/convites/${encodeURIComponent(id)}`).then(() => undefined),

    salvarDia: (empresaId, dia) =>
      api
        .put<void>(`${base(empresaId)}/dias/${encodeURIComponent(dia.dateKey)}`, {
          snapshot: dia.snapshot,
          caseState: dia.caseState,
        })
        .then(() => undefined),

    atualizarCaso: (empresaId, dateKey, chaveColaborador, patch) =>
      api
        .patch<void>(
          `${base(empresaId)}/dias/${encodeURIComponent(dateKey)}/casos/${encodeURIComponent(chaveColaborador)}`,
          patch,
        )
        .then(() => undefined),

    limparDias: (empresaId) =>
      api.delete<{ removidos: number }>(`${base(empresaId)}/dias`).then((r) => r.removidos),

    salvarPendencia: (empresaId, pendencia) =>
      api.put<Pendencia>(`${base(empresaId)}/pendencias/${encodeURIComponent(pendencia.id)}`, pendencia, {
        versao: pendencia.atualizadaEm,
      }),

    revisarPendencia: (empresaId, id, decisao, observacao) =>
      api.post<Pendencia>(`${base(empresaId)}/pendencias/${encodeURIComponent(id)}/revisao`, { decisao, observacao }),

    /* A auditoria de negócio é gravada pelo SERVIDOR, dentro de cada rota que altera algo, com o
     * autor vindo da sessão. Por isso este método não faz nada no modo remoto: deixar o cliente
     * escrever na trilha permitiria registrar uma ação em nome de outra pessoa — o oposto do que
     * uma auditoria precisa garantir. */
    async registrarAuditoria() {
      /* intencionalmente vazio — ver comentário acima */
    },

    /* Exportação é a exceção: o servidor não tem como saber que um CSV foi gerado no navegador.
     * Mesmo assim o AUTOR continua vindo da sessão; o cliente só descreve o que exportou. */
    registrarExportacao: (empresaId, relatorio, escopo) =>
      api.post<void>(`${base(empresaId)}/exportacoes`, { relatorio, escopo }).then(() => undefined),
  };
}
