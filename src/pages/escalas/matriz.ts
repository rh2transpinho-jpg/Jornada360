/* Leitura da planilha real de escala — que é uma MATRIZ, não uma lista.
 *
 * A FORMA DO ARQUIVO
 * ------------------
 *   linha 1   título e nomes dos dias da semana
 *   linha 2   cabeçalho: EMPRESA | FILIAL | HORÁRIO | DESCRIÇÃO | MOTORISTA | … | SEQ | e daí
 *             em diante uma coluna POR DATA
 *   linha 3+  um SERVIÇO por linha; a célula de cada coluna de data traz o motorista alocado
 *
 * Cada célula preenchida é uma alocação: serviço × data × motorista. Uma planilha de 1.106
 * serviços × 69 datas produz cerca de 15 mil alocações — por isso o desdobramento é feito aqui,
 * no navegador, e só as datas escolhidas são enviadas.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ
 * --------------------------
 * Não deriva jornada. Os horários lidos aqui são operacionais e viajam como tal. "X" e célula
 * vazia significam "rota não programada nesta data" — não geram serviço, não geram ausência. */
import { lerArquivo as lerArquivoBase, type Planilha } from './planilha';

export interface ServicoImportado {
  data: string;
  empresa: string;
  filial: string;
  linha: string;
  descricao: string;
  horario: string;
  horarioDescricao: string;
  horarioCondicional: string;
  rotulo: string;
  seq: string;
  projecaoCarro: string;
  terceirizado: boolean;
  colaborador: string;
}

export interface ColunaDeData {
  indice: number;
  data: string;
  rotuloBr: string;
  diaSemana: number;
  preenchidas: number;
}

export interface MatrizDeEscala {
  aba: string;
  abas: string[];
  cabecalho: string[];
  linhaCabecalho: number;
  colunas: Partial<Record<CampoFixo, number>>;
  datas: ColunaDeData[];
  totalServicos: number;
}

export type CampoFixo = 'empresa' | 'filial' | 'horario' | 'descricao' | 'motorista' | 'projecao' | 'seq';

const ROTULOS_FIXOS: Record<CampoFixo, string[]> = {
  empresa: ['empresa'],
  filial: ['filial'],
  horario: ['horario', 'horário'],
  descricao: ['descricao', 'descrição'],
  motorista: ['motorista'],
  projecao: ['projecao carros', 'projeção carros', 'projecao', 'carro'],
  seq: ['seq', 'sequencia', 'sequência'],
};

