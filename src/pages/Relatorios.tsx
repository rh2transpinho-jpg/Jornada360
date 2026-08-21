/* Central de Relatórios — escolhe o período, escolhe o relatório, vê na tela e exporta.
 *
 * A tela filtra os dias/pendências pelo período e entrega ao reportService, que monta a tabela.
 * Nenhum número é calculado aqui: o mesmo dado que aparece no Dashboard e nas telas operacionais
 * é o que sai no CSV. */
import { Link } from 'react-router-dom';
import { PainelGerencial } from '../components/relatorios/PainelGerencial';
import { useMemo, useState } from 'react';
import { RefreshCw, Download, FileText, Repeat2 } from 'lucide-react';
import { useHEEngineData } from '../engine/useHEEngineData';
import { useSessao, useWorkspace } from '../workspace/WorkspaceContext';
import { useAppState } from '../state/AppState';
import { cicloKeyFor, cicloLabel, mesLabel, minToStrSigned } from '../engine/heEngineCore';
import {
  RELATORIOS,
  gerarRelatorio,
  tabelaParaCsv,
  nomeArquivoCsv,
  baixarCsv,
  type TipoRelatorio,
  type ContextoRelatorio,
} from '../services/reportService';
import { AmbienteSemDados } from '../components/ui/Indicadores';

type Agrupamento = 'mes' | 'ciclo' | 'tudo';

/* Os 7 relatórios do reportService mapeados para os tipos que o ReportRepository registra no
 * histórico. Vários relatórios caem no mesmo tipo de registro porque o histórico existe para
 * responder "o que foi extraído e quando", não para reproduzir o arquivo. */
const TIPO_REGISTRO: Record<TipoRelatorio, 'diario' | 'horas_extras' | 'divergencias' | 'reincidencia' | 'gerencial'> = {
  pendencias: 'diario',
  horas_extras: 'horas_extras',
  divergencias: 'divergencias',
  colaborador: 'gerencial',
  setor: 'gerencial',
  reincidencia: 'reincidencia',
  auditoria: 'gerencial',
};

