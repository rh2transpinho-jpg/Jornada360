/* Horários Padrão — a jornada habitual de cada colaborador, com vigência.
 *
 * A IDEIA QUE ORGANIZA ESTA TELA
 * ------------------------------
 * Horário padrão não é um campo do cadastro: é uma LINHA DO TEMPO. A mesma pessoa tem um horário
 * em julho e outro em agosto, e a análise de julho precisa ler o de julho.
 *
 * Por isso a tela prioriza pesquisa + manutenção + histórico, e a vigência aparece em toda linha.
 * E por isso existem duas ações distintas onde um cadastro comum teria só "editar":
 *
 *   Corrigir  → o horário estava errado; conserta a linha, inclusive para o passado;
 *   Novo a partir de… → o horário MUDOU; abre vigência nova e preserva a anterior.
 *
 * Oferecer só "editar" faria toda mudança de horário reescrever o histórico — que é exatamente o
 * defeito que esta fase existe para eliminar. */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, Clock, History, Pencil, Plus, Power, RefreshCw, Search, X,
} from 'lucide-react';
import { useSessao } from '../workspace/WorkspaceContext';
import { useRecurso, useGravacao } from '../data/useRecurso';
import { Carregando, ErroAoCarregar, FeedbackGravacao } from '../components/ui/EstadosAsync';
import { initials } from '../utils/text';
import {
  alertasDePadrao, atualizarPadrao, criarPadrao, dataBr, historicoDoColaborador, hojeIso,
  inativarPadrao, listarPadroes, minutosParaHoras, obterPadrao, reativarPadrao,
  type EventoHistorico, type HorarioPadrao,
} from '../api/jornadaService';

type Modo = 'novo' | 'corrigir' | 'nova_vigencia';

