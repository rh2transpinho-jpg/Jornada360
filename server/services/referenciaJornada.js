/* Qual horário o ponto deve ser comparado contra.
 *
 * A PERGUNTA QUE ESTE ARQUIVO RESPONDE, E POR QUE ELA É DIFÍCIL
 * -------------------------------------------------------------
 * Uma pessoa tem um horário habitual (06:00–16:00) e, numa terça específica, foi escalada para
 * 06:00–17:00. Ela sai 17:18. Quanto de hora extra é isso?
 *
 *   comparando contra o hábito  → 78 minutos, quase todos programados;
 *   comparando contra a escala  → 18 minutos, que é a resposta certa.
 *
 * Comparar contra o horário errado não produz um número aproximado: produz hora extra que não
 * existe, com nome e data, que alguém vai ter que justificar. Por isso a precedência abaixo é
 * rígida e o terceiro caso é um estado explícito, não um valor default.
 *
 *   1. existe escala para (colaborador, data) → ESCALA
 *   2. senão, o padrão VIGENTE naquela data   → PADRÃO
 *   3. nenhum dos dois                        → NÃO ENCONTRADA
 *
 * Nunca inventar horário.
 *
 * SOBRE A ARITMÉTICA: nada aqui é regra trabalhista nova. `extraDeMarcacoes` é a mesma conta que
 * o motor já fazia sobre a planilha de padrão (soma dos turnos − carga, com a mesma faixa de
 * plausibilidade de ±300 min), portada para o servidor porque agora a referência vem do banco.
 * A classificação de excedente contra tolerância continua sendo a de `heEngineCore.reclassificar`.
 */
import { consultar, consultarUm } from '../db/index.js';

export const TIPO_ESCALA = 'escala';
export const TIPO_PADRAO = 'padrao';
export const TIPO_AUSENTE = 'nao_encontrada';

export const ROTULO_REFERENCIA = {
  [TIPO_ESCALA]: 'Escala do dia',
  [TIPO_PADRAO]: 'Horário padrão',
  [TIPO_AUSENTE]: 'Referência de jornada não encontrada',
};

export const SITUACOES_ESCALA = [
  'trabalha', 'folga', 'extra', 'alteracao_horario', 'ausencia_programada', 'sem_definicao',
];

export const ROTULO_SITUACAO_ESCALA = {
  trabalha: 'Trabalha',
  folga: 'Folga',
  extra: 'Escala extra',
  alteracao_horario: 'Alteração de horário',
  ausencia_programada: 'Ausência programada',
  sem_definicao: 'Sem escala definida',
};

/* ---------------------------------------------------------------- horas */

/* Aceita "6:00", "06:00", "06:00:00" e "0600". Devolve minutos desde a meia-noite, ou null.
 * Retornar null em vez de 0 é deliberado: 0 é meia-noite, um horário válido. */
