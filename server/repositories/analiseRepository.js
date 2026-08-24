/* Persistência da análise automática e da fila por exceção.
 *
 * DUAS RESPONSABILIDADES, E POR QUE ELAS MORAM JUNTAS
 * --------------------------------------------------
 * `jornada_analises` guarda a conclusão sobre cada jornada; `pendings` guarda o que exige ação
 * humana. A fila é DERIVADA da análise — e é justamente por isso que as duas escritas precisam
 * acontecer no mesmo lugar e na mesma transação. Separá-las produziria o pior defeito possível
 * numa fila: pendência aberta para um problema que já não existe, ou problema real sem pendência.
 *
 * A RESOLUÇÃO AUTOMÁTICA É O CORAÇÃO DISTO
 * ----------------------------------------
 * Quando a escala de um dia é importada, "ponto sem escala" deixa de ser verdade. Ninguém deveria
 * precisar entrar na fila para fechar manualmente algo que o próprio sistema já sabe que foi
 * resolvido. `sincronizarFila()` compara o que a análise diz AGORA com as pendências abertas e
 * fecha as que perderam a causa, registrando quem fechou: o sistema, não uma pessoa.
 *
 * O QUE NUNCA É FECHADO AUTOMATICAMENTE: pendência de HE cuja ocorrência tem análise humana. Essa
 * pertence a `he_ocorrencias` e segue a regra da fase anterior — reprocessamento não apaga
 * julgamento de gente. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';
import { ROTULO_DIVERGENCIA, TIPO_AUSENTE } from '../services/referenciaJornada.js';
import { GRAVIDADE, ROTULO_CLASSE } from '../services/analiseJornada.js';

const CAMPOS = `id, colaborador_chave AS colaboradorChave, colaborador_nome AS colaborador,
  colaborador_id AS colaboradorId, data, referencia_tipo AS referenciaTipo,
  referencia_id AS referenciaId, referencia_situacao AS referenciaSituacao,
  referencia_horarios AS referenciaHorarios, padrao_horarios AS padraoHorarios,
  carga_prevista_min AS cargaPrevistaMin, extra_previsto_min AS extraPrevistoMin,
  ponto_marcacoes AS pontoMarcacoes, jornada_realizada_min AS jornadaRealizadaMin,
  he_min AS heMin, excedente_min AS excedenteMin, classificacao,
  servicos_no_dia AS servicosNoDia,
  divergencias_json AS divergenciasJson, prioridade, analisado_em AS analisadoEm`;

function hidratar(linha) {
  if (!linha) return null;
  const { divergenciasJson, ...resto } = linha;
  return {
    ...resto,
    divergencias: JSON.parse(divergenciasJson || '[]'),
    rotuloClasse: ROTULO_CLASSE[linha.classificacao] ?? linha.classificacao,
  };
}

/* ---------------------------------------------------------------- gravação */

/* Grava as análises de um dia inteiro, substituindo as anteriores daquele dia.
 *
 * Substituir é correto aqui e seria errado em `he_ocorrencias`: a análise é derivada e
 * recalculável, a ocorrência carrega julgamento humano. */
