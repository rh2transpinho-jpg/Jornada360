/* Importação da escala operacional: prévia e confirmação.
 *
 * DOIS PASSOS, SEMPRE
 * -------------------
 * `prever()` calcula o que aconteceria e não grava nada. `confirmar()` grava. A escala de um dia
 * já analisado é o contexto de horas extras que já foram justificadas — trocá-la em silêncio muda
 * o que alguém vai ler amanhã sem que ninguém tenha visto a mudança.
 *
 * O QUE A PRÉVIA PRECISA RESPONDER
 * --------------------------------
 *   quantos serviços entram, quantos trocam de motorista, quantos ficam iguais;
 *   quais nomes da planilha não batem com o cadastro;
 *   quais serviços existiam na data e NÃO vieram no arquivo.
 *
 * O último item não vira remoção automática: um arquivo parcial (uma empresa só, um turno só)
 * apagaria o resto do dia sem ninguém pedir. É informado e a decisão fica com quem importa. */
import { consultar, executar } from '../db/index.js';
import { novoId } from '../lib/seguranca.js';
import { chaveColaborador } from '../repositories/heRepository.js';
import * as servicos from '../repositories/escalaServicoRepository.js';
import * as processamento from './processamento.js';

/* Nomes que o sistema já conhece: cadastro de colaboradores e quem já apareceu em jornada.
 *
 * NÃO existe casamento por aproximação. "ANDREIA MERCEDES" e "ANDRÉIA MERCEDES" batem porque a
 * chave normaliza acento; "ANDREIA M." e "ANDREIA MERCEDES" NÃO batem, e é isso que se quer — um
 * palpite silencioso aqui atribui o serviço de uma pessoa a outra. */
async function nomesConhecidos(tenantId) {
  const [empregados, jornadas, jaImportados] = await Promise.all([
    consultar('SELECT nome FROM employees WHERE tenant_id = ?', [tenantId]),
    consultar('SELECT DISTINCT colaborador_nome AS nome FROM he_ocorrencias WHERE tenant_id = ?', [tenantId]),
    consultar("SELECT DISTINCT colaborador_nome AS nome FROM escala_servicos WHERE tenant_id = ? AND colaborador_nome <> ''", [tenantId]),
  ]);
  const set = new Set();
  for (const l of [...empregados, ...jornadas, ...jaImportados]) {
    const c = chaveColaborador(l.nome);
    if (c) set.add(c);
  }
  return set;
}

function validar(s) {
  const problemas = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.data ?? ''))) {
    problemas.push({ tipo: 'data_invalida', mensagem: `Data inválida: "${s.data ?? ''}".` });
  }
  if (!String(s.colaborador ?? '').trim()) {
    problemas.push({ tipo: 'sem_motorista', mensagem: 'Serviço sem motorista atribuído.' });
  }
  if (!String(s.descricao ?? '').trim() && !String(s.linha ?? '').trim()) {
    problemas.push({ tipo: 'sem_identificacao', mensagem: 'Serviço sem descrição nem linha — não dá para identificá-lo.' });
  }
  return problemas;
}

