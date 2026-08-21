/* Minha Fila — o centro operacional.
 *
 * A FILOSOFIA, EM UMA TELA
 * ------------------------
 * "Se está correto, não me faça perder tempo conferindo. Se precisa de atenção, coloque na minha
 * frente já explicado."
 *
 * Quem abre esta área não vê as 72 jornadas do dia: vê as 14 que exigem alguém, na ordem em que
 * importam, cada uma com a referência usada, o previsto, o realizado e a diferença. A pergunta
 * "por que isso apareceu?" tem botão próprio, porque ninguém deveria precisar deduzir contra qual
 * horário o sistema comparou o ponto.
 *
 * NADA É CALCULADO AQUI. Classificação, prioridade, divergências, reincidência e o texto da
 * explicação vêm prontos do servidor — inclusive a ordem da lista. Ver src/api/jornadaService.ts. */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, ClipboardCopy, Clock,
  HelpCircle, MessageSquare, RefreshCw, Repeat2, Search, Sparkles, X,
} from 'lucide-react';
import { useSessao } from '../workspace/WorkspaceContext';
import { useRecurso, useGravacao } from '../data/useRecurso';
import { Carregando, ErroAoCarregar, FeedbackGravacao } from '../components/ui/EstadosAsync';
import { AmbienteSemDados } from '../components/ui/Indicadores';
import {
  comSinal, contadoresDaFila, dataBr, explicar, gerarMensagem, hojeIso, listarFila,
  minutosParaHoras, reprocessar, resumoDiario,
  type Explicacao, type FiltroRapidoFila, type ItemFila, type MensagemGerada,
} from '../api/jornadaService';

const FILTROS: { id: FiltroRapidoFila; rotulo: string }[] = [
  { id: 'todos', rotulo: 'Todos' },
  { id: 'criticos', rotulo: 'Críticos' },
  { id: 'he', rotulo: 'HE' },
  { id: 'intervalos', rotulo: 'Intervalos' },
  { id: 'escala', rotulo: 'Escala' },
  { id: 'sem_referencia', rotulo: 'Sem referência' },
];

const CLASSE_GRAVIDADE: Record<string, string> = {
  critico: 'badge-red',
  atencao: 'badge-orange',
  ok: 'badge-green',
};

