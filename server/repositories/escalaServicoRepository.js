/* Escala operacional: os serviços de um motorista numa data.
 *
 * O QUE ESTE ARQUIVO NÃO FAZ, E É O MAIS IMPORTANTE
 * ------------------------------------------------
 * Não deriva jornada. Não calcula entrada, saída, intervalo nem carga. Não produz referência
 * trabalhista de espécie nenhuma.
 *
 * Os horários daqui são OPERACIONAIS: "ENTRADA 07:10" é a viagem que leva os funcionários do
 * cliente para dentro às 07:10 — o motorista precisa começar antes para estar posicionado, e a
 * planilha não diz quando. Transformar o menor horário do dia em entrada da jornada e o maior em
 * saída foi exatamente o erro que esta fase corrige: numa pessoa com serviços das 05:40 às 22:00,
 * isso produziria 16h20 de "jornada prevista" e faria a hora extra real desaparecer.
 *
 * Referência trabalhista mora em `horarios_padrao`. Aqui é contexto. */
import { consultar, consultarUm, executar, emTransacao } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';
import { chaveColaborador } from './heRepository.js';

export const ROTULOS = ['entrada', 'saida', 'destino', 'translado', 'extra', 'outro'];

export const ROTULO_TEXTO = {
  entrada: 'Entrada',
  saida: 'Saída',
  destino: 'Destino',
  translado: 'Translado',
  extra: 'Extra',
  outro: 'Serviço',
};

/* ---------------------------------------------------------------- normalização */

function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizar(s) {
  return semAcento(s).toUpperCase().replace(/\s+/g, ' ').trim();
}

/* Horário em HH:MM. Aceita o que o Excel entrega: `Date`, `time`, texto e o serial de 1900 que
 * aparece quando a jornada atravessa a meia-noite (02:00 gravado como 01/01/1900 02:00). */
