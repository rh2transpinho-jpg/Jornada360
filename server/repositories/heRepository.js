/* Ocorrências de hora extra e suas justificativas.
 *
 * A REGRA QUE ORGANIZA ESTE ARQUIVO INTEIRO:
 *
 *   o motor calcula      → `he_ocorrencias` recebe os NÚMEROS (sincronizados a cada importação)
 *   uma pessoa analisa   → `he_ocorrencias` recebe a JUSTIFICATIVA (nunca sobrescrita pelo motor)
 *
 * `sincronizar()` é a única função que escreve o lado calculado, e ela nunca toca em `status`,
 * `motivo`, `justificativa`, `origem` nem nos campos de responsável. `registrarJustificativa()` é
 * a única que escreve o lado humano, e ela nunca toca nos números.
 *
 * Essa separação é o requisito 12 em forma de código. Sem ela, reimportar julho apagaria as
 * justificativas de julho — e ninguém perceberia, porque o total de HE continuaria correto. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';

export const STATUS = ['pendente', 'justificada', 'nao_autorizada', 'em_analise', 'abonada'];

export const ROTULO_STATUS = {
  pendente: 'Pendente de justificativa',
  justificada: 'Justificada',
  nao_autorizada: 'Não autorizada',
  em_analise: 'Em análise',
  abonada: 'Abonada/regularizada',
};

/* Sugestões iniciais. Cada empresa edita as suas (workspace_rules.he_motivos / he_origens) —
 * estas só preenchem o cadastro novo para ninguém começar de uma lista vazia. */
export const MOTIVOS_PADRAO = [
  'Escala extra', 'Troca de veículo', 'Quebra de veículo', 'Abastecimento',
  'Atraso operacional', 'Demanda da operação', 'Solicitação da supervisão',
  'Trânsito', 'Atendimento ao cliente', 'Retorno à garagem', 'Outro',
];

export const ORIGENS_PADRAO = [
  'Motorista', 'Supervisor', 'Operacional', 'RH', 'Rastreamento', 'Escala', 'Documento', 'Outro',
];

/* Mesma normalização do motor (heEngineCore.normName). Duplicada aqui de propósito: o backend não
 * importa do frontend, e é ESTA função que decide se duas importações falam da mesma pessoa. */
