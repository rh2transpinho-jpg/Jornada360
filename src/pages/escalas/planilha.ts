/* Leitura de planilha de escala: CSV nativo, XLSX sob demanda.
 *
 * POR QUE NÃO ENTROU UMA DEPENDÊNCIA NOVA
 * ---------------------------------------
 * CSV é lido aqui, sem biblioteca nenhuma — é o formato que sempre funciona, inclusive offline.
 *
 * XLSX é um ZIP de XMLs; escrever um leitor próprio seria muito código para errar em silêncio com
 * datas e horas, que é justamente o dado crítico aqui. Em vez de adicionar um pacote ao
 * `package.json` (superfície de supply chain a mais, num projeto que já carrega um alerta de
 * vulnerabilidade que decidimos não forçar), esta função carrega SOB DEMANDA a mesma biblioteca e
 * a mesma versão que o motor de HE já usa há tempos — e só quando alguém escolhe um .xlsx.
 *
 * Se o carregamento falhar (sem internet, CSP), a mensagem diz para converter em CSV, que é um
 * caminho real e imediato. Nunca deixamos o usuário sem saída. */

export interface Planilha {
  cabecalho: string[];
  linhas: string[][];
  formato: 'csv' | 'xlsx';
}

const CDN_XLSX = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

declare global {
  interface Window { XLSX?: { read: (d: ArrayBuffer, o: unknown) => unknown; utils: Record<string, (...a: unknown[]) => unknown> } }
}

let carregando: Promise<void> | null = null;

function carregarXlsx(): Promise<void> {
  if (window.XLSX) return Promise.resolve();
  if (carregando) return carregando;

  carregando = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN_XLSX;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(
      'Não foi possível carregar o leitor de XLSX. Salve a planilha como CSV e importe novamente.',
    ));
    document.head.appendChild(s);
  });
  return carregando;
}

/* Divide uma linha de CSV respeitando aspas. Um `split(',')` simples quebra em qualquer
 * observação que contenha vírgula — e observação com vírgula é o caso comum, não a exceção. */
export function dividirLinhaCsv(linha: string, separador: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let dentroDeAspas = false;

  for (let i = 0; i < linha.length; i += 1) {
    const c = linha[i];
    if (c === '"') {
      /* Aspas duplas escapadas dentro de um campo entre aspas. */
      if (dentroDeAspas && linha[i + 1] === '"') { atual += '"'; i += 1; }
      else dentroDeAspas = !dentroDeAspas;
    } else if (c === separador && !dentroDeAspas) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos.map((c) => c.trim());
}

/* Descobre o separador olhando o cabeçalho. Planilha brasileira exportada do Excel costuma sair
 * com ponto e vírgula; arquivo gerado por sistema costuma sair com vírgula. Chutar errado
 * transforma a planilha inteira numa coluna só. */
function detectarSeparador(primeiraLinha: string): string {
  const candidatos = [';', ',', '\t'];
  let melhor = ';';
  let maior = 0;
  for (const c of candidatos) {
    const n = dividirLinhaCsv(primeiraLinha, c).length;
    if (n > maior) { maior = n; melhor = c; }
  }
  return melhor;
}

export function lerCsv(texto: string): Planilha {
  /* BOM do Excel: sem remover, a primeira coluna do cabeçalho nunca casa com nada. */
  const limpo = texto.replace(/^﻿/, '');
  const linhas = limpo.split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return { cabecalho: [], linhas: [], formato: 'csv' };

  const sep = detectarSeparador(linhas[0]);
  const [cab, ...resto] = linhas;
  return {
    cabecalho: dividirLinhaCsv(cab, sep),
    linhas: resto.map((l) => dividirLinhaCsv(l, sep)),
    formato: 'csv',
  };
}

export async function lerXlsx(buffer: ArrayBuffer): Promise<Planilha> {
  await carregarXlsx();
  const XLSX = window.XLSX!;
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false }) as {
    SheetNames: string[]; Sheets: Record<string, unknown>;
  };
  const aba = wb.Sheets[wb.SheetNames[0]];

  /* `raw: false` faz a biblioteca aplicar a formatação da célula: uma hora vira "06:00" em vez do
   * número fracionário que o Excel guarda por baixo. É o que evita "0.25" no lugar de 06:00. */
  const matriz = XLSX.utils.sheet_to_json(aba, { header: 1, raw: false, defval: '' }) as unknown as string[][];
  const linhas = matriz.filter((l) => l.some((c) => String(c ?? '').trim()));
  if (!linhas.length) return { cabecalho: [], linhas: [], formato: 'xlsx' };

  const [cab, ...resto] = linhas;
  return {
    cabecalho: cab.map((c) => String(c ?? '').trim()),
    linhas: resto.map((l) => l.map((c) => String(c ?? '').trim())),
    formato: 'xlsx',
  };
}

