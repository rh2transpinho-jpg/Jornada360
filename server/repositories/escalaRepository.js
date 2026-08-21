/* Escala do dia: o que estava programado para uma pessoa numa data específica.
 *
 * DIFERENÇA PARA `schedules` (que já existia e continua existindo)
 * ---------------------------------------------------------------
 * `schedules` é um MODELO ("Turno A: 06:00–16:00, folga domingo") ligado ao cadastro do
 * colaborador. Ele responde "qual o regime dessa pessoa". Não responde "o que estava programado
 * para ela na terça, 22/07" — e é essa segunda pergunta que decide se 18 minutos a mais são hora
 * extra ou jornada normal. `escalas_dia` responde a segunda.
 *
 * REIMPORTAR NÃO SOBRESCREVE EM SILÊNCIO
 * --------------------------------------
 * `preverImportacao()` calcula o que mudaria e devolve as diferenças; só `confirmarImportacao()`
 * grava. A escala de um dia já analisado é a base de horas extras já justificadas: trocá-la sem
 * mostrar o antes e o depois altera o veredito de casos fechados sem ninguém ver. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';
import { chaveColaborador } from './heRepository.js';
import {
  SITUACOES_ESCALA, ROTULO_SITUACAO_ESCALA, duracaoMarcacoes, extraDeMarcacoes,
  faixaLegivel, marcacoesDeTexto, normalizarMarcacoes, paraMinutos, primeiraEntrada, ultimaSaida,
} from '../services/referenciaJornada.js';

export { SITUACOES_ESCALA, ROTULO_SITUACAO_ESCALA };

const CAMPOS = `id, colaborador_chave AS colaboradorChave, colaborador_nome AS colaborador,
  colaborador_id AS colaboradorId, data, situacao, marcacoes_json AS marcacoesJson,
  carga_prevista_min AS cargaPrevistaMin, extra_min AS extraMin, turno, setor, unidade,
  observacao, origem, importacao_id AS importacaoId, criado_em AS criadoEm,
  criado_por_nome AS criadoPor, atualizado_em AS atualizadoEm, atualizado_por_nome AS atualizadoPor`;

function hidratar(linha) {
  if (!linha) return null;
  const marcacoes = JSON.parse(linha.marcacoesJson || '[]');
  const { marcacoesJson, ...resto } = linha;
  return {
    ...resto,
    marcacoes,
    faixa: faixaLegivel(marcacoes),
    entradaPrevista: primeiraEntrada(marcacoes),
    saidaPrevista: ultimaSaida(marcacoes),
    duracaoPrevistaMin: duracaoMarcacoes(marcacoes).totalMin,
    rotuloSituacao: ROTULO_SITUACAO_ESCALA[linha.situacao] ?? linha.situacao,
  };
}

async function registrarHistorico(tx, tenantId, escalaId, evento, dados = {}) {
  await tx.executar(
    `INSERT INTO escalas_historico (id, tenant_id, escala_id, evento, usuario, user_id,
       valor_anterior, valor_novo, observacao, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      novoId('esh'), tenantId, escalaId, evento,
      dados.usuario ?? '', dados.userId ?? null,
      dados.valorAnterior ?? '', dados.valorNovo ?? '', dados.observacao ?? '',
      new Date().toISOString(),
    ],
  );
}

/* ---------------------------------------------------------------- validação */

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validar(dados) {
  const problemas = [];
  const brutas = Array.isArray(dados.marcacoes)
    ? dados.marcacoes.filter((v) => String(v ?? '').trim())
    : marcacoesDeTexto(dados.marcacoes);
  const marcacoes = normalizarMarcacoes(dados.marcacoes ?? []);
  const situacao = dados.situacao ?? 'trabalha';

  if (!String(dados.colaborador ?? '').trim()) {
    problemas.push({ campo: 'colaborador', tipo: 'colaborador_ausente', mensagem: 'Linha sem colaborador.' });
  }

  if (!DATA_ISO.test(String(dados.data ?? ''))) {
    problemas.push({ campo: 'data', tipo: 'data_invalida', mensagem: `Data inválida: "${dados.data ?? ''}". Use AAAA-MM-DD.` });
  }

  if (!SITUACOES_ESCALA.includes(situacao)) {
    problemas.push({ campo: 'situacao', tipo: 'situacao_invalida', mensagem: `Situação desconhecida: "${situacao}".` });
  }

  /* Folga e ausência programada NÃO precisam de horário — é justamente a ausência de jornada que
   * elas registram. Exigir marcação aqui obrigaria a inventar um horário para um dia sem trabalho. */
  const precisaHorario = situacao === 'trabalha' || situacao === 'extra' || situacao === 'alteracao_horario';

  if (brutas.length && marcacoes.length !== brutas.length) {
    problemas.push({ campo: 'marcacoes', tipo: 'horario_invalido', mensagem: 'Há horário em formato inválido. Use HH:MM.' });
  }

  if (precisaHorario && marcacoes.length === 0) {
    problemas.push({ campo: 'marcacoes', tipo: 'sem_marcacoes', mensagem: `Situação "${ROTULO_SITUACAO_ESCALA[situacao] ?? situacao}" exige horário previsto.` });
  } else if (marcacoes.length % 2 !== 0) {
    problemas.push({
      campo: 'marcacoes', tipo: 'quantidade_invalida',
      mensagem: `Número ímpar de registros (${marcacoes.length}). Cada entrada precisa de uma saída.`,
    });
  } else if (marcacoes.length > 6) {
    problemas.push({
      campo: 'marcacoes', tipo: 'quantidade_invalida',
      mensagem: `${marcacoes.length} registros. O modelo suporta até 6 (três turnos).`,
    });
  }

  return problemas;
}