export function chaveColaborador(nome) {
  return String(nome ?? '')
    .toUpperCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

const CAMPOS = `id, colaborador_chave AS colaboradorChave, colaborador_nome AS colaborador,
  colaborador_id AS colaboradorId, data, he_min AS heMin, excedente_min AS excedenteMin,
  padrao_min AS padraoMin, escala_prevista AS escalaPrevista, jornada_realizada AS jornadaRealizada,
  batidas, setor, rastreio, contexto, status, motivo, justificativa, origem,
  quem_informou AS quemInformou, quem_solicitou AS quemSolicitou, observacoes,
  anexo_nome AS anexoNome, anexo_url AS anexoUrl, justificada_em AS justificadaEm,
  responsavel_id AS responsavelId, responsavel_nome AS responsavel,
  criada_em AS criadaEm, atualizada_em AS atualizadaEm,
  recalculada_em AS recalculadaEm, he_min_anterior AS heMinAnterior`;

/* ---------------------------------------------------------------- sincronização com o motor */

async function registrarHistorico(tx, tenantId, ocorrenciaId, evento, dados = {}) {
  await tx.executar(
    `INSERT INTO he_historico (id, tenant_id, ocorrencia_id, evento, usuario, user_id,
       valor_anterior, valor_novo, observacao, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      novoId('heh'), tenantId, ocorrenciaId, evento,
      dados.usuario ?? '', dados.userId ?? null,
      dados.valorAnterior ?? '', dados.valorNovo ?? '', dados.observacao ?? '',
      new Date().toISOString(),
    ],
  );
}

/* Cria ou atualiza as ocorrências de UM dia processado, a partir do snapshot do motor.
 *
 * Chamada sempre que um dia é gravado. Idempotente: rodar duas vezes com o mesmo snapshot não
 * duplica nada nem altera nada, graças à chave (tenant, colaborador, data). */
export async function sincronizarDia(tenantId, dateKey, snapshot, { limiteMin = 1 } = {}) {
  const itens = (snapshot?.items ?? []).filter((i) => Number(i?.he1min ?? 0) >= limiteMin);
  if (itens.length === 0) return { criadas: 0, atualizadas: 0, recalculadas: 0 };

  return emTransacao(async (tx) => {
    let criadas = 0;
    let atualizadas = 0;
    let recalculadas = 0;
    const agora = new Date().toISOString();

    for (const item of itens) {
      const chave = chaveColaborador(item.motorista);
      if (!chave) continue;

      const escala = Array.isArray(item.padraoHorarios) && item.padraoHorarios.length
        ? item.padraoHorarios.join('–')
        : '';

      const existente = await tx.consultarUm(
        'SELECT id, he_min, status, justificativa FROM he_ocorrencias WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?',
        [tenantId, chave, dateKey],
      );

      if (!existente) {
        const id = novoId('heo');
        await tx.executar(
          `INSERT INTO he_ocorrencias (id, tenant_id, colaborador_chave, colaborador_nome, data,
             he_min, excedente_min, padrao_min, escala_prevista, jornada_realizada, batidas,
             setor, rastreio, contexto, status, criada_em, atualizada_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
          [
            id, tenantId, chave, item.motorista, dateKey,
            Number(item.he1min ?? 0), Number(item.excedenteMin ?? 0),
            item.padraoMin ?? null, escala, item.confirmadas ?? '', item.batidas ?? '',
            item.setorAtual ?? '', item.rastreioStatus ?? '', item.contexto ?? '',
            agora, agora,
          ],
        );
        await registrarHistorico(tx, tenantId, id, 'identificada', {
          valorNovo: `${item.he1min ?? 0} min de HE em ${dateKey}`,
          observacao: 'Ocorrência criada pelo processamento da jornada.',
        });
        criadas += 1;
        continue;
      }

      /* JÁ EXISTE: só o lado calculado é atualizado. `status`, `motivo`, `justificativa`,
       * `origem` e responsável ficam de fora do UPDATE de propósito — é a garantia do
       * requisito 12, e não uma omissão. */
      const heAnterior = Number(existente.he_min ?? 0);
      const heNovo = Number(item.he1min ?? 0);
      const mudouONumero = heAnterior !== heNovo;
      /* Só marca "recalculada" quando já havia análise humana: recalcular uma ocorrência que
       * ninguém olhou ainda não é informação, é ruído na tela. */
      const havialAnalise = existente.status !== 'pendente' || !!existente.justificativa;
      const sinalizar = mudouONumero && havialAnalise;

      await tx.executar(
        `UPDATE he_ocorrencias SET
           colaborador_nome = ?, he_min = ?, excedente_min = ?, padrao_min = ?,
           escala_prevista = ?, jornada_realizada = ?, batidas = ?, setor = ?, rastreio = ?,
           contexto = ?, atualizada_em = ?
           ${sinalizar ? ', recalculada_em = ?, he_min_anterior = ?' : ''}
         WHERE id = ? AND tenant_id = ?`,
        sinalizar
          ? [item.motorista, heNovo, Number(item.excedenteMin ?? 0), item.padraoMin ?? null,
             escala, item.confirmadas ?? '', item.batidas ?? '', item.setorAtual ?? '',
             item.rastreioStatus ?? '', item.contexto ?? '', agora, agora, heAnterior,
             existente.id, tenantId]
          : [item.motorista, heNovo, Number(item.excedenteMin ?? 0), item.padraoMin ?? null,
             escala, item.confirmadas ?? '', item.batidas ?? '', item.setorAtual ?? '',
             item.rastreioStatus ?? '', item.contexto ?? '', agora,
             existente.id, tenantId],
      );

      if (sinalizar) {
        await registrarHistorico(tx, tenantId, existente.id, 'recalculada', {
          valorAnterior: `${heAnterior} min`,
          valorNovo: `${heNovo} min`,
          observacao: 'A jornada foi reprocessada depois da análise. A justificativa foi preservada.',
        });
        recalculadas += 1;
      }
      atualizadas += 1;
    }

    return { criadas, atualizadas, recalculadas };
  });
}

