/* Escalas — a programação operacional do dia.
 *
 * O QUE ESTA TELA RESPONDE
 * ------------------------
 *   "Qual é a escala de hoje?"
 *   "O que o Ademar vai fazer hoje?"
 *   "Quais serviços a VIEMAR tem hoje?"
 *   "Quem está na Linha 103?"
 *   "Quais rotas existem às 07:10?"
 *
 * O QUE ELA NÃO FAZ, E É O PONTO
 * ------------------------------
 * Não apresenta horário de serviço como horário de jornada. "ENTRADA 07:10" é a viagem que leva
 * os funcionários do cliente para dentro às 07:10 — o motorista começa antes, e a planilha não
 * diz quando. Quando o horário padrão aparece aqui, aparece com nome próprio e em bloco separado.
 *
 * Também não é o Excel na tela: a planilha é uma matriz de 1.106 serviços × 69 datas, e a tela
 * mostra um dia, ou uma pessoa num dia. */
import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle, Building2, CalendarDays, Clock, Route, Search, Upload, User,
} from 'lucide-react';
import { useSessao } from '../workspace/WorkspaceContext';
import { useRecurso } from '../data/useRecurso';
import { Carregando, ErroAoCarregar } from '../components/ui/EstadosAsync';
import { initials } from '../utils/text';
import {
  dataBr, datasComEscala, hojeIso, listarServicos, minutosParaHoras, opcoesDeServico,
  panoramaDoDia, programacaoDoDia,
  type PanoramaDia, type ServicoEscala,
} from '../api/jornadaService';
import { ImportadorDeEscala } from './escalas/ImportadorDeEscala';

const CLASSE_ROTULO: Record<string, string> = {
  entrada: 'badge-green',
  saida: 'badge-blue',
  destino: 'badge-orange',
  translado: 'badge-orange',
  extra: 'badge-orange',
  outro: 'badge-gray',
};

type Aba = 'dia' | 'motorista';