/* ---------------------------------------------------------------- consultas */

export async function listar(tenantId, filtros = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];

  if (filtros.data) { where.push('data = ?'); args.push(filtros.data); }
  if (filtros.de) { where.push('data >= ?'); args.push(filtros.de); }
  if (filtros.ate) { where.push('data <= ?'); args.push(filtros.ate); }
  if (filtros.situacao) { where.push('situacao = ?'); args.push(filtros.situacao); }
  if (filtros.setor) { where.push('setor = ?'); args.push(filtros.setor); }
  if (filtros.unidade) { where.push('unidade = ?'); args.push(filtros.unidade); }
  if (filtros.turno) { where.push('turno = ?'); args.push(filtros.turno); }
  if (filtros.busca) {
    where.push('(colaborador_chave LIKE ? OR colaborador_nome LIKE ? OR data LIKE ?)');
    args.push(`%${chaveColaborador(filtros.busca)}%`, `%${filtros.busca}%`, `%${filtros.busca}%`);
  }

  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM escalas_dia WHERE ${where.join(' AND ')}
      ORDER BY data DESC, colaborador_nome ASC
      LIMIT ?`,
    [...args, Number(filtros.limite) || 500],
  );
  return linhas.map(hidratar);
}

export async function obter(tenantId, id) {
  return hidratar(await consultarUm(`SELECT ${CAMPOS} FROM escalas_dia WHERE tenant_id = ? AND id = ?`, [tenantId, id]));
}

export async function obterDoDia(tenantId, colaborador, data) {
  return hidratar(await consultarUm(
    `SELECT ${CAMPOS} FROM escalas_dia WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
    [tenantId, chaveColaborador(colaborador), data],
  ));
}

export async function historico(tenantId, escalaId) {
  return consultar(
    `SELECT id, evento, usuario, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
            observacao, criado_em AS criadoEm
       FROM escalas_historico WHERE tenant_id = ? AND escala_id = ?
      ORDER BY criado_em DESC`,
    [tenantId, escalaId],
  );
}

export async function listarImportacoes(tenantId, limite = 20) {
  const linhas = await consultar(
    `SELECT id, arquivo, formato, total_linhas AS totalLinhas, criadas, atualizadas, ignoradas,
            problemas_json AS problemasJson, status, criado_em AS criadoEm,
            criado_por_nome AS criadoPor
       FROM escala_importacoes WHERE tenant_id = ? ORDER BY criado_em DESC LIMIT ?`,
    [tenantId, limite],
  );
  return linhas.map(({ problemasJson, ...r }) => ({ ...r, problemas: JSON.parse(problemasJson || '[]') }));
}

/* Distintos para alimentar os filtros da tela, sem inventar lista fixa. */
export async function opcoesDeFiltro(tenantId) {
  const [turnos, setores, unidades] = await Promise.all([
    consultar("SELECT DISTINCT turno AS v FROM escalas_dia WHERE tenant_id = ? AND turno <> '' ORDER BY turno", [tenantId]),
    consultar("SELECT DISTINCT setor AS v FROM escalas_dia WHERE tenant_id = ? AND setor <> '' ORDER BY setor", [tenantId]),
    consultar("SELECT DISTINCT unidade AS v FROM escalas_dia WHERE tenant_id = ? AND unidade <> '' ORDER BY unidade", [tenantId]),
  ]);
  return {
    turnos: turnos.map((r) => r.v),
    setores: setores.map((r) => r.v),
    unidades: unidades.map((r) => r.v),
    situacoes: SITUACOES_ESCALA.map((s) => ({ valor: s, rotulo: ROTULO_SITUACAO_ESCALA[s] })),
  };
}

