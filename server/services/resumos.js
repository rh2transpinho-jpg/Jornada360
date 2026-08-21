/* Resumos diário e semanal, e a análise gerencial.
 *
 * OS NÚMEROS NUNCA VÊM DA IA
 * --------------------------
 * Todo valor aqui sai de contagem no banco (`analiseRepository`). A IA, quando disponível, recebe
 * esses números já calculados e escreve o parágrafo de leitura — ela interpreta, não apura.
 *
 * Isso não é purismo: um modelo que soma 41 divergências e escreve "cerca de 40" produz um número
 * que não bate com a tela logo abaixo, e a partir daí ninguém confia em nenhum dos dois.
 *
 * Sem IA configurada, `analiseGerencial()` devolve uma leitura determinística — menos fluida, com
 * exatamente a mesma informação. */
import { consultar } from '../db/index.js';
import * as analiseRepo from '../repositories/analiseRepository.js';
import * as ia from './ia.js';

function minutosParaHoras(min) {
  const n = Math.max(0, Math.round(Number(min ?? 0)));
  return `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}`;
}

function dataBr(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

function diasAntes(iso, n) {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- diário */

export async function resumoDiario(tenantId, data) {
  const base = await analiseRepo.resumoDoDia(tenantId, data);
  const contadores = await analiseRepo.contadoresDaFila(tenantId);

  return {
    ...base,
    dataBr: dataBr(data),
    heTotal: minutosParaHoras(base.heTotalMin),
    fila: { abertas: contadores.total, criticas: contadores.criticos },
    /* Frases prontas para a tela, montadas a partir dos MESMOS números — a interface não deve
     * remontar texto a partir de contagem, senão passa a existir uma segunda versão do resumo. */
    linhas: [
      `${base.processados} jornada(s) analisada(s)`,
      `${base.ok} sem divergências`,
      base.precisamAnalise ? `${base.precisamAnalise} precisam de atenção` : null,
      ...base.porTipo.slice(0, 6).map((t) => `${t.total} ${t.rotulo.toLowerCase()}`),
    ].filter(Boolean),
  };
}

/* ---------------------------------------------------------------- semanal */

export async function resumoSemanal(tenantId, ate, dias = 7) {
  const de = diasAntes(ate, dias - 1);
  const atual = await analiseRepo.resumoDoPeriodo(tenantId, de, ate);

  /* Período anterior de mesmo tamanho, para a comparação pedida. Só é mostrado quando existe base:
   * "variação de +100%" sobre uma semana sem dado nenhum é ruído, não informação. */
  const deAnterior = diasAntes(de, dias);
  const ateAnterior = diasAntes(de, 1);
  const anterior = await analiseRepo.resumoDoPeriodo(tenantId, deAnterior, ateAnterior);
  const temComparacao = anterior.processados > 0;

  const divergenciasAtual = atual.atencao + atual.critico;
  const divergenciasAnterior = anterior.atencao + anterior.critico;

  const fila = await analiseRepo.listarFila(tenantId, { de, ate, limite: 1000, incluirResolvidas: true });
  const resolvidas = fila.filter((p) => p.status === 'resolvida').length;
  const abertas = fila.filter((p) => p.status !== 'resolvida').length;

  const porSetor = await heMaiorSetor(tenantId, de, ate);

  return {
    de,
    ate,
    deBr: dataBr(de),
    ateBr: dataBr(ate),
    processados: atual.processados,
    colaboradores: atual.colaboradores,
    ok: atual.ok,
    divergencias: divergenciasAtual,
    resolvidas,
    abertas,
    heTotalMin: atual.heTotalMin,
    heTotal: minutosParaHoras(atual.heTotalMin),
    porTipo: atual.porTipo,
    ocorrenciaMaisFrequente: atual.porTipo[0] ?? null,
    setorComMaisHE: porSetor,
    comparacao: temComparacao
      ? {
        periodoAnterior: { de: deAnterior, ate: ateAnterior },
        heAnteriorMin: anterior.heTotalMin,
        heVariacaoMin: atual.heTotalMin - anterior.heTotalMin,
        heVariacao: `${atual.heTotalMin - anterior.heTotalMin >= 0 ? '+' : '-'}${minutosParaHoras(Math.abs(atual.heTotalMin - anterior.heTotalMin))}`,
        divergenciasAnterior,
        divergenciasVariacao: divergenciasAtual - divergenciasAnterior,
      }
      : null,
    /* Explicitar a ausência é melhor do que omitir: quem abre o relatório precisa saber que a
     * comparação não apareceu por falta de base, não por estabilidade. */
    observacaoComparacao: temComparacao ? null : 'Sem base suficiente no período anterior para comparar.',
  };
}

async function heMaiorSetor(tenantId, de, ate) {
  const linhas = await consultar(
    `SELECT setor, SUM(he_min) AS total FROM he_ocorrencias
      WHERE tenant_id = ? AND data >= ? AND data <= ? AND setor <> ''
      GROUP BY setor ORDER BY total DESC LIMIT 1`,
    [tenantId, de, ate],
  );
  if (!linhas.length) return null;
  return { setor: linhas[0].setor, heMin: Number(linhas[0].total), he: minutosParaHoras(linhas[0].total) };
}

/* ---------------------------------------------------------------- análise gerencial */

const SISTEMA = `Você é analista de gestão de jornada e responde a gestores de RH em português do Brasil.

REGRAS ABSOLUTAS:
- Use SOMENTE os números fornecidos. Nunca calcule, estime, arredonde ou invente valor.
- Se os dados não respondem à pergunta, diga isso claramente em vez de supor.
- Separe FATO de INTERPRETAÇÃO: apresente o dado e, quando opinar, deixe explícito que é leitura sua.
- Nunca sugira medida disciplinar contra pessoa específica.
- Seja direto: no máximo dois parágrafos curtos.`;

/* Leitura determinística — o que aparece quando a IA não está disponível.
 *
 * Deliberadamente factual: aponta o maior número, a maior variação e o tipo mais frequente. Não
 * tenta parecer uma análise que não é. */
export function leituraDeterministica(semanal) {
  const partes = [];
  partes.push(
    `No período de ${semanal.deBr} a ${semanal.ateBr}, foram analisadas ${semanal.processados} jornadas `
    + `de ${semanal.colaboradores} colaborador(es): ${semanal.ok} sem divergências e ${semanal.divergencias} com divergência.`,
  );
  partes.push(`Total de hora extra: ${semanal.heTotal}.`);

  if (semanal.comparacao) {
    const v = semanal.comparacao.heVariacaoMin;
    partes.push(
      v === 0
        ? 'A hora extra ficou igual à do período anterior.'
        : `Em relação ao período anterior, a hora extra ${v > 0 ? 'aumentou' : 'caiu'} ${semanal.comparacao.heVariacao.replace(/^[+-]/, '')}.`,
    );
  } else if (semanal.observacaoComparacao) {
    partes.push(semanal.observacaoComparacao);
  }

  if (semanal.ocorrenciaMaisFrequente) {
    partes.push(`Ocorrência mais frequente: ${semanal.ocorrenciaMaisFrequente.rotulo} (${semanal.ocorrenciaMaisFrequente.total}).`);
  }
  if (semanal.setorComMaisHE) {
    partes.push(`Setor com maior hora extra: ${semanal.setorComMaisHE.setor} (${semanal.setorComMaisHE.he}).`);
  }

  return partes.join(' ');
}

/* Responde a uma pergunta gerencial sobre os dados JÁ calculados do tenant.
 *
 * ISOLAMENTO: recebe `tenantId` e só consulta com ele. A IA nunca vê dado de outra empresa porque
 * nunca recebe dado que não tenha vindo destas consultas — e elas são todas filtradas por tenant.
 * A rota, além disso, exige a permissão de leitura do usuário. */
export async function analiseGerencial(tenantId, pergunta, { ate = null, dias = 7 } = {}) {
  const fim = ate ?? new Date().toISOString().slice(0, 10);
  const semanal = await resumoSemanal(tenantId, fim, dias);
  const diario = await resumoDiario(tenantId, fim);
  const contadores = await analiseRepo.contadoresDaFila(tenantId);

  const dados = {
    periodo: { de: semanal.de, ate: semanal.ate },
    jornadasAnalisadas: semanal.processados,
    colaboradores: semanal.colaboradores,
    semDivergencia: semanal.ok,
    comDivergencia: semanal.divergencias,
    horaExtraTotal: semanal.heTotal,
    horaExtraTotalMin: semanal.heTotalMin,
    comparacaoPeriodoAnterior: semanal.comparacao,
    divergenciasPorTipo: semanal.porTipo,
    setorComMaisHE: semanal.setorComMaisHE,
    filaAberta: { total: contadores.total, criticas: contadores.criticos, porTipo: contadores.porTipo },
    hoje: { data: diario.data, processados: diario.processados, precisamAnalise: diario.precisamAnalise },
  };

  const determinada = leituraDeterministica(semanal);

  if (!ia.disponivel()) {
    return {
      resposta: determinada,
      origem: 'deterministica',
      dados,
      observacao: 'IA não configurada: esta é a leitura factual dos números apurados.',
    };
  }

  try {
    const texto = await ia.completar({
      sistema: SISTEMA,
      mensagem: `DADOS APURADOS PELO SISTEMA (JSON):\n${JSON.stringify(dados, null, 2)}\n\nPERGUNTA DO GESTOR:\n${pergunta}`,
      maxTokens: 700,
    });
    return {
      resposta: texto,
      origem: 'ia',
      dados,
      observacao: 'Interpretação gerada por IA sobre os números apurados pelo sistema.',
    };
  } catch (e) {
    return {
      resposta: determinada,
      origem: 'deterministica',
      dados,
      observacao: `IA indisponível (${e.message}). Esta é a leitura factual dos números apurados.`,
    };
  }
}
