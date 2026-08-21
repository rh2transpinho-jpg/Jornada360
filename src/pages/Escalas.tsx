/* Escalas — o que estava programado, dia a dia.
 *
 * POR QUE A VISÃO É DIÁRIA, E NÃO UMA TABELA GIGANTE
 * --------------------------------------------------
 * Escala é uma pergunta operacional de hoje: "quem trabalha, quem folga, quem não tem escala, e
 * onde a escala não bate com o ponto". Uma lista de todos os dias de todos os colaboradores
 * responde essas quatro perguntas mal. Por isso a tela abre num dia, com a cobertura em destaque,
 * e a pesquisa por colaborador é o segundo caminho — não o primeiro.
 *
 * NADA É CALCULADO AQUI. Cobertura, faixa de horário, carga prevista e extra vêm do servidor. */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarDays, Check, ClipboardList, Coffee, Pencil,
  Plus, RefreshCw, Search, Upload, X,
} from 'lucide-react';
import { useSessao } from '../workspace/WorkspaceContext';
import { useRecurso, useGravacao } from '../data/useRecurso';
import { Carregando, ErroAoCarregar, FeedbackGravacao } from '../components/ui/EstadosAsync';
import { initials } from '../utils/text';
import {
  coberturaDoDia, dataBr, hojeIso, listarEscalas, minutosParaHoras, opcoesDeEscala,
  ROTULO_SITUACAO_ESCALA, salvarEscala,
  type Escala, type SituacaoEscala,
} from '../api/jornadaService';
import { ImportadorDeEscala } from './escalas/ImportadorDeEscala';

const CLASSE_SITUACAO: Record<SituacaoEscala, string> = {
  trabalha: 'badge-green',
  folga: 'badge-blue',
  extra: 'badge-orange',
  alteracao_horario: 'badge-orange',
  ausencia_programada: 'badge-blue',
  sem_definicao: 'badge-red',
};

type Aba = 'dia' | 'pesquisa';

