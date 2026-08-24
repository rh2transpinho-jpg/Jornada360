/* Orquestração do processamento automático de um dia.
 *
 * O QUE ACONTECE QUANDO UM DIA É GRAVADO
 * --------------------------------------
 *   1. o dia é salvo (snapshot do motor, intocado);
 *   2. as ocorrências de HE são sincronizadas — números atualizados, análise humana preservada;
 *   3. cada jornada é analisada contra o HORÁRIO PADRÃO vigente (a referência trabalhista);
 *   4. o resultado é classificado em OK / atenção / crítico;
 *   5. a fila recebe SÓ o que precisa de gente, e perde o que deixou de ser problema.
 *
 * TUDO ISSO NUMA CHAMADA SÓ, E DE PROPÓSITO
 * -----------------------------------------
 * A alternativa seria uma rotina separada que alguém dispara depois. Foi assim que, na fase
 * anterior, a pendência de HE ficava fora de sincronia com a ocorrência: dois caminhos para o
 * mesmo dado sempre acabam divergindo. Se o dia foi gravado, ele está analisado.
 *
 * ORDEM IMPORTA: a fila é sincronizada DEPOIS da análise porque ela lê o `analise.id` gravado no
 * passo anterior. */
import { executar } from '../db/index.js';
import * as operacao from '../repositories/operacaoRepository.js';
import * as he from '../repositories/heRepository.js';
import * as analiseRepo from '../repositories/analiseRepository.js';
import * as servicos from '../repositories/escalaServicoRepository.js';
import * as empresa from '../repositories/empresaRepository.js';
import { analisarDiaCompleto, resumirAnalises } from './analiseJornada.js';
import { resolverReferenciasDoDia } from './referenciaJornada.js';
import { chaveColaborador } from '../repositories/heRepository.js';

const REGRAS_PADRAO = { toleranceMin: 0, intervalMinMin: 0, prazoPadraoDias: 3 };

async function regrasDe(tenantId) {
  const r = await empresa.obterRegras(tenantId);
  return { ...REGRAS_PADRAO, ...(r?.regras ?? {}) };
}

/* Processa um dia já gravado. Idempotente: rodar de novo com o mesmo snapshot produz o mesmo
 * resultado e não duplica nada — nem análise (chave tenant+pessoa+dia) nem pendência (dedupe). */
export async function processarDia(tenantId, dateKey, snapshot, opcoes = {}) {
  const regras = await regrasDe(tenantId);

  /* Reincidência é lida ANTES de gravar a análise de hoje: senão o próprio dia entraria na conta
   * da própria priorização. */
  const reincidencias = await analiseRepo.reincidenciasDaJanela(tenantId, dateKey, 30);

  /* Quantos serviços operacionais cada pessoa tem no dia. É CONTEXTO — entra na explicação da
   * ocorrência e não em nenhuma conta de jornada. Uma consulta por dia, não por pessoa. */
  const servicosPorColaborador = await servicos.contagemPorColaborador(tenantId, dateKey);

  const analises = await analisarDiaCompleto(tenantId, dateKey, snapshot, {
    toleranciaMin: regras.toleranceMin,
    intervaloMinimoMin: regras.intervalMinMin,
    reincidencias,
    servicosPorColaborador,
  });

  await analiseRepo.sincronizarDia(tenantId, dateKey, analises);

  const fila = opcoes.sincronizarFila === false
    ? { criadas: 0, atualizadas: 0, resolvidas: 0 }
    : await analiseRepo.sincronizarFila(tenantId, dateKey, analises, { prazoDias: regras.prazoPadraoDias });

  return { resumo: resumirAnalises(analises), fila, analises };
}

/* Grava o dia E processa. É o caminho único usado pela rota e pelos testes. */
export async function salvarEProcessar(tenantId, dateKey, snapshot, caseState, opcoes = {}) {
  const dia = await operacao.salvarDia(tenantId, dateKey, snapshot, caseState);

  const sincronia = await he.sincronizarDia(tenantId, dateKey, snapshot);
  await registrarReferenciasNaHE(tenantId, dateKey, snapshot);
  await he.gerarPendencias(tenantId);

  const processamento = await processarDia(tenantId, dateKey, snapshot, opcoes);

  return { dia, he: sincronia, ...processamento };
}

/* Carimba, em cada ocorrência de HE do dia, contra qual horário ela foi comparada.
 *
 * Só escreve as colunas de REFERÊNCIA — nunca toca em justificativa, responsável, status ou
 * histórico. É a mesma fronteira da fase anterior: o motor escreve números e contexto de cálculo;
 * a análise humana é de quem analisou. */
async function registrarReferenciasNaHE(tenantId, dateKey, snapshot) {
  const itens = snapshot?.items ?? [];
  const chaves = itens.map((i) => chaveColaborador(i.motorista)).filter(Boolean);
  if (!chaves.length) return;

  const referencias = await resolverReferenciasDoDia(tenantId, chaves, dateKey);

  for (const [chave, ref] of referencias) {
    await executar(
      `UPDATE he_ocorrencias
          SET referencia_tipo = ?, referencia_id = ?, referencia_horarios = ?,
              referencia_extra_min = ?
        WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
      [ref.tipo, ref.id ?? null, ref.faixa ?? '', ref.extraMin ?? null, tenantId, chave, dateKey],
    );
  }
}

/* Reprocessa um intervalo de dias já gravados.
 *
 * Serve para depois de uma importação de escala: os dias já analisados passam a ter referência, e
 * as pendências de "ponto sem escala" se resolvem sozinhas. É o requisito 17 — o sistema não
 * obriga ninguém a fechar à mão o que ele já sabe que foi resolvido. */
export async function reprocessarPeriodo(tenantId, de, ate) {
  const dias = await operacao.listarDiasCompletos(tenantId);
  const alvo = dias.filter((d) => (!de || d.dateKey >= de) && (!ate || d.dateKey <= ate));

  const total = { dias: 0, criadas: 0, atualizadas: 0, resolvidas: 0, analisadas: 0 };

  for (const dia of alvo) {
    const snapshot = dia.snapshot ?? dia;
    if (!snapshot?.items?.length) continue;
    await he.sincronizarDia(tenantId, dia.dateKey, snapshot);
    await registrarReferenciasNaHE(tenantId, dia.dateKey, snapshot);
    const r = await processarDia(tenantId, dia.dateKey, snapshot);
    total.dias += 1;
    total.analisadas += r.resumo.processados;
    total.criadas += r.fila.criadas;
    total.atualizadas += r.fila.atualizadas;
    total.resolvidas += r.fila.resolvidas;
  }

  return total;
}
