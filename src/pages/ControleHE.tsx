/* Controle de Horas Extras — gestão por exceção.
 *
 * A pergunta que esta tela responde em segundos é a que motivou a funcionalidade:
 * "o Alex fez hora extra no dia 22/07 — qual foi a justificativa daquele dia?"
 *
 * POR QUE NÃO É SÓ UMA TABELA: uma lista com todas as horas extras do mês trata igualmente o que
 * já foi resolvido e o que ninguém olhou. Quem abre esta área precisa ver primeiro o que exige
 * ação. Daí a ordem por atenção (ver heService.pesoDeAtencao), os filtros rápidos e o destaque
 * para recálculo.
 *
 * NENHUM CÁLCULO ACONTECE AQUI. Minutos, excedente e valor anterior vêm prontos do servidor;
 * esta tela apresenta e opera. Ver src/api/heService.ts.
 *
 * A GARANTIA DO REPROCESSAMENTO É RESPEITADA PELA INTERFACE: o formulário de análise escreve
 * apenas motivo, justificativa, origem, responsável e observação. Ele nunca envia minutos, e por
 * isso não tem como sobrescrever o que o motor calculou — nem o contrário. */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Clock, Download, FileText, History,
  RefreshCw, Search, ShieldCheck, User,
} from 'lucide-react';
import { useSessao } from '../workspace/WorkspaceContext';
import { useRecurso, useGravacao } from '../data/useRecurso';
import { Carregando, ErroAoCarregar, FeedbackGravacao } from '../components/ui/EstadosAsync';
import { AmbienteSemDados } from '../components/ui/Indicadores';
import { initials } from '../utils/text';
import {
  dataBr, diasParado, listarOcorrencias, listasConfiguraveis, minutosParaHoras,
  obterOcorrencia, obterResumo, pesoDeAtencao, registrarJustificativa, ROTULO_SITUACAO,
  urlRelatorioCsv, type DetalheHE, type FiltrosHE, type OcorrenciaHE, type SituacaoHE,
} from '../api/heService';

type FiltroRapido = 'atencao' | 'pendente' | 'recalculada' | 'justificada' | 'todas';

const FILTROS_RAPIDOS: { id: FiltroRapido; rotulo: string }[] = [
  { id: 'atencao', rotulo: 'Precisa de análise' },
  { id: 'recalculada', rotulo: 'Recalculadas' },
  { id: 'pendente', rotulo: 'Sem justificativa' },
  { id: 'justificada', rotulo: 'Tratadas' },
  { id: 'todas', rotulo: 'Todas' },
];

const CLASSE_SITUACAO: Record<SituacaoHE, string> = {
  pendente: 'badge-orange',
  justificada: 'badge-green',
  nao_autorizada: 'badge-red',
  em_analise: 'badge-blue',
  abonada: 'badge-green',
};