export async function lerArquivo(arquivo: File): Promise<Planilha> {
  const nome = arquivo.name.toLowerCase();
  if (nome.endsWith('.csv') || nome.endsWith('.txt')) {
    return lerCsv(await arquivo.text());
  }
  if (nome.endsWith('.xlsx') || nome.endsWith('.xls')) {
    return lerXlsx(await arquivo.arrayBuffer());
  }
  throw new Error('Formato não reconhecido. Use .xlsx ou .csv.');
}

/* ---------------------------------------------------------------- mapeamento */

export type CampoEscala =
  | 'colaborador' | 'matricula' | 'data' | 'setor' | 'unidade' | 'turno'
  | 'entrada' | 'saidaIntervalo' | 'retorno' | 'saida'
  | 'entrada3' | 'saida3'
  | 'situacao' | 'observacao';

export const CAMPOS: { id: CampoEscala; rotulo: string; obrigatorio?: boolean }[] = [
  { id: 'colaborador', rotulo: 'Nome do colaborador', obrigatorio: true },
  { id: 'matricula', rotulo: 'Matrícula' },
  { id: 'data', rotulo: 'Data', obrigatorio: true },
  { id: 'situacao', rotulo: 'Situação' },
  { id: 'entrada', rotulo: 'Entrada' },
  { id: 'saidaIntervalo', rotulo: 'Saída para intervalo' },
  { id: 'retorno', rotulo: 'Retorno do intervalo' },
  { id: 'saida', rotulo: 'Saída' },
  { id: 'entrada3', rotulo: 'Entrada (3º turno)' },
  { id: 'saida3', rotulo: 'Saída (3º turno)' },
  { id: 'setor', rotulo: 'Setor' },
  { id: 'unidade', rotulo: 'Unidade' },
  { id: 'turno', rotulo: 'Turno' },
  { id: 'observacao', rotulo: 'Observação' },
];

/* Palpites por nome de coluna. É só um ponto de partida — quem importa confirma tudo na tela.
 * Adivinhar e aplicar sem confirmação é o que produz importação silenciosamente trocada. */
const PALPITES: Record<CampoEscala, string[]> = {
  colaborador: ['colaborador', 'nome', 'funcionario', 'funcionário', 'motorista', 'empregado'],
  matricula: ['matricula', 'matrícula', 'registro', 'chapa'],
  data: ['data', 'dia', 'dt'],
  situacao: ['situacao', 'situação', 'status', 'tipo'],
  entrada: ['entrada', 'entrada 1', 'ent1', 'inicio', 'início', 'horario 1', 'horário 1'],
  saidaIntervalo: ['saida intervalo', 'saída intervalo', 'saida almoco', 'saída almoço', 'intervalo', 'saida 1', 'saída 1'],
  retorno: ['retorno', 'volta', 'entrada 2', 'ent2', 'retorno intervalo'],
  saida: ['saida', 'saída', 'saida 2', 'saída 2', 'fim', 'termino', 'término'],
  entrada3: ['entrada 3', 'ent3'],
  saida3: ['saida 3', 'saída 3'],
  setor: ['setor', 'departamento', 'area', 'área'],
  unidade: ['unidade', 'filial', 'local'],
  turno: ['turno', 'escala'],
  observacao: ['observacao', 'observação', 'obs', 'nota'],
};

