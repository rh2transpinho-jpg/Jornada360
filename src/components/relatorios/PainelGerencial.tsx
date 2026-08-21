/* Resumo semanal e leitura gerencial.
 *
 * OS NÚMEROS SÃO DO SISTEMA; O TEXTO PODE SER DA IA
 * -------------------------------------------------
 * Todo valor aqui — jornadas analisadas, divergências, hora extra, variação sobre o período
 * anterior, setor com mais HE — vem de contagem no banco. A IA, quando houver credencial,
 * recebe esses números já apurados e escreve a leitura; ela interpreta, não apura.
 *
 * A distinção aparece na tela de propósito: quem lê a resposta tem o direito de saber se aquilo
 * passou por um modelo de linguagem. Sem credencial, a leitura sai igual, em texto determinístico
 * — o painel nunca fica indisponível por causa da IA. */
import { useCallback, useState } from 'react';
import { CalendarRange, MessageSquare, RefreshCw, Send, Sparkles } from 'lucide-react';
import { useRecurso, useGravacao } from '../../data/useRecurso';
import { Carregando, ErroAoCarregar, FeedbackGravacao } from '../ui/EstadosAsync';
import {
  analiseGerencial, estadoDaIA, hojeIso, resumoSemanal,
  type ResumoSemanal,
} from '../../api/jornadaService';

const PERGUNTAS = [
  'Por que aumentaram as horas extras esta semana?',
  'Qual setor teve mais divergências?',
  'Quais tipos de ocorrência estão aumentando?',
  'Quais casos precisam de atenção hoje?',
];

export function PainelGerencial({ tenantId }: { tenantId: string }) {
  const [ate, setAte] = useState(hojeIso());
  const [dias, setDias] = useState(7);
  const [pergunta, setPergunta] = useState('');
  const [resposta, setResposta] = useState<{ resposta: string; origem: string; observacao: string } | null>(null);

  const semanal = useRecurso<ResumoSemanal>(
    () => resumoSemanal(tenantId, ate, dias),
    [tenantId, ate, dias],
  );
  const ia = useRecurso(() => estadoDaIA(tenantId), [tenantId]);
  const consulta = useGravacao();

  const perguntar = useCallback(async (texto: string) => {
    if (texto.trim().length < 5) return;
    const r = await consulta.executar(() => analiseGerencial(tenantId, texto, { ate, dias }));
    if (r) setResposta(r as typeof resposta);
  }, [consulta, tenantId, ate, dias]);

  const s = semanal.dados;

  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <div className="toolbar toolbar--filtros">
        <h2 className="card-title" style={{ margin: 0 }}>
          <span><CalendarRange size={15} /> Resumo do período</span>
        </h2>
        <div className="filtros-linha">
          <label className="campo-inline">
            <span>Até</span>
            <input type="date" className="input" value={ate} onChange={(e) => setAte(e.target.value)} />
          </label>
          <label className="campo-inline">
            <span>Janela</span>
            <select className="input" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
              <option value={7}>7 dias</option>
              <option value={14}>14 dias</option>
              <option value={30}>30 dias</option>
            </select>
          </label>
          <button className="btn" onClick={() => void semanal.recarregar()}>
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      </div>

      {semanal.estado === 'carregando' && <Carregando texto="Apurando o período…" />}
      {semanal.erro && <ErroAoCarregar erro={semanal.erro} aoTentar={() => void semanal.recarregar()} />}

      {s && (
        s.processados === 0 ? (
          <p className="text-muted" style={{ margin: 0, fontSize: 13.5 }}>
            Nenhuma jornada analisada entre {s.deBr} e {s.ateBr}.
          </p>
        ) : (
          <>
            <div className="resumo-dia">
              <div className="resumo-dia__numeros">
                <div><strong>{s.processados}</strong><span>jornadas analisadas</span></div>
                <div><strong>{s.colaboradores}</strong><span>colaboradores</span></div>
                <div className="atencao"><strong>{s.divergencias}</strong><span>divergências</span></div>
                <div className="ok"><strong>{s.resolvidas}</strong><span>resolvidas</span></div>
                <div><strong>{s.abertas}</strong><span>aguardando</span></div>
                <div><strong>{s.heTotal}</strong><span>de hora extra</span></div>
              </div>

              <ul className="resumo-dia__tipos">
                {/* A comparação só aparece quando há base. "Sem base suficiente" é informação —
                    silenciar faria a estabilidade e a falta de dado parecerem a mesma coisa. */}
                {s.comparacao ? (
                  <li>
                    <span className={`ponto ponto--${s.comparacao.heVariacaoMin > 0 ? 'atencao' : 'ok'}`} />
                    Hora extra {s.comparacao.heVariacaoMin === 0 ? 'igual ao' : s.comparacao.heVariacaoMin > 0 ? 'acima do' : 'abaixo do'} período anterior
                    {s.comparacao.heVariacaoMin !== 0 && <> ({s.comparacao.heVariacao})</>}
                  </li>
                ) : (
                  <li className="text-faint">{s.observacaoComparacao}</li>
                )}
                {s.ocorrenciaMaisFrequente && (
                  <li><span className="ponto" /> Mais frequente: {s.ocorrenciaMaisFrequente.rotulo.toLowerCase()} ({s.ocorrenciaMaisFrequente.total})</li>
                )}
                {s.setorComMaisHE && (
                  <li><span className="ponto" /> Maior HE: {s.setorComMaisHE.setor} ({s.setorComMaisHE.he})</li>
                )}
              </ul>
            </div>

            <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '18px 0 14px' }} />

            <h3 className="he-secao__titulo"><MessageSquare size={13} /> Perguntar sobre estes números</h3>
            <p className="text-muted" style={{ fontSize: 12.5, marginTop: 0 }}>
              A resposta é construída sobre os valores acima. {ia.dados?.configurado
                ? 'A IA interpreta os números; ela não os calcula.'
                : 'Sem IA configurada, a leitura sai em texto determinístico — com exatamente a mesma informação.'}
            </p>

            <div className="he-chips" style={{ marginBottom: 10 }}>
              {PERGUNTAS.map((p) => (
                <button
                  key={p}
                  className="he-chip"
                  disabled={consulta.estado === 'salvando'}
                  onClick={() => { setPergunta(p); void perguntar(p); }}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="filtros-linha" style={{ alignItems: 'stretch' }}>
              <input
                className="input"
                style={{ flex: 1, minWidth: 240 }}
                placeholder="Ou escreva a sua pergunta…"
                value={pergunta}
                onChange={(e) => setPergunta(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void perguntar(pergunta); }}
              />
              <button
                className="btn btn-primary"
                disabled={pergunta.trim().length < 5 || consulta.estado === 'salvando'}
                onClick={() => void perguntar(pergunta)}
              >
                <Send size={14} /> Perguntar
              </button>
            </div>

            <FeedbackGravacao estado={consulta.estado} erro={consulta.erro} />

            {resposta && (
              <div className="he-justificativa-atual" style={{ marginTop: 12 }}>
                <div className="he-justificativa-atual__motivo">
                  {resposta.origem === 'ia'
                    ? <><Sparkles size={12} /> Leitura da IA</>
                    : 'Leitura factual'}
                </div>
                <p>{resposta.resposta}</p>
                <div className="he-justificativa-atual__rodape">
                  <span>{resposta.observacao}</span>
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
