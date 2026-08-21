/* Horários padrão com vigência.
 *
 * A REGRA QUE ORGANIZA ESTE ARQUIVO
 * ---------------------------------
 * Um horário padrão NÃO é um campo editável no cadastro da pessoa: é uma linha com data de início
 * e (quando encerrada) data de fim. Corrigir o horário de alguém não altera a linha antiga — fecha
 * a vigência dela e abre outra.
 *
 * Isso existe por um motivo concreto: a análise de julho precisa ler o horário que valia em julho.
 * Se `atualizar()` sobrescrevesse a linha, uma correção feita hoje mudaria retroativamente o
 * veredito de todos os dias já analisados — e horas extras já justificadas passariam a não fechar
 * com o próprio histórico. `atualizar()` aqui só corrige uma linha existente para o período dela;
 * mudar de horário é `substituir()`, que preserva a anterior.
 *
 * A leitura por data mora em `services/referenciaJornada.js` — este arquivo é o cadastro. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';
import {
  chaveColaborador,
} from './heRepository.js';
import {
  duracaoMarcacoes, extraDeMarcacoes, faixaLegivel, normalizarMarcacoes, paraMinutos,
} from '../services/referenciaJornada.js';

export const STATUS = ['ativo', 'inativo'];

const CAMPOS = `id, colaborador_chave AS colaboradorChave, colaborador_nome AS colaborador,
  colaborador_id AS colaboradorId, marcacoes_json AS marcacoesJson,
  carga_prevista_min AS cargaPrevistaMin, extra_min AS extraMin,
  vigencia_inicio AS vigenciaInicio, vigencia_fim AS vigenciaFim,
  status, observacoes, criado_em AS criadoEm, criado_por_nome AS criadoPor,
  atualizado_em AS atualizadoEm, atualizado_por_nome AS atualizadoPor`;

function hidratar(linha) {
  if (!linha) return null;
  const marcacoes = JSON.parse(linha.marcacoesJson || '[]');
  const { marcacoesJson, ...resto } = linha;
  return {
    ...resto,
    marcacoes,
    faixa: faixaLegivel(marcacoes),
    /* A carga REALIZADA pelo horário previsto — útil para conferir se a carga cadastrada bate com
     * os horários informados. É a conta do motor, não uma regra nova. */
    duracaoPrevistaMin: duracaoMarcacoes(marcacoes).totalMin,
    vigente: linha.status === 'ativo' && (!linha.vigenciaFim || linha.vigenciaFim >= hoje()),
  };
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

/* Um dia antes de `data`, em ISO. Usado para fechar a vigência anterior sem deixar buraco nem
 * sobreposição: se o novo padrão começa em 01/08, o anterior termina em 31/07. */
function diaAnterior(data) {
  const d = new Date(`${data}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function registrarHistorico(tx, tenantId, padraoId, evento, dados = {}) {
  await tx.executar(
    `INSERT INTO horarios_padrao_historico (id, tenant_id, padrao_id, evento, usuario, user_id,
       valor_anterior, valor_novo, observacao, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      novoId('hph'), tenantId, padraoId, evento,
      dados.usuario ?? '', dados.userId ?? null,
      dados.valorAnterior ?? '', dados.valorNovo ?? '', dados.observacao ?? '',
      new Date().toISOString(),
    ],
  );
}

/* ---------------------------------------------------------------- validação */

/* Problemas de qualidade do dado, em linguagem de quem cadastrou.
 *
 * Devolve uma LISTA em vez de lançar no primeiro erro: quem está importando cem linhas precisa ver
 * tudo que está errado de uma vez, não descobrir um problema por tentativa. */