/* ---------------------------------------------------------------- consulta */

/* Lista com todos os filtros do requisito 8. Tudo é resolvido em SQL, com `tenant_id` sempre no
 * WHERE — nenhuma linha de outra empresa chega a sair do banco. */
export async function listar(tenantId, filtros = {}) {
  const onde = ['o.tenant_id = ?'];
  const valores = [tenantId];

  if (filtros.busca) {
    /* Uma caixa de busca só: nome, motivo, justificativa ou data. É o requisito 2 — digitar
     * "Alex" ou "2026-07-22" e achar, sem escolher em qual campo procurar. */
    onde.push('(o.colaborador_chave LIKE ? OR o.data LIKE ? OR o.motivo LIKE ? OR o.justificativa LIKE ?)');
    const t = `%${chaveColaborador(filtros.busca)}%`;
    const bruto = `%${filtros.busca}%`;
    valores.push(t, bruto, bruto, bruto);
  }
  if (filtros.colaborador) {
    onde.push('o.colaborador_chave = ?');
    valores.push(chaveColaborador(filtros.colaborador));
  }
  if (filtros.data) { onde.push('o.data = ?'); valores.push(filtros.data); }
  if (filtros.de) { onde.push('o.data >= ?'); valores.push(filtros.de); }
  if (filtros.ate) { onde.push('o.data <= ?'); valores.push(filtros.ate); }
  if (filtros.status) { onde.push('o.status = ?'); valores.push(filtros.status); }
  if (filtros.motivo) { onde.push('o.motivo = ?'); valores.push(filtros.motivo); }
  if (filtros.origem) { onde.push('o.origem = ?'); valores.push(filtros.origem); }
  if (filtros.setor) { onde.push('o.setor = ?'); valores.push(filtros.setor); }
  if (filtros.responsavel) { onde.push('o.responsavel_nome = ?'); valores.push(filtros.responsavel); }
  if (filtros.heMinima) { onde.push('o.he_min >= ?'); valores.push(Number(filtros.heMinima)); }

  return consultar(
    `SELECT ${CAMPOS} FROM he_ocorrencias o WHERE ${onde.join(' AND ')} ORDER BY o.data DESC, o.colaborador_nome`,
    valores,
  );
}

export function obter(tenantId, id) {
  return consultarUm(`SELECT ${CAMPOS} FROM he_ocorrencias o WHERE o.tenant_id = ? AND o.id = ?`, [tenantId, id]);
}

export function historico(tenantId, ocorrenciaId) {
  return consultar(
    `SELECT id, evento, usuario, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
            observacao, criado_em AS criadoEm
     FROM he_historico WHERE tenant_id = ? AND ocorrencia_id = ? ORDER BY criado_em DESC`,
    [tenantId, ocorrenciaId],
  );
}

/* Os números do topo da tela (requisito 9). O que interessa de verdade é `minutosPendentes`:
 * "quantas horas extras ainda estão sem justificativa". */