/* ---------------------------------------------------------------- escrita manual */

function preparar(dados) {
  const marcacoes = normalizarMarcacoes(dados.marcacoes ?? []);
  const carga = dados.cargaPrevistaMin === '' || dados.cargaPrevistaMin === undefined || dados.cargaPrevistaMin === null
    ? null
    : Number(dados.cargaPrevistaMin);
  const { extraMin } = extraDeMarcacoes(marcacoes, carga);
  return { marcacoes, carga, extraMin };
}

/* Cria ou atualiza a escala de um dia. `origem` distingue quem escreveu: importação ou pessoa.
 * Uma correção manual sobre uma linha importada precisa ficar visível — é ela que explica por que
 * a escala do sistema diverge da planilha que alguém tem na mão. */
export async function salvar(tenantId, dados, autor = {}, opcoes = {}) {
  const problemas = validar(dados);
  if (problemas.length) {
    const erro = new Error(problemas[0].mensagem);
    erro.codigo = 'dados_invalidos';
    erro.problemas = problemas;
    throw erro;
  }

  const { marcacoes, carga, extraMin } = preparar(dados);
  const chave = chaveColaborador(dados.colaborador);
  const agora = new Date().toISOString();
  const origem = opcoes.origem ?? 'manual';

  return emTransacao(async (tx) => {
    const existente = await tx.consultarUm(
      `SELECT ${CAMPOS} FROM escalas_dia WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
      [tenantId, chave, dados.data],
    );

    if (existente) {
      const antes = hidratar(existente);
      await tx.executar(
        `UPDATE escalas_dia SET colaborador_nome = ?, situacao = ?, marcacoes_json = ?,
                carga_prevista_min = ?, extra_min = ?, turno = ?, setor = ?, unidade = ?,
                observacao = ?, origem = ?, importacao_id = ?, atualizado_em = ?,
                atualizado_por_nome = ?
          WHERE id = ?`,
        [
          String(dados.colaborador).trim(), dados.situacao ?? 'trabalha', JSON.stringify(marcacoes),
          carga, extraMin, dados.turno ?? '', dados.setor ?? '', dados.unidade ?? '',
          dados.observacao ?? '', origem, opcoes.importacaoId ?? null, agora, autor.nome ?? '',
          existente.id,
        ],
      );
      await registrarHistorico(tx, tenantId, existente.id, origem === 'importacao' ? 'substituida' : 'alterada', {
        usuario: autor.nome, userId: autor.id,
        valorAnterior: `${antes.rotuloSituacao} ${antes.faixa}`.trim(),
        valorNovo: `${ROTULO_SITUACAO_ESCALA[dados.situacao ?? 'trabalha']} ${faixaLegivel(marcacoes)}`.trim(),
        observacao: dados.motivo ?? '',
      });
      return hidratar(await tx.consultarUm(`SELECT ${CAMPOS} FROM escalas_dia WHERE id = ?`, [existente.id]));
    }

    const id = novoId('esc');
    await tx.executar(
      `INSERT INTO escalas_dia (id, tenant_id, colaborador_chave, colaborador_nome, colaborador_id,
         data, situacao, marcacoes_json, carga_prevista_min, extra_min, turno, setor, unidade,
         observacao, origem, importacao_id, criado_em, criado_por_nome, atualizado_em,
         atualizado_por_nome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, tenantId, chave, String(dados.colaborador).trim(), dados.colaboradorId ?? null,
        dados.data, dados.situacao ?? 'trabalha', JSON.stringify(marcacoes), carga, extraMin,
        dados.turno ?? '', dados.setor ?? '', dados.unidade ?? '', dados.observacao ?? '',
        origem, opcoes.importacaoId ?? null, agora, autor.nome ?? '', agora, autor.nome ?? '',
      ],
    );
    await registrarHistorico(tx, tenantId, id, origem === 'importacao' ? 'importada' : 'criada', {
      usuario: autor.nome, userId: autor.id,
      valorNovo: `${ROTULO_SITUACAO_ESCALA[dados.situacao ?? 'trabalha']} ${faixaLegivel(marcacoes)}`.trim(),
    });
    return hidratar(await tx.consultarUm(`SELECT ${CAMPOS} FROM escalas_dia WHERE id = ?`, [id]));
  });
}