export function validar(dados) {
  const problemas = [];
  const marcacoes = normalizarMarcacoes(dados.marcacoes ?? []);
  const brutas = Array.isArray(dados.marcacoes) ? dados.marcacoes : [];

  if (!String(dados.colaborador ?? '').trim()) {
    problemas.push({ campo: 'colaborador', tipo: 'colaborador_ausente', mensagem: 'Informe o colaborador.' });
  }

  if (brutas.length && marcacoes.length !== brutas.filter((v) => String(v ?? '').trim()).length) {
    problemas.push({
      campo: 'marcacoes', tipo: 'horario_invalido',
      mensagem: 'Há horário em formato inválido. Use HH:MM.',
    });
  }

  if (marcacoes.length === 0) {
    problemas.push({ campo: 'marcacoes', tipo: 'sem_marcacoes', mensagem: 'Informe ao menos entrada e saída.' });
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

  if (!dados.vigenciaInicio) {
    problemas.push({
      campo: 'vigenciaInicio', tipo: 'sem_vigencia',
      mensagem: 'Horário padrão sem vigência inicial: sem ela não há como saber a partir de quando ele vale.',
    });
  }

  if (dados.vigenciaFim && dados.vigenciaInicio && dados.vigenciaFim < dados.vigenciaInicio) {
    problemas.push({
      campo: 'vigenciaFim', tipo: 'vigencia_invertida',
      mensagem: 'A vigência final é anterior à inicial.',
    });
  }

  const carga = dados.cargaPrevistaMin;
  if (carga !== null && carga !== undefined && carga !== '') {
    const n = Number(carga);
    if (!Number.isFinite(n) || n <= 0 || n > 1440) {
      problemas.push({ campo: 'cargaPrevistaMin', tipo: 'carga_invalida', mensagem: 'Carga prevista fora de uma faixa plausível.' });
    }
  }

  /* O extra fora da faixa não impede o cadastro — o horário pode estar certo e a carga errada, ou
   * o contrário. Vira aviso para alguém conferir, não recusa. */
  const { extraMin, valido } = extraDeMarcacoes(marcacoes, carga === '' ? null : carga);
  if (extraMin !== null && !valido) {
    problemas.push({
      campo: 'cargaPrevistaMin', tipo: 'extra_implausivel', aviso: true,
      mensagem: `Os horários informados dão ${extraMin} min de extra habitual. Confira a carga prevista.`,
    });
  }

  return problemas;
}

/* ---------------------------------------------------------------- consultas */

export async function listar(tenantId, filtros = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];

  if (filtros.busca) {
    where.push('(colaborador_chave LIKE ? OR colaborador_nome LIKE ?)');
    const t = `%${chaveColaborador(filtros.busca)}%`;
    args.push(t, `%${filtros.busca}%`);
  }
  if (filtros.status) {
    where.push('status = ?');
    args.push(filtros.status);
  }
  /* "vigente em X" é a consulta que a operação faz o tempo todo. */
  if (filtros.vigenteEm) {
    where.push('status = ? AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?)');
    args.push('ativo', filtros.vigenteEm, filtros.vigenteEm);
  }

  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM horarios_padrao WHERE ${where.join(' AND ')}
      ORDER BY colaborador_nome ASC, vigencia_inicio DESC`,
    args,
  );
  return linhas.map(hidratar);
}

export async function obter(tenantId, id) {
  const linha = await consultarUm(
    `SELECT ${CAMPOS} FROM horarios_padrao WHERE tenant_id = ? AND id = ?`,
    [tenantId, id],
  );
  return hidratar(linha);
}

/* Todas as vigências de uma pessoa, da mais recente para a mais antiga. É a "linha do tempo" do
 * horário dela — a resposta a "qual horário valia em julho?". */
export async function historicoDoColaborador(tenantId, colaborador) {
  const chave = chaveColaborador(colaborador);
  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM horarios_padrao
      WHERE tenant_id = ? AND colaborador_chave = ?
      ORDER BY vigencia_inicio DESC`,
    [tenantId, chave],
  );
  return linhas.map(hidratar);
}

export async function historico(tenantId, padraoId) {
  return consultar(
    `SELECT id, evento, usuario, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
            observacao, criado_em AS criadoEm
       FROM horarios_padrao_historico
      WHERE tenant_id = ? AND padrao_id = ?
      ORDER BY criado_em DESC`,
    [tenantId, padraoId],
  );
}

/* Vigências ativas que se sobrepõem no tempo para a mesma pessoa. É um alerta de qualidade: o
 * sistema sabe escolher (a mais recente vence), mas escolher caladamente esconde um cadastro
 * errado que vai produzir análise errada em silêncio. */