export async function resumo(tenantId, filtros = {}) {
  const linhas = await listar(tenantId, filtros);
  const zero = { ocorrencias: 0, minutos: 0 };
  const porStatus = {};
  for (const s of STATUS) porStatus[s] = { ...zero };

  for (const o of linhas) {
    const s = porStatus[o.status] ?? (porStatus[o.status] = { ...zero });
    s.ocorrencias += 1;
    s.minutos += Number(o.heMin ?? 0);
  }

  return {
    ocorrencias: linhas.length,
    minutos: linhas.reduce((a, o) => a + Number(o.heMin ?? 0), 0),
    porStatus,
    minutosPendentes: porStatus.pendente.minutos,
    ocorrenciasPendentes: porStatus.pendente.ocorrencias,
    colaboradores: new Set(linhas.map((o) => o.colaboradorChave)).size,
  };
}

/* Histórico de HE de um colaborador (requisito 7). */
export async function porColaborador(tenantId, nome, filtros = {}) {
  const ocorrencias = await listar(tenantId, { ...filtros, colaborador: nome });
  const conta = (s) => ocorrencias.filter((o) => o.status === s).length;
  return {
    colaborador: ocorrencias[0]?.colaborador ?? nome,
    totalMin: ocorrencias.reduce((a, o) => a + Number(o.heMin ?? 0), 0),
    ocorrencias: ocorrencias.length,
    justificadas: conta('justificada'),
    pendentes: conta('pendente'),
    naoAutorizadas: conta('nao_autorizada'),
    emAnalise: conta('em_analise'),
    abonadas: conta('abonada'),
    historico: ocorrencias,
  };
}

/* ---------------------------------------------------------------- registro da justificativa */

/* Grava a análise humana. Não toca em nenhum número — e é por isso que reprocessar depois não
 * apaga nada disto. */