export default function Escalas() {
  const { workspaceIdAtivo, pode, modo } = useSessao();
  const tenantId = workspaceIdAtivo ?? '';
  const remoto = modo === 'remoto' && !!tenantId;

  const [aba, setAba] = useState<Aba>('dia');
  const [data, setData] = useState(hojeIso());
  const [busca, setBusca] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [filial, setFilial] = useState('');
  const [linha, setLinha] = useState('');
  const [horario, setHorario] = useState('');
  const [motorista, setMotorista] = useState('');
  const [importando, setImportando] = useState(false);

  const filtros = useMemo(
    () => ({ data, busca: busca.trim(), empresa, filial, linha, horario }),
    [data, busca, empresa, filial, linha, horario],
  );
  const chave = JSON.stringify(filtros);

  const lista = useRecurso<ServicoEscala[]>(
    () => listarServicos(tenantId, filtros),
    [tenantId, chave],
    { habilitado: remoto && aba === 'dia' },
  );

  const panorama = useRecurso(
    () => panoramaDoDia(tenantId, data),
    [tenantId, data],
    { habilitado: remoto && aba === 'dia' },
  );

  const opcoes = useRecurso(() => opcoesDeServico(tenantId), [tenantId], { habilitado: remoto });
  const datas = useRecurso(() => datasComEscala(tenantId), [tenantId], { habilitado: remoto });

  const doMotorista = useRecurso(
    () => programacaoDoDia(tenantId, data, motorista),
    [tenantId, data, motorista],
    { habilitado: remoto && aba === 'motorista' && !!motorista.trim() },
  );

  const recarregar = useCallback(() => {
    void lista.recarregar();
    void panorama.recarregar();
    void datas.recarregar();
  }, [lista, panorama, datas]);

  if (!remoto) {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Escalas</h1>
          <p className="page-subtitle">A programação operacional de cada dia</p>
        </header>
        <div className="card card-pad">
          <p className="text-muted" style={{ margin: 0 }}>
            A demonstração é local e não possui servidor de escalas. Entre na sua empresa para usar esta área.
          </p>
        </div>
      </>
    );
  }

  const servicos = lista.dados ?? [];
  const p = panorama.dados;
  const comEscala = datas.dados ?? [];

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Escalas</h1>
          <p className="page-subtitle">A programação operacional de cada dia — serviços, rotas e quem opera</p>
        </div>
        <div className="acoes-topo">
          {pode('config:escrever') && (
            <button className="btn btn-primary" onClick={() => setImportando(true)}>
              <Upload size={15} /> Importar escala
            </button>
          )}
        </div>
      </header>

      {/* O aviso que impede a leitura errada. Fica no topo porque é o mal-entendido mais caro
          que esta tela pode causar. */}
      <p className="conta-aviso" style={{ marginBottom: 16 }}>
        <Clock size={15} />
        <span>
          Os horários abaixo são <strong>operacionais</strong>: dizem quando a rota acontece, não
          quando a jornada do motorista começa ou termina. A referência de jornada é o{' '}
          <strong>Horário Padrão</strong>.
        </span>
      </p>

      <div className="card card-pad">
        <div className="toolbar toolbar--filtros">
          <div className="he-chips">
            <button className={`he-chip${aba === 'dia' ? ' he-chip--ativo' : ''}`} onClick={() => setAba('dia')}>
              <CalendarDays size={13} /> Visão do dia
            </button>
            <button className={`he-chip${aba === 'motorista' ? ' he-chip--ativo' : ''}`} onClick={() => setAba('motorista')}>
              <User size={13} /> Por motorista
            </button>
          </div>

          <div className="filtros-linha">
            <label className="campo-inline">
              <span>Data</span>
              <input type="date" className="input" value={data} onChange={(e) => setData(e.target.value)} />
            </label>
            {comEscala.length > 0 && (
              <label className="campo-inline">
                <span>Datas com escala</span>
                <select className="input" value="" onChange={(e) => e.target.value && setData(e.target.value)}>
                  <option value="">Escolher…</option>
                  {comEscala.map((d) => (
                    <option key={d.data} value={d.data}>
                      {dataBr(d.data)} — {d.servicos} serviço(s)
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {aba === 'motorista' ? (
          <PorMotorista
            motorista={motorista}
            setMotorista={setMotorista}
            data={data}
            recurso={doMotorista}
          />
        ) : (
          <VisaoDoDia
            panorama={p}
            servicos={servicos}
            lista={lista}
            opcoes={opcoes.dados}
            filtros={{ busca, empresa, filial, linha, horario }}
            setFiltro={{ setBusca, setEmpresa, setFilial, setLinha, setHorario }}
            aoVerMotorista={(nome) => { setMotorista(nome); setAba('motorista'); }}
          />
        )}
      </div>

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

/* ---------------------------------------------------------------- visão do dia */

function VisaoDoDia({
  panorama, servicos, lista, opcoes, filtros, setFiltro, aoVerMotorista,
}: {
  panorama: PanoramaDia | null | undefined;
  servicos: ServicoEscala[];
  lista: { estado: string; erro: unknown; recarregar: () => Promise<unknown> };
  opcoes: { empresas: string[]; filiais: string[]; linhas: string[]; horarios: string[] } | null;
  filtros: { busca: string; empresa: string; filial: string; linha: string; horario: string };
  setFiltro: Record<string, (v: string) => void>;
  aoVerMotorista: (nome: string) => void;
}) {
  return (
    <>
      {panorama && panorama.servicos > 0 && (
        <div className="resumo-dia" style={{ marginBottom: 16 }}>
          <div className="resumo-dia__numeros">
            <div><strong>{panorama.motoristas}</strong><span>motoristas programados</span></div>
            <div><strong>{panorama.servicos}</strong><span>serviços</span></div>
            <div><strong>{panorama.empresas}</strong><span>empresas/clientes</span></div>
            <div><strong>{panorama.linhas}</strong><span>linhas/rotas</span></div>
            {panorama.terceirizados > 0 && (
              <div><strong>{panorama.terceirizados}</strong><span>de terceiros</span></div>
            )}
          </div>
          {panorama.porRotulo.length > 0 && (
            <ul className="resumo-dia__tipos">
              {panorama.porRotulo.map((r: { rotulo: string; rotuloTexto: string; total: number }) => (
                <li key={r.rotulo}><span className="ponto" /> {r.total} {r.rotuloTexto.toLowerCase()}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="filtros-linha" style={{ marginBottom: 14 }}>
        <label className="campo-inline campo-inline--largo">
          <span><Search size={12} /> Pesquisar</span>
          <input
            className="input" placeholder="Motorista, rota, empresa ou descrição…"
            value={filtros.busca} onChange={(e) => setFiltro.setBusca(e.target.value)}
          />
        </label>
        <label className="campo-inline">
          <span><Building2 size={12} /> Empresa</span>
          <select className="input" value={filtros.empresa} onChange={(e) => setFiltro.setEmpresa(e.target.value)}>
            <option value="">Todas</option>
            {(opcoes?.empresas ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="campo-inline">
          <span>Filial</span>
          <select className="input" value={filtros.filial} onChange={(e) => setFiltro.setFilial(e.target.value)}>
            <option value="">Todas</option>
            {(opcoes?.filiais ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="campo-inline">
          <span><Route size={12} /> Linha</span>
          <select className="input" value={filtros.linha} onChange={(e) => setFiltro.setLinha(e.target.value)}>
            <option value="">Todas</option>
            {(opcoes?.linhas ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="campo-inline">
          <span><Clock size={12} /> Horário</span>
          <select className="input" value={filtros.horario} onChange={(e) => setFiltro.setHorario(e.target.value)}>
            <option value="">Todos</option>
            {(opcoes?.horarios ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      {lista.estado === 'carregando' && <Carregando texto="Carregando serviços…" />}
      {lista.erro != null && <ErroAoCarregar erro={lista.erro as never} aoTentar={() => void lista.recarregar()} />}

      {lista.estado !== 'carregando' && lista.erro == null && (
        servicos.length === 0 ? (
          <p className="text-muted" style={{ margin: '24px 0', fontSize: 13.5 }}>
            Nenhum serviço para este recorte. Importe a escala do período ou ajuste os filtros.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>HORÁRIO</th>
                  <th>MOTORISTA</th>
                  <th>EMPRESA</th>
                  <th>LINHA</th>
                  <th>DESCRIÇÃO</th>
                  <th>TIPO</th>
                </tr>
              </thead>
              <tbody>
                {servicos.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <b>{s.horario || '—'}</b>
                      {s.horarioDescricao && <div className="he-antes">na descrição {s.horarioDescricao}</div>}
                      {s.horarioCondicional && <div className="he-antes">{s.horarioCondicional}</div>}
                    </td>
                    <td>
                      <button className="link-inline" onClick={() => aoVerMotorista(s.colaborador)}>
                        <span className="name-cell">
                          <span className="avatar">{initials(s.colaborador)}</span>
                          <span className="cell-strong">{s.colaborador || '—'}</span>
                        </span>
                      </button>
                      {s.terceirizado && <div className="text-faint" style={{ fontSize: 11 }}>terceirizado</div>}
                    </td>
                    <td>
                      {s.empresa}
                      {s.filial && <div className="text-faint" style={{ fontSize: 11 }}>{s.filial}</div>}
                    </td>
                    <td className="mono">{s.linha || '—'}</td>
                    <td style={{ maxWidth: 340 }}>{s.descricao}</td>
                    <td>
                      <span className={`badge ${CLASSE_ROTULO[s.rotulo] ?? 'badge-gray'}`}>{s.rotuloTexto}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}

/* ---------------------------------------------------------------- por motorista */

function PorMotorista({
  motorista, setMotorista, data, recurso,
}: {
  motorista: string;
  setMotorista: (v: string) => void;
  data: string;
  recurso: { dados: unknown; estado: string; erro: unknown; recarregar: () => Promise<unknown> };
}) {
  const dados = recurso.dados as {
    total: number;
    servicos: ServicoEscala[];
    referenciaTrabalhista: { tipo: string; rotulo: string; faixa: string; cargaPrevistaMin: number | null };
  } | null;

  return (
    <>
      <label className="campo-inline campo-inline--largo" style={{ marginBottom: 16 }}>
        <span><Search size={12} /> Motorista</span>
        <input
          className="input"
          placeholder="Nome do motorista, como aparece na escala…"
          value={motorista}
          onChange={(e) => setMotorista(e.target.value)}
        />
      </label>

      {!motorista.trim() && (
        <p className="text-muted" style={{ margin: '20px 0', fontSize: 13.5 }}>
          Digite o nome de um motorista para ver toda a programação dele em {dataBr(data)}.
        </p>
      )}

      {motorista.trim() && recurso.estado === 'carregando' && <Carregando texto="Carregando programação…" />}

      {dados && (
        dados.total === 0 ? (
          <p className="text-muted" style={{ margin: '20px 0', fontSize: 13.5 }}>
            Nenhum serviço programado para <strong>{motorista}</strong> em {dataBr(data)}.
          </p>
        ) : (
          <>
            <h2 className="he-painel__nome" style={{ marginBottom: 2 }}>{motorista}</h2>
            <p className="he-painel__data mono" style={{ marginBottom: 16 }}>{dataBr(data)}</p>

            {/* AS DUAS FONTES, SEPARADAS E NOMEADAS. É isto que impede a leitura errada. */}
            <div className="referencia-comparacao" style={{ marginBottom: 18 }}>
              <div className="ref-bloco ref-bloco--usada">
                <span className="ref-bloco__rotulo">Referência trabalhista — horário padrão</span>
                <span className="mono">
                  {dados.referenciaTrabalhista.tipo === 'padrao'
                    ? dados.referenciaTrabalhista.faixa
                    : '— sem horário padrão vigente nesta data —'}
                </span>
                {dados.referenciaTrabalhista.cargaPrevistaMin != null && (
                  <span className="text-faint" style={{ fontSize: 11 }}>
                    carga {minutosParaHoras(dados.referenciaTrabalhista.cargaPrevistaMin)}
                  </span>
                )}
              </div>
              <div className="ref-bloco ref-bloco--ponto">
                <span className="ref-bloco__rotulo">Programação operacional — {dados.total} serviço(s)</span>
                <span className="text-faint" style={{ fontSize: 11.5 }}>
                  Horários de rota. Não definem início nem fim da jornada.
                </span>
              </div>
            </div>

            <ol className="programacao">
              {dados.servicos.map((s) => (
                <li key={s.id} className="programacao__item">
                  <span className="programacao__hora mono">{s.horario || '—'}</span>
                  <span className="programacao__corpo">
                    <span className="programacao__topo">
                      <strong>{s.empresa}</strong>
                      {s.linha && <span className="mono programacao__linha">Linha {s.linha}</span>}
                      <span className={`badge ${CLASSE_ROTULO[s.rotulo] ?? 'badge-gray'}`}>{s.rotuloTexto}</span>
                      {s.terceirizado && <span className="badge badge-gray">terceirizado</span>}
                    </span>
                    <span className="programacao__desc">{s.descricao}</span>
                    {(s.horarioDescricao || s.horarioCondicional || s.projecaoCarro) && (
                      <span className="text-faint" style={{ fontSize: 11.5 }}>
                        {s.horarioDescricao && <>horário na descrição {s.horarioDescricao} · </>}
                        {s.horarioCondicional && <>{s.horarioCondicional} · </>}
                        {s.projecaoCarro && <>carro {s.projecaoCarro}</>}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>

            {dados.servicos.some((s) => s.horarioCondicional) && (
              <p className="conta-aviso" style={{ marginTop: 14 }}>
                <AlertTriangle size={15} />
                <span>
                  Alguns serviços têm horário diferente em dias específicos, escrito no texto da
                  planilha. O sistema guarda essa observação como está e não a interpreta.
                </span>
              </p>
            )}
          </>
        )
      )}
    </>
  );
}

