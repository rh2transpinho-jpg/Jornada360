import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Fingerprint,
  Timer,
  ClipboardCheck,
  Repeat2,
  Award,
  Inbox,
  ListChecks,
  Building2,
  CalendarRange,
  ShieldCheck,
  UploadCloud,
  Settings,
  FileText,
} from 'lucide-react';
import { useHEEngineData } from '../../engine/useHEEngineData';
import { useWorkspace } from '../../workspace/WorkspaceContext';

const NAV = [
  { to: '/', label: 'Dashboard Executivo', icon: LayoutDashboard, end: true },
  { to: '/ponto', label: 'Controle de Ponto', icon: Fingerprint },
  { to: '/he1', label: 'Horas Extras HE1', icon: Timer },
  /* Duas telas, duas perguntas diferentes: HE1 responde "quanto cada um acumulou"; o Controle
     responde "por que este colaborador teve hora extra neste dia". */
  { to: '/horas-extras', label: 'Controle de HE', icon: FileText },
  { to: '/motor-he', label: 'Assistente HE Diário', icon: ClipboardCheck },
  { to: '/reincidencia', label: 'Ranking de Reincidência', icon: Repeat2 },
  { to: '/score', label: 'Score do Colaborador', icon: Award },
  { to: '/pendencias', label: 'Pendências', icon: Inbox, countKey: 'pendencias' as const },
  { to: '/centro-de-acoes', label: 'Centro de Ações', icon: ListChecks },
  { to: '/setores', label: 'Análise por Setor', icon: Building2 },
  { to: '/relatorios', label: 'Relatórios', icon: CalendarRange },
  { to: '/auditoria', label: 'Auditoria', icon: ShieldCheck },
  { to: '/importar', label: 'Importar Dados', icon: UploadCloud },
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
];

const DIAS_SEMANA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

/* Data real do sistema — nunca fixa. Recalculada a cada render (o rodapé não precisa de estado
 * próprio: se a aba ficar aberta passando da meia-noite, o próximo render já mostra o dia certo). */
function dataRodape(): string {
  const hoje = new Date();
  const dd = String(hoje.getDate()).padStart(2, '0');
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const yyyy = hoje.getFullYear();
  return `${dd}/${mm}/${yyyy} · ${DIAS_SEMANA[hoje.getDay()]}`;
}

export function Sidebar() {
  const { dias } = useHEEngineData();
  const { workspace } = useWorkspace();
  const pendenciasAbertas = dias.reduce((s, d) => s + d.pendentes, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">J</div>
        <div className="sidebar-brand-text">
          <div className="name">JORNADA360</div>
          <div className="sub">Central Inteligente de Gestão e Auditoria de Jornada</div>
        </div>
      </div>
      <div className="sidebar-scope">{(workspace.company.nome || 'Empresa não configurada').toUpperCase()}</div>
      <nav className="sidebar-nav">
        {NAV.map(({ to, label, icon: Icon, end, countKey }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
          >
            <Icon size={17} strokeWidth={2} />
            {label}
            {countKey === 'pendencias' && pendenciasAbertas > 0 && (
              <span className="badge-count">{pendenciasAbertas}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <NavLink to="/portfolio" className="sidebar-foot-link">
          Portfólio
        </NavLink>
        <span>{dataRodape()}</span>
      </div>
    </aside>
  );
}
