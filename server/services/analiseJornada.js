/* Análise automática da jornada: de "72 pessoas processadas" para "14 precisam de você".
 *
 * A FILOSOFIA, EM CÓDIGO
 * ----------------------
 * "Se está correto, não me faça perder tempo conferindo. Se precisa de atenção, coloque na minha
 * frente já explicado."
 *
 * Traduzindo: toda jornada é analisada, mas só as que divergem entram na fila — e cada uma entra
 * carregando o porquê (referência usada, previsto, realizado, diferença). Quem está OK sai do
 * caminho.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ
 * --------------------------
 * Não inventa regra trabalhista. A detecção de divergência é `referenciaJornada.compararComReferencia`,
 * que usa a tolerância JÁ configurada da empresa. O cálculo de hora extra continua sendo do motor
 * (`he1min`) e a classificação de excedente continua sendo `excedente = HE − extra previsto`, a
 * mesma conta que `heEngineCore.reclassificar` sempre fez. O que muda nesta fase é DE ONDE vem o
 * "extra previsto": antes só da planilha de padrão, agora da escala do dia quando ela existe.
 *
 * A GRAVIDADE É DECLARATIVA
 * -------------------------
 * `GRAVIDADE` abaixo é a única tabela que decide o que é crítico. Espalhar isso em `if`s pela
 * classificação e pela priorização produziria duas opiniões sobre o mesmo caso. */
import {
  DIVERGENCIAS, ROTULO_DIVERGENCIA, TIPO_AUSENTE, TIPO_ESCALA, TIPO_PADRAO,
  compararComReferencia, duracaoMarcacoes, faixaLegivel, marcacoesDeTexto,
  resolverReferenciasDoDia,
} from './referenciaJornada.js';
import { chaveColaborador } from '../repositories/heRepository.js';

export const CLASSES = ['ok', 'atencao', 'critico'];

export const ROTULO_CLASSE = {
  ok: 'Sem divergências',
  atencao: 'Precisa de análise',
  critico: 'Tratamento prioritário',
};

/* Gravidade por tipo de divergência.
 *
 * `critico` é reservado para o que tem consequência trabalhista ou impede a própria análise:
 * trabalhar em folga, não ter contra o que comparar, e intervalo abaixo do mínimo. O resto é
 * atenção — divergência real, tratada na fila, sem alarme falso. */
export const GRAVIDADE = {
  [DIVERGENCIAS.TRABALHO_EM_FOLGA]: 'critico',
  [DIVERGENCIAS.SEM_REFERENCIA]: 'critico',
  [DIVERGENCIAS.PONTO_SEM_ESCALA]: 'critico',
  [DIVERGENCIAS.INTERVALO_INSUFICIENTE]: 'critico',
  [DIVERGENCIAS.SEM_INTERVALO]: 'critico',
  [DIVERGENCIAS.REGISTROS_INCOMPATIVEIS]: 'critico',
  [DIVERGENCIAS.JORNADA_INCOMPLETA]: 'critico',

  [DIVERGENCIAS.ESCALA_SEM_PONTO]: 'atencao',
  [DIVERGENCIAS.INTERVALO_DIVERGENTE]: 'atencao',
  [DIVERGENCIAS.INTERVALO_FORA_DO_PREVISTO]: 'atencao',
  [DIVERGENCIAS.ENTRADA_ANTECIPADA]: 'atencao',
  [DIVERGENCIAS.ENTRADA_ATRASADA]: 'atencao',
  [DIVERGENCIAS.SAIDA_ANTECIPADA]: 'atencao',
  [DIVERGENCIAS.SAIDA_POSTERIOR]: 'atencao',
  [DIVERGENCIAS.JORNADA_DIFERENTE]: 'atencao',
  [DIVERGENCIAS.HE_POTENCIAL]: 'atencao',

  /* Escala extra é contexto, não problema: um dia extra com horário batendo certinho continua OK.
   * Marcar como atenção encheria a fila de dias corretos — o oposto do que esta fase existe para
   * fazer. */
  [DIVERGENCIAS.ESCALA_EXTRA]: 'ok',
};

