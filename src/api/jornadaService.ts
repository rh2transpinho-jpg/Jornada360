/* Acesso a escalas, horários padrão, análise automática e fila.
 *
 * ESTE ARQUIVO NÃO DECIDE NADA. Qual referência foi usada, o que divergiu, quanto de hora extra
 * excedeu, o que é crítico e o que é só atenção, a ordem da fila — tudo vem pronto do servidor.
 *
 * A razão é a mesma de `heService.ts`: a precedência escala > padrão é a regra que define se uma
 * hora extra existe. Reimplementá-la aqui criaria duas respostas para a mesma pergunta, e a da
 * tela seria a errada no dia em que a regra mudasse no backend.
 *
 * O `tenantId` vai na URL, nunca no corpo — o servidor o valida contra as memberships da sessão. */
import { api } from './client';

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}`;

function comFiltros(caminho: string, filtros: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor !== undefined && valor !== null && valor !== '') p.set(chave, String(valor));
  }
  const q = p.toString();
  return q ? `${caminho}?${q}` : caminho;
}

/* ---------------------------------------------------------------- tipos */

export type TipoReferencia = 'escala' | 'padrao' | 'nao_encontrada';

export const ROTULO_REFERENCIA: Record<TipoReferencia, string> = {
  escala: 'Escala do dia',
  padrao: 'Horário padrão',
  nao_encontrada: 'Referência não encontrada',
};

export type SituacaoEscala =
  | 'trabalha' | 'folga' | 'extra' | 'alteracao_horario' | 'ausencia_programada' | 'sem_definicao';

export const ROTULO_SITUACAO_ESCALA: Record<SituacaoEscala, string> = {
  trabalha: 'Trabalha',
  folga: 'Folga',
  extra: 'Escala extra',
  alteracao_horario: 'Alteração de horário',
  ausencia_programada: 'Ausência programada',
  sem_definicao: 'Sem escala definida',
};

export type Classificacao = 'ok' | 'atencao' | 'critico';

export const ROTULO_CLASSE: Record<Classificacao, string> = {
  ok: 'Sem divergências',
  atencao: 'Precisa de análise',
  critico: 'Tratamento prioritário',
};

export interface Divergencia {
  tipo: string;
  rotulo: string;
  previsto: string;
  realizado: string;
  diferencaMin: number | null;
  detalhe: string;
}

export interface Escala {
  id: string;
  colaborador: string;
  colaboradorChave: string;
  data: string;
  situacao: SituacaoEscala;
  rotuloSituacao: string;
  marcacoes: string[];
  faixa: string;
  entradaPrevista: string;
  saidaPrevista: string;
  cargaPrevistaMin: number | null;
  extraMin: number | null;
  duracaoPrevistaMin: number;
  turno: string;
  setor: string;
  unidade: string;
  observacao: string;
  origem: string;
  importacaoId: string | null;
  criadoEm: string;
  criadoPor: string;
  atualizadoEm: string;
  atualizadoPor: string;
}

export interface HorarioPadrao {
  id: string;
  colaborador: string;
  colaboradorChave: string;
  marcacoes: string[];
  faixa: string;
  cargaPrevistaMin: number | null;
  extraMin: number | null;
  duracaoPrevistaMin: number;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  vigente: boolean;
  status: 'ativo' | 'inativo';
  observacoes: string;
  criadoEm: string;
  criadoPor: string;
  atualizadoEm: string;
  atualizadoPor: string;
}

export interface EventoHistorico {
  id: string;
  evento: string;
  usuario: string;
  valorAnterior: string;
  valorNovo: string;
  observacao: string;
  criadoEm: string;
}

export interface Analise {
  id: string;
  colaborador: string;
  colaboradorChave: string;
  data: string;
  referenciaTipo: TipoReferencia;
  referenciaId: string | null;
  referenciaSituacao: string;
  referenciaHorarios: string;
  padraoHorarios: string;
  cargaPrevistaMin: number | null;
  extraPrevistoMin: number | null;
  pontoMarcacoes: string;
  jornadaRealizadaMin: number | null;
  heMin: number;
  excedenteMin: number;
  classificacao: Classificacao;
  rotuloClasse: string;
  divergencias: Divergencia[];
  prioridade: number;
  analisadoEm: string;
}

export interface Reincidencia {
  janelaDias: number;
  de: string;
  ate: string;
  diasComDivergencia: number;
  total: number;
  itens: { tipo: string; rotulo: string; total: number; ultima: string }[];
  ultimaSemelhante: string | null;
}

export interface Explicacao extends Analise {
  reincidencia: Reincidencia;
  porQue: string;
}

export interface ItemFila {
  id: string;
  data: string;
  tipo: string;
  rotuloTipo: string;
  categoria: string;
  status: string;
  prioridade: string;
  gravidade: Classificacao;
  origem: string;
  descricao: string;
  evidencias: string[];
  recomendacao: string | null;
  prazo: string | null;
  criadaEm: string;
  atualizadaEm: string;
  resolvidaEm: string | null;
  resolucao: string | null;
  analiseId: string | null;
  prioridadeScore: number;
  resolvidaAutomaticamente: boolean;
}

export interface ContadoresFila {
  total: number;
  criticos: number;
  he: number;
  intervalos: number;
  escala: number;
  semReferencia: number;
  porTipo: Record<string, number>;
}

export interface ResumoDiario {
  data: string;
  dataBr: string;
  processados: number;
  ok: number;
  atencao: number;
  critico: number;
  precisamAnalise: number;
  heTotalMin: number;
  heTotal: string;
  porTipo: { tipo: string; rotulo: string; total: number; gravidade: Classificacao }[];
  referencias: Record<string, number>;
  fila: { abertas: number; criticas: number };
  linhas: string[];
}

export interface ResumoSemanal {
  de: string;
  ate: string;
  deBr: string;
  ateBr: string;
  processados: number;
  colaboradores: number;
  ok: number;
  divergencias: number;
  resolvidas: number;
  abertas: number;
  heTotalMin: number;
  heTotal: string;
  porTipo: { tipo: string; rotulo: string; total: number }[];
  ocorrenciaMaisFrequente: { tipo: string; rotulo: string; total: number } | null;
  setorComMaisHE: { setor: string; heMin: number; he: string } | null;
  comparacao: {
    periodoAnterior: { de: string; ate: string };
    heAnteriorMin: number;
    heVariacaoMin: number;
    heVariacao: string;
    divergenciasAnterior: number;
    divergenciasVariacao: number;
  } | null;
  observacaoComparacao: string | null;
}

export interface MensagemGerada {
  mensagem: string;
  origem: 'ia' | 'deterministica';
  revisaoObrigatoria: boolean;
  observacao: string;
  fatos: Record<string, unknown>;
}

export interface Cobertura {
  data: string;
  comEscala: number;
  comPonto: number;
  pontoSemEscala: { colaborador: string; colaboradorChave: string }[];
  escalaSemPonto: { colaborador: string; colaboradorChave: string; situacao: string }[];
  semEscala: { colaborador: string; colaboradorChave: string }[];
  folgas: number;
  extras: number;
}

export interface ProblemaImportacao {
  tipo: string;
  mensagem: string;
  aviso?: boolean;
  campo?: string;
}

export interface ItemPrevia {
  linha: number;
  colaborador: string;
  data: string;
  situacao: SituacaoEscala;
  rotuloSituacao: string;
  marcacoes: string[];
  faixa: string;
  turno: string;
  setor: string;
  unidade: string;
  observacao: string;
  colaboradorConhecido: boolean;
  acao: 'novo' | 'substitui' | 'sem_mudanca' | 'erro';
  anterior: { faixa: string; situacao: string; rotuloSituacao: string; origem: string; atualizadoEm: string } | null;
  problemas: ProblemaImportacao[];
}

export interface PreviaImportacao {
  total: number;
  novos: number;
  substituicoes: number;
  semMudanca: number;
  comProblema: number;
  itens: ItemPrevia[];
}

/* ---------------------------------------------------------------- escalas */

export function listarEscalas(tenantId: string, filtros: Record<string, unknown> = {}): Promise<Escala[]> {
  return api.get<Escala[]>(comFiltros(`${base(tenantId)}/escalas`, filtros));
}

export function obterEscala(tenantId: string, id: string): Promise<Escala & { historico: EventoHistorico[] }> {
  return api.get(`${base(tenantId)}/escalas/${encodeURIComponent(id)}`);
}

export function opcoesDeEscala(tenantId: string): Promise<{
  turnos: string[]; setores: string[]; unidades: string[];
  situacoes: { valor: SituacaoEscala; rotulo: string }[];
}> {
  return api.get(`${base(tenantId)}/escalas/opcoes`);
}

export function coberturaDoDia(tenantId: string, data: string): Promise<Cobertura> {
  return api.get<Cobertura>(`${base(tenantId)}/escalas/cobertura/${data}`);
}

export function salvarEscala(tenantId: string, dados: Record<string, unknown>): Promise<Escala> {
  return api.put<Escala>(`${base(tenantId)}/escalas`, dados);
}

export function previaDeEscala(tenantId: string, linhas: unknown[]): Promise<PreviaImportacao> {
  return api.post<PreviaImportacao>(`${base(tenantId)}/escalas/importacao/previa`, { linhas });
}

export function importarEscala(
  tenantId: string, linhas: unknown[], meta: { arquivo?: string; formato?: string } = {},
): Promise<{ criadas: number; atualizadas: number; ignoradas: number; problemas: unknown[]; reprocesso: { dias: number; resolvidas: number } }> {
  return api.post(`${base(tenantId)}/escalas/importacao`, { linhas, ...meta });
}

/* ---------------------------------------------------------------- horários padrão */

export function listarPadroes(tenantId: string, filtros: Record<string, unknown> = {}): Promise<HorarioPadrao[]> {
  return api.get<HorarioPadrao[]>(comFiltros(`${base(tenantId)}/padroes`, filtros));
}

export function obterPadrao(tenantId: string, id: string): Promise<HorarioPadrao & { historico: EventoHistorico[] }> {
  return api.get(`${base(tenantId)}/padroes/${encodeURIComponent(id)}`);
}

export function historicoDoColaborador(tenantId: string, nome: string): Promise<HorarioPadrao[]> {
  return api.get<HorarioPadrao[]>(`${base(tenantId)}/padroes/colaborador/${encodeURIComponent(nome)}`);
}

export function alertasDePadrao(tenantId: string): Promise<{ tipo: string; id: string; colaborador: string; mensagem: string }[]> {
  return api.get(`${base(tenantId)}/padroes/alertas`);
}

export function criarPadrao(tenantId: string, dados: Record<string, unknown>): Promise<HorarioPadrao> {
  return api.post<HorarioPadrao>(`${base(tenantId)}/padroes`, dados);
}

export function atualizarPadrao(tenantId: string, id: string, dados: Record<string, unknown>): Promise<HorarioPadrao> {
  return api.put<HorarioPadrao>(`${base(tenantId)}/padroes/${encodeURIComponent(id)}`, dados);
}

export function inativarPadrao(tenantId: string, id: string, motivo = ''): Promise<HorarioPadrao> {
  return api.post<HorarioPadrao>(`${base(tenantId)}/padroes/${encodeURIComponent(id)}/inativar`, { motivo });
}

export function reativarPadrao(tenantId: string, id: string): Promise<HorarioPadrao> {
  return api.post<HorarioPadrao>(`${base(tenantId)}/padroes/${encodeURIComponent(id)}/reativar`, {});
}

/* ---------------------------------------------------------------- análise e fila */

export function listarAnalises(tenantId: string, filtros: Record<string, unknown> = {}): Promise<Analise[]> {
  return api.get<Analise[]>(comFiltros(`${base(tenantId)}/analises`, filtros));
}

export function explicar(tenantId: string, analiseId: string): Promise<Explicacao> {
  return api.get<Explicacao>(`${base(tenantId)}/analises/${encodeURIComponent(analiseId)}/explicacao`);
}

export function gerarMensagem(tenantId: string, analiseId: string, tipo?: string): Promise<MensagemGerada> {
  return api.post<MensagemGerada>(`${base(tenantId)}/analises/${encodeURIComponent(analiseId)}/mensagem`, { tipo });
}

export type FiltroRapidoFila = 'todos' | 'criticos' | 'he' | 'intervalos' | 'escala' | 'sem_referencia';

export function listarFila(tenantId: string, filtros: Record<string, unknown> = {}): Promise<ItemFila[]> {
  return api.get<ItemFila[]>(comFiltros(`${base(tenantId)}/fila`, filtros));
}

export function contadoresDaFila(tenantId: string): Promise<ContadoresFila> {
  return api.get<ContadoresFila>(`${base(tenantId)}/fila/contadores`);
}

export function reprocessar(tenantId: string, de?: string, ate?: string): Promise<{
  dias: number; analisadas: number; criadas: number; atualizadas: number; resolvidas: number;
}> {
  return api.post(`${base(tenantId)}/reprocessar`, { de, ate });
}

/* ---------------------------------------------------------------- resumos */

export function resumoDiario(tenantId: string, data: string): Promise<ResumoDiario> {
  return api.get<ResumoDiario>(`${base(tenantId)}/resumo/diario/${data}`);
}

export function resumoSemanal(tenantId: string, data: string, dias = 7): Promise<ResumoSemanal> {
  return api.get<ResumoSemanal>(`${base(tenantId)}/resumo/semanal/${data}?dias=${dias}`);
}

export function analiseGerencial(tenantId: string, pergunta: string, opcoes: { ate?: string; dias?: number } = {}): Promise<{
  resposta: string; origem: 'ia' | 'deterministica'; observacao: string; dados: Record<string, unknown>;
}> {
  return api.post(`${base(tenantId)}/analise-gerencial`, { pergunta, ...opcoes });
}

export function estadoDaIA(tenantId: string): Promise<{
  configurado: boolean; provedor: string; modelo: string | null; observacao: string;
}> {
  return api.get(`${base(tenantId)}/ia/estado`);
}

/* ---------------------------------------------------------------- formatação */

/* Apresentação, não cálculo: transforma minuto em texto. A conta que PRODUZIU o minuto é do
 * servidor. */
export function minutosParaHoras(min: number | null | undefined): string {
  const n = Math.abs(Math.round(Number(min ?? 0)));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function comSinal(min: number | null | undefined): string {
  const n = Number(min ?? 0);
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${minutosParaHoras(n)}`;
}

export function dataBr(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

export function hojeIso(): string {
  return new Date().toISOString().slice(0, 10);
}