function norm(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* Abas de fim de semana e de férias ficam FORA desta integração, por decisão de escopo.
 * A operação de sábado e domingo tem diferenças próprias, e férias não é assunto de escala. */
export function abaEhSuportada(nome: string): boolean {
  const n = norm(nome);
  if (/sabado|domingo|ferias|guarda|sumario|dados/.test(n)) return false;
  return true;
}

export function motivoDeAbaIgnorada(nome: string): string {
  const n = norm(nome);
  if (/sabado|domingo/.test(n)) return 'Escala de fim de semana — fora desta integração.';
  if (/ferias/.test(n)) return 'Férias não fazem parte da escala operacional.';
  if (/guarda/.test(n)) return 'Lista da portaria — não é escala de serviços.';
  if (/sumario|dados/.test(n)) return 'Cadastro de motoristas, não escala.';
  return 'Aba não reconhecida como escala diária.';
}

/* Excel guarda hora como fração do dia e data como serial. A biblioteca já formata quando pedimos
 * `raw: false`, mas jornadas que atravessam a meia-noite voltam como "01/01/1900 02:00". */
export function horaDaCelula(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) return '';
  const m = t.match(/(\d{1,2})[:h](\d{2})/);
  if (!m) return '';
  const h = Number(m[1]) % 24;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/* Converte o cabeçalho de uma coluna de data em ISO. Aceita o que a biblioteca devolver:
 * "01/06/2026", "2026-06-01" ou o texto de uma data formatada. */
export function dataDaCelula(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const br = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (br) {
    const ano = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${ano}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }
  return '';
}

export function ehDiaUtil(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function rotuloDeData(iso: string): string {
  const [a, m, d] = iso.split('-');
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return `${d}/${m}/${a} · ${DIAS[dow]}`;
}

/* ---------------------------------------------------------------- reconhecimento */

/* Descobre qual linha é o cabeçalho e onde estão as colunas fixas e as de data.
 *
 * O cabeçalho não está sempre na primeira linha: na planilha real ele está na SEGUNDA, porque a
 * primeira traz o título da empresa e os nomes dos dias da semana. Procurar por conteúdo em vez
 * de assumir a posição é o que faz o arquivo ser aceito como ele é. */
export function reconhecerMatriz(linhas: unknown[][], aba: string, abas: string[]): MatrizDeEscala {
  let melhor = { indice: 0, pontos: -1 };

  for (let i = 0; i < Math.min(linhas.length, 8); i += 1) {
    const celulas = linhas[i] ?? [];
    let pontos = 0;
    for (const c of celulas) {
      const n = norm(c);
      for (const alvos of Object.values(ROTULOS_FIXOS)) if (alvos.includes(n)) pontos += 2;
      if (dataDaCelula(c)) pontos += 1;
    }
    if (pontos > melhor.pontos) melhor = { indice: i, pontos };
  }

  const cabecalho = (linhas[melhor.indice] ?? []).map((c) => String(c ?? '').trim());
  const colunas: Partial<Record<CampoFixo, number>> = {};

  for (const [campo, alvos] of Object.entries(ROTULOS_FIXOS) as [CampoFixo, string[]][]) {
    const i = cabecalho.findIndex((c) => alvos.includes(norm(c)));
    if (i >= 0) colunas[campo] = i;
  }

  const corpo = linhas.slice(melhor.indice + 1);

  /* Colunas de data: só as que estão DEPOIS das colunas fixas. Uma data solta no meio dos campos
   * fixos (a planilha real tem uma) não é coluna de alocação — é resto de edição. */
  const ultimaFixa = Math.max(-1, ...Object.values(colunas));
  const datas: ColunaDeData[] = [];

  for (let j = ultimaFixa + 1; j < cabecalho.length; j += 1) {
    const iso = dataDaCelula(cabecalho[j]);
    if (!iso) continue;
    let preenchidas = 0;
    for (const l of corpo) {
      const v = String(l?.[j] ?? '').trim();
      if (v && norm(v) !== 'x') preenchidas += 1;
    }
    datas.push({
      indice: j,
      data: iso,
      rotuloBr: rotuloDeData(iso),
      diaSemana: new Date(`${iso}T12:00:00Z`).getUTCDay(),
      preenchidas,
    });
  }

  const totalServicos = corpo.filter((l) => {
    const desc = colunas.descricao !== undefined ? l?.[colunas.descricao] : null;
    const hora = colunas.horario !== undefined ? l?.[colunas.horario] : null;
    return String(desc ?? '').trim() || String(hora ?? '').trim();
  }).length;

  return { aba, abas, cabecalho, linhaCabecalho: melhor.indice, colunas, datas, totalServicos };
}

/* ---------------------------------------------------------------- classificação */

export function rotuloDaDescricao(descricao: string): string {
  const d = norm(descricao).toUpperCase();
  if (/\bTRANSLADO\b/.test(d)) return 'translado';
  if (/\bDESTINO\b/.test(d)) return 'destino';
  if (/\bENTRADA\b/.test(d)) return 'entrada';
  if (/\bSAIDA\b/.test(d)) return 'saida';
  if (/\bEXTRA\b/.test(d)) return 'extra';
  return 'outro';
}

export function linhaDaDescricao(descricao: string): string {
  const t = String(descricao ?? '').trim();
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9/ºª.-]{0,11})\s*[-–]\s*/);
  if (m) return m[1].trim();
  const l = t.match(/\bLINHA\s+([A-Za-z0-9]+)/i);
  return l ? l[1] : '';
}