export default function MinhaFila() {
  const { workspaceIdAtivo, pode, modo } = useSessao();
  const tenantId = workspaceIdAtivo ?? '';
  const remoto = modo === 'remoto' && !!tenantId;

  const [rapido, setRapido] = useState<FiltroRapidoFila>('todos');
  const [busca, setBusca] = useState('');
  const [dia, setDia] = useState(hojeIso());
  const [aberta, setAberta] = useState<ItemFila | null>(null);

  const filtros = useMemo(
    () => ({ rapido: rapido === 'todos' ? '' : rapido, busca: busca.trim() }),
    [rapido, busca],
  );
  const chave = JSON.stringify(filtros);

  const fila = useRecurso<ItemFila[]>(
    () => listarFila(tenantId, filtros),
    [tenantId, chave],
    { habilitado: remoto },
  );

  const contadores = useRecurso(() => contadoresDaFila(tenantId), [tenantId], { habilitado: remoto });
  const resumo = useRecurso(() => resumoDiario(tenantId, dia), [tenantId, dia], { habilitado: remoto });
  const reproc = useGravacao();
  /* O resultado do reprocessamento vive aqui, não no hook: `useGravacao` guarda estado e erro, e
   * o que interessa mostrar é quantas pendências se resolveram sozinhas. */
  const [resultadoReproc, setResultadoReproc] = useState<{ dias: number; resolvidas: number } | null>(null);

  const recarregar = useCallback(() => {
    void fila.recarregar();
    void contadores.recarregar();
    void resumo.recarregar();
  }, [fila, contadores, resumo]);

  if (!remoto) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Minha Fila</h1>
          <p className="page-subtitle">Só o que precisa de você, já explicado</p>
        </header>
        <div className="card card-pad">
          <p className="text-muted" style={{ margin: 0 }}>
            A demonstração é local e não possui a análise automática do servidor. Entre na sua
            empresa para usar esta área.
          </p>
        </div>
      </>
    );
  }

  const itens = fila.dados ?? [];
  const c = contadores.dados;
  const r = resumo.dados;

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Minha Fila</h1>
          <p className="page-subtitle">Só o que precisa de você, já explicado</p>
        </div>
        <div className="acoes-topo">
          <button className="btn" onClick={recarregar}><RefreshCw size={15} /> Atualizar</button>
          {pode('dados:escrever') && (
            <button
              className="btn"
              disabled={reproc.estado === 'salvando'}
              onClick={async () => {
                const r = await reproc.executar(() => reprocessar(tenantId));
                if (r) { setResultadoReproc(r); recarregar(); }
              }}
            >
              <Repeat2 size={15} /> Reanalisar tudo
            </button>
          )}
        </div>
      </header>

      {resultadoReproc && (
        <p className="he-aviso-recalculo">
          <CheckCircle2 size={15} />
          <span>
            {resultadoReproc.dias} dia(s) reanalisados
            {resultadoReproc.resolvidas > 0 && <> · <strong>{resultadoReproc.resolvidas} pendência(s) se resolveram sozinhas</strong></>}.
          </span>
        </p>
      )}

      {/* O resumo do dia fica no topo porque é a resposta à pergunta "como foi hoje?" — e os
          números saem das mesmas análises que produzem a lista abaixo, nunca de outra fonte. */}
      {r && (
        <div className="card card-pad card--resumo">
          <div className="toolbar toolbar--filtros">
            <h2><CalendarDays size={15} /> Resumo de {r.dataBr}</h2>
            <label className="campo-inline">
              <span>Dia</span>
              <input type="date" className="input" value={dia} onChange={(e) => setDia(e.target.value)} />
            </label>
          </div>
          <div>
            {r.processados === 0 ? (
              <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
                Nenhuma jornada processada em {r.dataBr}.
              </p>
            ) : (
              <div className="resumo-dia">
                <div className="resumo-dia__numeros">
                  <div><strong>{r.processados}</strong><span>jornadas analisadas</span></div>
                  <div className="ok"><strong>{r.ok}</strong><span>sem divergências</span></div>
                  <div className="atencao"><strong>{r.atencao}</strong><span>precisam de atenção</span></div>
                  <div className="critico"><strong>{r.critico}</strong><span>prioritárias</span></div>
                  <div><strong>{r.heTotal}</strong><span>de hora extra</span></div>
                </div>
                {r.porTipo.length > 0 && (
                  <ul className="resumo-dia__tipos">
                    {r.porTipo.slice(0, 8).map((t) => (
                      <li key={t.tipo}>
                        <span className={`ponto ponto--${t.gravidade}`} />
                        {t.total} {t.rotulo.toLowerCase()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="toolbar toolbar--filtros">
          <div className="he-chips">
            {FILTROS.map((f) => {
              const total = !c ? null : f.id === 'todos' ? c.total
                : f.id === 'criticos' ? c.criticos
                  : f.id === 'he' ? c.he
                    : f.id === 'intervalos' ? c.intervalos
                      : f.id === 'escala' ? c.escala : c.semReferencia;
              return (
                <button
                  key={f.id}
                  className={`he-chip${rapido === f.id ? ' he-chip--ativo' : ''}`}
                  onClick={() => setRapido(f.id)}
                >
                  {f.rotulo}{total !== null && <span className="he-chip__n">{total}</span>}
                </button>
              );
            })}
          </div>
          <label className="campo-inline campo-inline--largo">
            <span><Search size={12} /> Pesquisar</span>
            <input
              className="input" placeholder="Colaborador ou tipo de ocorrência…"
              value={busca} onChange={(e) => setBusca(e.target.value)}
            />
          </label>
        </div>

        {fila.estado === 'carregando' && <Carregando texto="Carregando a fila…" />}
        {fila.erro && <ErroAoCarregar erro={fila.erro} aoTentar={() => void fila.recarregar()} />}

        {fila.estado !== 'carregando' && !fila.erro && (
          itens.length === 0 ? (
            <div style={{ padding: '28px 4px' }}>
              {/* A distinção que importa: fila vazia porque está tudo certo é BOA notícia, e
                  precisa ser dita assim. Só quando não há nenhuma jornada processada é que o
                  problema é falta de dado. */}
              {c && c.total === 0 && r && r.processados > 0 ? (
                <p className="fila-limpa">
                  <CheckCircle2 size={18} /> Nada pendente. As jornadas analisadas não têm divergência aberta.
                </p>
              ) : r && r.processados === 0 && !busca.trim() && rapido === 'todos' ? (
                <AmbienteSemDados />
              ) : (
                <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
                  Nada neste recorte.{' '}
                  <button type="button" className="link-inline" onClick={() => { setRapido('todos'); setBusca(''); }}>
                    Ver todos
                  </button>
                </p>
              )}
            </div>
          ) : (
            <ul className="fila-lista">
              {itens.map((item) => (
                <li key={item.id} className={`fila-item fila-item--${item.gravidade}`}>
                  <div className="fila-item__cabeca">
                    <span className={`badge ${CLASSE_GRAVIDADE[item.gravidade]}`}>{item.rotuloTipo}</span>
                    <span className="mono text-faint">{dataBr(item.data)}</span>
                    {item.prazo && (
                      <span className="text-faint" style={{ fontSize: 11.5 }}>
                        <Clock size={11} /> prazo {dataBr(item.prazo)}
                      </span>
                    )}
                  </div>

                  <p className="fila-item__desc">{item.descricao}</p>

                  {item.evidencias.length > 0 && (
                    <ul className="fila-item__evidencias">
                      {item.evidencias.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  )}

                  {item.recomendacao && (
                    <p className="fila-item__recomendacao"><ArrowRight size={12} /> {item.recomendacao}</p>
                  )}

                  <div className="acoes-linha">
                    {item.analiseId && (
                      <button className="btn btn-sm" onClick={() => setAberta(item)}>
                        <HelpCircle size={13} /> Por que isso apareceu?
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </div>

      {aberta?.analiseId && (
        <PainelExplicacao
          tenantId={tenantId}
          item={aberta}
          podeTratar={pode('pendencia:tratar')}
          aoFechar={() => setAberta(null)}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- "por que isso apareceu?" */

function PainelExplicacao({
  tenantId, item, podeTratar, aoFechar,
}: {
  tenantId: string;
  item: ItemFila;
  podeTratar: boolean;
  aoFechar: () => void;
}) {
  const dados = useRecurso<Explicacao>(
    () => explicar(tenantId, item.analiseId!),
    [tenantId, item.analiseId],
  );
  const geracao = useGravacao();
  const [mensagem, setMensagem] = useState<MensagemGerada | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function gerar() {
    const r = await geracao.executar(() => gerarMensagem(tenantId, item.analiseId!, item.tipo));
    if (r) setMensagem(r);
  }

  async function copiar() {
    if (!mensagem) return;
    await navigator.clipboard.writeText(mensagem.mensagem);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  const a = dados.dados;

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside
        className="he-painel" role="dialog"
        aria-label="Por que isso apareceu"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><X size={14} /> Fechar</button>
          <span className={`badge ${CLASSE_GRAVIDADE[item.gravidade]}`}>{item.rotuloTipo}</span>
        </header>

        <div className="he-painel__corpo">
          {dados.estado === 'carregando' && <Carregando texto="Carregando a explicação…" />}
          {dados.erro && <ErroAoCarregar erro={dados.erro} aoTentar={() => void dados.recarregar()} />}

          {a && (
            <>
              <h2 className="he-painel__nome">{a.colaborador}</h2>
              <p className="he-painel__data mono">{dataBr(a.data)}</p>

              {/* A resposta direta, em uma frase, escrita pelo servidor. */}
              <p className="explicacao-porque">
                <HelpCircle size={16} />
                <span>{a.porQue}</span>
              </p>

              <section className="he-secao">
                <h3 className="he-secao__titulo">Referência utilizada</h3>
                <div className="referencia-comparacao">
                  <div className={a.referenciaTipo === 'padrao' ? 'ref-bloco ref-bloco--usada' : 'ref-bloco'}>
                    <span className="ref-bloco__rotulo">Horário padrão</span>
                    <span className="mono">{a.padraoHorarios || (a.referenciaTipo === 'padrao' ? a.referenciaHorarios : '— não cadastrado —')}</span>
                    {a.referenciaTipo === 'padrao' && <span className="ref-bloco__marca">usada</span>}
                  </div>
                  <div className={a.referenciaTipo === 'escala' ? 'ref-bloco ref-bloco--usada' : 'ref-bloco'}>
                    <span className="ref-bloco__rotulo">Escala do dia</span>
                    <span className="mono">{a.referenciaTipo === 'escala' ? a.referenciaHorarios : '— sem escala específica —'}</span>
                    {a.referenciaTipo === 'escala' && <span className="ref-bloco__marca">usada</span>}
                  </div>
                  <div className="ref-bloco ref-bloco--ponto">
                    <span className="ref-bloco__rotulo">Ponto registrado</span>
                    <span className="mono">{a.pontoMarcacoes || '— sem registro —'}</span>
                  </div>
                </div>
              </section>

              <section className="he-secao">
                <h3 className="he-secao__titulo">O que divergiu</h3>
                <ul className="divergencias">
                  {a.divergencias.map((d, i) => (
                    <li key={i}>
                      <strong>{d.rotulo}</strong>
                      {(d.previsto || d.realizado) && (
                        <div className="mono divergencia-linha">
                          {d.previsto && <>previsto <b>{d.previsto}</b></>}
                          {d.previsto && d.realizado && ' · '}
                          {d.realizado && <>registrado <b>{d.realizado}</b></>}
                          {d.diferencaMin !== null && <> · <b>{comSinal(d.diferencaMin)}</b></>}
                        </div>
                      )}
                      {d.detalhe && <div className="text-muted" style={{ fontSize: 12.5 }}>{d.detalhe}</div>}
                    </li>
                  ))}
                </ul>
                {a.heMin > 0 && (
                  <p className="text-muted" style={{ fontSize: 13 }}>
                    Hora extra do dia: <strong className="mono">{minutosParaHoras(a.heMin)}</strong>
                    {a.extraPrevistoMin !== null && (
                      <> · já previsto na referência: <span className="mono">{minutosParaHoras(a.extraPrevistoMin)}</span>
                        {' '}· excedente: <strong className="mono">{comSinal(a.excedenteMin)}</strong></>
                    )}
                  </p>
                )}
              </section>

              {/* Reincidência como inteligência transversal: o número aparece ao lado do caso que
                  está sendo analisado, não numa tela de ranking separada. "É a quinta vez este
                  mês" muda a conversa. */}
              {a.reincidencia.total > 0 && (
                <section className="he-secao">
                  <h3 className="he-secao__titulo"><Repeat2 size={13} /> Reincidência — últimos {a.reincidencia.janelaDias} dias</h3>
                  <ul className="reincidencia">
                    {a.reincidencia.itens.slice(0, 6).map((r) => (
                      <li key={r.tipo}>
                        <strong>{r.total}</strong> {r.rotulo.toLowerCase()}
                        <span className="text-faint"> · última em {dataBr(r.ultima)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {podeTratar && (
                <section className="he-secao">
                  <h3 className="he-secao__titulo"><MessageSquare size={13} /> Mensagem para o colaborador</h3>

                  {!mensagem ? (
                    <>
                      <p className="text-muted" style={{ fontSize: 13 }}>
                        O texto é montado a partir dos fatos acima. Nenhum horário que não esteja
                        aqui pode aparecer na mensagem.
                      </p>
                      <button
                        className="btn" disabled={geracao.estado === 'salvando'}
                        onClick={() => void gerar()}
                      >
                        <Sparkles size={14} /> Gerar mensagem
                      </button>
                    </>
                  ) : (
                    <>
                      <textarea
                        className="input" rows={4} value={mensagem.mensagem}
                        onChange={(e) => setMensagem({ ...mensagem, mensagem: e.target.value })}
                      />
                      {/* Só a observação do servidor: ela já diz a origem, e prefixar aqui
                          produzia a mesma frase duas vezes seguidas. */}
                      <p className="text-faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                        {mensagem.observacao}
                      </p>
                      <div className="acoes-linha" style={{ marginTop: 8 }}>
                        <button className="btn" onClick={() => void copiar()}>
                          <ClipboardCopy size={14} /> {copiado ? 'Copiado' : 'Copiar'}
                        </button>
                        <button className="btn btn-sm" onClick={() => void gerar()}>
                          <RefreshCw size={13} /> Gerar outra
                        </button>
                      </div>
                      <p className="he-aviso-recalculo" style={{ marginTop: 10 }}>
                        <AlertTriangle size={15} />
                        <span>Revise antes de enviar. O sistema não envia mensagem por conta própria.</span>
                      </p>
                    </>
                  )}

                  <FeedbackGravacao estado={geracao.estado} erro={geracao.erro} />
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