export function horaDeCelula(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return `${String(v.getHours()).padStart(2, '0')}:${String(v.getMinutes()).padStart(2, '0')}`;
  }
  const t = String(v).trim();
  const m = t.match(/^(\d{1,2})[:h.](\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 47 || min > 59) return '';
  return `${String(h % 24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/* O rótulo vem da DESCRIÇÃO — é o que a operação escreveu que o serviço é.
 *
 * Note que `entrada`/`saida` aqui descrevem o movimento dos PASSAGEIROS, não do motorista. O nome
 * do rótulo é o da planilha de propósito: renomear para "chegada"/"partida" inventaria vocabulário
 * que a operação não usa. Quem lê a tela vê a mesma palavra que vê no Excel. */
export function rotuloDaDescricao(descricao) {
  const d = normalizar(descricao);
  if (/\bTRANSLADO\b/.test(d)) return 'translado';
  if (/\bDESTINO\b/.test(d)) return 'destino';
  if (/\bENTRADA\b/.test(d)) return 'entrada';
  if (/\bSAIDA\b/.test(d)) return 'saida';
  if (/\bEXTRA\b/.test(d)) return 'extra';
  return 'outro';
}

/* Código da linha/rota: o prefixo antes do primeiro travessão, quando parece um código.
 * "401 - RS 030/ RINCÃO" → "401". "3D - Canoas" → "3D". Sem código reconhecível, devolve ''. */
export function linhaDaDescricao(descricao) {
  const t = String(descricao ?? '').trim();
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9/ºª.-]{0,11})\s*[-–]\s*/);
  if (m) return m[1].trim();
  const linha = t.match(/\bLINHA\s+([A-Za-z0-9]+)/i);
  return linha ? linha[1] : '';
}

/* Horário citado DENTRO da descrição: "(ENTRADA 07:10)" → "07:10". */
export function horaDaDescricao(descricao) {
  const m = String(descricao ?? '').match(/(\d{1,2})[:h](\d{2})/);
  if (!m) return '';
  return `${String(Number(m[1]) % 24).padStart(2, '0')}:${m[2]}`;
}

/* Horário condicional por dia da semana, mantido como TEXTO.
 * "(SAÍDA 18:00/ Sexta 17:00)" → "Sexta 17:00".
 *
 * Não é interpretado. A planilha não define uma regra geral para isso, e inventar uma produziria
 * jornada prevista errada às sextas — exatamente o tipo de heurística silenciosa que esta fase
 * existe para eliminar. */
export function condicionalDaDescricao(descricao) {
  const m = String(descricao ?? '').match(/\/\s*(s[eé]x[a-z]*\.?\s*\d{1,2}[:h]\d{2})/i);
  return m ? m[1].trim() : '';
}

/* "X" ou vazio = a rota existe na estrutura, mas NÃO foi programada naquela data.
 * Não é falta, não é ausência, não é folga — é ausência de programação. */
export function semProgramacao(celula) {
  const t = String(celula ?? '').trim();
  return t === '' || normalizar(t) === 'X';
}

/* Terceirizado: nome no formato "EMPRESA - Pessoa", ou projeção de carro marcada como 3º.
 *
 * Na planilha auditada, TODAS as 31 linhas com nome prefixado estavam no grupo "3º", e NENHUMA
 * das 649 linhas com número de carro próprio tinha nome prefixado. A correlação sustenta a
 * inferência — mas ela continua sendo inferência, e por isso o campo é gravado e exibido, nunca
 * usado para excluir alguém de uma análise em silêncio. */
export function pareceTerceirizado(nome, projecao) {
  if (/\s-\s/.test(String(nome ?? ''))) return true;
  return /^3\s*[ºª°]/.test(String(projecao ?? '').trim());
}

/* A chave que identifica o serviço na data.
 *
 * EMPRESA + HORÁRIO NÃO BASTA: a mesma empresa tem várias linhas saindo no mesmo horário, com
 * motoristas diferentes. A linha e a descrição entram para que três rotas simultâneas continuem
 * sendo três serviços — e para que reimportar não funda uma na outra. */
export function chaveDoServico({ empresa, filial, linha, horario, descricao }) {
  return [
    normalizar(empresa),
    normalizar(filial),
    normalizar(linha),
    horaDeCelula(horario) || normalizar(horario),
    normalizar(descricao),
  ].join('|');
}

const CAMPOS = `id, data, chave_servico AS chaveServico, seq, empresa, filial, linha, descricao,
  horario, horario_descricao AS horarioDescricao, horario_condicional AS horarioCondicional,
  rotulo, projecao_carro AS projecaoCarro, terceirizado,
  colaborador_chave AS colaboradorChave, colaborador_nome AS colaborador,
  colaborador_id AS colaboradorId, origem, importacao_id AS importacaoId,
  criado_em AS criadoEm, atualizado_em AS atualizadoEm, atualizado_por_nome AS atualizadoPor`;

function hidratar(l) {
  if (!l) return null;
  return { ...l, terceirizado: !!l.terceirizado, rotuloTexto: ROTULO_TEXTO[l.rotulo] ?? 'Serviço' };
}

/* ---------------------------------------------------------------- consultas */

export async function listar(tenantId, filtros = {}) {
  const where = ['tenant_id = ?'];
  const args = [tenantId];

  if (filtros.data) { where.push('data = ?'); args.push(filtros.data); }
  if (filtros.de) { where.push('data >= ?'); args.push(filtros.de); }
  if (filtros.ate) { where.push('data <= ?'); args.push(filtros.ate); }
  if (filtros.colaborador) {
    where.push('colaborador_chave = ?');
    args.push(chaveColaborador(filtros.colaborador));
  }
  if (filtros.empresa) { where.push('empresa = ?'); args.push(filtros.empresa); }
  if (filtros.filial) { where.push('filial = ?'); args.push(filtros.filial); }
  if (filtros.linha) { where.push('linha = ?'); args.push(filtros.linha); }
  if (filtros.horario) { where.push('horario = ?'); args.push(filtros.horario); }
  if (filtros.rotulo) { where.push('rotulo = ?'); args.push(filtros.rotulo); }
  if (filtros.busca) {
    where.push('(colaborador_nome LIKE ? OR colaborador_chave LIKE ? OR descricao LIKE ? OR empresa LIKE ? OR linha LIKE ?)');
    const b = `%${filtros.busca}%`;
    args.push(b, `%${chaveColaborador(filtros.busca)}%`, b, b, b);
  }

  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM escala_servicos WHERE ${where.join(' AND ')}
      ORDER BY data DESC, horario ASC, empresa ASC, linha ASC
      LIMIT ?`,
    [...args, Number(filtros.limite) || 500],
  );
  return linhas.map(hidratar);
}

/* A consulta que a operação faz o tempo todo: o dia inteiro de uma pessoa. */
export async function programacaoDoDia(tenantId, colaborador, data) {
  const linhas = await consultar(
    `SELECT ${CAMPOS} FROM escala_servicos
      WHERE tenant_id = ? AND colaborador_chave = ? AND data = ?
      ORDER BY horario ASC, empresa ASC`,
    [tenantId, chaveColaborador(colaborador), data],
  );
  return linhas.map(hidratar);
}

/* Quantos serviços cada pessoa tem no dia — usado como CONTEXTO na análise, em uma consulta só. */
export async function contagemPorColaborador(tenantId, data) {
  const linhas = await consultar(
    `SELECT colaborador_chave AS chave, COUNT(*) AS total FROM escala_servicos
      WHERE tenant_id = ? AND data = ? AND colaborador_chave <> ''
      GROUP BY colaborador_chave`,
    [tenantId, data],
  );
  return new Map(linhas.map((l) => [l.chave, Number(l.total)]));
}