export function horaDaDescricao(descricao: string): string {
  return horaDaCelula(descricao);
}

/* Horário diferente às sextas, guardado como TEXTO. Ver o repositório do servidor: interpretar
 * isso exigiria uma regra que a planilha não define. */
export function condicionalDaDescricao(descricao: string): string {
  const m = String(descricao ?? '').match(/\/\s*(s[eé]x[a-z]*\.?\s*\d{1,2}[:h]\d{2})/i);
  return m ? m[1].trim() : '';
}

export function pareceTerceirizado(nome: string, projecao: string): boolean {
  if (/\s-\s/.test(String(nome ?? ''))) return true;
  return /^3\s*[ºª°]/.test(String(projecao ?? '').trim());
}

/* ---------------------------------------------------------------- desdobramento */

/* Serviço × data → uma alocação por célula preenchida.
 *
 * "X" e célula vazia são PULADAS: a rota existe na estrutura da planilha, mas não foi programada
 * naquela data. Não vira serviço, não vira ausência, não vira nada. */
export function desdobrar(
  linhas: unknown[][],
  matriz: MatrizDeEscala,
  datasEscolhidas: string[],
): { servicos: ServicoImportado[]; naoProgramados: number } {
  const corpo = linhas.slice(matriz.linhaCabecalho + 1);
  const col = matriz.colunas;
  const escolhidas = matriz.datas.filter((d) => datasEscolhidas.includes(d.data));

  const servicos: ServicoImportado[] = [];
  let naoProgramados = 0;

  const valor = (l: unknown[], c?: number) => (c === undefined ? '' : String(l?.[c] ?? '').trim());

  for (const l of corpo) {
    const descricao = valor(l, col.descricao);
    const horarioBruto = valor(l, col.horario);
    if (!descricao && !horarioBruto) continue;

    const empresa = valor(l, col.empresa);
    const filial = valor(l, col.filial);
    const projecao = valor(l, col.projecao);
    const seq = valor(l, col.seq);

    const horario = horaDaCelula(horarioBruto);
    const horarioDesc = horaDaDescricao(descricao);
    const base = {
      empresa,
      filial,
      linha: linhaDaDescricao(descricao),
      descricao,
      horario,
      /* Só guarda o horário da descrição quando ele DIFERE do da coluna — na planilha real eles
       * divergem (HORÁRIO 17:18 com descrição "(SAÍDA 17:33)") e as duas informações importam. */
      horarioDescricao: horarioDesc && horarioDesc !== horario ? horarioDesc : '',
      horarioCondicional: condicionalDaDescricao(descricao),
      rotulo: rotuloDaDescricao(descricao),
      seq,
      projecaoCarro: projecao,
    };

    for (const d of escolhidas) {
      const celula = String(l?.[d.indice] ?? '').trim();
      if (!celula || norm(celula) === 'x') { naoProgramados += 1; continue; }

      servicos.push({
        ...base,
        data: d.data,
        colaborador: celula,
        terceirizado: pareceTerceirizado(celula, projecao),
      });
    }
  }

  return { servicos, naoProgramados };
}

/* ---------------------------------------------------------------- leitura do arquivo */

export interface ArquivoLido {
  abas: string[];
  porAba: Record<string, unknown[][]>;
}

/* Reaproveita o leitor que já existe (`planilha.ts`), que carrega o XLSX sob demanda pela mesma
 * biblioteca que o motor de HE já usa — nenhuma dependência nova entrou no projeto. */
export async function lerTodasAsAbas(arquivo: File): Promise<ArquivoLido> {
  const { lerAbas } = await import('./planilha');
  return lerAbas(arquivo);
}

export { lerArquivoBase };
export type { Planilha };
