import type { HECaseState, HEDiaSnapshot } from '../engine/heEngineCore';
import type { Company, Department, Employee, Pendencia, Rules, Schedule, Unit, WorkspaceConfig } from '../domain';
import type { AuditEntry } from '../repositories/AuditRepository';

/* CONTRATO ÚNICO DE PERSISTÊNCIA
 *
 * Este é o ponto onde a Fase 4 encosta na promessa que a arquitetura vem fazendo desde a Fase 1:
 * a interface não sabe — e não pode saber — se o dado vem do navegador ou do servidor.
 *
 * Duas implementações honram este contrato:
 *   `conjuntoLocal`  → demonstração. localStorage, sem rede, funciona com o servidor desligado.
 *   `conjuntoRemoto` → empresa real. API, banco, tenant, sessão.
 *
 * A escolha entre as duas acontece UMA vez, em `RepositorioProvider`. Nenhuma tela, nenhum service
 * e nenhum componente pergunta "estou no demo?" — é justamente esse `if` espalhado que a fábrica
 * existe para impedir.
 *
 * Tudo é assíncrono, inclusive no modo local (onde as promessas já vêm resolvidas). Um contrato
 * que fosse síncrono no local e assíncrono no remoto obrigaria cada chamador a tratar os dois
 * casos — que é exatamente o vazamento que se quer evitar. */

/** Um dia processado, no formato cru que o motor HE produz. O servidor guarda isso como JSON
 *  opaco: nunca interpreta, nunca recalcula. É o que permite o motor continuar intocado. */
export interface DiaBruto {
  dateKey: string;
  snapshot: HEDiaSnapshot;
  caseState: Record<string, HECaseState>;
}

/** Tudo que uma empresa tem, carregado de uma vez. É o que alimenta as treze telas. */
export interface EstadoEmpresa {
  config: WorkspaceConfig;
  dias: DiaBruto[];
  pendencias: Pendencia[];
  auditoria: AuditEntry[];
  /** Carimbo de concorrência do cadastro. Vazio no modo local (não há concorrência lá). */
  versao: string;
  /** Permissões do usuário NESTA empresa, segundo o servidor. Vazio no modo local. */
  permissoes: string[];
  papel: string;
}

export interface Membro {
  id: string;
  nome: string;
  email: string;
  papel: string;
}

export interface Convite {
  id: string;
  email: string;
  papel: string;
  criadoEm: string;
  expiraEm: string;
  aceitoEm: string | null;
}

/** O código cru só existe no instante da criação — o banco guarda apenas o hash. */
export interface ConviteCriado {
  codigo: string;
  email: string;
  papel: string;
  expiraEm: string;
}

export interface ConjuntoRepositorios {
  readonly modo: 'local' | 'remoto';

  carregarTudo(empresaId: string): Promise<EstadoEmpresa>;

  /* ---- cadastro (o `versao` é o carimbo lido; o servidor recusa se já mudou) ---- */
  salvarEmpresa(empresaId: string, company: Company, versao: string): Promise<void>;
  salvarUnidade(empresaId: string, unidade: Unit, versao: string): Promise<void>;
  excluirUnidade(empresaId: string, id: string, versao: string): Promise<void>;
  salvarSetor(empresaId: string, setor: Department, versao: string): Promise<void>;
  excluirSetor(empresaId: string, id: string, versao: string): Promise<void>;
  salvarEscala(empresaId: string, escala: Schedule, versao: string): Promise<void>;
  excluirEscala(empresaId: string, id: string, versao: string): Promise<void>;
  salvarColaborador(empresaId: string, colaborador: Employee, versao: string): Promise<void>;
  excluirColaborador(empresaId: string, id: string, versao: string): Promise<void>;
  salvarRegras(empresaId: string, regras: Rules, causaOpts: string[], versao: string): Promise<void>;
  salvarIntegracao(empresaId: string, id: string, status: 'configurado' | 'nao_configurado', versao: string): Promise<void>;

  /* ---- acesso de pessoas (só existe de verdade no modo remoto) ---- */
  listarMembros(empresaId: string): Promise<Membro[]>;
  adicionarMembro(empresaId: string, email: string, papel: string): Promise<void>;
  alterarPapel(empresaId: string, userId: string, papel: string): Promise<void>;
  removerMembro(empresaId: string, userId: string): Promise<void>;
  listarConvites(empresaId: string): Promise<Convite[]>;
  criarConvite(empresaId: string, email: string, papel: string): Promise<ConviteCriado>;
  revogarConvite(empresaId: string, id: string): Promise<void>;

  /* ---- operação ---- */
  salvarDia(empresaId: string, dia: DiaBruto): Promise<void>;
  atualizarCaso(empresaId: string, dateKey: string, chaveColaborador: string, patch: Partial<HECaseState>): Promise<void>;
  limparDias(empresaId: string): Promise<number>;

  salvarPendencia(empresaId: string, pendencia: Pendencia): Promise<Pendencia>;
  revisarPendencia(empresaId: string, id: string, decisao: 'aprovado' | 'reprovado', observacao: string | null): Promise<Pendencia>;

  /* ---- trilha ---- */
  registrarAuditoria(empresaId: string, entrada: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;
  registrarExportacao(empresaId: string, relatorio: string, escopo: string): Promise<void>;
}