export async function conflitosDeVigencia(tenantId) {
  const linhas = await consultar(
    `SELECT a.id AS idA, b.id AS idB, a.colaborador_nome AS colaborador,
            a.vigencia_inicio AS inicioA, a.vigencia_fim AS fimA,
            b.vigencia_inicio AS inicioB, b.vigencia_fim AS fimB
       FROM horarios_padrao a
       JOIN horarios_padrao b
         ON a.tenant_id = b.tenant_id
        AND a.colaborador_chave = b.colaborador_chave
        AND a.id < b.id
      WHERE a.tenant_id = ? AND a.status = 'ativo' AND b.status = 'ativo'
        AND a.vigencia_inicio <= COALESCE(b.vigencia_fim, '9999-12-31')
        AND b.vigencia_inicio <= COALESCE(a.vigencia_fim, '9999-12-31')`,
    [tenantId],
  );
  return linhas;
}

/* Períodos SEM horário padrão vigente, entre duas vigências ou depois da última.
 *
 * É o alerta que faltava, e ele veio de um caso real na validação: cadastrar uma vigência
 * histórica fechada (junho–julho) encerra a vigência aberta que existia antes dela — e o mês
 * seguinte fica descoberto. Ninguém percebe até uma jornada aparecer como "referência não
 * encontrada", já com o dia processado.
 *
 * A sobreposição o sistema resolve sozinho (a mais recente vence); o buraco ele NÃO tem como
 * resolver, porque a resposta certa é um horário que ninguém informou. Por isso este alerta é
 * mais importante que o de sobreposição. */
export async function buracosDeVigencia(tenantId, ate = null) {
  const limite = ate ?? hoje();
  const linhas = await consultar(
    `SELECT id, colaborador_chave AS chave, colaborador_nome AS colaborador,
            vigencia_inicio AS inicio, vigencia_fim AS fim
       FROM horarios_padrao
      WHERE tenant_id = ? AND status = 'ativo'
      ORDER BY colaborador_chave, vigencia_inicio`,
    [tenantId],
  );

  const porPessoa = new Map();
  for (const l of linhas) {
    if (!porPessoa.has(l.chave)) porPessoa.set(l.chave, []);
    porPessoa.get(l.chave).push(l);
  }

  const alertas = [];
  for (const [, vigencias] of porPessoa) {
    for (let i = 0; i < vigencias.length; i += 1) {
      const atual = vigencias[i];
      if (!atual.fim) continue; /* aberta: cobre daqui para a frente */

      const proxima = vigencias[i + 1];
      const inicioDoBuraco = diaSeguinte(atual.fim);

      if (!proxima) {
        /* Última vigência da pessoa, e ela terminou. Só é problema se já passou. */
        if (atual.fim < limite) {
          alertas.push({
            tipo: 'sem_vigencia_atual', id: atual.id, colaborador: atual.colaborador,
            mensagem: `Sem horário padrão vigente desde ${inicioDoBuraco}. Jornadas a partir dessa data ficam sem referência.`,
          });
        }
        continue;
      }

      if (proxima.inicio > inicioDoBuraco) {
        alertas.push({
          tipo: 'buraco_de_vigencia', id: atual.id, colaborador: atual.colaborador,
          mensagem: `Sem horário padrão entre ${inicioDoBuraco} e ${diaAnterior(proxima.inicio)}. Jornadas nesse intervalo ficam sem referência.`,
        });
      }
    }
  }
  return alertas;
}