export async function registrarJustificativa(tenantId, id, dados, autor) {
  const antes = await obter(tenantId, id);
  if (!antes) return null;

  const agora = new Date().toISOString();
  const status = STATUS.includes(dados.status) ? dados.status : 'justificada';

  await emTransacao(async (tx) => {
    await tx.executar(
      `UPDATE he_ocorrencias SET
         status = ?, motivo = ?, justificativa = ?, origem = ?, quem_informou = ?,
         quem_solicitou = ?, observacoes = ?, anexo_nome = ?, anexo_url = ?,
         justificada_em = ?, responsavel_id = ?, responsavel_nome = ?, atualizada_em = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        status, dados.motivo ?? null, dados.justificativa ?? null, dados.origem ?? null,
        dados.quemInformou ?? null, dados.quemSolicitou ?? null, dados.observacoes ?? null,
        dados.anexoNome ?? null, dados.anexoUrl ?? null,
        agora, autor?.id ?? null, autor?.nome ?? '', agora,
        id, tenantId,
      ],
    );

    /* Alterar uma justificativa existente é evento diferente de registrar a primeira: o histórico
     * precisa guardar o texto anterior, senão "o que estava escrito antes?" fica sem resposta. */
    const primeira = !antes.justificativa;
    await registrarHistorico(tx, tenantId, id, primeira ? 'justificada' : 'justificativa_alterada', {
      usuario: autor?.nome ?? '',
      userId: autor?.id ?? null,
      valorAnterior: primeira ? '' : `${antes.motivo ?? ''} — ${antes.justificativa ?? ''}`,
      valorNovo: `${dados.motivo ?? ''} — ${dados.justificativa ?? ''}`,
      observacao: `Status: ${ROTULO_STATUS[status] ?? status}`,
    });

    if (antes.status !== status) {
      await registrarHistorico(tx, tenantId, id, 'status_alterado', {
        usuario: autor?.nome ?? '',
        userId: autor?.id ?? null,
        valorAnterior: ROTULO_STATUS[antes.status] ?? antes.status,
        valorNovo: ROTULO_STATUS[status] ?? status,
      });
    }

    /* A pendência da Minha Fila é RESOLVIDA aqui dentro, na mesma transação (requisito 10).
     * Não existe uma segunda verdade para manter em dia: quem justifica a ocorrência já fecha
     * a fila, e não há como uma das duas ficar para trás. */
    if (status !== 'pendente') {
      await tx.executar(
        `UPDATE pendings SET status = 'justificado', resolvida_em = ?, atualizada_em = ?,
           resolucao = ? WHERE tenant_id = ? AND he_ocorrencia_id = ? AND resolvida_em IS NULL`,
        [agora, agora, `${dados.motivo ?? ''} — ${dados.justificativa ?? ''}`.slice(0, 500), tenantId, id],
      );
    }
  });

  return obter(tenantId, id);
}

/* ---------------------------------------------------------------- Minha Fila */

/* Cria, para cada HE sem justificativa, UMA pendência ligada à ocorrência.
 *
 * A prioridade sai dos sinais do requisito 10 — quantidade de HE, tempo sem justificativa e HE em
 * dia sem escala. Um número grande parado há duas semanas sobe; uma HE pequena de ontem não. */
export async function gerarPendencias(tenantId, { agora = new Date() } = {}) {
  const semJustificativa = await consultar(
    `SELECT o.id, o.colaborador_nome, o.colaborador_id, o.data, o.he_min, o.padrao_min, o.criada_em
     FROM he_ocorrencias o
     WHERE o.tenant_id = ? AND o.status = 'pendente'
       AND NOT EXISTS (SELECT 1 FROM pendings p WHERE p.he_ocorrencia_id = o.id AND p.resolvida_em IS NULL)`,
    [tenantId],
  );

  let criadas = 0;
  for (const o of semJustificativa) {
    const diasParado = Math.floor((agora.getTime() - new Date(o.criada_em).getTime()) / 86400_000);
    const horas = Number(o.he_min ?? 0) / 60;

    let prioridade = 'media';
    if (horas >= 3 || diasParado >= 14 || o.padrao_min === null) prioridade = 'critica';
    else if (horas >= 1.5 || diasParado >= 7) prioridade = 'alta';
    else if (horas < 0.5 && diasParado < 3) prioridade = 'baixa';

    const carimbo = new Date().toISOString();
    await executar(
      `INSERT INTO pendings (id, tenant_id, colaborador_id, data, tipo, categoria, status,
         prioridade, origem, descricao, evidencias, recomendacao, criada_em, atualizada_em,
         he_ocorrencia_id)
       VALUES (?, ?, ?, ?, 'he_sem_justificativa', 'Hora extra', 'aberta', ?, 'motor', ?, '[]', ?, ?, ?, ?)`,
      [
        novoId('pen'), tenantId, o.colaborador_id ?? null, o.data, prioridade,
        `${o.colaborador_nome} — ${Math.floor(o.he_min / 60)}h${String(o.he_min % 60).padStart(2, '0')} de HE sem justificativa`,
        'Abrir a ocorrência em Horas Extras e registrar o motivo.',
        carimbo, carimbo, o.id,
      ],
    );
    criadas += 1;
  }
  return { criadas };
}

/* ---------------------------------------------------------------- listas configuráveis */

export async function listasDaEmpresa(tenantId) {
  const r = await consultarUm('SELECT he_motivos, he_origens FROM workspace_rules WHERE tenant_id = ?', [tenantId]);
  const ler = (txt, padrao) => {
    try {
      const v = JSON.parse(txt || '[]');
      return Array.isArray(v) && v.length ? v : padrao;
    } catch {
      return padrao;
    }
  };
  return {
    motivos: ler(r?.he_motivos, MOTIVOS_PADRAO),
    origens: ler(r?.he_origens, ORIGENS_PADRAO),
  };
}

export async function salvarListas(tenantId, { motivos, origens }) {
  await executar('UPDATE workspace_rules SET he_motivos = ?, he_origens = ? WHERE tenant_id = ?', [
    JSON.stringify(Array.isArray(motivos) ? motivos : MOTIVOS_PADRAO),
    JSON.stringify(Array.isArray(origens) ? origens : ORIGENS_PADRAO),
    tenantId,
  ]);
  return listasDaEmpresa(tenantId);
}