export default function HorariosPadrao() {
  const { workspaceIdAtivo, pode, modo } = useSessao();
  const tenantId = workspaceIdAtivo ?? '';
  const remoto = modo === 'remoto' && !!tenantId;

  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState('ativo');
  const [editor, setEditor] = useState<{ modo: Modo; padrao?: HorarioPadrao } | null>(null);
  const [linhaDoTempo, setLinhaDoTempo] = useState<string | null>(null);

  const filtros = useMemo(() => ({ busca: busca.trim(), status }), [busca, status]);
  const chave = JSON.stringify(filtros);

  const lista = useRecurso<HorarioPadrao[]>(
    () => listarPadroes(tenantId, filtros),
    [tenantId, chave],
    { habilitado: remoto },
  );

  const alertas = useRecurso(() => alertasDePadrao(tenantId), [tenantId], { habilitado: remoto });

  const recarregar = useCallback(() => {
    void lista.recarregar();
    void alertas.recarregar();
  }, [lista, alertas]);

  if (!remoto) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Horários Padrão</h1>
          <p className="page-subtitle">A jornada habitual de cada colaborador, com vigência</p>
        </header>
        <div className="card card-pad">
          <p className="text-muted" style={{ margin: 0 }}>
            A demonstração é local e não possui servidor de horários padrão. Entre na sua empresa para usar esta área.
          </p>
        </div>
      </>
    );
  }

  const padroes = lista.dados ?? [];
  const problemas = alertas.dados ?? [];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Horários Padrão</h1>
          <p className="page-subtitle">A jornada habitual de cada colaborador, com vigência</p>
        </div>
        <div className="acoes-topo">
          <button className="btn" onClick={recarregar}><RefreshCw size={15} /> Atualizar</button>
          {pode('config:escrever') && (
            <button className="btn btn-primary" onClick={() => setEditor({ modo: 'novo' })}>
              <Plus size={15} /> Novo horário padrão
            </button>
          )}
        </div>
      </header>

      {problemas.length > 0 && (
        <div className="card card-pad card--alerta">
          <div>
            <h2 className="titulo-alerta"><AlertTriangle size={15} /> {problemas.length} problema(s) no cadastro</h2>
            <ul className="lista-alertas">
              {problemas.slice(0, 8).map((p, i) => (
                <li key={i}><strong>{p.colaborador}</strong>: {p.mensagem}</li>
              ))}
              {problemas.length > 8 && <li className="text-faint">e mais {problemas.length - 8}…</li>}
            </ul>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="toolbar toolbar--filtros">
          <label className="campo-inline campo-inline--largo">
            <span><Search size={12} /> Colaborador</span>
            <input
              className="input" placeholder="Pesquisar por nome…"
              value={busca} onChange={(e) => setBusca(e.target.value)}
            />
          </label>
          <label className="campo-inline">
            <span>Situação</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="ativo">Ativos</option>
              <option value="inativo">Inativos</option>
              <option value="">Todos</option>
            </select>
          </label>
        </div>

        {lista.estado === 'carregando' && <Carregando texto="Carregando horários padrão…" />}
        {lista.erro && <ErroAoCarregar erro={lista.erro} aoTentar={() => void lista.recarregar()} />}

        {lista.estado !== 'carregando' && !lista.erro && (
          padroes.length === 0 ? (
            <div style={{ padding: '28px 4px' }}>
              <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
                {busca.trim()
                  ? `Nenhum horário padrão encontrado para “${busca.trim()}”.`
                  : 'Nenhum horário padrão cadastrado ainda. Sem ele, uma jornada sem escala do dia fica sem referência para comparar.'}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>COLABORADOR</th>
                    <th>HORÁRIO</th>
                    <th>CARGA</th>
                    <th>EXTRA PREVISTO</th>
                    <th>VIGÊNCIA</th>
                    <th>SITUAÇÃO</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {padroes.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="name-cell">
                          <span className="avatar">{initials(p.colaborador)}</span>
                          <span>{p.colaborador}</span>
                        </div>
                      </td>
                      <td className="mono">{p.faixa || '—'}</td>
                      <td className="mono">{p.cargaPrevistaMin ? minutosParaHoras(p.cargaPrevistaMin) : '—'}</td>
                      <td className="mono">
                        {p.extraMin === null ? '—' : minutosParaHoras(p.extraMin)}
                      </td>
                      <td className="mono">
                        {dataBr(p.vigenciaInicio)} → {p.vigenciaFim ? dataBr(p.vigenciaFim) : 'sem fim'}
                      </td>
                      <td>
                        {p.status === 'inativo'
                          ? <span className="badge badge-red">Inativo</span>
                          : p.vigente
                            ? <span className="badge badge-green">Vigente</span>
                            : <span className="badge badge-blue">Encerrado</span>}
                      </td>
                      <td>
                        <div className="acoes-linha">
                          <button className="btn btn-sm" onClick={() => setLinhaDoTempo(p.colaborador)}>
                            <History size={13} /> Histórico
                          </button>
                          {pode('config:escrever') && (
                            <>
                              <button className="btn btn-sm" onClick={() => setEditor({ modo: 'corrigir', padrao: p })}>
                                <Pencil size={13} /> Corrigir
                              </button>
                              <button className="btn btn-sm" onClick={() => setEditor({ modo: 'nova_vigencia', padrao: p })}>
                                <Clock size={13} /> Novo a partir de…
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {editor && (
        <EditorDePadrao
          tenantId={tenantId}
          modo={editor.modo}
          padrao={editor.padrao}
          aoFechar={() => setEditor(null)}
          aoSalvar={() => { setEditor(null); recarregar(); }}
        />
      )}

      {linhaDoTempo && (
        <LinhaDoTempo
          tenantId={tenantId}
          colaborador={linhaDoTempo}
          podeEscrever={pode('config:escrever')}
          aoFechar={() => setLinhaDoTempo(null)}
          aoMudar={recarregar}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- editor */

function EditorDePadrao({
  tenantId, modo, padrao, aoFechar, aoSalvar,
}: {
  tenantId: string;
  modo: Modo;
  padrao?: HorarioPadrao;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const gravacao = useGravacao();
  const corrigindo = modo === 'corrigir';

  const [colaborador, setColaborador] = useState(padrao?.colaborador ?? '');
  const [marcacoes, setMarcacoes] = useState<string[]>(() => {
    const m = padrao?.marcacoes ?? [];
    return [m[0] ?? '', m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? '', m[5] ?? ''];
  });
  const [carga, setCarga] = useState(String(padrao?.cargaPrevistaMin ?? 480));
  const [inicio, setInicio] = useState(corrigindo ? (padrao?.vigenciaInicio ?? hojeIso()) : hojeIso());
  const [fim, setFim] = useState(corrigindo ? (padrao?.vigenciaFim ?? '') : '');
  const [observacoes, setObservacoes] = useState(padrao?.observacoes ?? '');
  const [motivo, setMotivo] = useState('');

  function alterar(i: number, valor: string) {
    setMarcacoes((m) => m.map((v, idx) => (idx === i ? valor : v)));
  }

  async function salvar() {
    const dados = {
      colaborador,
      marcacoes: marcacoes.filter((m) => m.trim()),
      cargaPrevistaMin: carga === '' ? null : Number(carga),
      vigenciaInicio: inicio,
      vigenciaFim: fim || null,
      observacoes,
      motivo,
    };

    const r = await gravacao.executar(() => (corrigindo && padrao
      ? atualizarPadrao(tenantId, padrao.id, dados)
      : criarPadrao(tenantId, dados)));

    /* Recusa do servidor aparece por `FeedbackGravacao`, que mostra a mensagem do erro. O servidor
     * devolve a lista completa de problemas, mas o cliente HTTP só preserva a primeira mensagem —
     * e ela é a que resolve o caso comum (um campo errado por vez). */
    if (r) aoSalvar();
  }

  const titulo = modo === 'novo' ? 'Novo horário padrão'
    : modo === 'corrigir' ? 'Corrigir horário padrão'
      : 'Novo horário a partir de uma data';

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside className="he-painel" role="dialog" aria-label={titulo} onClick={(e) => e.stopPropagation()}>
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><X size={14} /> Fechar</button>
          <span className="badge badge-blue">{titulo}</span>
        </header>

        <div className="he-painel__corpo">
          {/* A distinção entre corrigir e trocar é a coisa mais importante desta tela. Se ela não
              estiver clara aqui, alguém vai corrigir o passado sem querer. */}
          <p className={corrigindo ? 'he-aviso-recalculo' : 'he-justificativa-atual'} style={{ marginBottom: 14 }}>
            {corrigindo ? <AlertTriangle size={15} /> : <Clock size={15} />}
            <span>
              {corrigindo
                ? 'Corrigir altera este período — inclusive dias já analisados. Use quando o horário foi cadastrado errado.'
                : 'Abre uma vigência nova. O horário anterior continua valendo para os dias anteriores, e a análise do passado não muda.'}
            </span>
          </p>

          <div className="he-form">
            <label className="field-label" htmlFor="pad-colab">Colaborador</label>
            <input
              id="pad-colab" className="input" value={colaborador}
              onChange={(e) => setColaborador(e.target.value)}
              disabled={modo !== 'novo'}
              placeholder="Nome como aparece no espelho de ponto"
            />

            <span className="field-label">Horário</span>
            <p className="text-faint" style={{ margin: '0 0 8px', fontSize: 12 }}>
              Em pares de entrada e saída. Suporta 2, 4 ou 6 marcações — jornada com dois intervalos
              não precisa ser achatada.
            </p>
            <div className="marcacoes-grid">
              {marcacoes.map((m, i) => (
                <label key={i} className="marcacao">
                  <span>{i % 2 === 0 ? `Entrada ${Math.floor(i / 2) + 1}` : `Saída ${Math.floor(i / 2) + 1}`}</span>
                  <input type="time" className="input" value={m} onChange={(e) => alterar(i, e.target.value)} />
                </label>
              ))}
            </div>

            <label className="field-label" htmlFor="pad-carga">Carga prevista (minutos)</label>
            <input id="pad-carga" type="number" className="input" value={carga} onChange={(e) => setCarga(e.target.value)} />

            <label className="field-label" htmlFor="pad-ini">Vigência inicial</label>
            <input id="pad-ini" type="date" className="input" value={inicio} onChange={(e) => setInicio(e.target.value)} />

            <label className="field-label" htmlFor="pad-fim">Vigência final (opcional)</label>
            <input id="pad-fim" type="date" className="input" value={fim} onChange={(e) => setFim(e.target.value)} />
            <p className="text-faint" style={{ fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
              Deixe vazio para valer por prazo indeterminado.
            </p>

            <label className="field-label" htmlFor="pad-obs">Observações</label>
            <textarea id="pad-obs" className="input" rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />

            {modo !== 'novo' && (
              <>
                <label className="field-label" htmlFor="pad-motivo">Motivo</label>
                <input
                  id="pad-motivo" className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Fica registrado no histórico e na auditoria"
                />
              </>
            )}

            <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

            <button
              className="btn btn-primary" style={{ marginTop: 10 }}
              disabled={!colaborador.trim() || !inicio || gravacao.estado === 'salvando'}
              onClick={() => void salvar()}
            >
              <Check size={15} /> {corrigindo ? 'Salvar correção' : 'Cadastrar'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- linha do tempo */

function LinhaDoTempo({
  tenantId, colaborador, podeEscrever, aoFechar, aoMudar,
}: {
  tenantId: string;
  colaborador: string;
  podeEscrever: boolean;
  aoFechar: () => void;
  aoMudar: () => void;
}) {
  const vigencias = useRecurso(
    () => historicoDoColaborador(tenantId, colaborador),
    [tenantId, colaborador],
  );
  const [aberto, setAberto] = useState<string | null>(null);
  const gravacao = useGravacao();

  const detalhe = useRecurso<(HorarioPadrao & { historico: EventoHistorico[] }) | null>(
    () => (aberto ? obterPadrao(tenantId, aberto) : Promise.resolve(null)),
    [tenantId, aberto],
    { habilitado: !!aberto },
  );

  async function alternar(p: HorarioPadrao) {
    const r = await gravacao.executar(() => (p.status === 'ativo'
      ? inativarPadrao(tenantId, p.id)
      : reativarPadrao(tenantId, p.id)));
    if (r) { void vigencias.recarregar(); aoMudar(); }
  }

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside
        className="he-painel" role="dialog"
        aria-label={`Linha do tempo de ${colaborador}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><X size={14} /> Fechar</button>
          <span className="badge badge-blue">Linha do tempo</span>
        </header>

        <div className="he-painel__corpo">
          <h2 className="he-painel__nome">{colaborador}</h2>
          <p className="text-muted" style={{ fontSize: 13 }}>
            Cada linha é o horário que valia num período. A análise de um dia usa a vigência daquele
            dia — não a mais recente.
          </p>

          {vigencias.estado === 'carregando' && <Carregando texto="Carregando…" />}

          <ol className="he-linha-tempo">
            {(vigencias.dados ?? []).map((p) => (
              <li key={p.id}>
                <div className="he-linha-tempo__evento">
                  <strong className="mono">{p.faixa || '—'}</strong>
                  {p.status === 'inativo'
                    ? <span className="badge badge-red">Inativo</span>
                    : p.vigente
                      ? <span className="badge badge-green">Vigente</span>
                      : <span className="badge badge-blue">Encerrado</span>}
                </div>
                <div className="he-linha-tempo__mudanca mono">
                  {dataBr(p.vigenciaInicio)} → {p.vigenciaFim ? dataBr(p.vigenciaFim) : 'sem fim'}
                  {p.extraMin !== null && <> · extra previsto {minutosParaHoras(p.extraMin)}</>}
                </div>
                {p.observacoes && <div className="he-linha-tempo__obs">{p.observacoes}</div>}
                <div className="acoes-linha" style={{ marginTop: 6 }}>
                  <button className="btn btn-sm" onClick={() => setAberto(aberto === p.id ? null : p.id)}>
                    <History size={12} /> {aberto === p.id ? 'Ocultar alterações' : 'Ver alterações'}
                  </button>
                  {podeEscrever && (
                    <button className="btn btn-sm" onClick={() => void alternar(p)}>
                      <Power size={12} /> {p.status === 'ativo' ? 'Inativar' : 'Reativar'}
                    </button>
                  )}
                </div>

                {aberto === p.id && detalhe.dados && (
                  <ul className="he-linha-tempo he-linha-tempo--aninhada">
                    {detalhe.dados.historico.map((h) => (
                      <li key={h.id}>
                        <div className="he-linha-tempo__evento">
                          <span>{h.evento.replace(/_/g, ' ')}{h.usuario ? ` · ${h.usuario}` : ''}</span>
                        </div>
                        {(h.valorAnterior || h.valorNovo) && (
                          <div className="he-linha-tempo__mudanca mono">
                            {h.valorAnterior && <>{h.valorAnterior} → </>}{h.valorNovo}
                          </div>
                        )}
                        {h.observacao && <div className="he-linha-tempo__obs">{h.observacao}</div>}
                        <div className="text-faint" style={{ fontSize: 11 }}>
                          {new Date(h.criadoEm).toLocaleString('pt-BR')}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>

          <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />
        </div>
      </aside>
    </div>
  );
}
