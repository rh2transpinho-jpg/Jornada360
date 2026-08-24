/* Importação da escala real: arquivo → aba → datas → prévia → confirmação.
 *
 * O SISTEMA FAZ O TRABALHO DE INTERPRETAÇÃO
 * -----------------------------------------
 * A planilha da operação é uma matriz: 1.106 serviços em linhas, 69 datas em colunas, e o
 * motorista alocado dentro de cada célula. Ninguém deveria ter que transformar isso em outro
 * formato toda semana — a tela reconhece a estrutura, mostra o que entendeu e pede confirmação.
 *
 * "X" e célula vazia são PULADOS: a rota existe na estrutura, mas não foi programada naquela data.
 * Não vira serviço, não vira ausência, não vira falta de ninguém.
 *
 * Fim de semana e férias ficam fora, por decisão de escopo — e a tela diz isso em vez de ignorar
 * em silêncio. */
import { useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, FileSpreadsheet, Upload, X,
} from 'lucide-react';
import { useGravacao } from '../../data/useRecurso';
import { FeedbackGravacao } from '../../components/ui/EstadosAsync';
import { dataBr, importarServicos, previaDeServicos, type PreviaServicos } from '../../api/jornadaService';
import {
  abaEhSuportada, desdobrar, ehDiaUtil, lerTodasAsAbas, motivoDeAbaIgnorada, reconhecerMatriz,
  type MatrizDeEscala, type ServicoImportado,
} from './matriz';

type Passo = 'arquivo' | 'aba' | 'datas' | 'previa' | 'concluido';

const ROTULO_ACAO: Record<string, string> = {
  novo: 'Novo',
  troca_motorista: 'Troca de motorista',
  sem_mudanca: 'Sem mudança',
  erro: 'Não será importado',
};

