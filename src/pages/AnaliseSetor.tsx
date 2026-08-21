/* Análise por Setor — lê os agregados prontos do analyticsService (mesma regra de rateio que o
 * Dashboard Executivo usa no ranking de setores) e exibe o status unificado em cada caso. */
import { Link } from 'react-router-dom';
import { Fragment, useMemo, useState } from 'react';
import { RefreshCw, ChevronDown, ChevronRight, Repeat2 } from 'lucide-react';
import { useHEEngineData } from '../engine/useHEEngineData';
import { calcularPorSetor } from '../services/analyticsService';
import { statusDoCaso } from '../services/pendingClassificationService';
import { minToStrSigned } from '../engine/heEngineCore';
import { StatusPendenciaBadge } from '../components/ui/Badges';
import { AmbienteSemDados } from '../components/ui/Indicadores';

export default function AnaliseSetor() {
  const { dias, refresh } = useHEEngineData();
  const [aberto, setAberto] = useState<string | null>(null);

  const setores = useMemo(() => calcularPorSetor(dias), [dias]);
  const totalHE = setores.reduce((s, x) => s + x.heTotalMin, 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Análise por Setor</h1>
          <p className="page-subtitle">Hora extra agrupada por setor responsável — clique numa linha para ver os casos</p>
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
        <div className="card card-pad">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Setor</th>
                  <th>HE1 total</th>
                  <th>Casos</th>
                  <th>Divergências</th>
                  <th style={{ minWidth: 140 }}>% do total</th>
                </tr>
              </thead>
              <tbody>
                {setores.map((s) => {
                  const pct = totalHE ? Math.round((s.heTotalMin / totalHE) * 100) : 0;
                  const isOpen = aberto === s.setor;
                  return (
                    <Fragment key={s.setor}>
                      <tr style={{ cursor: 'pointer' }} onClick={() => setAberto(isOpen ? null : s.setor)}>
                        <td>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="cell-strong">
                          {s.setor}
                          {s.sintetico && (
                            <span
                              className="text-faint"
                              style={{ fontWeight: 400, marginLeft: 6, fontSize: 11.5 }}
                              title="Não é um setor da empresa: agrupa a parcela de hora extra que ficou dentro do padrão configurado."
                            >
                              (rotina normal)
                            </span>
                          )}
                        </td>
                        <td className="mono">{minToStrSigned(s.heTotalMin)}</td>
                        <td>{s.casos}</td>
                        <td>
                          {s.divergencias > 0 ? (
                            <span className="badge badge-orange">{s.divergencias}</span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="progress-track" style={{ width: 100 }}>
                              <div className="progress-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="mono">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td></td>
                          <td colSpan={5} style={{ padding: 0 }}>
                            <div style={{ padding: '4px 0 12px' }}>
                              <table className="data-table" style={{ background: 'var(--surface-muted)' }}>
                                <thead>
                                  <tr>
                                    <th>Colaborador</th>
                                    <th>Data</th>
                                    <th>Contribuição</th>
                                    <th>Situação</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.registros
                                    .slice()
                                    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
                                    .map((r, i) => (
                                      <tr key={i}>
                                        <td>{r.item.motorista}</td>
                                        <td className="mono">{r.dateLabel}</td>
                                        <td className="mono">{minToStrSigned(r.item._heMin)}</td>
                                        <td>
                                          <StatusPendenciaBadge status={statusDoCaso(r.item)} />
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
