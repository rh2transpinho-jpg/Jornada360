import { useLocation, useNavigate } from 'react-router-dom';
import { DoorOpen, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import { useAuth } from '../../auth/AuthContext';

const TITLES: Record<string, string> = {
  '/': 'Dashboard Executivo',
  '/ponto': 'Controle de Ponto',
  '/he1': 'Horas Extras HE1',
  '/motor-he': 'Assistente HE Diário',
  '/reincidencia': 'Ranking de Reincidência',
  '/score': 'Score do Colaborador',
  '/pendencias': 'Pendências',
  '/centro-de-acoes': 'Centro de Ações',
  '/setores': 'Análise por Setor',
  '/relatorios': 'Relatórios',
  '/auditoria': 'Auditoria',
  '/importar': 'Importar Dados',
  '/configuracoes': 'Configurações',
  '/minha-conta': 'Minha conta',
  '/fila': 'Minha Fila',
  '/escalas': 'Escalas',
  '/horarios-padrao': 'Horários Padrão',
  '/horas-extras': 'Controle de Horas Extras',
};

export function Topbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace, empresas, setWorkspaceAtivo, sairDoWorkspace, carregando, recarregar, modo, papel } = useWorkspace();
  const { usuario, sair } = useAuth();

  const title = TITLES[location.pathname] ?? 'Jornada360';
  const isDemo = workspace.environment === 'demo';

  /* Sair da conta é diferente de sair da empresa, e a interface precisa deixar isso claro: um
   * encerra a sessão no servidor, o outro só desfaz a escolha de onde estou trabalhando. */
  async function encerrarSessao() {
    sairDoWorkspace();
    await sair();
    navigate('/bem-vindo');
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-crumb">Jornada360 / {workspace.company.nome || 'empresa ainda sem nome'}</span>
        <span className="topbar-title">{title}</span>
      </div>
      <div className="topbar-controls">
        {isDemo && <span className="env-banner-demo">🟣 AMBIENTE DEMONSTRAÇÃO — dados fictícios</span>}

        {/* Recarga manual existe porque, com servidor, os dados podem ter mudado por outra pessoa
            enquanto esta tela estava aberta. */}
        {modo === 'remoto' && (
          <button
            onClick={() => void recarregar()}
            disabled={carregando}
            className="btn btn-sm btn-rotulado"
            title="Buscar as alterações mais recentes do servidor"
          >
            <RefreshCw size={13} className={carregando ? 'girando' : undefined} />
            <span className="btn-rotulado__texto">Atualizar</span>
          </button>
        )}

        <select
          className="select"
          value={workspace.id}
          onChange={(e) => setWorkspaceAtivo(e.target.value)}
          title="Trocar de empresa"
        >
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.environment === 'demo' ? '🟣' : '🟢'} {e.nome || 'Empresa sem nome'}
            </option>
          ))}
        </select>

        {/* O nome vira o caminho para "Minha conta". Um usuário procura os próprios ajustes onde o
            próprio nome está — não num item de menu lateral entre telas de operação. */}
        {modo === 'remoto' && usuario && (
          <button
            className="topbar-usuario"
            onClick={() => navigate('/minha-conta')}
            title={`${usuario.email} — papel: ${papel}. Abrir Minha conta`}
          >
            <UserRound size={13} />
            <span className="topbar-usuario__nome">{usuario.nome}</span>
          </button>
        )}

        {/* Volta ao portão de entrada. Não apaga nada — só desfaz a escolha de empresa. */}
        <button className="btn btn-sm btn-rotulado" onClick={sairDoWorkspace} title="Trocar de empresa">
          <DoorOpen size={13} />
          <span className="btn-rotulado__texto">Trocar empresa</span>
        </button>

        {/* SAIR É O ÚNICO COM RÓTULO QUE NUNCA SOME.
            Os outros botões do topo escondem o texto quando a tela aperta; este não. Um ícone de
            porta sozinho não é óbvio para quem abriu o sistema pela primeira vez, e "como eu saio
            daqui" é a pergunta que menos pode depender de passar o mouse para descobrir. */}
        {modo === 'remoto' && (
          <button
            className="btn btn-sm btn-sair"
            onClick={() => void encerrarSessao()}
            title="Encerrar a sessão e voltar para a tela de entrada"
          >
            <LogOut size={13} />
            <span>Sair</span>
          </button>
        )}
      </div>
    </header>
  );
}