export async function prever(tenantId, lista = []) {
  const conhecidos = await nomesConhecidos(tenantId);

  const porData = new Map();
  const desconhecidos = new Map();
  const chavesVistas = new Map();

  let novos = 0; let trocados = 0; let semMudanca = 0; let comProblema = 0; let duplicados = 0;

  const itens = [];

  for (let i = 0; i < lista.length; i += 1) {
    const s = lista[i];
    const problemas = validar(s);
    const chave = servicos.chaveDoServico(s);
    const colabChave = chaveColaborador(s.colaborador);

    /* Duas linhas do MESMO arquivo para o mesmo serviço na mesma data. É erro de planilha —
     * gravar as duas faria uma sobrescrever a outra em ordem arbitrária. */
    const dedupe = `${s.data}|${chave}`;
    if (chavesVistas.has(dedupe)) {
      problemas.push({
        tipo: 'duplicado_no_arquivo',
        mensagem: `Serviço repetido na linha ${chavesVistas.get(dedupe) + 1} do arquivo.`,
      });
      duplicados += 1;
    } else {
      chavesVistas.set(dedupe, i);
    }

    if (colabChave && !conhecidos.has(colabChave)) {
      /* AVISO, não erro: o serviço é importado do mesmo jeito. A escala é a fonte de quem opera,
       * e recusar o serviço porque a pessoa ainda não foi cadastrada esvaziaria a escala. Mas o
       * nome aparece na prévia para conferência — sem casamento por aproximação. */
      problemas.push({
        tipo: 'motorista_nao_cadastrado', aviso: true,
        mensagem: `"${s.colaborador}" não consta no cadastro nem em jornadas já processadas.`,
      });
      if (!desconhecidos.has(colabChave)) desconhecidos.set(colabChave, s.colaborador);
    }

    const existente = problemas.some((p) => !p.aviso) ? null : await consultarServico(tenantId, s.data, chave);

    let acao;
    if (problemas.some((p) => !p.aviso)) { acao = 'erro'; comProblema += 1; }
    else if (!existente) { acao = 'novo'; novos += 1; }
    else if (existente.colaborador_chave === colabChave) { acao = 'sem_mudanca'; semMudanca += 1; }
    else { acao = 'troca_motorista'; trocados += 1; }

    if (!porData.has(s.data)) porData.set(s.data, { data: s.data, servicos: 0, motoristas: new Set() });
    const d = porData.get(s.data);
    d.servicos += 1;
    if (colabChave) d.motoristas.add(colabChave);

    /* A prévia não devolve 15 mil linhas: guarda as primeiras para exibição e conta o resto. */
    if (itens.length < 300) {
      itens.push({
        linha: i + 1,
        data: s.data, empresa: s.empresa ?? '', filial: s.filial ?? '', linha_rota: s.linha ?? '',
        horario: s.horario ?? '', descricao: s.descricao ?? '', rotulo: s.rotulo ?? 'outro',
        colaborador: s.colaborador ?? '', terceirizado: !!s.terceirizado,
        acao,
        anterior: existente ? { colaborador: existente.colaborador_nome } : null,
        problemas,
      });
    }
  }

  const datas = [...porData.values()].map((d) => ({
    data: d.data, servicos: d.servicos, motoristas: d.motoristas.size,
  })).sort((a, b) => a.data.localeCompare(b.data));

  /* Serviços que existiam nas datas do arquivo e não vieram nele. */
  const ausentes = [];
  for (const d of datas) {
    const doDia = lista.filter((s) => s.data === d.data);
    const faltando = await servicos.ausentesNoLote(tenantId, d.data, doDia);
    if (faltando.length) ausentes.push({ data: d.data, total: faltando.length, exemplos: faltando.slice(0, 5) });
  }

  return {
    total: lista.length,
    novos,
    trocados,
    semMudanca,
    comProblema,
    duplicados,
    datas,
    motoristasNaoCadastrados: [...desconhecidos.values()].sort(),
    ausentesNoArquivo: ausentes,
    itens,
    itensOmitidos: Math.max(0, lista.length - itens.length),
  };
}

async function consultarServico(tenantId, data, chave) {
  const [r] = await consultar(
    'SELECT id, colaborador_chave, colaborador_nome FROM escala_servicos WHERE tenant_id = ? AND data = ? AND chave_servico = ?',
    [tenantId, data, chave],
  );
  return r ?? null;
}

export async function confirmar(tenantId, lista = [], autor = {}, meta = {}) {
  const previa = await prever(tenantId, lista);
  const validos = lista.filter((s) => validar(s).length === 0);

  const importacaoId = novoId('imp');
  const agora = new Date().toISOString();

  await executar(
    `INSERT INTO escala_importacoes (id, tenant_id, arquivo, formato, total_linhas, criadas,
       atualizadas, ignoradas, problemas_json, status, criado_em, criado_por_nome)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, '[]', 'concluida', ?, ?)`,
    [importacaoId, tenantId, meta.arquivo ?? '', meta.formato ?? '', lista.length, agora, autor.nome ?? ''],
  );

  const r = await servicos.gravarLote(tenantId, validos, autor, { importacaoId, origem: 'importacao' });

  await executar(
    'UPDATE escala_importacoes SET criadas = ?, atualizadas = ?, ignoradas = ? WHERE id = ?',
    [r.novos, r.trocados, lista.length - validos.length, importacaoId],
  );

  /* A escala é CONTEXTO: mudar quem opera não muda jornada nenhuma. Mas a análise guarda a
   * contagem de serviços do dia, e ela precisa acompanhar — por isso os dias tocados são
   * reprocessados. O reprocessamento preserva justificativa, responsável e histórico (ver
   * heRepository); é a mesma garantia da fase anterior, e há teste. */
  const datas = [...new Set(validos.map((s) => s.data))].sort();
  const reprocesso = datas.length
    ? await processamento.reprocessarPeriodo(tenantId, datas[0], datas[datas.length - 1])
    : { dias: 0, resolvidas: 0 };

  return { importacaoId, ...r, recusados: lista.length - validos.length, previa, reprocesso };
}