export async function historico(tenantId, servicoId) {
  return consultar(
    `SELECT id, evento, usuario, valor_anterior AS valorAnterior, valor_novo AS valorNovo,
            observacao, importacao_id AS importacaoId, criado_em AS criadoEm
       FROM escala_servicos_historico
      WHERE tenant_id = ? AND servico_id = ? ORDER BY criado_em DESC`,
    [tenantId, servicoId],
  );
}

/* Painel do dia: os números que a tela de Escalas mostra no topo. */
export async function panoramaDoDia(tenantId, data) {
  const [t] = await consultar(
    `SELECT COUNT(*) AS servicos,
            COUNT(DISTINCT colaborador_chave) AS motoristas,
            COUNT(DISTINCT empresa) AS empresas,
            COUNT(DISTINCT linha) AS linhas,
            SUM(terceirizado) AS terceirizados
       FROM escala_servicos WHERE tenant_id = ? AND data = ?`,
    [tenantId, data],
  );

  const porEmpresa = await consultar(
    `SELECT empresa, COUNT(*) AS total FROM escala_servicos
      WHERE tenant_id = ? AND data = ? AND empresa <> ''
      GROUP BY empresa ORDER BY total DESC LIMIT 12`,
    [tenantId, data],
  );

  const porRotulo = await consultar(
    `SELECT rotulo, COUNT(*) AS total FROM escala_servicos
      WHERE tenant_id = ? AND data = ? GROUP BY rotulo ORDER BY total DESC`,
    [tenantId, data],
  );

  return {
    data,
    servicos: Number(t?.servicos ?? 0),
    motoristas: Number(t?.motoristas ?? 0),
    empresas: Number(t?.empresas ?? 0),
    linhas: Number(t?.linhas ?? 0),
    terceirizados: Number(t?.terceirizados ?? 0),
    porEmpresa: porEmpresa.map((e) => ({ empresa: e.empresa, total: Number(e.total) })),
    porRotulo: porRotulo.map((r) => ({ rotulo: r.rotulo, rotuloTexto: ROTULO_TEXTO[r.rotulo] ?? r.rotulo, total: Number(r.total) })),
  };
}

export async function opcoesDeFiltro(tenantId) {
  const [empresas, filiais, linhas, horarios] = await Promise.all([
    consultar("SELECT DISTINCT empresa AS v FROM escala_servicos WHERE tenant_id = ? AND empresa <> '' ORDER BY empresa", [tenantId]),
    consultar("SELECT DISTINCT filial AS v FROM escala_servicos WHERE tenant_id = ? AND filial <> '' ORDER BY filial", [tenantId]),
    consultar("SELECT DISTINCT linha AS v FROM escala_servicos WHERE tenant_id = ? AND linha <> '' ORDER BY linha", [tenantId]),
    consultar("SELECT DISTINCT horario AS v FROM escala_servicos WHERE tenant_id = ? AND horario <> '' ORDER BY horario", [tenantId]),
  ]);
  return {
    empresas: empresas.map((r) => r.v),
    filiais: filiais.map((r) => r.v),
    linhas: linhas.map((r) => r.v),
    horarios: horarios.map((r) => r.v),
    rotulos: ROTULOS.map((r) => ({ valor: r, rotulo: ROTULO_TEXTO[r] })),
  };
}

/* Datas que já têm escala importada. */
export async function datasComEscala(tenantId, limite = 90) {
  const linhas = await consultar(
    `SELECT data, COUNT(*) AS servicos, COUNT(DISTINCT colaborador_chave) AS motoristas
       FROM escala_servicos WHERE tenant_id = ?
      GROUP BY data ORDER BY data DESC LIMIT ?`,
    [tenantId, limite],
  );
  return linhas.map((l) => ({ data: l.data, servicos: Number(l.servicos), motoristas: Number(l.motoristas) }));
}

/* ---------------------------------------------------------------- gravação */