function diaSeguinte(data) {
  const d = new Date(`${data}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- escrita */

function preparar(dados) {
  const marcacoes = normalizarMarcacoes(dados.marcacoes ?? []);
  const carga = dados.cargaPrevistaMin === '' || dados.cargaPrevistaMin === undefined
    ? null
    : Number(dados.cargaPrevistaMin);
  const { extraMin } = extraDeMarcacoes(marcacoes, carga);
  return { marcacoes, carga, extraMin };
}

export async function criar(tenantId, dados, autor = {}) {
  const problemas = validar(dados).filter((p) => !p.aviso);
  if (problemas.length) {
    const erro = new Error(problemas[0].mensagem);
    erro.codigo = 'dados_invalidos';
    erro.problemas = problemas;
    throw erro;
  }

  const { marcacoes, carga, extraMin } = preparar(dados);
  const chave = chaveColaborador(dados.colaborador);
  const agora = new Date().toISOString();
  const id = novoId('hpd');

  return emTransacao(async (tx) => {
    /* Abrir uma vigência nova FECHA a anterior que ficaria sobreposta. É o que mantém a linha do
     * tempo sem buracos e sem dois horários válidos no mesmo dia. */
    const anteriores = await tx.consultar(
      `SELECT id, vigencia_inicio, vigencia_fim FROM horarios_padrao
        WHERE tenant_id = ? AND colaborador_chave = ? AND status = 'ativo'
          AND (vigencia_fim IS NULL OR vigencia_fim >= ?)`,
      [tenantId, chave, dados.vigenciaInicio],
    );

    for (const ant of anteriores) {
      if (ant.vigencia_inicio >= dados.vigenciaInicio) continue; /* tratado como conflito, não fechado */
      const novoFim = diaAnterior(dados.vigenciaInicio);
      await tx.executar(
        'UPDATE horarios_padrao SET vigencia_fim = ?, atualizado_em = ?, atualizado_por_nome = ? WHERE id = ?',
        [novoFim, agora, autor.nome ?? '', ant.id],
      );
      await registrarHistorico(tx, tenantId, ant.id, 'vigencia_alterada', {
        usuario: autor.nome, userId: autor.id,
        valorAnterior: ant.vigencia_fim ?? 'sem fim',
        valorNovo: novoFim,
        observacao: 'Vigência encerrada porque um novo horário padrão passou a valer.',
      });
    }

    await tx.executar(
      `INSERT INTO horarios_padrao (id, tenant_id, colaborador_chave, colaborador_nome,
         colaborador_id, marcacoes_json, carga_prevista_min, extra_min, vigencia_inicio,
         vigencia_fim, status, observacoes, criado_em, criado_por_nome, atualizado_em,
         atualizado_por_nome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, tenantId, chave, String(dados.colaborador).trim(), dados.colaboradorId ?? null,
        JSON.stringify(marcacoes), carga, extraMin, dados.vigenciaInicio,
        dados.vigenciaFim || null, dados.status ?? 'ativo', dados.observacoes ?? '',
        agora, autor.nome ?? '', agora, autor.nome ?? '',
      ],
    );

    await registrarHistorico(tx, tenantId, id, 'criado', {
      usuario: autor.nome, userId: autor.id,
      valorNovo: `${faixaLegivel(marcacoes)} a partir de ${dados.vigenciaInicio}`,
    });

    const linha = await tx.consultarUm(`SELECT ${CAMPOS} FROM horarios_padrao WHERE id = ?`, [id]);
    return hidratar(linha);
  });
}

/* Corrige uma vigência existente — para o período dela.
 *
 * Use quando o cadastro estava ERRADO (horário digitado torto, carga errada). Para uma MUDANÇA de
 * horário a partir de uma data, use `criar()`: a diferença é que a correção reescreve o passado
 * de propósito, e a mudança preserva. */