export default function Relatorios() {
  const { dias, refresh } = useHEEngineData();
  const { workspace, workspaceIdAtivo, pendencias, repositorios } = useWorkspace();
  const { modo } = useSessao();
  const { auditLog, registrarAuditoria, usuarioAtual } = useAppState();

  const [agrupamento, setAgrupamento] = useState<Agrupamento>('mes');
  const [periodoSelecionado, setPeriodoSelecionado] = useState<string | null>(null);
  const [tipo, setTipo] = useState<TipoRelatorio>('pendencias');

  const periodos = useMemo(() => {
    if (agrupamento === 'tudo') return [] as [string, typeof dias][];
    const chave = (dk: string) => (agrupamento === 'mes' ? dk.slice(0, 7) : cicloKeyFor(dk));
    const map = new Map<string, typeof dias>();
    for (const dia of dias) {
      const k = chave(dia.dateKey);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(dia);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [dias, agrupamento]);

  const chaveAtual = agrupamento === 'tudo' ? null : periodoSelecionado ?? periodos[0]?.[0] ?? null;

  /* Memoizado porque é a raiz de toda a cadeia do relatório: sem isso, um novo array a cada render
   * invalidaria `pendenciasDoPeriodo` → `contexto` → `tabela`, e o relatório inteiro seria gerado
   * de novo a cada digitação ou clique em qualquer lugar da tela. */
  const diasDoPeriodo = useMemo(
    () => (agrupamento === 'tudo' ? dias : periodos.find(([k]) => k === chaveAtual)?.[1] ?? []),
    [agrupamento, dias, periodos, chaveAtual],
  );

  const descricaoFiltro = useMemo(() => {
    if (agrupamento === 'tudo') return `Todo o período processado (${dias.length} dia(s))`;
    if (!chaveAtual) return 'Sem período selecionado';
    const label = agrupamento === 'mes' ? mesLabel(chaveAtual) : cicloLabel(chaveAtual);
    return `${label} (${diasDoPeriodo.length} dia(s) processado(s))`;
  }, [agrupamento, chaveAtual, diasDoPeriodo.length, dias.length]);

  /* As pendências são filtradas pelas MESMAS datas do período selecionado — sem isso, um relatório
   * "de agosto" traria pendências de julho e o total não bateria com o que a tela mostra. */
  const pendenciasDoPeriodo = useMemo(() => {
    const chaves = new Set(diasDoPeriodo.map((d) => d.dateKey));
    return pendencias.filter((p) => chaves.has(p.data));
  }, [pendencias, diasDoPeriodo]);

  const contexto: ContextoRelatorio = useMemo(
    () => ({
      nomeEmpresa: workspace.company.nome || workspace.id,
      dias: diasDoPeriodo,
      pendencias: pendenciasDoPeriodo,
      /* A auditoria não tem data de dia processado — é sempre a trilha inteira do workspace. O
       * escopo do relatório diz isso explicitamente para não parecer filtrada pelo período. */
      auditoria: auditLog,
      usuarios: workspace.users,
      recurrenceLimit: workspace.rules.recurrenceLimit,
      alertaAntecedenciaDias: workspace.rules.alertaAntecedenciaDias,
      descricaoFiltro: tipo === 'auditoria' ? 'Trilha completa da empresa (não filtrada por período)' : descricaoFiltro,
    }),
    [workspace, diasDoPeriodo, pendenciasDoPeriodo, auditLog, descricaoFiltro, tipo],
  );

  const tabela = useMemo(() => gerarRelatorio(tipo, contexto), [tipo, contexto]);
  const definicao = RELATORIOS.find((r) => r.tipo === tipo)!;

  const totalHE = diasDoPeriodo.reduce((s, d) => s + d.totalHEAtual, 0);
  const totalPendentes = diasDoPeriodo.reduce((s, d) => s + d.pendentes, 0);

  /* Exportar é a única ação que o SERVIDOR não consegue observar sozinho: o CSV é gerado no
   * navegador. Por isso o registro é pedido explicitamente — mas o AUTOR continua vindo da sessão;
   * o cliente só descreve o que exportou. Levar dado de uma empresa para fora merece constar na
   * trilha tanto quanto alterá-lo. */
  function exportar() {
    const csv = tabelaParaCsv(tabela, contexto.nomeEmpresa);
    baixarCsv(csv, nomeArquivoCsv(tipo, contexto.nomeEmpresa));
    void repositorios
      .registrarExportacao(workspaceIdAtivo, TIPO_REGISTRO[tipo], contexto.descricaoFiltro)
      .catch(() => {
        /* O arquivo já foi entregue; não registrar a exportação não deve parecer uma falha do
         * download. A ausência do registro fica visível na própria trilha. */
      });
    registrarAuditoria({
      usuario: usuarioAtual,
      entidade: `Relatório: ${definicao.titulo}`,
      acao: 'Relatório exportado',
      valorAnterior: '—',
      valorNovo: `${tabela.linhas.length} linha(s)`,
      motivo: `Exportação em CSV — ${contexto.descricaoFiltro}.`,
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Relatórios</h1>
          <p className="page-subtitle">Escolha o período e o relatório — o mesmo dado das telas, pronto para exportar</p>
        </div>
        <div className="acoes-topo">
          {/* O Ranking saiu do menu principal quando a reincidência virou informação transversal
              (ela aparece dentro de cada ocorrência). Mas a visão consolidada continua valendo, e
              é aqui — ao lado da análise agregada — que alguém pensa em pedi-la. */}
          <Link className="btn" to="/reincidencia">
            <Repeat2 size={14} />
            Ranking de Reincidência
          </Link>
          <button className="btn" onClick={refresh}>
            <RefreshCw size={14} />
            Atualizar
          </button>
        </div>
      </div>

      {dias.length === 0 ? (
        <div className="card card-pad">
          <AmbienteSemDados />
        </div>
      ) : (
        <>
          {/* ---------------------------------------- período */}
          <div className="card card-pad section-gap">
            <div className="card-title">Período</div>
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              <div className="filter-pill">
                <button
                  className={agrupamento === 'mes' ? 'active' : ''}
                  onClick={() => {
                    setAgrupamento('mes');
                    setPeriodoSelecionado(null);
                  }}
                >
                  Por mês
                </button>
                <button
                  className={agrupamento === 'ciclo' ? 'active' : ''}
                  onClick={() => {
                    setAgrupamento('ciclo');
                    setPeriodoSelecionado(null);
                  }}
                >
                  Por ciclo (28–27)
                </button>
                <button className={agrupamento === 'tudo' ? 'active' : ''} onClick={() => setAgrupamento('tudo')}>
                  Todo o período
                </button>
              </div>

              {agrupamento !== 'tudo' && (
                <select className="select" value={chaveAtual ?? ''} onChange={(e) => setPeriodoSelecionado(e.target.value)}>
                  {periodos.map(([k]) => (
                    <option key={k} value={k}>
                      {agrupamento === 'mes' ? mesLabel(k) : cicloLabel(k)}
                    </option>
                  ))}
                </select>
              )}

              <div className="spacer" />
              <span className="text-faint" style={{ fontSize: 12.5 }}>
                {descricaoFiltro}
              </span>
            </div>

            <div className="kpi-grid" style={{ marginTop: 14 }}>
              <div className="kpi-card">
                <div className="kpi-label">HE1 no período</div>
                <div className="kpi-value">{minToStrSigned(totalHE)}</div>
                <div className="kpi-foot">{diasDoPeriodo.length} dia(s) processado(s)</div>
              </div>
              <div className={`kpi-card${totalPendentes ? ' accent-red' : ''}`}>
                <div className="kpi-label">Pendentes no período</div>
                <div className="kpi-value">{totalPendentes}</div>
                <div className="kpi-foot">ainda sem tratamento</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Pendências registradas</div>
                <div className="kpi-value">{pendenciasDoPeriodo.length}</div>
                <div className="kpi-foot">no recorte selecionado</div>
              </div>
            </div>
          </div>

          {/* ---------------------------------------- escolha do relatório */}
          <div className="card card-pad section-gap">
            <div className="card-title">Relatório</div>
            <div className="relatorio-grid">
              {RELATORIOS.map((r) => (
                <button key={r.tipo} className={`relatorio-opcao ${tipo === r.tipo ? 'ativo' : ''}`} onClick={() => setTipo(r.tipo)}>
                  <FileText size={15} />
                  <div>
                    <div className="relatorio-titulo">{r.titulo}</div>
                    <div className="relatorio-descricao">{r.descricao}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* ---------------------------------------- resultado */}
          <div className="card card-pad">
            <div className="card-title">
              <span>{tabela.titulo}</span>
              <button className="btn btn-primary btn-sm" onClick={exportar} disabled={tabela.linhas.length === 0}>
                <Download size={13} />
                Exportar CSV
              </button>
            </div>
            <div className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
              {tabela.escopo} · {tabela.linhas.length} linha(s)
            </div>

            {tabela.linhas.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px 12px' }}>
                Não há dados para este relatório no período selecionado.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      {tabela.colunas.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tabela.linhas.slice(0, 100).map((linha, i) => (
                      <tr key={i}>
                        {linha.map((celula, j) => (
                          <td key={j} className={j === 0 ? 'cell-strong' : undefined}>
                            {String(celula)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tabela.linhas.length > 100 && (
              <div className="text-faint" style={{ fontSize: 12, marginTop: 10 }}>
                Mostrando as primeiras 100 linhas. O arquivo exportado contém todas as {tabela.linhas.length}.
              </div>
            )}
          </div>
        </>
      )}

      {/* O resumo do período e a leitura gerencial ficam AQUI, e não numa tela própria: quem abre
          Relatórios já veio perguntar "como foi o período". Uma tela separada para a mesma
          pergunta dividiria a resposta em dois lugares. Só aparece no modo remoto — os números
          vêm da análise do servidor. */}
      {modo === 'remoto' && workspaceIdAtivo && <PainelGerencial tenantId={workspaceIdAtivo} />}
    </>
  );
}