async function registrarHistorico(tx, tenantId, servicoId, evento, d = {}) {
  await tx.executar(
    `INSERT INTO escala_servicos_historico (id, tenant_id, servico_id, evento, usuario, user_id,
       valor_anterior, valor_novo, observacao, importacao_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      novoId('esh'), tenantId, servicoId, evento, d.usuario ?? '', d.userId ?? null,
      d.valorAnterior ?? '', d.valorNovo ?? '', d.observacao ?? '', d.importacaoId ?? null,
      new Date().toISOString(),
    ],
  );
}

/* Grava um lote de serviços de forma IDEMPOTENTE.
 *
 * Três resultados possíveis por serviço:
 *   novo         — não existia
 *   trocado      — existia com OUTRO motorista → troca e registra quem estava antes
 *   sem_mudanca  — existia igual → não escreve nada
 *
 * O terceiro é o que torna reimportar o mesmo arquivo inofensivo: nada muda, nada duplica, e o
 * histórico não ganha uma linha dizendo que houve alteração quando não houve. */
export async function gravarLote(tenantId, servicos, autor = {}, opcoes = {}) {
  if (!servicos.length) return { novos: 0, trocados: 0, atualizados: 0, semMudanca: 0 };

  const agora = new Date().toISOString();
  const importacaoId = opcoes.importacaoId ?? null;

  return emTransacao(async (tx) => {
    let novos = 0; let trocados = 0; let atualizados = 0; let semMudanca = 0;

    for (const s of servicos) {
      const chave = chaveDoServico(s);
      const colabChave = chaveColaborador(s.colaborador);

      const existente = await tx.consultarUm(
        `SELECT id, colaborador_chave, colaborador_nome, seq, projecao_carro, rotulo
           FROM escala_servicos WHERE tenant_id = ? AND data = ? AND chave_servico = ?`,
        [tenantId, s.data, chave],
      );

      if (!existente) {
        const id = novoId('esv');
        await tx.executar(
          `INSERT INTO escala_servicos (id, tenant_id, data, chave_servico, seq, empresa, filial,
             linha, descricao, horario, horario_descricao, horario_condicional, rotulo,
             projecao_carro, terceirizado, colaborador_chave, colaborador_nome, colaborador_id,
             origem, importacao_id, criado_em, atualizado_em, atualizado_por_nome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, tenantId, s.data, chave, String(s.seq ?? ''), s.empresa ?? '', s.filial ?? '',
            s.linha ?? '', s.descricao ?? '', s.horario ?? '', s.horarioDescricao ?? '',
            s.horarioCondicional ?? '', s.rotulo ?? 'outro', s.projecaoCarro ?? '',
            s.terceirizado ? 1 : 0, colabChave, s.colaborador ?? '', s.colaboradorId ?? null,
            opcoes.origem ?? 'importacao', importacaoId, agora, agora, autor.nome ?? '',
          ],
        );
        await registrarHistorico(tx, tenantId, id, 'criado', {
          usuario: autor.nome, userId: autor.id, importacaoId,
          valorNovo: `${s.colaborador ?? '(sem motorista)'} — ${s.horario ?? ''} ${s.descricao ?? ''}`.trim(),
        });
        novos += 1;
        continue;
      }

      if (existente.colaborador_chave === colabChave) {
        semMudanca += 1;
        continue;
      }

      await tx.executar(
        `UPDATE escala_servicos SET colaborador_chave = ?, colaborador_nome = ?, colaborador_id = ?,
                seq = ?, projecao_carro = ?, importacao_id = ?, atualizado_em = ?,
                atualizado_por_nome = ?
          WHERE id = ?`,
        [
          colabChave, s.colaborador ?? '', s.colaboradorId ?? null, String(s.seq ?? ''),
          s.projecaoCarro ?? '', importacaoId, agora, autor.nome ?? '', existente.id,
        ],
      );
      await registrarHistorico(tx, tenantId, existente.id, 'motorista_alterado', {
        usuario: autor.nome, userId: autor.id, importacaoId,
        valorAnterior: existente.colaborador_nome || '(sem motorista)',
        valorNovo: s.colaborador || '(sem motorista)',
        observacao: 'Responsável pelo serviço trocado na reimportação da escala.',
      });
      trocados += 1;
    }

    return { novos, trocados, atualizados, semMudanca };
  });
}

/* Serviços que existiam na data e NÃO vieram no arquivo novo.
 *
 * Não são removidos automaticamente: um arquivo parcial (só uma empresa, só um turno) apagaria o
 * resto do dia sem ninguém pedir. São devolvidos para a prévia mostrar e para quem importa
 * decidir. */
export async function ausentesNoLote(tenantId, data, servicos) {
  const chaves = new Set(servicos.map((s) => chaveDoServico(s)));
  const atuais = await consultar(
    `SELECT ${CAMPOS} FROM escala_servicos WHERE tenant_id = ? AND data = ?`,
    [tenantId, data],
  );
  return atuais.filter((a) => !chaves.has(a.chaveServico)).map(hidratar);
}

export async function remover(tenantId, id, autor = {}) {
  const s = await consultarUm(`SELECT ${CAMPOS} FROM escala_servicos WHERE tenant_id = ? AND id = ?`, [tenantId, id]);
  if (!s) return null;
  await executar('DELETE FROM escala_servicos WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  return hidratar(s);
}