export default function Escalas() {
  const { workspaceIdAtivo, pode, modo } = useSessao();
  const tenantId = workspaceIdAtivo ?? '';
  const remoto = modo === 'remoto' && !!tenantId;

  const [aba, setAba] = useState<Aba>('dia');
  const [data, setData] = useState(hojeIso());
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [setor, setSetor] = useState('');
  const [unidade, setUnidade] = useState('');
  const [turno, setTurno] = useState('');
  const [editando, setEditando] = useState<Partial<Escala> | null>(null);
  const [importando, setImportando] = useState(false);

  const filtros = useMemo(() => (aba === 'dia'
    ? { data, situacao, setor, unidade, turno }
    : { busca: busca.trim(), situacao, setor, unidade, turno }
  ), [aba, data, busca, situacao, setor, unidade, turno]);

  const chave = JSON.stringify(filtros);

  const lista = useRecurso<Escala[]>(
    () => listarEscalas(tenantId, filtros),
    [tenantId, chave],
    { habilitado: remoto },
  );

  const cobertura = useRecurso(
    () => coberturaDoDia(tenantId, data),
    [tenantId, data],
    { habilitado: remoto && aba === 'dia' },
  );

  const opcoes = useRecurso(() => opcoesDeEscala(tenantId), [tenantId], { habilitado: remoto });

  const recarregar = useCallback(() => {
    void lista.recarregar();
    void cobertura.recarregar();
  }, [lista, cobertura]);

  if (!remoto) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Escalas</h1>
          <p className="page-subtitle">O que estava programado para cada colaborador, dia a dia</p>
        </header>
        <div className="card card-pad">
          <p className="text-muted" style={{ margin: 0 }}>
            A demonstração é local e não possui servidor de escalas. Entre na sua empresa para usar esta área.
          </p>
        </div>
      </>
    );
  }

  const escalas = lista.dados ?? [];
  const cob = cobertura.dados;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Escalas</h1>
          <p className="page-subtitle">O que estava programado para cada colaborador, dia a dia</p>
        </div>
        <div className="acoes-topo">
          <button className="btn" onClick={recarregar}><RefreshCw size={15} /> Atualizar</button>
          {pode('config:escrever') && (
            <>
              <button className="btn" onClick={() => setImportando(true)}><Upload size={15} /> Importar</button>
              <button
                className="btn btn-primary"
                onClick={() => setEditando({ data, situacao: 'trabalha', marcacoes: [] })}
              >
                <Plus size={15} /> Nova escala
              </button>
            </>
          )}
        </div>
      </header>

      {/* Cobertura primeiro: as três perguntas que a operação faz sobre o dia. Ficam acima da
          tabela porque são o motivo de alguém abrir esta tela às sete da manhã. */}
      {aba === 'dia' && cob && (
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">COM ESCALA</div>
            <div className="kpi-value">{cob.comEscala}</div>
            <div className="kpi-foot">{cob.folgas} folga(s) · {cob.extras} extra(s)</div>
          </div>
          <div className={`kpi-card${cob.semEscala.length ? ' kpi-card--atencao' : ''}`}>
            <div className="kpi-label">SEM ESCALA</div>
            <div className="kpi-value">{cob.semEscala.length}</div>
            <div className="kpi-foot">colaborador(es) ativo(s) sem programação</div>
          </div>
          <div className={`kpi-card${cob.pontoSemEscala.length ? ' kpi-card--alerta' : ''}`}>
            <div className="kpi-label">PONTO SEM ESCALA</div>
            <div className="kpi-value">{cob.pontoSemEscala.length}</div>
            <div className="kpi-foot">bateram ponto sem programação no dia</div>
          </div>
          <div className={`kpi-card${cob.escalaSemPonto.length ? ' kpi-card--atencao' : ''}`}>
            <div className="kpi-label">ESCALA SEM PONTO</div>
            <div className="kpi-value">{cob.escalaSemPonto.length}</div>
            <div className="kpi-foot">programados e sem registro</div>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="toolbar toolbar--filtros">
          <div className="he-chips">
            <button
              className={`he-chip${aba === 'dia' ? ' he-chip--ativo' : ''}`}
              onClick={() => setAba('dia')}
            >
              <CalendarDays size={13} /> Escala do dia
            </button>
            <button
              className={`he-chip${aba === 'pesquisa' ? ' he-chip--ativo' : ''}`}
              onClick={() => setAba('pesquisa')}
            >
              <Search size={13} /> Pesquisar colaborador
            </button>
          </div>

          <div className="filtros-linha">
            {aba === 'dia' ? (
              <label className="campo-inline">
                <span>Data</span>
                <input type="date" className="input" value={data} onChange={(e) => setData(e.target.value)} />
              </label>
            ) : (
              <label className="campo-inline campo-inline--largo">
                <span>Colaborador ou data</span>
                <input
                  className="input"
                  placeholder="Nome do colaborador ou AAAA-MM-DD…"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
              </label>
            )}

            <label className="campo-inline">
              <span>Situação</span>
              <select className="input" value={situacao} onChange={(e) => setSituacao(e.target.value)}>
                <option value="">Todas</option>
                {(opcoes.dados?.situacoes ?? []).map((s) => (
                  <option key={s.valor} value={s.valor}>{s.rotulo}</option>
                ))}
              </select>
            </label>

            <label className="campo-inline">
              <span>Setor</span>
              <select className="input" value={setor} onChange={(e) => setSetor(e.target.value)}>
                <option value="">Todos</option>
                {(opcoes.dados?.setores ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <label className="campo-inline">
              <span>Unidade</span>
              <select className="input" value={unidade} onChange={(e) => setUnidade(e.target.value)}>
                <option value="">Todas</option>
                {(opcoes.dados?.unidades ?? []).map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>

            <label className="campo-inline">
              <span>Turno</span>
              <select className="input" value={turno} onChange={(e) => setTurno(e.target.value)}>
                <option value="">Todos</option>
                {(opcoes.dados?.turnos ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>
        </div>

        {lista.estado === 'carregando' && <Carregando texto="Carregando escalas…" />}
        {lista.erro && <ErroAoCarregar erro={lista.erro} aoTentar={() => void lista.recarregar()} />}

        {lista.estado !== 'carregando' && !lista.erro && (
          escalas.length === 0 ? (
            <div style={{ padding: '28px 4px' }}>
              <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
                {aba === 'dia'
                  ? `Nenhuma escala cadastrada para ${dataBr(data)}.`
                  : busca.trim()
                    ? `Nenhuma escala encontrada para “${busca.trim()}”.`
                    : 'Pesquise por colaborador ou data.'}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>DATA</th>
                    <th>COLABORADOR</th>
                    <th>SITUAÇÃO</th>
                    <th>HORÁRIO PREVISTO</th>
                    <th>CARGA</th>
                    <th>TURNO</th>
                    <th>SETOR</th>
                    <th>ORIGEM</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {escalas.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">{dataBr(e.data)}</td>
                      <td>
                        <div className="name-cell">
                          <span className="avatar">{initials(e.colaborador)}</span>
                          <span>{e.colaborador}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${CLASSE_SITUACAO[e.situacao] ?? 'badge-blue'}`}>
                          {e.situacao === 'folga' && <Coffee size={11} />} {e.rotuloSituacao}
                        </span>
                      </td>
                      <td className="mono">{e.faixa || '—'}</td>
                      <td className="mono">{e.cargaPrevistaMin ? minutosParaHoras(e.cargaPrevistaMin) : '—'}</td>
                      <td>{e.turno || '—'}</td>
                      <td>{e.setor || '—'}</td>
                      <td>
                        <span className="text-faint" style={{ fontSize: 11.5 }}>
                          {e.origem === 'importacao' ? 'Importada' : 'Manual'}
                          {e.atualizadoPor ? ` · ${e.atualizadoPor}` : ''}
                        </span>
                      </td>
                      <td>
                        {pode('config:escrever') && (
                          <button className="btn btn-sm" onClick={() => setEditando(e)}>
                            <Pencil size={13} /> Editar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* Listas de exceção do dia. Ficam abaixo da tabela porque são o detalhe de quem já viu o
          número lá em cima e quer saber de quem se trata. */}
      {aba === 'dia' && cob && (cob.pontoSemEscala.length > 0 || cob.escalaSemPonto.length > 0 || cob.semEscala.length > 0) && (
        <div className="card card-pad">
          <div className="card-title"><h2><AlertTriangle size={15} /> Onde escala e ponto não se encontram</h2></div>
          <div className="cobertura-listas">
            <ListaSimples titulo="Bateram ponto sem escala" itens={cob.pontoSemEscala.map((p) => p.colaborador)} />
            <ListaSimples titulo="Escala sem ponto" itens={cob.escalaSemPonto.map((p) => p.colaborador)} />
            <ListaSimples titulo="Sem escala no dia" itens={cob.semEscala.map((p) => p.colaborador)} />
          </div>
        </div>
      )}

      {editando && (
        <EditorDeEscala
          tenantId={tenantId}
          inicial={editando}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => { setEditando(null); recarregar(); }}
        />
      )}

      {importando && (
        <ImportadorDeEscala
          tenantId={tenantId}
          aoFechar={() => setImportando(false)}
          aoConcluir={() => { setImportando(false); recarregar(); }}
        />
      )}
    </>
  );
}

function ListaSimples({ titulo, itens }: { titulo: string; itens: string[] }) {
  return (
    <div className="cobertura-lista">
      <h3>{titulo} <span className="text-faint">({itens.length})</span></h3>
      {itens.length === 0
        ? <p className="text-faint">Nenhum.</p>
        : <ul>{itens.slice(0, 12).map((n) => <li key={n}>{n}</li>)}
          {itens.length > 12 && <li className="text-faint">e mais {itens.length - 12}…</li>}
        </ul>}
    </div>
  );
}

/* ---------------------------------------------------------------- editor */

/* Editor manual. As marcações são campos de horário separados, não um texto livre: digitar
 * "06:00-16:00" numa caixa deixa o formato à sorte de quem digita, e um horário mal formado aqui
 * vira análise errada para o dia inteiro. */
function EditorDeEscala({
  tenantId, inicial, aoFechar, aoSalvar,
}: {
  tenantId: string;
  inicial: Partial<Escala>;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const gravacao = useGravacao();
  const [colaborador, setColaborador] = useState(inicial.colaborador ?? '');
  const [data, setData] = useState(inicial.data ?? hojeIso());
  const [situacao, setSituacao] = useState<SituacaoEscala>(inicial.situacao ?? 'trabalha');
  const [marcacoes, setMarcacoes] = useState<string[]>(() => {
    const m = inicial.marcacoes ?? [];
    return [m[0] ?? '', m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? '', m[5] ?? ''];
  });
  const [carga, setCarga] = useState(String(inicial.cargaPrevistaMin ?? 480));
  const [turno, setTurno] = useState(inicial.turno ?? '');
  const [setor, setSetor] = useState(inicial.setor ?? '');
  const [unidade, setUnidade] = useState(inicial.unidade ?? '');
  const [observacao, setObservacao] = useState(inicial.observacao ?? '');
  const [motivo, setMotivo] = useState('');

  const precisaHorario = situacao === 'trabalha' || situacao === 'extra' || situacao === 'alteracao_horario';

  function alterarMarcacao(i: number, valor: string) {
    setMarcacoes((m) => m.map((v, idx) => (idx === i ? valor : v)));
  }

  async function salvar() {
    const r = await gravacao.executar(() => salvarEscala(tenantId, {
      colaborador, data, situacao,
      marcacoes: marcacoes.filter((m) => m.trim()),
      cargaPrevistaMin: carga === '' ? null : Number(carga),
      turno, setor, unidade, observacao, motivo,
    }));
    if (r) aoSalvar();
  }

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside
        className="he-painel"
        role="dialog"
        aria-label="Escala do dia"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><X size={14} /> Fechar</button>
          <span className="badge badge-blue">{inicial.id ? 'Editar escala' : 'Nova escala'}</span>
        </header>

        <div className="he-painel__corpo">
          <div className="he-form">
            <label className="field-label" htmlFor="esc-colab">Colaborador</label>
            <input
              id="esc-colab" className="input" value={colaborador}
              onChange={(e) => setColaborador(e.target.value)}
              disabled={!!inicial.id}
              placeholder="Nome como aparece no espelho de ponto"
            />

            <label className="field-label" htmlFor="esc-data">Data</label>
            <input
              id="esc-data" type="date" className="input" value={data}
              onChange={(e) => setData(e.target.value)} disabled={!!inicial.id}
            />

            <label className="field-label" htmlFor="esc-sit">Situação</label>
            <select
              id="esc-sit" className="input" value={situacao}
              onChange={(e) => setSituacao(e.target.value as SituacaoEscala)}
            >
              {(Object.keys(ROTULO_SITUACAO_ESCALA) as SituacaoEscala[])
                .filter((s) => s !== 'sem_definicao')
                .map((s) => <option key={s} value={s}>{ROTULO_SITUACAO_ESCALA[s]}</option>)}
            </select>

            {precisaHorario && (
              <>
                <span className="field-label">Horário previsto</span>
                <p className="text-faint" style={{ margin: '0 0 8px', fontSize: 12 }}>
                  Preencha em pares de entrada e saída. Deixe os últimos vazios se a jornada tiver
                  um intervalo só.
                </p>
                <div className="marcacoes-grid">
                  {marcacoes.map((m, i) => (
                    <label key={i} className="marcacao">
                      <span>{i % 2 === 0 ? `Entrada ${Math.floor(i / 2) + 1}` : `Saída ${Math.floor(i / 2) + 1}`}</span>
                      <input
                        type="time" className="input" value={m}
                        onChange={(e) => alterarMarcacao(i, e.target.value)}
                      />
                    </label>
                  ))}
                </div>

                <label className="field-label" htmlFor="esc-carga">Carga prevista (minutos)</label>
                <input
                  id="esc-carga" type="number" className="input" value={carga}
                  onChange={(e) => setCarga(e.target.value)}
                />
              </>
            )}

            <label className="field-label" htmlFor="esc-turno">Turno</label>
            <input id="esc-turno" className="input" value={turno} onChange={(e) => setTurno(e.target.value)} />

            <label className="field-label" htmlFor="esc-setor">Setor</label>
            <input id="esc-setor" className="input" value={setor} onChange={(e) => setSetor(e.target.value)} />

            <label className="field-label" htmlFor="esc-unid">Unidade</label>
            <input id="esc-unid" className="input" value={unidade} onChange={(e) => setUnidade(e.target.value)} />

            <label className="field-label" htmlFor="esc-obs">Observação</label>
            <textarea id="esc-obs" className="input" rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} />

            {inicial.id && (
              <>
                <label className="field-label" htmlFor="esc-motivo">Motivo da alteração</label>
                <input
                  id="esc-motivo" className="input" value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Fica registrado no histórico e na auditoria"
                />
              </>
            )}

            <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

            <button
              className="btn btn-primary"
              style={{ marginTop: 10 }}
              disabled={!colaborador.trim() || !data || gravacao.estado === 'salvando'}
              onClick={() => void salvar()}
            >
              <Check size={15} /> {inicial.id ? 'Salvar alteração' : 'Cadastrar escala'}
            </button>

            <p className="text-faint" style={{ marginTop: 8, fontSize: 11.5 }}>
              <ClipboardList size={11} /> Toda alteração fica no histórico da escala e na trilha de auditoria.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