/* Peso base por gravidade, usado na priorização. A distância entre as faixas é grande de
 * propósito: nenhum acúmulo de minutos deve fazer um caso de atenção passar na frente de um
 * crítico. */
const PESO_CLASSE = { critico: 1_000_000, atencao: 10_000, ok: 0 };

export function classeDe(divergencias) {
  let classe = 'ok';
  for (const d of divergencias) {
    const g = GRAVIDADE[d.tipo] ?? 'atencao';
    if (g === 'critico') return 'critico';
    if (g === 'atencao') classe = 'atencao';
  }
  return classe;
}

/* ---------------------------------------------------------------- priorização */

/* Score de urgência. Maior = mais para cima na fila.
 *
 * Combina os sinais que o requisito pede, em ordem de importância:
 *   gravidade  → separa as faixas (peso dominante)
 *   minutos    → dentro da faixa, o caso maior vem antes
 *   HE         → hora extra pesa mais que divergência sem custo
 *   reincidência → quem repete sobe
 *   idade      → o que está parado há mais tempo sobe (evita fila que envelhece no fundo)
 *   recálculo  → mudou depois de alguém já ter analisado: precisa de segunda olhada
 *   sem referência → não dá nem para concluir; sobe
 */
export function prioridadeDe({
  classe, divergencias = [], heMin = 0, excedenteMin = 0, reincidencia = 0,
  diasParado = 0, recalculada = false, semReferencia = false,
}) {
  let score = PESO_CLASSE[classe] ?? 0;

  const maiorDiferenca = divergencias.reduce(
    (m, d) => Math.max(m, Math.abs(Number(d.diferencaMin ?? 0))), 0,
  );

  score += Math.min(maiorDiferenca, 600) * 3;
  score += Math.min(Math.max(excedenteMin, 0), 600) * 4;
  score += Math.min(Math.max(heMin, 0), 600);
  score += Math.min(reincidencia, 20) * 250;
  score += Math.min(diasParado, 120) * 40;
  if (recalculada) score += 5_000;
  if (semReferencia) score += 3_000;

  return Math.round(score);
}

/* ---------------------------------------------------------------- análise de um dia */

/* Extrai as marcações reais do item do motor.
 *
 * `batidas` vem com ícones ("06:03✅ 11:02✅ 12:01❌") — o marcador é a informação de conferência
 * do rastreio, não do ponto, e aqui interessa só o horário. */
export function marcacoesDoItem(item) {
  const doTexto = marcacoesDeTexto(item?.batidas);
  if (doTexto.length) return doTexto;
  /* Snapshots antigos podem não ter `batidas` detalhado; `confirmadas` às vezes traz a faixa. */
  return marcacoesDeTexto(item?.confirmadas);
}

/* Analisa TODOS os itens de um dia contra suas referências.
 *
 * Recebe o snapshot que o motor produziu — não reprocessa ponto, não recalcula HE. O que faz é
 * decidir contra qual horário cada pessoa deveria ter sido comparada, apontar as diferenças e
 * classificar. */