export function paraMinutos(valor) {
  if (valor === null || valor === undefined) return null;
  const txt = String(valor).trim();
  if (!txt) return null;

  const m = txt.match(/^(\d{1,2})[:h.]?(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59 || h > 47) return null;
  return h * 60 + min;
}

export function paraHora(minutos) {
  if (minutos === null || minutos === undefined || !Number.isFinite(minutos)) return '';
  const m = ((Math.round(minutos) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* Extrai as marcações de um texto livre. Serve tanto para a coluna de uma planilha
 * ("06:00 11:00 12:00 16:00") quanto para o campo `batidas` do motor, que vem com ícones
 * ("06:03✅ 11:02✅ 12:01✅ 17:18❌"). */
export function marcacoesDeTexto(texto) {
  if (!texto) return [];
  const achados = String(texto).match(/\d{1,2}[:h]\d{2}/g) ?? [];
  return achados.map((h) => paraHora(paraMinutos(h))).filter(Boolean);
}

/* Normaliza uma lista de marcações: descarta o que não é horário e mantém a ordem informada.
 * NÃO ordena — a ordem das batidas é informação (uma saída antes da entrada é um erro a mostrar,
 * não a consertar silenciosamente). */
export function normalizarMarcacoes(lista) {
  if (!Array.isArray(lista)) return marcacoesDeTexto(lista);
  return lista.map((v) => paraHora(paraMinutos(v))).filter(Boolean);
}

/* Soma a duração dos pares (0–1, 2–3, 4–5). Suporta 2, 4 ou 6 marcações — que é o que o motor já
 * lia da planilha em três pares entrada/saída. Uma marcação ímpar sobrando é ignorada na soma e
 * sinalizada por `quantidadeValida`. */
export function duracaoMarcacoes(marcacoes) {
  const mins = normalizarMarcacoes(marcacoes).map(paraMinutos);
  let total = 0;
  let pares = 0;
  for (let i = 0; i + 1 < mins.length; i += 2) {
    let ini = mins[i];
    let fim = mins[i + 1];
    if (ini === null || fim === null) continue;
    /* Vira o dia: saída 02:00 com entrada 22:00 é jornada noturna, não oito horas negativas. */
    if (fim < ini) fim += 1440;
    total += fim - ini;
    pares += 1;
  }
  return { totalMin: total, pares, quantidadeValida: mins.length > 0 && mins.length % 2 === 0 };
}

/* Extra habitual/previsto: soma dos turnos − carga contratual.
 *
 * Mesma fórmula e mesma faixa de plausibilidade do motor. Fora da faixa devolve `valido: false` em
 * vez de um número — um extra de 8 horas quase sempre significa coluna trocada na planilha, e
 * aceitar isso caladamente contamina toda a análise daquela pessoa. */
export function extraDeMarcacoes(marcacoes, cargaPrevistaMin) {
  const { totalMin, pares } = duracaoMarcacoes(marcacoes);
  if (!pares || cargaPrevistaMin === null || cargaPrevistaMin === undefined) {
    return { extraMin: null, totalMin, valido: false };
  }
  const extraMin = Math.round(totalMin - Number(cargaPrevistaMin));
  return { extraMin, totalMin, valido: extraMin >= -300 && extraMin <= 300 };
}

/* Faixa legível: "06:00–16:00". Com dois intervalos vira "06:00–11:00 · 12:00–16:00". */
export function faixaLegivel(marcacoes) {
  const m = normalizarMarcacoes(marcacoes);
  const partes = [];
  for (let i = 0; i + 1 < m.length; i += 2) partes.push(`${m[i]}–${m[i + 1]}`);
  return partes.join(' · ');
}

export function primeiraEntrada(marcacoes) {
  const m = normalizarMarcacoes(marcacoes);
  return m.length ? m[0] : '';
}

export function ultimaSaida(marcacoes) {
  const m = normalizarMarcacoes(marcacoes);
  /* Com número ímpar de marcações a última é uma entrada sem saída — não é saída prevista. */
  return m.length >= 2 && m.length % 2 === 0 ? m[m.length - 1] : '';
}

/* ---------------------------------------------------------------- resolução da referência */

function referenciaDeEscala(linha) {
  const marcacoes = JSON.parse(linha.marcacoes_json || '[]');
  return {
    tipo: TIPO_ESCALA,
    rotulo: ROTULO_REFERENCIA[TIPO_ESCALA],
    id: linha.id,
    situacao: linha.situacao,
    marcacoes,
    faixa: faixaLegivel(marcacoes),
    entradaPrevista: primeiraEntrada(marcacoes),
    saidaPrevista: ultimaSaida(marcacoes),
    cargaPrevistaMin: linha.carga_prevista_min ?? null,
    extraMin: linha.extra_min ?? null,
    turno: linha.turno ?? '',
    setor: linha.setor ?? '',
    unidade: linha.unidade ?? '',
    observacao: linha.observacao ?? '',
    origem: linha.origem ?? '',
    vigencia: null,
  };
}

function referenciaDePadrao(linha) {
  const marcacoes = JSON.parse(linha.marcacoes_json || '[]');
  return {
    tipo: TIPO_PADRAO,
    rotulo: ROTULO_REFERENCIA[TIPO_PADRAO],
    id: linha.id,
    situacao: 'trabalha',
    marcacoes,
    faixa: faixaLegivel(marcacoes),
    entradaPrevista: primeiraEntrada(marcacoes),
    saidaPrevista: ultimaSaida(marcacoes),
    cargaPrevistaMin: linha.carga_prevista_min ?? null,
    extraMin: linha.extra_min ?? null,
    turno: '',
    setor: '',
    unidade: '',
    observacao: linha.observacoes ?? '',
    origem: 'padrao',
    vigencia: { inicio: linha.vigencia_inicio, fim: linha.vigencia_fim ?? null },
  };
}

export function referenciaAusente(motivo = 'Nenhuma escala para o dia e nenhum horário padrão vigente nesta data.') {
  return {
    tipo: TIPO_AUSENTE,
    rotulo: ROTULO_REFERENCIA[TIPO_AUSENTE],
    id: null,
    situacao: 'sem_definicao',
    marcacoes: [],
    faixa: '',
    entradaPrevista: '',
    saidaPrevista: '',
    cargaPrevistaMin: null,
    extraMin: null,
    turno: '', setor: '', unidade: '',
    observacao: motivo,
    origem: '',
    vigencia: null,
  };
}

/* A precedência, em uma função.
 *
 * `db` permite rodar dentro de uma transação (a sincronização de HE resolve a referência de vários
 * colaboradores dentro da mesma transação do dia). Fora dela, usa o acesso global. */
export async function resolverReferencia(tenantId, colaboradorChave, data, db = null) {
  const um = db ? db.consultarUm.bind(db) : consultarUm;

  const escala = await um(
    `SELECT id, situacao, marcacoes_json, carga_prevista_min, extra_min, turno, setor, unidade,
            observacao, origem
       FROM escalas_dia
      WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
    [tenantId, colaboradorChave, data],
  );

  /* Uma escala EXISTE mesmo quando diz "folga": nesse caso a referência do dia é justamente a
   * ausência de jornada programada, e trabalhar nela é a divergência mais grave que existe aqui.
   * Cair no padrão neste ponto apagaria essa informação. */
  if (escala) return referenciaDeEscala(escala);

  const padrao = await um(
    `SELECT id, marcacoes_json, carga_prevista_min, extra_min, vigencia_inicio, vigencia_fim,
            observacoes
       FROM horarios_padrao
      WHERE tenant_id = ? AND colaborador_chave = ? AND status = 'ativo'
        AND vigencia_inicio <= ?
        AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
      ORDER BY vigencia_inicio DESC
      LIMIT 1`,
    [tenantId, colaboradorChave, data, data],
  );

  /* ORDER BY vigencia_inicio DESC: se por erro de cadastro houver duas vigências cobrindo a mesma
   * data, vale a mais recente — e o conflito aparece nos alertas de qualidade, não aqui. Escolher
   * caladamente uma das duas sem sinalizar seria o comportamento errado. */
  if (padrao) return referenciaDePadrao(padrao);

  return referenciaAusente();
}

/* Versão em lote, para um dia inteiro: uma consulta por tabela em vez de duas por pessoa.
 * O dia de uma transportadora tem dezenas de motoristas — N+1 aqui custaria caro no Turso, que é
 * remoto e cobra latência por consulta. */
export async function resolverReferenciasDoDia(tenantId, chaves, data, db = null) {
  const todos = db ? db.consultar.bind(db) : consultar;
  const unicas = [...new Set(chaves.filter(Boolean))];
  const mapa = new Map();
  if (unicas.length === 0) return mapa;

  const marcadores = unicas.map(() => '?').join(', ');

  const escalas = await todos(
    `SELECT id, colaborador_chave, situacao, marcacoes_json, carga_prevista_min, extra_min,
            turno, setor, unidade, observacao, origem
       FROM escalas_dia
      WHERE tenant_id = ? AND data = ? AND colaborador_chave IN (${marcadores})`,
    [tenantId, data, ...unicas],
  );
  for (const e of escalas) mapa.set(e.colaborador_chave, referenciaDeEscala(e));

  const faltam = unicas.filter((c) => !mapa.has(c));
  if (faltam.length) {
    const m2 = faltam.map(() => '?').join(', ');
    const padroes = await todos(
      `SELECT id, colaborador_chave, marcacoes_json, carga_prevista_min, extra_min,
              vigencia_inicio, vigencia_fim, observacoes
         FROM horarios_padrao
        WHERE tenant_id = ? AND status = 'ativo'
          AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
          AND colaborador_chave IN (${m2})
        ORDER BY vigencia_inicio ASC`,
      [tenantId, data, data, ...faltam],
    );
    /* ASC + sobrescrita = a vigência mais recente vence, igual à consulta unitária. */
    for (const p of padroes) mapa.set(p.colaborador_chave, referenciaDePadrao(p));
  }

  for (const c of unicas) if (!mapa.has(c)) mapa.set(c, referenciaAusente());
  return mapa;
}

/* ---------------------------------------------------------------- divergências */

export const DIVERGENCIAS = {
  ENTRADA_ANTECIPADA: 'entrada_antecipada',
  ENTRADA_ATRASADA: 'entrada_atrasada',
  SAIDA_ANTECIPADA: 'saida_antecipada',
  SAIDA_POSTERIOR: 'saida_posterior',
  /* Duração da pausa diferente da prevista. */
  INTERVALO_DIVERGENTE: 'intervalo_divergente',
  /* A pausa começou noutro horário — pode ter a duração certa e mesmo assim estar fora do
     previsto. São dois problemas diferentes e produzem conversas diferentes com o colaborador. */
  INTERVALO_FORA_DO_PREVISTO: 'intervalo_fora_do_previsto',
  INTERVALO_INSUFICIENTE: 'intervalo_insuficiente',
  SEM_INTERVALO: 'sem_intervalo',
  PONTO_SEM_ESCALA: 'ponto_sem_escala',
  ESCALA_SEM_PONTO: 'escala_sem_ponto',
  TRABALHO_EM_FOLGA: 'trabalho_em_folga',
  JORNADA_DIFERENTE: 'jornada_diferente',
  JORNADA_INCOMPLETA: 'jornada_incompleta',
  REGISTROS_INCOMPATIVEIS: 'registros_incompativeis',
  HE_POTENCIAL: 'he_potencial',
  ESCALA_EXTRA: 'escala_extra',
  SEM_REFERENCIA: 'sem_referencia',
};

export const ROTULO_DIVERGENCIA = {
  entrada_antecipada: 'Entrada antecipada',
  entrada_atrasada: 'Entrada atrasada',
  saida_antecipada: 'Saída antecipada',
  saida_posterior: 'Saída posterior ao previsto',
  intervalo_divergente: 'Intervalo com duração diferente da prevista',
  intervalo_fora_do_previsto: 'Intervalo iniciado fora do previsto',
  intervalo_insuficiente: 'Intervalo abaixo do mínimo',
  sem_intervalo: 'Intervalo não registrado',
  ponto_sem_escala: 'Ponto sem escala',
  escala_sem_ponto: 'Escala sem ponto',
  trabalho_em_folga: 'Trabalho em dia de folga',
  jornada_diferente: 'Jornada diferente da programada',
  jornada_incompleta: 'Jornada incompleta',
  registros_incompativeis: 'Quantidade incompatível de registros',
  he_potencial: 'Possível hora extra',
  escala_extra: 'Escala extra',
  sem_referencia: 'Referência de jornada não encontrada',
};

/* Compara o ponto real contra a referência resolvida.
 *
 * `toleranciaMin` vem de `workspace_rules.tolerance_min` — a MESMA configuração que já governava a
 * classificação de excedente. Esta fase troca a FONTE da referência, não a régua.
 *
 * Devolve uma lista de divergências explicáveis: cada uma diz o previsto, o realizado e a
 * diferença, para que a tela nunca precise recalcular nada para mostrar o porquê. */
export function compararComReferencia(referencia, marcacoesReais, opcoes = {}) {
  const { toleranciaMin = 0, intervaloMinimoMin = 0 } = opcoes;
  const reais = normalizarMarcacoes(marcacoesReais);
  const achados = [];

  const item = (tipo, { previsto = '', realizado = '', diferencaMin = null, detalhe = '' }) => ({
    tipo,
    rotulo: ROTULO_DIVERGENCIA[tipo],
    previsto,
    realizado,
    diferencaMin,
    detalhe,
  });

  if (referencia.tipo === TIPO_AUSENTE) {
    if (reais.length) {
      achados.push(item(DIVERGENCIAS.PONTO_SEM_ESCALA, {
        realizado: faixaLegivel(reais),
        detalhe: 'Há ponto registrado, mas nenhuma escala do dia nem horário padrão vigente para comparar.',
      }));
    }
    achados.push(item(DIVERGENCIAS.SEM_REFERENCIA, {
      detalhe: referencia.observacao,
    }));
    return achados;
  }

  const ehFolga = referencia.situacao === 'folga' || referencia.situacao === 'ausencia_programada';

  if (ehFolga) {
    if (reais.length) {
      achados.push(item(DIVERGENCIAS.TRABALHO_EM_FOLGA, {
        previsto: ROTULO_SITUACAO_ESCALA[referencia.situacao],
        realizado: faixaLegivel(reais),
        detalhe: 'O dia estava programado sem jornada e há ponto registrado.',
      }));
    }
    return achados;
  }

  if (!reais.length) {
    achados.push(item(DIVERGENCIAS.ESCALA_SEM_PONTO, {
      previsto: referencia.faixa,
      detalhe: 'Havia jornada programada e não há ponto registrado no dia.',
    }));
    return achados;
  }

  /* Escala extra não é um erro: é contexto. Entra na lista para que a jornada apareça marcada como
   * trabalho fora do regime habitual — inclusive quando o horário bate certinho com o programado. */
  if (referencia.situacao === 'extra') {
    achados.push(item(DIVERGENCIAS.ESCALA_EXTRA, {
      previsto: referencia.faixa,
      realizado: faixaLegivel(reais),
      detalhe: 'O dia foi programado como escala extra.',
    }));
  }

  /* Jornada incompleta: abriu e não fechou. Diferente de "registros incompatíveis" (que é
   * quantidade errada) — aqui a última entrada simplesmente não tem saída. */
  if (reais.length % 2 !== 0) {
    achados.push(item(DIVERGENCIAS.JORNADA_INCOMPLETA, {
      previsto: referencia.faixa,
      realizado: reais.join(' '),
      detalhe: `A última marcação (${reais[reais.length - 1]}) não tem saída correspondente.`,
    }));
  }

  /* --- entrada */
  const entradaPrev = paraMinutos(referencia.entradaPrevista);
  const entradaReal = paraMinutos(reais[0]);
  if (entradaPrev !== null && entradaReal !== null) {
    const dif = entradaReal - entradaPrev;
    if (Math.abs(dif) > toleranciaMin) {
      achados.push(item(dif < 0 ? DIVERGENCIAS.ENTRADA_ANTECIPADA : DIVERGENCIAS.ENTRADA_ATRASADA, {
        previsto: referencia.entradaPrevista,
        realizado: reais[0],
        diferencaMin: dif,
      }));
    }
  }

  /* --- saída */
  const saidaPrev = paraMinutos(referencia.saidaPrevista);
  const saidaReal = reais.length % 2 === 0 ? paraMinutos(reais[reais.length - 1]) : null;
  if (saidaPrev !== null && saidaReal !== null) {
    let dif = saidaReal - saidaPrev;
    /* Jornada que atravessa a meia-noite: sem isto, sair 00:10 contra previsão 23:00 viraria
     * "saiu 22 horas mais cedo". */
    if (dif < -720) dif += 1440;
    if (dif > 720) dif -= 1440;
    if (Math.abs(dif) > toleranciaMin) {
      achados.push(item(dif < 0 ? DIVERGENCIAS.SAIDA_ANTECIPADA : DIVERGENCIAS.SAIDA_POSTERIOR, {
        previsto: referencia.saidaPrevista,
        realizado: reais[reais.length - 1],
        diferencaMin: dif,
      }));
    }
  }

  /* --- intervalo */
  const prevMarc = normalizarMarcacoes(referencia.marcacoes);
  const preveIntervalo = prevMarc.length >= 4;
  const temIntervaloReal = reais.length >= 4;

  if (preveIntervalo && !temIntervaloReal) {
    achados.push(item(DIVERGENCIAS.SEM_INTERVALO, {
      previsto: `${prevMarc[1]}–${prevMarc[2]}`,
      detalhe: 'A referência prevê intervalo e o espelho não registrou a pausa.',
    }));
  } else if (preveIntervalo && temIntervaloReal) {
    const inicioPrev = paraMinutos(prevMarc[1]);
    const inicioReal = paraMinutos(reais[1]);
    const prevInt = paraMinutos(prevMarc[2]) - inicioPrev;
    const realInt = paraMinutos(reais[2]) - inicioReal;

    /* Início e duração são checados separadamente de propósito: uma pausa de uma hora começando
     * 27 minutos atrasada tem a duração certa e ainda assim está fora do previsto. Fundir os dois
     * casos esconderia justamente o que se pergunta ao colaborador. */
    const difInicio = inicioReal - inicioPrev;
    if (Math.abs(difInicio) > toleranciaMin) {
      achados.push(item(DIVERGENCIAS.INTERVALO_FORA_DO_PREVISTO, {
        previsto: prevMarc[1],
        realizado: reais[1],
        diferencaMin: difInicio,
        detalhe: `O intervalo estava previsto para iniciar às ${prevMarc[1]} e foi registrado às ${reais[1]}.`,
      }));
    }

    const dif = realInt - prevInt;
    if (Math.abs(dif) > toleranciaMin) {
      achados.push(item(DIVERGENCIAS.INTERVALO_DIVERGENTE, {
        previsto: `${prevMarc[1]}–${prevMarc[2]} (${prevInt} min)`,
        realizado: `${reais[1]}–${reais[2]} (${realInt} min)`,
        diferencaMin: dif,
      }));
    }

    if (intervaloMinimoMin && realInt < intervaloMinimoMin) {
      achados.push(item(DIVERGENCIAS.INTERVALO_INSUFICIENTE, {
        previsto: `mínimo de ${intervaloMinimoMin} min`,
        realizado: `${realInt} min`,
        diferencaMin: realInt - intervaloMinimoMin,
        detalhe: 'A pausa registrada ficou abaixo do mínimo configurado para a empresa.',
      }));
    }
  }

  /* --- jornada como um todo */
  const prevTotal = duracaoMarcacoes(prevMarc).totalMin;
  const realTotal = duracaoMarcacoes(reais).totalMin;
  if (prevTotal && realTotal) {
    const dif = realTotal - prevTotal;
    if (Math.abs(dif) > toleranciaMin) {
      achados.push(item(DIVERGENCIAS.JORNADA_DIFERENTE, {
        previsto: `${prevTotal} min`,
        realizado: `${realTotal} min`,
        diferencaMin: dif,
      }));
    }
  }

  return achados;
}

/* Análise completa de um colaborador num dia: referência + divergências, pronta para a tela.
 * Existe para que a interface receba a explicação inteira do servidor e não monte nenhuma parte
 * dela por conta própria. */
export async function analisarDia(tenantId, colaboradorChave, data, marcacoesReais, opcoes = {}) {
  const referencia = await resolverReferencia(tenantId, colaboradorChave, data, opcoes.db ?? null);
  return {
    referencia,
    divergencias: compararComReferencia(referencia, marcacoesReais, opcoes),
  };
}