export default function ControleHE() {
  const { workspaceIdAtivo, pode, modo } = useSessao();
  const tenantId = workspaceIdAtivo ?? '';

  const [busca, setBusca] = useState('');
  const [rapido, setRapido] = useState<FiltroRapido>('atencao');
  const [periodo, setPeriodo] = useState<{ de: string; ate: string }>({ de: '', ate: '' });
  const [selecionada, setSelecionada] = useState<string | null>(null);

  /* Os filtros que o SERVIDOR resolve viajam na consulta; os que são só de apresentação
   * (situação combinada, "recalculadas") são aplicados sobre o resultado. Mandar tudo para o
   * servidor exigiria uma linguagem de filtro; resolver tudo aqui traria a empresa inteira para
   * o navegador. A divisão é essa. */
  const filtrosServidor: FiltrosHE = useMemo(
    () => ({ busca: busca.trim() || undefined, de: periodo.de || undefined, ate: periodo.ate || undefined }),
    [busca, periodo],
  );

  const chaveFiltros = JSON.stringify(filtrosServidor);

  const lista = useRecurso<OcorrenciaHE[]>(
    () => listarOcorrencias(tenantId, filtrosServidor),
    [tenantId, chaveFiltros],
    { habilitado: !!tenantId && modo === 'remoto' },
  );

  const resumo = useRecurso(
    () => obterResumo(tenantId, filtrosServidor),
    [tenantId, chaveFiltros],
    { habilitado: !!tenantId && modo === 'remoto' },
  );

  const ocorrencias = useMemo(() => {
    const todas = lista.dados ?? [];
    const filtrada = todas.filter((o) => {
      if (rapido === 'todas') return true;
      if (rapido === 'pendente') return o.status === 'pendente';
      if (rapido === 'recalculada') return !!o.recalculadaEm;
      if (rapido === 'justificada') return o.status !== 'pendente';
      /* 'atencao' = o que exige alguém: sem justificativa, em análise, ou recalculada depois de
       * já ter sido analisada. */
      return o.status === 'pendente' || o.status === 'em_analise' || !!o.recalculadaEm;
    });
    return [...filtrada].sort((a, b) => pesoDeAtencao(b) - pesoDeAtencao(a));
  }, [lista.dados, rapido]);

  const recalculadas = (lista.dados ?? []).filter((o) => o.recalculadaEm).length;

  /* Um resultado vazio só significa "empresa sem dados" se nada estiver filtrando. */
  const temFiltro = !!(filtrosServidor.busca || filtrosServidor.de || filtrosServidor.ate) || rapido !== 'todas';

  const limparFiltros = useCallback(() => {
    setBusca('');
    setPeriodo({ de: '', ate: '' });
    setRapido('todas');
  }, []);

  const recarregar = useCallback(() => {
    void lista.recarregar();
    void resumo.recarregar();
  }, [lista, resumo]);

  /* A demonstração é local e não tem servidor de HE. Dizer isso é melhor do que mostrar uma tela
   * vazia que parece defeito. */
  if (modo !== 'remoto') {
    return (
      <>
        <div className="page-header">
          <div>
            <h1 className="page-title">Controle de Horas Extras</h1>
            <p className="page-subtitle">Ocorrências identificadas pelo motor de jornada</p>
          </div>
        </div>
        <div className="card card-pad">
          <p className="text-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            O controle de horas extras trabalha sobre os dados guardados no servidor da sua empresa.
            A demonstração é local, então esta área fica disponível quando você entra numa empresa real.
          </p>
        </div>
      </>
    );
  }

  if (lista.erro) {
    return (
      <div className="card card-pad">
        <ErroAoCarregar erro={lista.erro} aoTentar={recarregar} />
      </div>
    );
  }

  if (lista.primeiraCarga) return <Carregando texto="Carregando ocorrências…" />;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Controle de Horas Extras</h1>
          <p className="page-subtitle">
            Cada hora extra identificada, com a justificativa de quem a analisou
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {pode('relatorio:exportar') && (
            <a className="btn" href={urlRelatorioCsv(tenantId, filtrosServidor)} download>
              <Download size={14} /> Exportar
            </a>
          )}
          <button className="btn" onClick={recarregar}>
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {/* O indicador que importa vem primeiro: quanto de hora extra ainda não tem explicação. */}
      <div className="kpi-grid">
        <div className={`kpi-card ${(resumo.dados?.ocorrenciasPendentes ?? 0) > 0 ? 'kpi-card--alerta' : ''}`}>
          <div className="kpi-label">Sem justificativa</div>
          <div className="kpi-value">{minutosParaHoras(resumo.dados?.minutosPendentes ?? 0)}</div>
          <div className="kpi-foot">{resumo.dados?.ocorrenciasPendentes ?? 0} ocorrência(s) aguardando</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">HE no período</div>
          <div className="kpi-value">{minutosParaHoras(resumo.dados?.minutos ?? 0)}</div>
          <div className="kpi-foot">{resumo.dados?.ocorrencias ?? 0} ocorrência(s)</div>
        </div>
        <div className={`kpi-card ${recalculadas > 0 ? 'kpi-card--atencao' : ''}`}>
          <div className="kpi-label">Recalculadas após análise</div>
          <div className="kpi-value">{recalculadas}</div>
          <div className="kpi-foot">o número mudou depois da justificativa</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Colaboradores</div>
          <div className="kpi-value">{resumo.dados?.colaboradores ?? 0}</div>
          <div className="kpi-foot">com hora extra no período</div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="toolbar he-toolbar">
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-faint)' }} />
            <input
              className="input"
              style={{ paddingLeft: 30, width: 250 }}
              placeholder="Colaborador, data ou motivo…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>

          <input
            className="input" type="date" aria-label="De"
            value={periodo.de} onChange={(e) => setPeriodo((p) => ({ ...p, de: e.target.value }))}
          />
          <input
            className="input" type="date" aria-label="Até"
            value={periodo.ate} onChange={(e) => setPeriodo((p) => ({ ...p, ate: e.target.value }))}
          />

          <div className="spacer" />
          <span className="text-faint" style={{ fontSize: 12.5 }}>{ocorrencias.length} na lista</span>
        </div>

        <div className="he-chips">
          {FILTROS_RAPIDOS.map((f) => (
            <button
              key={f.id}
              className={`he-chip ${rapido === f.id ? 'he-chip--ativo' : ''}`}
              onClick={() => setRapido(f.id)}
            >
              {f.rotulo}
            </button>
          ))}
        </div>

        {ocorrencias.length === 0 ? (
          <div style={{ padding: '28px 4px' }}>
            {/* "Ambiente sem dados" SÓ quando nenhum filtro está ativo.
             *
             * `lista.dados` já vem filtrada pelo servidor: uma pesquisa que não casa devolve lista
             * vazia mesmo numa empresa cheia. Sem esta condição, quem pesquisava um nome inexistente
             * lia "Seu ambiente ainda não possui dados" e um convite para importar tudo de novo —
             * a tela dizia que os dados sumiram quando só a busca não tinha casado. */}
            {temFiltro ? (
              <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
                {filtrosServidor.busca
                  ? `Nenhuma ocorrência corresponde a “${filtrosServidor.busca}” nos filtros atuais.`
                  : 'Nenhuma ocorrência no período e situação selecionados.'}{' '}
                <button type="button" className="link-inline" onClick={limparFiltros}>
                  Limpar filtros
                </button>
              </p>
            ) : (
              <AmbienteSemDados />
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Colaborador</th>
                  <th>Escala</th>
                  <th>HE</th>
                  <th>Situação</th>
                  <th>Motivo</th>
                  <th>Responsável</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ocorrencias.map((o) => (
                  <tr key={o.id} className={o.status === 'pendente' ? 'he-linha--pendente' : ''}>
                    <td className="mono">{dataBr(o.data)}</td>
                    <td>
                      <div className="name-cell">
                        <span className="avatar">{initials(o.colaborador)}</span>
                        <span className="cell-strong">{o.colaborador}</span>
                      </div>
                    </td>
                    <td className="cell-muted mono">{o.escalaPrevista || '—'}</td>
                    <td className="mono">
                      <b>{minutosParaHoras(o.heMin)}</b>
                      {o.recalculadaEm && o.heMinAnterior !== null && (
                        <span className="he-antes" title="O motor recalculou este dia depois da análise">
                          antes {minutosParaHoras(o.heMinAnterior)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${CLASSE_SITUACAO[o.status]}`}>{ROTULO_SITUACAO[o.status]}</span>
                      {o.status === 'pendente' && diasParado(o.criadaEm) >= 7 && (
                        <span className="he-parado">há {diasParado(o.criadaEm)} dias</span>
                      )}
                    </td>
                    <td className="cell-muted">{o.motivo ?? '—'}</td>
                    <td className="cell-muted">{o.responsavel ?? '—'}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => setSelecionada(o.id)}>Abrir</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selecionada && (
        <PainelOcorrencia
          tenantId={tenantId}
          id={selecionada}
          podeTratar={pode('pendencia:tratar')}
          aoFechar={() => setSelecionada(null)}
          aoSalvar={() => {
            recarregar();
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- detalhe */

function PainelOcorrencia({
  tenantId, id, podeTratar, aoFechar, aoSalvar,
}: {
  tenantId: string;
  id: string;
  podeTratar: boolean;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const detalhe = useRecurso<DetalheHE>(() => obterOcorrencia(tenantId, id), [tenantId, id]);
  const listas = useRecurso(() => listasConfiguraveis(tenantId), [tenantId]);
  const gravacao = useGravacao();

  const o = detalhe.dados;

  const [form, setForm] = useState<{ status: SituacaoHE; motivo: string; justificativa: string; origem: string; quemInformou: string; quemSolicitou: string; observacoes: string } | null>(null);

  /* O formulário nasce com o que já foi registrado — editar uma justificativa não pode obrigar a
   * pessoa a reescrever tudo do zero. */
  const formAtual = form ?? {
    status: (o?.status === 'pendente' ? 'justificada' : o?.status ?? 'justificada') as SituacaoHE,
    motivo: o?.motivo ?? '',
    justificativa: o?.justificativa ?? '',
    origem: o?.origem ?? '',
    quemInformou: o?.quemInformou ?? '',
    quemSolicitou: o?.quemSolicitou ?? '',
    observacoes: o?.observacoes ?? '',
  };

  function campo<K extends keyof typeof formAtual>(chave: K, valor: (typeof formAtual)[K]) {
    setForm({ ...formAtual, [chave]: valor });
  }

  async function salvar() {
    if (!formAtual.motivo || !formAtual.justificativa.trim()) return;
    const r = await gravacao.executar(() => registrarJustificativa(tenantId, id, formAtual));
    if (r) {
      setForm(null);
      await detalhe.recarregar();
      aoSalvar();
    }
  }

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside className="he-painel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Detalhe da ocorrência">
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><ArrowLeft size={14} /> Voltar</button>
          {o && <span className={`badge ${CLASSE_SITUACAO[o.status]}`}>{ROTULO_SITUACAO[o.status]}</span>}
        </header>

        {detalhe.erro ? (
          <div style={{ padding: 20 }}><ErroAoCarregar erro={detalhe.erro} aoTentar={() => void detalhe.recarregar()} /></div>
        ) : !o ? (
          <Carregando texto="Abrindo ocorrência…" />
        ) : (
          <div className="he-painel__corpo">
            <div className="he-painel__cabecalho">
              <span className="avatar avatar-lg">{initials(o.colaborador)}</span>
              <div>
                <h2 className="he-painel__nome">{o.colaborador}</h2>
                <p className="he-painel__data">{dataBr(o.data)}{o.setor ? ` · ${o.setor}` : ''}</p>
              </div>
            </div>

            {/* O recálculo é dito em destaque: alguém decidiu com base num número que mudou. */}
            {o.recalculadaEm && o.heMinAnterior !== null && (
              <div className="he-aviso-recalculo">
                <AlertTriangle size={16} aria-hidden />
                <div>
                  <b>A jornada foi reprocessada depois da análise.</b>
                  <div>
                    A hora extra passou de <b className="mono">{minutosParaHoras(o.heMinAnterior)}</b> para{' '}
                    <b className="mono">{minutosParaHoras(o.heMin)}</b>
                    {' '}(diferença de <span className="mono">{minutosParaHoras(o.heMin - o.heMinAnterior)}</span>).
                    A justificativa registrada foi preservada — confira se ela ainda explica o novo valor.
                  </div>
                </div>
              </div>
            )}

            <section className="he-secao">
              <h3 className="he-secao__titulo"><Clock size={13} /> Jornada</h3>
              <dl className="he-campos">
                <div><dt>Escala prevista</dt><dd className="mono">{o.escalaPrevista || '—'}</dd></div>
                <div><dt>Jornada realizada</dt><dd className="mono">{o.jornadaRealizada || '—'}</dd></div>
                <div><dt>Hora extra</dt><dd className="mono"><b>{minutosParaHoras(o.heMin)}</b></dd></div>
                <div><dt>Excedente ao padrão</dt><dd className="mono">{minutosParaHoras(o.excedenteMin)}</dd></div>
                {o.batidas && <div><dt>Batidas</dt><dd className="mono">{o.batidas}</dd></div>}
              </dl>
            </section>

            <section className="he-secao">
              <h3 className="he-secao__titulo"><FileText size={13} /> Análise</h3>

              {o.justificativa && !form && (
                <div className="he-justificativa-atual">
                  <div className="he-justificativa-atual__motivo">{o.motivo}</div>
                  <p>{o.justificativa}</p>
                  {/* A observação é escrita à mão e costuma ser o que explica o caso difícil —
                      quem lê o registro pronto precisa vê-la sem abrir o formulário de edição. */}
                  {o.observacoes && <p className="he-justificativa-atual__obs">{o.observacoes}</p>}
                  <div className="he-justificativa-atual__rodape">
                    {o.responsavel && <span><User size={12} /> {o.responsavel}</span>}
                    {o.origem && <span>Origem: {o.origem}</span>}
                    {/* "Supervisor" diz de onde veio; o nome diz a QUEM voltar para confirmar. */}
                    {o.quemInformou && <span>Informado por: {o.quemInformou}</span>}
                    {o.quemSolicitou && <span>Solicitado por: {o.quemSolicitou}</span>}
                    {o.justificadaEm && <span>{new Date(o.justificadaEm).toLocaleString('pt-BR')}</span>}
                  </div>
                </div>
              )}

              {podeTratar ? (
                <div className="he-form">
                  <label className="field-label" htmlFor="he-situacao">Situação</label>
                  <select
                    id="he-situacao" className="input"
                    value={formAtual.status}
                    onChange={(e) => campo('status', e.target.value as SituacaoHE)}
                  >
                    {(Object.keys(ROTULO_SITUACAO) as SituacaoHE[]).map((s) => (
                      <option key={s} value={s}>{ROTULO_SITUACAO[s]}</option>
                    ))}
                  </select>

                  <label className="field-label" htmlFor="he-motivo">Motivo</label>
                  <select
                    id="he-motivo" className="input"
                    value={formAtual.motivo}
                    onChange={(e) => campo('motivo', e.target.value)}
                  >
                    <option value="">Selecione…</option>
                    {(listas.dados?.motivos ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>

                  <label className="field-label" htmlFor="he-just">Justificativa</label>
                  <textarea
                    id="he-just" className="input"
                    style={{ minHeight: 88, resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="O que aconteceu naquele dia?"
                    value={formAtual.justificativa}
                    onChange={(e) => campo('justificativa', e.target.value)}
                  />

                  <div className="he-form__linha">
                    <div>
                      <label className="field-label" htmlFor="he-origem">Origem da informação</label>
                      <select
                        id="he-origem" className="input"
                        value={formAtual.origem}
                        onChange={(e) => campo('origem', e.target.value)}
                      >
                        <option value="">—</option>
                        {(listas.dados?.origens ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="field-label" htmlFor="he-informou">Quem informou</label>
                      <input
                        id="he-informou" className="input"
                        value={formAtual.quemInformou}
                        onChange={(e) => campo('quemInformou', e.target.value)}
                      />
                    </div>
                  </div>

                  <label className="field-label" htmlFor="he-obs">Observações</label>
                  <input
                    id="he-obs" className="input"
                    value={formAtual.observacoes}
                    onChange={(e) => campo('observacoes', e.target.value)}
                  />

                  <div className="he-form__acoes">
                    <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} aoRecarregar={() => void detalhe.recarregar()} />
                    <div className="spacer" />
                    <button
                      className="btn btn-primary"
                      onClick={salvar}
                      disabled={gravacao.estado === 'salvando' || !formAtual.motivo || !formAtual.justificativa.trim()}
                    >
                      {o.justificativa ? 'Atualizar análise' : 'Registrar justificativa'}
                    </button>
                  </div>

                  <p className="he-nota">
                    <ShieldCheck size={12} /> O responsável é você — vem da sua sessão, não deste formulário.
                  </p>
                </div>
              ) : (
                !o.justificativa && (
                  <p className="text-muted" style={{ fontSize: 13 }}>
                    Esta ocorrência ainda não foi justificada. Seu perfil não permite registrar a análise.
                  </p>
                )
              )}
            </section>

            <section className="he-secao">
              <h3 className="he-secao__titulo"><History size={13} /> Histórico</h3>
              <ol className="he-linha-tempo">
                {o.historico.map((h) => (
                  <li key={h.id}>
                    <div className="he-linha-tempo__marca" aria-hidden />
                    <div>
                      <div className="he-linha-tempo__evento">
                        {rotuloEvento(h.evento)}
                        {h.usuario && <span className="he-linha-tempo__autor"> · {h.usuario}</span>}
                      </div>
                      {h.valorAnterior && (
                        <div className="he-linha-tempo__mudanca">
                          <s>{h.valorAnterior}</s> → {h.valorNovo}
                        </div>
                      )}
                      {!h.valorAnterior && h.valorNovo && (
                        <div className="he-linha-tempo__mudanca">{h.valorNovo}</div>
                      )}
                      {h.observacao && <div className="he-linha-tempo__obs">{h.observacao}</div>}
                      <time className="he-linha-tempo__quando">{new Date(h.criadoEm).toLocaleString('pt-BR')}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function rotuloEvento(evento: string): string {
  const mapa: Record<string, string> = {
    identificada: 'Ocorrência identificada pelo motor',
    recalculada: 'Jornada reprocessada — número recalculado',
    justificada: 'Justificativa registrada',
    justificativa_alterada: 'Justificativa alterada',
    status_alterado: 'Situação alterada',
  };
  return mapa[evento] ?? evento;
}