export async function analisarDiaCompleto(tenantId, dateKey, snapshot, opcoes = {}) {
  const {
    toleranciaMin = 0, intervaloMinimoMin = 0, db = null, reincidencias = new Map(),
  } = opcoes;

  const itens = snapshot?.items ?? [];
  const chaves = itens.map((i) => chaveColaborador(i.motorista)).filter(Boolean);
  const referencias = await resolverReferenciasDoDia(tenantId, chaves, dateKey, db);

  const analises = [];

  for (const item of itens) {
    const chave = chaveColaborador(item.motorista);
    if (!chave) continue;

    const referencia = referencias.get(chave) ?? referencias.get(chave);
    const reais = marcacoesDoItem(item);
    const divergencias = compararComReferencia(referencia, reais, { toleranciaMin, intervaloMinimoMin });

    /* Quantidade incompatível de registros: ímpar, ou mais do que o modelo comporta. Não vem da
     * comparação com a referência — é um problema do próprio espelho, e sem ele a jornada não
     * fecha nem contra a escala nem contra o padrão. */
    if (reais.length && (reais.length % 2 !== 0 || reais.length > 6)) {
      divergencias.push({
        tipo: DIVERGENCIAS.REGISTROS_INCOMPATIVEIS,
        rotulo: ROTULO_DIVERGENCIA[DIVERGENCIAS.REGISTROS_INCOMPATIVEIS],
        previsto: referencia.faixa,
        realizado: faixaLegivel(reais) || reais.join(' '),
        diferencaMin: null,
        detalhe: `O espelho trouxe ${reais.length} registro(s) no dia: a jornada não fecha em pares de entrada e saída.`,
      });
    }

    /* HE potencial: o motor já calculou o HE do dia; o que decidimos aqui é se ele PASSA do que a
     * referência previa. `extraMin` é o extra já programado — na escala do exemplo, os 60 minutos
     * que a pessoa iria fazer de qualquer forma. */
    const heMin = Number(item.he1min ?? 0);
    const extraPrevisto = referencia.extraMin ?? null;
    const excedenteMin = extraPrevisto === null ? heMin : heMin - extraPrevisto;

    if (heMin > 0 && excedenteMin > toleranciaMin) {
      divergencias.push({
        tipo: DIVERGENCIAS.HE_POTENCIAL,
        rotulo: ROTULO_DIVERGENCIA[DIVERGENCIAS.HE_POTENCIAL],
        previsto: extraPrevisto === null ? 'sem extra previsto' : `${extraPrevisto} min previstos`,
        realizado: `${heMin} min`,
        diferencaMin: excedenteMin,
        detalhe: extraPrevisto === null
          ? 'Há hora extra e nenhuma referência informa quanto já era previsto.'
          : `Excedeu em ${excedenteMin} min o que a ${referencia.tipo === TIPO_ESCALA ? 'escala do dia' : 'jornada padrão'} previa.`,
      });
    }

    const classe = classeDe(divergencias);
    const semReferencia = referencia.tipo === TIPO_AUSENTE;

    analises.push({
      colaboradorChave: chave,
      colaborador: item.motorista,
      data: dateKey,
      referencia,
      divergencias,
      classificacao: classe,
      heMin,
      excedenteMin,
      pontoMarcacoes: faixaLegivel(reais) || reais.join(' '),
      jornadaRealizadaMin: duracaoMarcacoes(reais).totalMin,
      prioridade: prioridadeDe({
        classe,
        divergencias,
        heMin,
        excedenteMin,
        reincidencia: reincidencias.get(chave) ?? 0,
        semReferencia,
      }),
    });
  }

  return analises;
}

/* Contagem para o painel do dia. Sai da MESMA lista de análises que alimenta a fila — por isso o
 * resumo nunca discorda do que a tela mostra logo abaixo dele. */
export function resumirAnalises(analises) {
  const porTipo = {};
  let ok = 0; let atencao = 0; let critico = 0;

  for (const a of analises) {
    if (a.classificacao === 'ok') ok += 1;
    else if (a.classificacao === 'critico') critico += 1;
    else atencao += 1;

    for (const d of a.divergencias) {
      porTipo[d.tipo] = (porTipo[d.tipo] ?? 0) + 1;
    }
  }

  return {
    processados: analises.length,
    ok,
    atencao,
    critico,
    precisamAnalise: atencao + critico,
    porTipo,
    detalhePorTipo: Object.entries(porTipo)
      .map(([tipo, total]) => ({ tipo, rotulo: ROTULO_DIVERGENCIA[tipo] ?? tipo, total }))
      .sort((a, b) => b.total - a.total),
    heTotalMin: analises.reduce((s, a) => s + Math.max(a.heMin, 0), 0),
    referencias: {
      escala: analises.filter((a) => a.referencia.tipo === TIPO_ESCALA).length,
      padrao: analises.filter((a) => a.referencia.tipo === TIPO_PADRAO).length,
      ausente: analises.filter((a) => a.referencia.tipo === TIPO_AUSENTE).length,
    },
  };
}