export async function atualizar(tenantId, id, dados, autor = {}) {
  const atual = await obter(tenantId, id);
  if (!atual) return null;

  const mesclado = {
    colaborador: dados.colaborador ?? atual.colaborador,
    marcacoes: dados.marcacoes ?? atual.marcacoes,
    cargaPrevistaMin: dados.cargaPrevistaMin ?? atual.cargaPrevistaMin,
    vigenciaInicio: dados.vigenciaInicio ?? atual.vigenciaInicio,
    vigenciaFim: dados.vigenciaFim === undefined ? atual.vigenciaFim : dados.vigenciaFim,
    observacoes: dados.observacoes ?? atual.observacoes,
    status: dados.status ?? atual.status,
  };

  const problemas = validar(mesclado).filter((p) => !p.aviso);
  if (problemas.length) {
    const erro = new Error(problemas[0].mensagem);
    erro.codigo = 'dados_invalidos';
    erro.problemas = problemas;
    throw erro;
  }

  const { marcacoes, carga, extraMin } = preparar(mesclado);
  const agora = new Date().toISOString();

  return emTransacao(async (tx) => {
    await tx.executar(
      `UPDATE horarios_padrao SET colaborador_nome = ?, marcacoes_json = ?, carga_prevista_min = ?,
              extra_min = ?, vigencia_inicio = ?, vigencia_fim = ?, status = ?, observacoes = ?,
              atualizado_em = ?, atualizado_por_nome = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        String(mesclado.colaborador).trim(), JSON.stringify(marcacoes), carga, extraMin,
        mesclado.vigenciaInicio, mesclado.vigenciaFim || null, mesclado.status,
        mesclado.observacoes ?? '', agora, autor.nome ?? '', tenantId, id,
      ],
    );

    const mudouHorario = faixaLegivel(atual.marcacoes) !== faixaLegivel(marcacoes);
    const mudouVigencia = atual.vigenciaInicio !== mesclado.vigenciaInicio
      || (atual.vigenciaFim ?? null) !== (mesclado.vigenciaFim || null);

    if (mudouHorario || mudouVigencia) {
      await registrarHistorico(tx, tenantId, id, mudouVigencia && !mudouHorario ? 'vigencia_alterada' : 'alterado', {
        usuario: autor.nome, userId: autor.id,
        valorAnterior: `${faixaLegivel(atual.marcacoes)} (${atual.vigenciaInicio} → ${atual.vigenciaFim ?? 'sem fim'})`,
        valorNovo: `${faixaLegivel(marcacoes)} (${mesclado.vigenciaInicio} → ${mesclado.vigenciaFim || 'sem fim'})`,
        observacao: dados.motivo ?? '',
      });
    }

    const linha = await tx.consultarUm(`SELECT ${CAMPOS} FROM horarios_padrao WHERE id = ?`, [id]);
    return hidratar(linha);
  });
}

export async function inativar(tenantId, id, autor = {}, motivo = '') {
  const atual = await obter(tenantId, id);
  if (!atual) return null;
  const agora = new Date().toISOString();

  return emTransacao(async (tx) => {
    await tx.executar(
      `UPDATE horarios_padrao SET status = 'inativo', atualizado_em = ?, atualizado_por_nome = ?
        WHERE tenant_id = ? AND id = ?`,
      [agora, autor.nome ?? '', tenantId, id],
    );
    await registrarHistorico(tx, tenantId, id, 'inativado', {
      usuario: autor.nome, userId: autor.id,
      valorAnterior: 'ativo', valorNovo: 'inativo', observacao: motivo,
    });
    const linha = await tx.consultarUm(`SELECT ${CAMPOS} FROM horarios_padrao WHERE id = ?`, [id]);
    return hidratar(linha);
  });
}

export async function reativar(tenantId, id, autor = {}) {
  const atual = await obter(tenantId, id);
  if (!atual) return null;
  const agora = new Date().toISOString();

  return emTransacao(async (tx) => {
    await tx.executar(
      `UPDATE horarios_padrao SET status = 'ativo', atualizado_em = ?, atualizado_por_nome = ?
        WHERE tenant_id = ? AND id = ?`,
      [agora, autor.nome ?? '', tenantId, id],
    );
    await registrarHistorico(tx, tenantId, id, 'reativado', {
      usuario: autor.nome, userId: autor.id, valorAnterior: 'inativo', valorNovo: 'ativo',
    });
    const linha = await tx.consultarUm(`SELECT ${CAMPOS} FROM horarios_padrao WHERE id = ?`, [id]);
    return hidratar(linha);
  });
}

/* ---------------------------------------------------------------- importação */

/* Prévia: valida tudo e diz o que ACONTECERIA, sem gravar nada.
 *
 * O fluxo de importação é sempre dois passos (prévia → confirmação) porque importar horário padrão
 * altera como toda a jornada futura será interpretada. Um erro de coluna aqui contamina a análise
 * de todo mundo, e descobrir isso depois de gravar é caro. */
export async function preverImportacao(tenantId, linhas = []) {
  const resultado = { total: linhas.length, novos: 0, substituicoes: 0, comProblema: 0, itens: [] };
  const vistos = new Map();

  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    const problemas = validar(linha);
    const chave = chaveColaborador(linha.colaborador);

    /* Duas linhas para a mesma pessoa com a mesma vigência é erro de planilha, não dois cadastros. */
    const dedupe = `${chave}|${linha.vigenciaInicio ?? ''}`;
    if (vistos.has(dedupe)) {
      problemas.push({
        tipo: 'duplicado_no_arquivo',
        mensagem: `Mesma pessoa e mesma vigência já apareceram na linha ${vistos.get(dedupe) + 1}.`,
      });
    } else {
      vistos.set(dedupe, i);
    }

    const existente = chave
      ? await consultarUm(
        `SELECT id, marcacoes_json, vigencia_inicio, vigencia_fim FROM horarios_padrao
          WHERE tenant_id = ? AND colaborador_chave = ? AND status = 'ativo'
            AND (vigencia_fim IS NULL OR vigencia_fim >= ?)
          ORDER BY vigencia_inicio DESC LIMIT 1`,
        [tenantId, chave, linha.vigenciaInicio ?? hoje()],
      )
      : null;

    const bloqueantes = problemas.filter((p) => !p.aviso);
    if (bloqueantes.length) resultado.comProblema += 1;
    else if (existente) resultado.substituicoes += 1;
    else resultado.novos += 1;

    resultado.itens.push({
      linha: i + 1,
      colaborador: linha.colaborador ?? '',
      marcacoes: normalizarMarcacoes(linha.marcacoes ?? []),
      faixa: faixaLegivel(normalizarMarcacoes(linha.marcacoes ?? [])),
      vigenciaInicio: linha.vigenciaInicio ?? '',
      vigenciaFim: linha.vigenciaFim ?? '',
      cargaPrevistaMin: linha.cargaPrevistaMin ?? null,
      acao: bloqueantes.length ? 'erro' : (existente ? 'substitui' : 'novo'),
      anterior: existente
        ? {
          faixa: faixaLegivel(JSON.parse(existente.marcacoes_json || '[]')),
          vigenciaInicio: existente.vigencia_inicio,
          vigenciaFim: existente.vigencia_fim,
        }
        : null,
      problemas,
    });
  }

  return resultado;
}

/* Aplica a importação. Só grava as linhas SEM problema bloqueante — as com erro voltam no relatório
 * para correção. Importar metade é melhor do que recusar tudo por causa de uma linha torta, desde
 * que fique explícito o que não entrou. */
export async function importar(tenantId, linhas = [], autor = {}) {
  const previa = await preverImportacao(tenantId, linhas);
  const aplicadas = [];
  const recusadas = [];

  for (const item of previa.itens) {
    if (item.acao === 'erro') {
      recusadas.push(item);
      continue;
    }
    const original = linhas[item.linha - 1];
    try {
      const salvo = await criar(tenantId, original, autor);
      aplicadas.push({ linha: item.linha, id: salvo.id, colaborador: salvo.colaborador, acao: item.acao });
    } catch (e) {
      recusadas.push({ ...item, acao: 'erro', problemas: [{ tipo: 'falha_gravacao', mensagem: e.message }] });
    }
  }

  return { total: previa.total, aplicadas, recusadas, previa };
}

/* Alertas de qualidade do cadastro inteiro. Alimenta a tela e a fila. */
export async function alertasDeQualidade(tenantId) {
  const alertas = [];

  const semVigencia = await consultar(
    `SELECT id, colaborador_nome AS colaborador FROM horarios_padrao
      WHERE tenant_id = ? AND (vigencia_inicio IS NULL OR vigencia_inicio = '')`,
    [tenantId],
  );
  for (const s of semVigencia) {
    alertas.push({ tipo: 'horario_padrao_sem_vigencia', id: s.id, colaborador: s.colaborador,
      mensagem: 'Horário padrão sem vigência inicial.' });
  }

  for (const c of await conflitosDeVigencia(tenantId)) {
    alertas.push({
      tipo: 'vigencias_sobrepostas', id: c.idB, colaborador: c.colaborador,
      mensagem: `Duas vigências ativas cobrem a mesma data (${c.inicioA}–${c.fimA ?? 'sem fim'} e ${c.inicioB}–${c.fimB ?? 'sem fim'}).`,
    });
  }

  for (const b of await buracosDeVigencia(tenantId)) alertas.push(b);

  const invalidos = await consultar(
    `SELECT id, colaborador_nome AS colaborador, marcacoes_json AS m FROM horarios_padrao
      WHERE tenant_id = ? AND status = 'ativo'`,
    [tenantId],
  );
  for (const i of invalidos) {
    const marc = JSON.parse(i.m || '[]');
    if (marc.length === 0 || marc.length % 2 !== 0 || marc.length > 6) {
      alertas.push({
        tipo: 'marcacoes_invalidas', id: i.id, colaborador: i.colaborador,
        mensagem: `Horário padrão com ${marc.length} registro(s): o modelo espera 2, 4 ou 6.`,
      });
    }
    if (marc.some((h) => paraMinutos(h) === null)) {
      alertas.push({
        tipo: 'horario_invalido', id: i.id, colaborador: i.colaborador,
        mensagem: 'Horário padrão com marcação em formato inválido.',
      });
    }
  }

  return alertas;
}