/* ---------------------------------------------------------------- importação */

/* Passo 1: o que ACONTECERIA. Nada é gravado.
 *
 * Devolve, para cada linha: a ação (novo / substitui / erro), o registro que já existe e o que
 * mudaria nele. É o requisito de não sobrescrever silenciosamente, em forma de dado. */
export async function preverImportacao(tenantId, linhas = []) {
  const itens = [];
  const vistos = new Map();
  let novos = 0; let substituicoes = 0; let comProblema = 0; let semMudanca = 0;

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    const problemas = validar(linha);
    const chave = chaveColaborador(linha.colaborador);
    const marcacoes = normalizarMarcacoes(linha.marcacoes ?? []);

    const dedupe = `${chave}|${linha.data ?? ''}`;
    if (vistos.has(dedupe)) {
      problemas.push({
        tipo: 'duplicado_no_arquivo',
        mensagem: `Mesma pessoa e mesma data já apareceram na linha ${vistos.get(dedupe) + 1}. Dois horários para a mesma pessoa no mesmo dia.`,
      });
    } else {
      vistos.set(dedupe, i);
    }

    /* O colaborador não precisa existir no cadastro para a escala valer — a chave normalizada é
     * quem casa as fontes. Mas não achar ninguém quase sempre é nome torto na planilha, e isso
     * precisa ser dito antes de gravar. */
    let colaboradorConhecido = false;
    if (chave) {
      const emp = await consultarUm(
        'SELECT id FROM employees WHERE tenant_id = ? AND UPPER(nome) = ? LIMIT 1',
        [tenantId, chave],
      );
      const jaVisto = await consultarUm(
        'SELECT 1 AS x FROM he_ocorrencias WHERE tenant_id = ? AND colaborador_chave = ? LIMIT 1',
        [tenantId, chave],
      );
      colaboradorConhecido = !!(emp || jaVisto);
      if (!colaboradorConhecido) {
        problemas.push({
          tipo: 'colaborador_nao_encontrado', aviso: true,
          mensagem: `"${linha.colaborador}" não consta no cadastro nem em jornadas já processadas. Confira a grafia.`,
        });
      }
    }

    const existente = chave && linha.data
      ? await consultarUm(
        `SELECT ${CAMPOS} FROM escalas_dia WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?`,
        [tenantId, chave, linha.data],
      )
      : null;

    const anterior = existente ? hidratar(existente) : null;
    const novaFaixa = faixaLegivel(marcacoes);
    const novaSituacao = linha.situacao ?? 'trabalha';
    const identico = anterior
      && anterior.faixa === novaFaixa
      && anterior.situacao === novaSituacao;

    const bloqueantes = problemas.filter((p) => !p.aviso);
    let acao;
    if (bloqueantes.length) { acao = 'erro'; comProblema += 1; }
    else if (identico) { acao = 'sem_mudanca'; semMudanca += 1; }
    else if (anterior) { acao = 'substitui'; substituicoes += 1; }
    else { acao = 'novo'; novos += 1; }

    itens.push({
      linha: i + 1,
      colaborador: linha.colaborador ?? '',
      data: linha.data ?? '',
      situacao: novaSituacao,
      rotuloSituacao: ROTULO_SITUACAO_ESCALA[novaSituacao] ?? novaSituacao,
      marcacoes,
      faixa: novaFaixa,
      turno: linha.turno ?? '', setor: linha.setor ?? '', unidade: linha.unidade ?? '',
      observacao: linha.observacao ?? '',
      colaboradorConhecido,
      acao,
      anterior: anterior
        ? { faixa: anterior.faixa, situacao: anterior.situacao, rotuloSituacao: anterior.rotuloSituacao, origem: anterior.origem, atualizadoEm: anterior.atualizadoEm }
        : null,
      problemas,
    });
  }

  return { total: linhas.length, novos, substituicoes, semMudanca, comProblema, itens };
}

