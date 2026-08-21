/* Importação de escala em quatro passos: arquivo → mapeamento → prévia → confirmação.
 *
 * POR QUE EXISTE UM PASSO DE PRÉVIA
 * ---------------------------------
 * A escala de um dia já analisado é a base de horas extras que já foram justificadas. Trocá-la em
 * silêncio muda o veredito de casos fechados sem ninguém ver. A prévia mostra, linha a linha, o
 * que existe hoje e o que passaria a existir — e nada é gravado até alguém confirmar.
 *
 * A prévia inteira é calculada pelo SERVIDOR: é ele quem sabe o que já está no banco. Esta tela
 * só monta as linhas a partir da planilha e exibe o que voltou. */
import { useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, FileSpreadsheet, Upload, X,
} from 'lucide-react';
import { useGravacao } from '../../data/useRecurso';
import { FeedbackGravacao } from '../../components/ui/EstadosAsync';
import { dataBr, importarEscala, previaDeEscala, type PreviaImportacao } from '../../api/jornadaService';
import {
  CAMPOS, lerArquivo, montarLinhas, sugerirMapeamento,
  type CampoEscala, type Planilha,
} from './planilha';

type Passo = 'arquivo' | 'mapear' | 'previa' | 'concluido';

const ROTULO_ACAO: Record<string, string> = {
  novo: 'Nova',
  substitui: 'Substitui a atual',
  sem_mudanca: 'Sem mudança',
  erro: 'Não será importada',
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
  const [planilha, setPlanilha] = useState<Planilha | null>(null);
  const [mapa, setMapa] = useState<Partial<Record<CampoEscala, number>>>({});
  const [carga, setCarga] = useState('480');
  const [previa, setPrevia] = useState<PreviaImportacao | null>(null);
  const [erroLeitura, setErroLeitura] = useState('');
  const [resultado, setResultado] = useState<{
    criadas: number; atualizadas: number; ignoradas: number;
    reprocesso: { dias: number; resolvidas: number };
  } | null>(null);

  const gravacao = useGravacao();

  async function escolher(f: File) {
    setErroLeitura('');
    setArquivo(f);
    try {
      const p = await lerArquivo(f);
      if (!p.cabecalho.length) {
        setErroLeitura('A planilha parece vazia.');
        return;
      }
      setPlanilha(p);
      setMapa(sugerirMapeamento(p.cabecalho));
      setPasso('mapear');
    } catch (e) {
      setErroLeitura((e as Error).message);
    }
  }

  async function verPrevia() {
    if (!planilha) return;
    const linhas = montarLinhas(planilha, mapa, carga === '' ? null : Number(carga));
    const r = await gravacao.executar(() => previaDeEscala(tenantId, linhas));
    if (r) { setPrevia(r as PreviaImportacao); setPasso('previa'); }
  }

  async function confirmar() {
    if (!planilha) return;
    const linhas = montarLinhas(planilha, mapa, carga === '' ? null : Number(carga));
    const r = await gravacao.executar(() => importarEscala(tenantId, linhas, {
      arquivo: arquivo?.name ?? '', formato: planilha.formato,
    }));
    if (r) {
      setResultado(r as typeof resultado);
      setPasso('concluido');
    }
  }

  const faltaObrigatorio = CAMPOS.filter((c) => c.obrigatorio && mapa[c.id] === undefined);

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
          <span className="badge badge-blue">Importar escala</span>
        </header>

        <div className="he-painel__corpo">
          <ol className="passos">
            {(['arquivo', 'mapear', 'previa', 'concluido'] as Passo[]).map((p, i) => (
              <li key={p} className={`passo${passo === p ? ' passo--ativo' : ''}${['arquivo', 'mapear', 'previa', 'concluido'].indexOf(passo) > i ? ' passo--feito' : ''}`}>
                {['Arquivo', 'Mapear colunas', 'Prévia', 'Concluído'][i]}
              </li>
            ))}
          </ol>

          {passo === 'arquivo' && (
            <section className="he-secao">
              <p className="text-muted" style={{ fontSize: 13.5 }}>
                Selecione a planilha de escala. Aceita <strong>.xlsx</strong> e <strong>.csv</strong>.
                A primeira linha precisa conter os nomes das colunas.
              </p>
              <label className="drop-arquivo">
                <FileSpreadsheet size={26} />
                <span>{arquivo ? arquivo.name : 'Escolher arquivo'}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.txt"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void escolher(f); }}
                />
              </label>
              {erroLeitura && (
                <p className="aviso-erro"><AlertTriangle size={14} /> {erroLeitura}</p>
              )}
            </section>
          )}

          {passo === 'mapear' && planilha && (
            <section className="he-secao">
              <h3 className="he-secao__titulo">Mapear colunas</h3>
              <p className="text-muted" style={{ fontSize: 13 }}>
                O sistema tentou reconhecer as colunas pelo nome. Confira antes de continuar —
                uma coluna trocada aqui contamina a análise de todo o período.
              </p>

              <div className="mapa-grid">
                {CAMPOS.map((campo) => (
                  <label key={campo.id} className="campo-inline">
                    <span>
                      {campo.rotulo}
                      {campo.obrigatorio && <strong style={{ color: 'var(--danger)' }}> *</strong>}
                    </span>
                    <select
                      className="input"
                      value={mapa[campo.id] ?? ''}
                      onChange={(e) => setMapa((m) => ({
                        ...m,
                        [campo.id]: e.target.value === '' ? undefined : Number(e.target.value),
                      }))}
                    >
                      <option value="">— não usar —</option>
                      {planilha.cabecalho.map((c, i) => (
                        <option key={i} value={i}>{c || `(coluna ${i + 1})`}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <label className="campo-inline" style={{ marginTop: 12 }}>
                <span>Carga prevista do dia (minutos)</span>
                <input
                  type="number" className="input" value={carga}
                  onChange={(e) => setCarga(e.target.value)}
                />
              </label>
              <p className="text-faint" style={{ fontSize: 11.5, marginTop: 4 }}>
                Usada para calcular quanto de extra já estava previsto na escala. 480 = 8 horas.
              </p>

              {faltaObrigatorio.length > 0 && (
                <p className="aviso-erro">
                  <AlertTriangle size={14} /> Falta mapear: {faltaObrigatorio.map((c) => c.rotulo).join(', ')}.
                </p>
              )}

              <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

              <div className="passo-acoes">
                <button className="btn" onClick={() => setPasso('arquivo')}><ArrowLeft size={14} /> Voltar</button>
                <button
                  className="btn btn-primary"
                  disabled={faltaObrigatorio.length > 0 || gravacao.estado === 'salvando'}
                  onClick={() => void verPrevia()}
                >
                  Ver prévia <ArrowRight size={14} />
                </button>
              </div>
            </section>
          )}

          {passo === 'previa' && previa && (
            <section className="he-secao">
              <h3 className="he-secao__titulo">Prévia — nada foi gravado ainda</h3>

              <div className="previa-resumo">
                <span className="badge badge-green">{previa.novos} nova(s)</span>
                <span className="badge badge-orange">{previa.substituicoes} substituição(ões)</span>
                <span className="badge badge-blue">{previa.semMudanca} sem mudança</span>
                {previa.comProblema > 0 && <span className="badge badge-red">{previa.comProblema} com problema</span>}
              </div>

              {previa.substituicoes > 0 && (
                <p className="he-aviso-recalculo">
                  <AlertTriangle size={15} />
                  <span>
                    <strong>{previa.substituicoes} escala(s) já existem para essas datas.</strong> Confira
                    o antes e o depois abaixo: alterar a escala de um dia já analisado muda a
                    referência usada para calcular a hora extra daquele dia.
                  </span>
                </p>
              )}

              <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>COLABORADOR</th>
                      <th>DATA</th>
                      <th>SITUAÇÃO</th>
                      <th>HORÁRIO</th>
                      <th>AÇÃO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previa.itens.map((item) => (
                      <tr key={item.linha} className={item.acao === 'erro' ? 'he-linha--pendente' : undefined}>
                        <td className="mono text-faint">{item.linha}</td>
                        <td>
                          {item.colaborador || <span className="text-faint">— vazio —</span>}
                          {!item.colaboradorConhecido && item.colaborador && (
                            <div className="text-faint" style={{ fontSize: 11 }}>não consta no cadastro</div>
                          )}
                        </td>
                        <td className="mono">{item.data ? dataBr(item.data) : '—'}</td>
                        <td>{item.rotuloSituacao}</td>
                        <td className="mono">
                          {item.faixa || '—'}
                          {item.anterior && item.anterior.faixa !== item.faixa && (
                            <div className="he-antes">antes {item.anterior.faixa}</div>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${
                            item.acao === 'erro' ? 'badge-red'
                              : item.acao === 'substitui' ? 'badge-orange'
                                : item.acao === 'novo' ? 'badge-green' : 'badge-blue'
                          }`}>
                            {ROTULO_ACAO[item.acao]}
                          </span>
                          {item.problemas.length > 0 && (
                            <ul className="previa-problemas">
                              {item.problemas.map((p, i) => (
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

              <FeedbackGravacao estado={gravacao.estado} erro={gravacao.erro} />

              <div className="passo-acoes">
                <button className="btn" onClick={() => setPasso('mapear')}><ArrowLeft size={14} /> Voltar</button>
                <button
                  className="btn btn-primary"
                  disabled={gravacao.estado === 'salvando' || previa.novos + previa.substituicoes === 0}
                  onClick={() => void confirmar()}
                >
                  <Upload size={15} /> Confirmar importação de {previa.novos + previa.substituicoes} linha(s)
                </button>
              </div>
            </section>
          )}

          {passo === 'concluido' && resultado && (
            <section className="he-secao">
              <h3 className="he-secao__titulo"><Check size={14} /> Importação concluída</h3>
              <ul className="lista-resultado">
                <li><strong>{resultado.criadas}</strong> escala(s) criada(s)</li>
                <li><strong>{resultado.atualizadas}</strong> atualizada(s)</li>
                <li><strong>{resultado.ignoradas}</strong> ignorada(s)</li>
              </ul>

              {/* A parte que o usuário não pediu mas é a mais útil: a importação reprocessou os
                  dias afetados, e pendências que existiam por falta de escala se encerraram. */}
              {resultado.reprocesso.dias > 0 && (
                <p className="he-aviso-recalculo">
                  <Check size={15} />
                  <span>
                    <strong>{resultado.reprocesso.dias} dia(s) foram reanalisados</strong> com a nova escala
                    {resultado.reprocesso.resolvidas > 0 && (
                      <> e <strong>{resultado.reprocesso.resolvidas} pendência(s) se resolveram sozinhas</strong>,
                        porque a causa delas deixou de existir</>
                    )}.
                  </span>
                </p>
              )}

              <button className="btn btn-primary" onClick={aoConcluir}>Ver escalas</button>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
