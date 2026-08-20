/* Acesso às ocorrências de hora extra.
 *
 * ESTE ARQUIVO NÃO CALCULA NADA. Todo número que aparece na tela de HE — minutos, excedente,
 * valor anterior a um recálculo, contagens por situação — vem pronto do servidor. É lá que o
 * motor roda e é lá que as regras da empresa são aplicadas.
 *
 * Repetir a conta aqui criaria uma segunda verdade sobre hora extra: bastaria uma regra mudar no
 * backend para a tela passar a mostrar um número que ninguém consegue explicar. Num sistema de
 * auditoria, dois números diferentes para o mesmo dia é pior do que número nenhum.
 *
 * O `tenantId` vai na URL e nunca no corpo — o servidor o valida contra as memberships da sessão
 * antes de responder. Ver src/api/remoteEmpresaRepository.ts, que segue a mesma regra. */
import { api } from './client';

export type SituacaoHE = 'pendente' | 'justificada' | 'nao_autorizada' | 'em_analise' | 'abonada';

/* Os rótulos são os mesmos do backend (heRepository.ROTULO_STATUS). Duplicados aqui porque o
 * frontend não importa do servidor; qualquer mudança precisa acontecer nos dois lugares. */
export const ROTULO_SITUACAO: Record<SituacaoHE, string> = {
  pendente: 'Pendente de justificativa',
  justificada: 'Justificada',
  nao_autorizada: 'Não autorizada',
  em_analise: 'Em análise',
  abonada: 'Abonada',
};

export interface OcorrenciaHE {
  id: string;
  colaborador: string;
  colaboradorChave: string;
  data: string;
  heMin: number;
  excedenteMin: number;
  padraoMin: number | null;
  escalaPrevista: string;
  jornadaRealizada: string;
  batidas: string;
  setor: string;
  contexto: string;
  status: SituacaoHE;
  motivo: string | null;
  justificativa: string | null;
  origem: string | null;
  quemInformou: string | null;
  quemSolicitou: string | null;
  observacoes: string | null;
  justificadaEm: string | null;
  responsavel: string | null;
  criadaEm: string;
  atualizadaEm: string;
  /** Preenchido quando o motor recalculou o dia DEPOIS de alguém já ter analisado. */
  recalculadaEm: string | null;
  /** O valor que existia antes desse recálculo. */
  heMinAnterior: number | null;
}

export interface EventoHistorico {
  id: string;
  evento: 'identificada' | 'recalculada' | 'justificada' | 'justificativa_alterada' | 'status_alterado';
  usuario: string;
  valorAnterior: string;
  valorNovo: string;
  observacao: string;
  criadoEm: string;
}

export interface DetalheHE extends OcorrenciaHE {
  historico: EventoHistorico[];
}

export interface ResumoHE {
  ocorrencias: number;
  minutos: number;
  minutosPendentes: number;
  ocorrenciasPendentes: number;
  colaboradores: number;
  porStatus: Record<SituacaoHE, { ocorrencias: number; minutos: number }>;
}

export interface FiltrosHE {
  busca?: string;
  colaborador?: string;
  data?: string;
  de?: string;
  ate?: string;
  status?: SituacaoHE | '';
  motivo?: string;
  origem?: string;
  setor?: string;
}

function base(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/he`;
}

function comFiltros(caminho: string, filtros: FiltrosHE = {}): string {
  const p = new URLSearchParams();
  for (const [chave, valor] of Object.entries(filtros)) {
    if (valor) p.set(chave, String(valor));
  }
  const q = p.toString();
  return q ? `${caminho}?${q}` : caminho;
}

export function listarOcorrencias(tenantId: string, filtros: FiltrosHE = {}): Promise<OcorrenciaHE[]> {
  return api.get<OcorrenciaHE[]>(comFiltros(base(tenantId), filtros));
}

export function obterResumo(tenantId: string, filtros: FiltrosHE = {}): Promise<ResumoHE> {
  return api.get<ResumoHE>(comFiltros(`${base(tenantId)}/resumo`, filtros));
}

export function obterOcorrencia(tenantId: string, id: string): Promise<DetalheHE> {
  return api.get<DetalheHE>(`${base(tenantId)}/${encodeURIComponent(id)}`);
}

export function listasConfiguraveis(tenantId: string): Promise<{ motivos: string[]; origens: string[] }> {
  return api.get<{ motivos: string[]; origens: string[] }>(`${base(tenantId)}/listas`);
}

export interface DadosJustificativa {
  status: SituacaoHE;
  motivo: string;
  justificativa: string;
  origem?: string;
  quemInformou?: string;
  quemSolicitou?: string;
  observacoes?: string;
}

/* Grava a análise humana.
 *
 * O RESPONSÁVEL NÃO VAI NO CORPO. Quem assina é quem está logado, e o servidor resolve isso da
 * sessão — deixar a tela escolher o autor tornaria a trilha de auditoria decorativa. */
export function registrarJustificativa(tenantId: string, id: string, dados: DadosJustificativa): Promise<OcorrenciaHE> {
  return api.put<OcorrenciaHE>(`${base(tenantId)}/${encodeURIComponent(id)}/justificativa`, dados);
}

export function urlRelatorioCsv(tenantId: string, filtros: FiltrosHE = {}): string {
  return comFiltros(`${base(tenantId)}/relatorio/csv`, filtros);
}

/* ---------------------------------------------------------------- apresentação */

export function minutosParaHoras(min: number): string {
  const sinal = min < 0 ? '-' : '';
  const abs = Math.abs(min);
  return `${sinal}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function dataBr(iso: string): string {
  const [a, m, d] = iso.split('-');
  return d ? `${d}/${m}/${a}` : iso;
}

/* Quanto tempo uma ocorrência está esperando análise. É o que separa "apareceu hoje" de
 * "está parada há três semanas" — a segunda precisa aparecer primeiro. */
export function diasParado(criadaEm: string): number {
  return Math.floor((Date.now() - new Date(criadaEm).getTime()) / 86_400_000);
}

/* Ordem de atenção, e não ordem cronológica.
 *
 * A tela existe para gestão por exceção: primeiro o que exige ação. Pendentes vêm antes de tudo;
 * entre elas, a mais antiga e a maior sobem. Recalculadas depois de analisadas vêm logo em
 * seguida, porque o número mudou debaixo de uma decisão que alguém já tinha tomado. */
export function pesoDeAtencao(o: OcorrenciaHE): number {
  if (o.status === 'pendente') return 1_000_000 + diasParado(o.criadaEm) * 1000 + o.heMin;
  if (o.recalculadaEm) return 500_000 + o.heMin;
  if (o.status === 'em_analise') return 100_000 + o.heMin;
  return o.heMin;
}