/* Passo 2: grava. Só o que não tem problema bloqueante. */
export async function confirmarImportacao(tenantId, linhas = [], autor = {}, meta = {}) {
  const previa = await preverImportacao(tenantId, linhas);
  const importacaoId = novoId('imp');
  const agora = new Date().toISOString();

  let criadas = 0; let atualizadas = 0; let ignoradas = 0;
  const problemas = [];

  await executarRegistroDeImportacao(tenantId, importacaoId, meta, previa, autor, agora);

  for (const item of previa.itens) {
    if (item.acao === 'erro') {
      ignoradas += 1;
      problemas.push({ linha: item.linha, colaborador: item.colaborador, tipo: 'recusada', mensagens: item.problemas.map((p) => p.mensagem) });
      continue;
    }
    if (item.acao === 'sem_mudanca') {
      ignoradas += 1;
      continue;
    }
    const original = linhas[item.linha - 1];
    try {
      await salvar(tenantId, original, autor, { origem: 'importacao', importacaoId });
      if (item.acao === 'novo') criadas += 1; else atualizadas += 1;
    } catch (e) {
      ignoradas += 1;
      problemas.push({ linha: item.linha, colaborador: item.colaborador, tipo: 'falha_gravacao', mensagens: [e.message] });
    }
  }

  await executar(
    `UPDATE escala_importacoes SET criadas = ?, atualizadas = ?, ignoradas = ?, problemas_json = ?
      WHERE id = ?`,
    [criadas, atualizadas, ignoradas, JSON.stringify(problemas), importacaoId],
  );

  return { importacaoId, total: previa.total, criadas, atualizadas, ignoradas, problemas, previa };
}

async function executarRegistroDeImportacao(tenantId, id, meta, previa, autor, agora) {
  await executar(
    `INSERT INTO escala_importacoes (id, tenant_id, arquivo, formato, total_linhas, criadas,
       atualizadas, ignoradas, problemas_json, status, criado_em, criado_por_nome)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, '[]', 'concluida', ?, ?)`,
    [id, tenantId, meta.arquivo ?? '', meta.formato ?? '', previa.total, agora, autor.nome ?? ''],
  );
}

/* ---------------------------------------------------------------- cobertura do dia */

/* Quem tem escala, quem tem ponto, e onde os dois não se encontram.
 *
 * Responde de uma vez às três perguntas do requisito: quem não possui escala, escala sem ponto e
 * ponto sem escala. As três saem da MESMA comparação — separá-las em três consultas faria três
 * respostas que podem discordar entre si. */
export async function cobertura(tenantId, data) {
  const escalas = await consultar(
    'SELECT colaborador_chave AS chave, colaborador_nome AS nome, situacao FROM escalas_dia WHERE tenant_id = ? AND data = ?',
    [tenantId, data],
  );

  const registro = await consultarUm(
    'SELECT snapshot_json FROM time_records WHERE tenant_id = ? AND date_key = ?',
    [tenantId, data],
  );

  const doPonto = new Map();
  if (registro) {
    const snap = JSON.parse(registro.snapshot_json || '{}');
    for (const item of snap.items ?? []) {
      const chave = chaveColaborador(item.motorista);
      if (chave) doPonto.set(chave, item.motorista);
    }
  }

  const daEscala = new Map(escalas.map((e) => [e.chave, e]));

  const pontoSemEscala = [];
  for (const [chave, nome] of doPonto) {
    if (!daEscala.has(chave)) pontoSemEscala.push({ colaboradorChave: chave, colaborador: nome });
  }

  const escalaSemPonto = [];
  for (const e of escalas) {
    const previaTrabalho = e.situacao === 'trabalha' || e.situacao === 'extra' || e.situacao === 'alteracao_horario';
    if (previaTrabalho && !doPonto.has(e.chave)) {
      escalaSemPonto.push({ colaboradorChave: e.chave, colaborador: e.nome, situacao: e.situacao });
    }
  }

  /* Do cadastro: quem está ativo e não tem escala nenhuma para o dia. Diferente de "ponto sem
   * escala": aqui a pessoa pode nem ter batido ponto. */
  const ativos = await consultar(
    "SELECT nome FROM employees WHERE tenant_id = ? AND status = 'ativo'",
    [tenantId],
  );
  const semEscala = ativos
    .map((a) => ({ colaborador: a.nome, colaboradorChave: chaveColaborador(a.nome) }))
    .filter((a) => !daEscala.has(a.colaboradorChave));

  return {
    data,
    comEscala: escalas.length,
    comPonto: doPonto.size,
    pontoSemEscala,
    escalaSemPonto,
    semEscala,
    folgas: escalas.filter((e) => e.situacao === 'folga').length,
    extras: escalas.filter((e) => e.situacao === 'extra').length,
  };
}