function normalizar(s: string): string {
  return s.toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function sugerirMapeamento(cabecalho: string[]): Partial<Record<CampoEscala, number>> {
  const mapa: Partial<Record<CampoEscala, number>> = {};
  const usadas = new Set<number>();

  for (const campo of CAMPOS) {
    const palpites = PALPITES[campo.id].map(normalizar);
    const i = cabecalho.findIndex((c, idx) => !usadas.has(idx) && palpites.includes(normalizar(c)));
    if (i >= 0) { mapa[campo.id] = i; usadas.add(i); }
  }
  return mapa;
}

/* ---------------------------------------------------------------- normalização de valores */

/* Datas chegam em qualquer forma. Aceita AAAA-MM-DD, DD/MM/AAAA e DD/MM/AA, e devolve sempre ISO.
 * Devolve o texto original quando não reconhece — para que o servidor recuse com uma mensagem
 * sobre a linha, em vez de esta função inventar uma data plausível. */
export function normalizarData(valor: string): string {
  const t = String(valor ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const br = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (br) {
    const [, d, m, a] = br;
    const ano = a.length === 2 ? `20${a}` : a;
    return `${ano}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return t;
}

/* Situação em texto livre → o valor que o servidor entende. Sem correspondência, devolve
 * 'trabalha' apenas quando a célula está vazia; qualquer outro texto vira o próprio texto, para
 * que o servidor recuse e a linha apareça na prévia com o problema. */
export function normalizarSituacao(valor: string): string {
  const t = normalizar(String(valor ?? ''));
  if (!t) return 'trabalha';
  if (/^(folga|descanso|dsr)$/.test(t)) return 'folga';
  if (/extra/.test(t)) return 'extra';
  if (/(altera|troca|mudan)/.test(t)) return 'alteracao_horario';
  if (/(ferias|férias|atestado|afast|licenc|ausencia)/.test(t)) return 'ausencia_programada';
  if (/^(trabalha|normal|util|útil|t)$/.test(t)) return 'trabalha';
  return String(valor).trim();
}

export interface LinhaEscala {
  colaborador: string;
  data: string;
  situacao: string;
  marcacoes: string[];
  setor: string;
  unidade: string;
  turno: string;
  observacao: string;
  matricula: string;
}

export function montarLinhas(
  planilha: Planilha,
  mapa: Partial<Record<CampoEscala, number>>,
  cargaPrevistaMin: number | null,
): (LinhaEscala & { cargaPrevistaMin: number | null })[] {
  const val = (linha: string[], campo: CampoEscala): string => {
    const i = mapa[campo];
    return i === undefined ? '' : String(linha[i] ?? '').trim();
  };

  return planilha.linhas.map((linha) => {
    /* A ordem das marcações É a ordem da jornada. Campos vazios no meio são descartados, não
     * preenchidos: quem só tem entrada e saída não tem intervalo inventado. */
    const marcacoes = [
      val(linha, 'entrada'),
      val(linha, 'saidaIntervalo'),
      val(linha, 'retorno'),
      val(linha, 'saida'),
      val(linha, 'entrada3'),
      val(linha, 'saida3'),
    ].filter((m) => m);

    return {
      colaborador: val(linha, 'colaborador'),
      data: normalizarData(val(linha, 'data')),
      situacao: normalizarSituacao(val(linha, 'situacao')),
      marcacoes,
      setor: val(linha, 'setor'),
      unidade: val(linha, 'unidade'),
      turno: val(linha, 'turno'),
      observacao: val(linha, 'observacao'),
      matricula: val(linha, 'matricula'),
      cargaPrevistaMin,
    };
  });
}