export async function sincronizarDia(tenantId, dateKey, analises) {
  if (!analises.length) return { gravadas: 0 };
  const agora = new Date().toISOString();

  return emTransacao(async (tx) => {
    for (const a of analises) {
      const existente = await tx.consultarUm(
        'SELECT id FROM jornada_analises WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?',
        [tenantId, a.colaboradorChave, dateKey],
      );

      const valores = [
        a.colaborador, a.colaboradorId ?? null,
        a.referencia.tipo, a.referencia.id ?? null, a.referencia.situacao ?? '',
        a.referencia.faixa ?? '', a.padraoHorarios ?? '',
        a.referencia.cargaPrevistaMin ?? null, a.referencia.extraMin ?? null,
        a.pontoMarcacoes ?? '', a.jornadaRealizadaMin ?? null,
        a.heMin ?? 0, a.excedenteMin ?? 0, a.classificacao, a.servicosNoDia ?? 0,
        JSON.stringify(a.divergencias ?? []), a.prioridade ?? 0, agora,
      ];

      if (existente) {
        await tx.executar(
          `UPDATE jornada_analises SET colaborador_nome = ?, colaborador_id = ?,
             referencia_tipo = ?, referencia_id = ?, referencia_situacao = ?,
             referencia_horarios = ?, padrao_horarios = ?, carga_prevista_min = ?,
             extra_previsto_min = ?, ponto_marcacoes = ?, jornada_realizada_min = ?,
             he_min = ?, excedente_min = ?, classificacao = ?, servicos_no_dia = ?,
             divergencias_json = ?,
             prioridade = ?, analisado_em = ?
           WHERE id = ?`,
          [...valores, existente.id],
        );
        a.id = existente.id;
      } else {
        const id = novoId('anl');
        await tx.executar(
          `INSERT INTO jornada_analises (id, tenant_id, colaborador_chave, data,
             colaborador_nome, colaborador_id, referencia_tipo, referencia_id,
             referencia_situacao, referencia_horarios, padrao_horarios, carga_prevista_min,
             extra_previsto_min, ponto_marcacoes, jornada_realizada_min, he_min, excedente_min,
             classificacao, servicos_no_dia, divergencias_json, prioridade, analisado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, tenantId, a.colaboradorChave, dateKey, ...valores],
        );
        a.id = id;
      }
    }
    return { gravadas: analises.length };
  });
}

/* ---------------------------------------------------------------- consultas */

export async function listar(tenantId, filtros = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];

  if (filtros.data) { where.push('data = ?'); args.push(filtros.data); }
  if (filtros.de) { where.push('data >= ?'); args.push(filtros.de); }
  if (filtros.ate) { where.push('data <= ?'); args.push(filtros.ate); }
  if (filtros.classificacao) { where.push('classificacao = ?'); args.push(filtros.classificacao); }
  /* O padrão da tela é a exceção: quem está OK não ocupa a fila. */
  if (filtros.somenteExcecoes) { where.push("classificacao <> 'ok'"); }
  if (filtros.busca) {
    where.push('(colaborador_chave LIKE ? OR colaborador_nome LIKE ? OR data LIKE ?)');
    args.push(`%${String(filtros.busca).toUpperCase()}%`, `%${filtros.busca}%`, `%${filtros.busca}%`);
  }

  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM jornada_analises WHERE ${where.join(' AND ')}
      ORDER BY prioridade DESC, data DESC LIMIT ?`,
    [...args, Number(filtros.limite) || 300],
  );
  return linhas.map(hidratar);
}

export async function obter(tenantId, id) {
  return hidratar(await consultarUm(`SELECT ${CAMPOS} FROM jornada_analises WHERE tenant_id = ? AND id = ?`, [tenantId, id]));
}

export async function obterDoDia(tenantId, colaboradorChave, data) {
  return hidratar(await consultarUm(
    `SELECT ${CAMPOS} FROM jornada_analises WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
    [tenantId, colaboradorChave, data],
  ));
}

/* Resumo do dia, direto do banco. Os números vêm de contagem SQL, nunca de estimativa — é o
 * requisito de o resumo ser gerado pelos dados reais do sistema. */
export async function resumoDoDia(tenantId, data) {
  const linhas = await consultar(
    `SELECT classificacao, COUNT(*) AS total, SUM(he_min) AS he
       FROM jornada_analises WHERE tenant_id = ? AND data = ? GROUP BY classificacao`,
    [tenantId, data],
  );

  const base = { ok: 0, atencao: 0, critico: 0 };
  let heTotalMin = 0;
  for (const l of linhas) {
    base[l.classificacao] = Number(l.total);
    heTotalMin += Number(l.he ?? 0);
  }

  /* A contagem por tipo de divergência sai do JSON, em memória: são dezenas de linhas por dia, e
   * uma tabela normalizada só para contar rótulo seria estrutura demais para o ganho. */
  const comDivergencia = await consultar(
    "SELECT divergencias_json AS j FROM jornada_analises WHERE tenant_id = ? AND data = ? AND classificacao <> 'ok'",
    [tenantId, data],
  );
  const porTipo = {};
  for (const c of comDivergencia) {
    for (const d of JSON.parse(c.j || '[]')) porTipo[d.tipo] = (porTipo[d.tipo] ?? 0) + 1;
  }

  const referencias = await consultar(
    'SELECT referencia_tipo AS tipo, COUNT(*) AS total FROM jornada_analises WHERE tenant_id = ? AND data = ? GROUP BY referencia_tipo',
    [tenantId, data],
  );

  return {
    data,
    processados: base.ok + base.atencao + base.critico,
    ok: base.ok,
    atencao: base.atencao,
    critico: base.critico,
    precisamAnalise: base.atencao + base.critico,
    heTotalMin,
    porTipo: Object.entries(porTipo)
      .map(([tipo, total]) => ({ tipo, rotulo: ROTULO_DIVERGENCIA[tipo] ?? tipo, total, gravidade: GRAVIDADE[tipo] ?? 'atencao' }))
      .sort((a, b) => b.total - a.total),
    referencias: Object.fromEntries(referencias.map((r) => [r.tipo, Number(r.total)])),
  };
}

/* Resumo de um período. Mesma fonte, janela maior — usado no resumo semanal. */
export async function resumoDoPeriodo(tenantId, de, ate) {
  const [totais] = await consultar(
    `SELECT COUNT(*) AS processados,
            SUM(CASE WHEN classificacao = 'ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN classificacao = 'atencao' THEN 1 ELSE 0 END) AS atencao,
            SUM(CASE WHEN classificacao = 'critico' THEN 1 ELSE 0 END) AS critico,
            SUM(he_min) AS heTotalMin,
            COUNT(DISTINCT colaborador_chave) AS colaboradores
       FROM jornada_analises WHERE tenant_id = ? AND data >= ? AND data <= ?`,
    [tenantId, de, ate],
  );

  const comDivergencia = await consultar(
    "SELECT divergencias_json AS j FROM jornada_analises WHERE tenant_id = ? AND data >= ? AND data <= ? AND classificacao <> 'ok'",
    [tenantId, de, ate],
  );
  const porTipo = {};
  for (const c of comDivergencia) {
    for (const d of JSON.parse(c.j || '[]')) porTipo[d.tipo] = (porTipo[d.tipo] ?? 0) + 1;
  }

  return {
    de,
    ate,
    processados: Number(totais?.processados ?? 0),
    ok: Number(totais?.ok ?? 0),
    atencao: Number(totais?.atencao ?? 0),
    critico: Number(totais?.critico ?? 0),
    heTotalMin: Number(totais?.heTotalMin ?? 0),
    colaboradores: Number(totais?.colaboradores ?? 0),
    porTipo: Object.entries(porTipo)
      .map(([tipo, total]) => ({ tipo, rotulo: ROTULO_DIVERGENCIA[tipo] ?? tipo, total }))
      .sort((a, b) => b.total - a.total),
  };
}

/* ---------------------------------------------------------------- reincidência */

/* Quantas vezes esta pessoa teve CADA tipo de divergência na janela.
 *
 * É a reincidência que o requisito pede como inteligência transversal: em vez de um ranking numa
 * tela separada, o número aparece ao lado da ocorrência que está sendo analisada — "esta é a
 * quinta vez este mês" muda a conversa. */
export async function reincidenciaDe(tenantId, colaboradorChave, { dias = 30, ate = null } = {}) {
  const fim = ate ?? new Date().toISOString().slice(0, 10);
  const inicio = new Date(`${fim}T12:00:00.000Z`);
  inicio.setUTCDate(inicio.getUTCDate() - dias);
  const de = inicio.toISOString().slice(0, 10);

  const linhas = await consultar(
    `SELECT data, divergencias_json AS j FROM jornada_analises
      WHERE tenant_id = ? AND colaborador_chave = ? AND data >= ? AND data <= ?
      ORDER BY data DESC`,
    [tenantId, colaboradorChave, de, fim],
  );

  const porTipo = {};
  const ultimaPorTipo = {};
  for (const l of linhas) {
    for (const d of JSON.parse(l.j || '[]')) {
      porTipo[d.tipo] = (porTipo[d.tipo] ?? 0) + 1;
      if (!ultimaPorTipo[d.tipo]) ultimaPorTipo[d.tipo] = l.data;
    }
  }

  const itens = Object.entries(porTipo)
    .map(([tipo, total]) => ({ tipo, rotulo: ROTULO_DIVERGENCIA[tipo] ?? tipo, total, ultima: ultimaPorTipo[tipo] }))
    .sort((a, b) => b.total - a.total);

  return {
    janelaDias: dias,
    de,
    ate: fim,
    diasComDivergencia: linhas.filter((l) => JSON.parse(l.j || '[]').length > 0).length,
    total: itens.reduce((s, i) => s + i.total, 0),
    itens,
    ultimaSemelhante: itens[0]?.ultima ?? null,
  };
}

/* Reincidência de TODO MUNDO numa janela, em uma consulta. Usada durante a análise em lote para
 * alimentar a priorização sem uma consulta por pessoa. */
export async function reincidenciasDaJanela(tenantId, ate, dias = 30) {
  const inicio = new Date(`${ate}T12:00:00.000Z`);
  inicio.setUTCDate(inicio.getUTCDate() - dias);
  const de = inicio.toISOString().slice(0, 10);

  const linhas = await consultar(
    `SELECT colaborador_chave AS chave, COUNT(*) AS total FROM jornada_analises
      WHERE tenant_id = ? AND data >= ? AND data < ? AND classificacao <> 'ok'
      GROUP BY colaborador_chave`,
    [tenantId, de, ate],
  );
  return new Map(linhas.map((l) => [l.chave, Number(l.total)]));
}

/* ---------------------------------------------------------------- fila por exceção */

/* Tipos de divergência que viram pendência.
 *
 * Nem toda divergência precisa de alguém: "escala extra" é contexto, e uma diferença de entrada
 * dentro da tolerância nem chega aqui. Esta lista é o filtro entre "o sistema notou" e "alguém
 * precisa agir" — e é o que impede a fila de virar um espelho do log. */
const GERA_PENDENCIA = new Set([
  'trabalho_em_folga', 'sem_referencia', 'ponto_sem_escala', 'escala_sem_ponto',
  'sem_intervalo', 'intervalo_insuficiente', 'intervalo_divergente', 'intervalo_fora_do_previsto',
  'registros_incompativeis', 'jornada_incompleta',
  'entrada_atrasada', 'entrada_antecipada', 'saida_antecipada', 'saida_posterior',

  /* `he_potencial` NÃO entra aqui, e isso é deliberado.
   *
   * A hora extra sem justificativa já gera pendência por outro caminho, mais antigo e mais rico:
   * `heRepository.gerarPendencias()` cria uma pendência LIGADA à ocorrência (`he_ocorrencia_id`),
   * que se encerra sozinha no instante em que alguém registra a justificativa.
   *
   * Gerar as duas encheria a fila com o mesmo fato escrito de duas formas — "Possível hora extra"
   * e "2h16 de HE sem justificativa" — e uma delas continuaria aberta depois de a pessoa ter
   * tratado a outra. Um fato, uma pendência; sobrevive a que tem o ciclo de vida completo.
   *
   * `he_potencial` continua sendo uma DIVERGÊNCIA: aparece na análise, na explicação da ocorrência
   * e no resumo do dia. Só não vira uma segunda linha na fila. */
]);

function prioridadeTexto(gravidade) {
  return gravidade === 'critico' ? 'alta' : 'media';
}

/* Cria, atualiza e ENCERRA pendências a partir das análises de um dia.
 *
 * O contrato: depois desta função, a fila daquele dia reflete exatamente o que a análise concluiu.
 * Nada a mais (duplicata), nada a menos (problema sem pendência), nada obsoleto (pendência cuja
 * causa sumiu). */
export async function sincronizarFila(tenantId, dateKey, analises, opcoes = {}) {
  const agora = new Date().toISOString();
  const { prazoDias = 3 } = opcoes;
  const prazo = new Date(`${dateKey}T12:00:00.000Z`);
  prazo.setUTCDate(prazo.getUTCDate() + prazoDias);
  const prazoIso = prazo.toISOString().slice(0, 10);

  /* Chaves que DEVEM existir depois desta rodada. */
  const desejadas = new Map();

  for (const a of analises) {
    for (const d of a.divergencias) {
      if (!GERA_PENDENCIA.has(d.tipo)) continue;
      const chave = `${a.colaboradorChave}|${dateKey}|${d.tipo}`;
      const gravidade = GRAVIDADE[d.tipo] ?? 'atencao';
      desejadas.set(chave, {
        analise: a,
        divergencia: d,
        gravidade,
        descricao: montarDescricao(a, d),
      });
    }
  }

  return emTransacao(async (tx) => {
    const abertas = await tx.consultar(
      `SELECT id, chave_dedupe, tipo, status, he_ocorrencia_id AS heOcorrenciaId
         FROM pendings
        WHERE tenant_id = ? AND data = ? AND chave_dedupe IS NOT NULL AND resolvida_em IS NULL`,
      [tenantId, dateKey],
    );

    let criadas = 0; let atualizadas = 0; let resolvidas = 0;

    /* --- o que deixou de existir: encerra */
    for (const p of abertas) {
      if (desejadas.has(p.chave_dedupe)) continue;

      /* Pendência ligada a uma ocorrência de HE com análise humana NÃO é fechada aqui: quem
       * decide o destino dela é a justificativa, não o recálculo. */
      if (p.heOcorrenciaId) {
        const oc = await tx.consultarUm(
          'SELECT status FROM he_ocorrencias WHERE id = ?', [p.heOcorrenciaId],
        );
        if (oc && oc.status !== 'pendente') continue;
      }

      await tx.executar(
        `UPDATE pendings SET status = 'resolvida', resolvida_em = ?, atualizada_em = ?,
                resolucao = ?, resolvida_automaticamente = 1
          WHERE id = ?`,
        [agora, agora, 'Resolvida automaticamente: a causa deixou de existir após o reprocessamento.', p.id],
      );
      resolvidas += 1;
    }

    /* --- o que existe agora: cria ou atualiza */
    const porChave = new Map(abertas.map((p) => [p.chave_dedupe, p]));

    for (const [chave, item] of desejadas) {
      const { analise, divergencia, gravidade, descricao } = item;
      const existente = porChave.get(chave);
      const score = analise.prioridade;

      const evidencias = [
        `Referência utilizada: ${analise.referencia.rotulo}`,
        analise.referencia.faixa ? `Previsto: ${analise.referencia.faixa}` : null,
        analise.pontoMarcacoes ? `Ponto: ${analise.pontoMarcacoes}` : null,
        divergencia.diferencaMin !== null && divergencia.diferencaMin !== undefined
          ? `Diferença: ${divergencia.diferencaMin > 0 ? '+' : ''}${divergencia.diferencaMin} min`
          : null,
      ].filter(Boolean);

      if (existente) {
        await tx.executar(
          `UPDATE pendings SET descricao = ?, evidencias = ?, prioridade = ?, prioridade_score = ?,
                  categoria = ?, analise_id = ?, atualizada_em = ?
            WHERE id = ?`,
          [
            descricao, JSON.stringify(evidencias), prioridadeTexto(gravidade), score,
            divergencia.tipo, analise.id ?? null, agora, existente.id,
          ],
        );
        atualizadas += 1;
      } else {
        await tx.executar(
          `INSERT INTO pendings (id, tenant_id, colaborador_id, data, tipo, categoria, status,
             prioridade, origem, descricao, evidencias, recomendacao, prazo, criada_em,
             atualizada_em, analise_id, chave_dedupe, prioridade_score, resolvida_automaticamente)
           VALUES (?, ?, ?, ?, ?, ?, 'aberta', ?, 'analise_automatica', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            novoId('pen'), tenantId, analise.colaboradorId ?? null, dateKey,
            divergencia.tipo, divergencia.tipo, prioridadeTexto(gravidade),
            descricao, JSON.stringify(evidencias), recomendacaoDe(divergencia.tipo),
            prazoIso, agora, agora, analise.id ?? null, chave, score,
          ],
        );
        criadas += 1;
      }
    }

    return { criadas, atualizadas, resolvidas };
  });
}

function montarDescricao(analise, divergencia) {
  const partes = [`${analise.colaborador} — ${divergencia.rotulo}`];
  if (divergencia.previsto && divergencia.realizado) {
    partes.push(`previsto ${divergencia.previsto}, registrado ${divergencia.realizado}`);
  } else if (divergencia.detalhe) {
    partes.push(divergencia.detalhe);
  }
  return partes.join(': ');
}

/* Recomendações fixas por tipo. Texto determinístico de propósito: é a instrução operacional, e
 * ela não pode variar entre duas ocorrências do mesmo problema. */
const RECOMENDACOES = {
  trabalho_em_folga: 'Confirmar se houve convocação e registrar a autorização, ou corrigir a escala do dia.',
  sem_referencia: 'Cadastrar a escala do dia ou o horário padrão vigente para este colaborador.',
  ponto_sem_escala: 'Importar a escala desta data ou cadastrar o horário padrão do colaborador.',
  escala_sem_ponto: 'Verificar ausência, atestado ou falha no espelho de ponto.',
  sem_intervalo: 'Conferir o espelho: a pausa pode não ter sido registrada.',
  intervalo_insuficiente: 'Verificar a pausa concedida no dia e regularizar.',
  intervalo_divergente: 'Confirmar com o colaborador a duração da pausa e ajustar ou justificar.',
  intervalo_fora_do_previsto: 'Confirmar com o colaborador o horário do intervalo e ajustar ou justificar.',
  registros_incompativeis: 'Corrigir o espelho de ponto: há marcação faltando ou sobrando.',
  jornada_incompleta: 'Verificar a marcação de saída que não foi registrada.',
  he_potencial: 'Analisar e registrar a justificativa da hora extra.',
  entrada_atrasada: 'Confirmar o motivo do atraso e ajustar ou justificar.',
  entrada_antecipada: 'Verificar se houve autorização prévia para a entrada antecipada.',
  saida_antecipada: 'Confirmar o motivo da saída antecipada.',
  saida_posterior: 'Analisar e registrar a justificativa da permanência após o horário previsto.',
};

function recomendacaoDe(tipo) {
  return RECOMENDACOES[tipo] ?? null;
}

/* Fila priorizada, com os filtros rápidos do requisito. */
export async function listarFila(tenantId, filtros = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];

  if (!filtros.incluirResolvidas) where.push("status <> 'resolvida'");
  if (filtros.data) { where.push('data = ?'); args.push(filtros.data); }
  if (filtros.de) { where.push('data >= ?'); args.push(filtros.de); }
  if (filtros.ate) { where.push('data <= ?'); args.push(filtros.ate); }
  if (filtros.tipo) { where.push('tipo = ?'); args.push(filtros.tipo); }
  if (filtros.tipos?.length) {
    where.push(`tipo IN (${filtros.tipos.map(() => '?').join(', ')})`);
    args.push(...filtros.tipos);
  }
  if (filtros.prioridade) { where.push('prioridade = ?'); args.push(filtros.prioridade); }
  if (filtros.busca) { where.push('descricao LIKE ?'); args.push(`%${filtros.busca}%`); }

  const linhas = await consultar(
    `SELECT id, colaborador_id AS colaboradorId, data, tipo, categoria, status, prioridade,
            origem, descricao, evidencias, recomendacao, prazo, criada_em AS criadaEm,
            atualizada_em AS atualizadaEm, resolvida_em AS resolvidaEm, resolucao,
            analise_id AS analiseId, prioridade_score AS prioridadeScore,
            resolvida_automaticamente AS resolvidaAutomaticamente
       FROM pendings WHERE ${where.join(' AND ')}
      ORDER BY prioridade_score DESC, data DESC LIMIT ?`,
    [...args, Number(filtros.limite) || 200],
  );

  return linhas.map((l) => ({
    ...l,
    evidencias: JSON.parse(l.evidencias || '[]'),
    rotuloTipo: ROTULO_TIPO_FILA[l.tipo] ?? ROTULO_DIVERGENCIA[l.tipo] ?? l.tipo,
    gravidade: GRAVIDADE_FILA[l.tipo] ?? GRAVIDADE[l.tipo] ?? 'atencao',
    resolvidaAutomaticamente: !!l.resolvidaAutomaticamente,
  }));
}

/* Tipos de pendência que NÃO vêm da análise de divergência e por isso não estão em
 * `ROTULO_DIVERGENCIA`. Hoje é só a hora extra sem justificativa, criada por `heRepository`. */
const ROTULO_TIPO_FILA = {
  he_sem_justificativa: 'Hora extra sem justificativa',
};

const GRAVIDADE_FILA = {
  he_sem_justificativa: 'atencao',
};

/* Contadores dos filtros rápidos. Saem da mesma tabela que a lista — os números do topo nunca
 * discordam do que está logo abaixo. */
export async function contadoresDaFila(tenantId) {
  const linhas = await consultar(
    `SELECT tipo, prioridade, COUNT(*) AS total FROM pendings
      WHERE tenant_id = ? AND status <> 'resolvida' GROUP BY tipo, prioridade`,
    [tenantId],
  );

  const porTipo = {};
  let total = 0; let criticos = 0;
  for (const l of linhas) {
    porTipo[l.tipo] = (porTipo[l.tipo] ?? 0) + Number(l.total);
    total += Number(l.total);
    if ((GRAVIDADE_FILA[l.tipo] ?? GRAVIDADE[l.tipo] ?? 'atencao') === 'critico') criticos += Number(l.total);
  }

  const soma = (tipos) => tipos.reduce((s, t) => s + (porTipo[t] ?? 0), 0);

  return {
    total,
    criticos,
    /* O filtro "HE" recorta a pendência de hora extra sem justificativa, que é a que existe na
     * fila — `he_potencial` é divergência, não pendência (ver GERA_PENDENCIA). */
    he: soma(['he_sem_justificativa']),
    intervalos: soma(['sem_intervalo', 'intervalo_insuficiente', 'intervalo_divergente', 'intervalo_fora_do_previsto']),
    escala: soma(['ponto_sem_escala', 'escala_sem_ponto', 'trabalho_em_folga']),
    semReferencia: soma(['sem_referencia', 'ponto_sem_escala']),
    porTipo,
  };
}

/* Tipos agrupados por filtro rápido — a interface pede o filtro pelo nome, não pela lista. */
export const FILTROS_RAPIDOS = {
  todos: null,
  criticos: Object.entries(GRAVIDADE).filter(([, g]) => g === 'critico').map(([t]) => t),
  he: ['he_sem_justificativa'],
  intervalos: ['sem_intervalo', 'intervalo_insuficiente', 'intervalo_divergente', 'intervalo_fora_do_previsto'],
  escala: ['ponto_sem_escala', 'escala_sem_ponto', 'trabalho_em_folga'],
  sem_referencia: ['sem_referencia', 'ponto_sem_escala'],
};

export { TIPO_AUSENTE };