export function ImportadorDeEscala({
  tenantId, aoFechar, aoConcluir,
}: {
  tenantId: string;
  aoFechar: () => void;
  aoConcluir: () => void;
}) {
  const [passo, setPasso] = useState<Passo>('arquivo');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [conteudo, setConteudo] = useState<{ abas: string[]; porAba: Record<string, unknown[][]> } | null>(null);
  const [aba, setAba] = useState('');
  const [matriz, setMatriz] = useState<MatrizDeEscala | null>(null);
  const [datasEscolhidas, setDatasEscolhidas] = useState<string[]>([]);
  const [servicos, setServicos] = useState<ServicoImportado[]>([]);
  const [naoProgramados, setNaoProgramados] = useState(0);
  const [previa, setPrevia] = useState<PreviaServicos | null>(null);
  const [erroLeitura, setErroLeitura] = useState('');
  const [resultado, setResultado] = useState<{
    novos: number; trocados: number; semMudanca: number; recusados: number;
    reprocesso: { dias: number; resolvidas: number };
  } | null>(null);

  const gravacao = useGravacao();

  async function escolherArquivo(f: File) {
    setErroLeitura('');
    setArquivo(f);
    try {
      const c = await lerTodasAsAbas(f);
      setConteudo(c);
      const suportadas = c.abas.filter(abaEhSuportada);
      if (suportadas.length === 1) {
        selecionarAba(suportadas[0], c);
      } else {
        setPasso('aba');
      }
    } catch (e) {
      setErroLeitura((e as Error).message);
    }
  }

  function selecionarAba(nome: string, c = conteudo) {
    if (!c) return;
    const m = reconhecerMatriz(c.porAba[nome] ?? [], nome, c.abas);
    setAba(nome);
    setMatriz(m);
    /* Só dias úteis vêm marcados: sábado e domingo estão fora desta integração. */
    setDatasEscolhidas(m.datas.filter((d) => ehDiaUtil(d.data) && d.preenchidas > 0).map((d) => d.data));
    setPasso('datas');
  }

  async function verPrevia() {
    if (!matriz || !conteudo) return;
    const { servicos: lista, naoProgramados: np } = desdobrar(
      conteudo.porAba[aba] ?? [], matriz, datasEscolhidas,
    );
    setServicos(lista);
    setNaoProgramados(np);

    const r = await gravacao.executar(() => previaDeServicos(tenantId, lista));
    if (r) { setPrevia(r as PreviaServicos); setPasso('previa'); }
  }

  async function confirmar() {
    const r = await gravacao.executar(() => importarServicos(tenantId, servicos, {
      arquivo: arquivo?.name ?? '', formato: 'xlsx',
    }));
    if (r) { setResultado(r as typeof resultado); setPasso('concluido'); }
  }

  const utilEscolhidas = matriz?.datas.filter((d) => datasEscolhidas.includes(d.data)) ?? [];

  return (
    <div className="he-painel-fundo" onClick={aoFechar}>
      <aside
        className="he-painel he-painel--largo"
        role="dialog"
        aria-label="Importar escala"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="he-painel__topo">
          <button className="btn btn-sm" onClick={aoFechar}><X size={14} /> Fechar</button>
          <span className="badge badge-blue">Importar escala operacional</span>
        </header>

        <div className="he-painel__corpo">
          <ol className="passos">
            {(['arquivo', 'aba', 'datas', 'previa', 'concluido'] as Passo[]).map((p, i) => (
              <li
                key={p}
                className={`passo${passo === p ? ' passo--ativo' : ''}${
                  ['arquivo', 'aba', 'datas', 'previa', 'concluido'].indexOf(passo) > i ? ' passo--feito' : ''}`}
              >
                {['Arquivo', 'Aba', 'Datas', 'Prévia', 'Concluído'][i]}
              </li>
            ))}
          </ol>

          {passo === 'arquivo' && (
            <section className="he-secao">
              <p className="text-muted" style={{ fontSize: 13.5 }}>
                Selecione a planilha de escala como ela é — o sistema reconhece a estrutura de
                serviços por data. Aceita <strong>.xlsx</strong> e <strong>.csv</strong>.
              </p>
              <label className="drop-arquivo">
                <FileSpreadsheet size={26} />
                <span>{arquivo ? arquivo.name : 'Escolher arquivo'}</span>
                <input
                  type="file" accept=".xlsx,.xls,.csv,.txt"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void escolherArquivo(f); }}
                />
              </label>
              {erroLeitura && <p className="aviso-erro"><AlertTriangle size={14} /> {erroLeitura}</p>}
            </section>
          )}

          {passo === 'aba' && conteudo && (
            <section className="he-secao">
              <h3 className="he-secao__titulo">Qual aba tem a escala diária?</h3>
              <ul className="lista-abas">
                {conteudo.abas.map((nome) => {
                  const ok = abaEhSuportada(nome);
                  return (
                    <li key={nome}>
                      <button
                        className={`btn${ok ? ' btn-primary' : ''}`}
                        disabled={!ok}
                        onClick={() => selecionarAba(nome)}
                      >
                        {nome}
                      </button>
                      {!ok && <span className="text-faint"> — {motivoDeAbaIgnorada(nome)}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {passo === 'datas' && matriz && (
            <section className="he-secao">
              <h3 className="he-secao__titulo">O que o sistema entendeu</h3>
              <ul className="lista-resultado">
                <li>Aba: <strong>{matriz.aba}</strong></li>
                <li>Cabeçalho na linha <strong>{matriz.linhaCabecalho + 1}</strong></li>
                <li><strong>{matriz.totalServicos}</strong> serviços (linhas)</li>
                <li><strong>{matriz.datas.length}</strong> colunas de data</li>
                <li>
                  Colunas reconhecidas:{' '}
                  {Object.keys(matriz.colunas).join(', ') || <span className="text-faint">nenhuma</span>}
                </li>
              </ul>

              {(!matriz.colunas.descricao || !matriz.colunas.horario) && (
                <p className="aviso-erro">
                  <AlertTriangle size={14} /> Não encontrei as colunas de descrição e horário. Confira se a
                  aba escolhida é mesmo a escala diária.
                </p>
              )}

              <h3 className="he-secao__titulo" style={{ marginTop: 16 }}>Datas a importar</h3>
              <p className="text-muted" style={{ fontSize: 12.5, marginTop: 0 }}>
                Só dias úteis vêm marcados. Sábado e domingo têm operação própria e ficam fora
                desta integração.
              </p>

              <div className="datas-grid">
                {matriz.datas.map((d) => {
                  const util = ehDiaUtil(d.data);
                  const marcada = datasEscolhidas.includes(d.data);
                  return (
                    <label key={d.data} className={`data-chip${marcada ? ' data-chip--marcada' : ''}${util ? '' : ' data-chip--fds'}`}>
                      <input
                        type="checkbox"
                        checked={marcada}
                        disabled={!util}
                        onChange={(e) => setDatasEscolhidas((atual) => (
                          e.target.checked ? [...atual, d.data] : atual.filter((x) => x !== d.data)
                        ))}
                      />
                      <span>{d.rotuloBr}</span>
                      <span className="text-faint">{d.preenchidas} alocações</span>
                    </label>
                  );
                })}
              </div>

              <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

              <div className="passo-acoes">
                <button className="btn" onClick={() => setPasso(conteudo && conteudo.abas.filter(abaEhSuportada).length > 1 ? 'aba' : 'arquivo')}>
                  <ArrowLeft size={14} /> Voltar
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!datasEscolhidas.length || gravacao.estado === 'salvando'}
                  onClick={() => void verPrevia()}
                >
                  Ver prévia de {utilEscolhidas.length} data(s) <ArrowRight size={14} />
                </button>
              </div>
            </section>
          )}

          {passo === 'previa' && previa && (
            <section className="he-secao">
              <h3 className="he-secao__titulo">Prévia — nada foi gravado ainda</h3>

              <div className="previa-resumo">
                <span className="badge badge-green">{previa.novos} novo(s)</span>
                <span className="badge badge-orange">{previa.trocados} troca(s) de motorista</span>
                <span className="badge badge-blue">{previa.semMudanca} sem mudança</span>
                {previa.comProblema > 0 && <span className="badge badge-red">{previa.comProblema} com problema</span>}
              </div>

              <ul className="lista-resultado" style={{ marginBottom: 14 }}>
                <li><strong>{previa.datas.length}</strong> data(s): {previa.datas.map((d) => dataBr(d.data)).slice(0, 6).join(', ')}
                  {previa.datas.length > 6 && ` e mais ${previa.datas.length - 6}`}</li>
                <li><strong>{previa.total}</strong> alocações no arquivo</li>
                <li><strong>{naoProgramados}</strong> células com “X” ou vazias — rota sem programação nessas datas,
                  ignoradas (não geram ausência)</li>
              </ul>

              {previa.motoristasNaoCadastrados.length > 0 && (
                <>
                  <p className="conta-aviso">
                    <AlertTriangle size={15} />
                    <span>
                      <strong>{previa.motoristasNaoCadastrados.length} nome(s) não reconhecido(s).</strong> Os
                      serviços entram assim mesmo, mas confira a grafia — o sistema não associa por
                      aproximação, de propósito.
                    </span>
                  </p>
                  <ul className="previa-problemas" style={{ color: 'var(--text-muted)' }}>
                    {previa.motoristasNaoCadastrados.slice(0, 12).map((n) => <li key={n}>{n}</li>)}
                    {previa.motoristasNaoCadastrados.length > 12 && (
                      <li>e mais {previa.motoristasNaoCadastrados.length - 12}…</li>
                    )}
                  </ul>
                </>
              )}

              {previa.ausentesNoArquivo.length > 0 && (
                <p className="conta-aviso">
                  <AlertTriangle size={15} />
                  <span>
                    Existem serviços já gravados nessas datas que <strong>não vieram</strong> neste
                    arquivo ({previa.ausentesNoArquivo.reduce((s, a) => s + a.total, 0)} no total). Eles
                    <strong> não serão removidos</strong> — um arquivo parcial apagaria o resto do dia.
                  </span>
                </p>
              )}

              <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>DATA</th><th>HORÁRIO</th><th>EMPRESA</th><th>LINHA</th>
                      <th>MOTORISTA</th><th>AÇÃO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previa.itens.map((it) => (
                      <tr key={`${it.linha}-${it.data}`} className={it.acao === 'erro' ? 'he-linha--pendente' : undefined}>
                        <td className="mono">{dataBr(it.data)}</td>
                        <td className="mono">{it.horario || '—'}</td>
                        <td>{it.empresa}</td>
                        <td className="mono">{it.linha_rota || '—'}</td>
                        <td>
                          {it.colaborador || <span className="text-faint">—</span>}
                          {it.anterior && it.anterior.colaborador !== it.colaborador && (
                            <div className="he-antes">antes {it.anterior.colaborador}</div>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${
                            it.acao === 'erro' ? 'badge-red'
                              : it.acao === 'troca_motorista' ? 'badge-orange'
                                : it.acao === 'novo' ? 'badge-green' : 'badge-blue'}`}
                          >
                            {ROTULO_ACAO[it.acao]}
                          </span>
                          {it.problemas.length > 0 && (
                            <ul className="previa-problemas">
                              {it.problemas.map((p, i) => (
                                <li key={i} className={p.aviso ? 'text-faint' : undefined}>{p.mensagem}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previa.itensOmitidos > 0 && (
                <p className="text-faint" style={{ fontSize: 11.5, marginTop: 6 }}>
                  Mostrando as primeiras {previa.itens.length} de {previa.total} alocações.
                </p>
              )}

              <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

              <div className="passo-acoes">
                <button className="btn" onClick={() => setPasso('datas')}><ArrowLeft size={14} /> Voltar</button>
                <button
                  className="btn btn-primary"
                  disabled={gravacao.estado === 'salvando' || previa.novos + previa.trocados === 0}
                  onClick={() => void confirmar()}
                >
                  <Upload size={15} /> Confirmar {previa.novos + previa.trocados} alteração(ões)
                </button>
              </div>
            </section>
          )}

          {passo === 'concluido' && resultado && (
            <section className="he-secao">
              <h3 className="he-secao__titulo"><Check size={14} /> Importação concluída</h3>
              <ul className="lista-resultado">
                <li><strong>{resultado.novos}</strong> serviço(s) criado(s)</li>
                <li><strong>{resultado.trocados}</strong> troca(s) de motorista</li>
                <li><strong>{resultado.semMudanca}</strong> sem mudança</li>
                {resultado.recusados > 0 && <li><strong>{resultado.recusados}</strong> recusado(s)</li>}
              </ul>

              {resultado.reprocesso.dias > 0 && (
                <p className="he-aviso-recalculo">
                  <Check size={15} />
                  <span>
                    <strong>{resultado.reprocesso.dias} dia(s) reanalisados</strong> — a escala entra como
                    contexto das ocorrências. A referência de jornada continua sendo o horário padrão.
                  </span>
                </p>
              )}

              <button className="btn btn-primary" onClick={aoConcluir}>Ver escala</button>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
