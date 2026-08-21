import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppStateProvider } from './state/AppState';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { WorkspaceProvider, useSessao } from './workspace/WorkspaceContext';
import { AppLayout } from './components/layout/AppLayout';
import { Carregando, ErroAoCarregar } from './components/ui/EstadosAsync';
import BemVindo from './pages/BemVindo';

/* Code splitting por rota.
 *
 * `BemVindo` fica no bundle principal de propósito: é a primeira tela de todo visitante novo, e
 * carregá-la sob demanda só adicionaria um salto visível logo na entrada.
 *
 * As demais rotas são carregadas quando alcançadas. O ganho concreto está em três lugares:
 * Recharts (só o Dashboard usa), a Central de Relatórios e as telas públicas — juntas somavam a
 * maior parte do bundle inicial, sendo que a maioria das sessões nunca abre todas. */
const Entrar = lazy(() => import('./pages/Entrar'));
const CriarConta = lazy(() => import('./pages/CriarConta'));
const NovaEmpresa = lazy(() => import('./pages/NovaEmpresa'));
const AceitarConvite = lazy(() => import('./pages/AceitarConvite'));
const EsqueciSenha = lazy(() => import('./pages/EsqueciSenha'));
const RedefinirSenha = lazy(() => import('./pages/RedefinirSenha'));
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Apresentacao = lazy(() => import('./pages/Apresentacao'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ControlePonto = lazy(() => import('./pages/ControlePonto'));
const HorasExtras = lazy(() => import('./pages/HorasExtras'));
const ControleHE = lazy(() => import('./pages/ControleHE'));
const Escalas = lazy(() => import('./pages/Escalas'));
const HorariosPadrao = lazy(() => import('./pages/HorariosPadrao'));
const MinhaFila = lazy(() => import('./pages/MinhaFila'));
const MotorHE = lazy(() => import('./pages/MotorHE'));
const RankingReincidencia = lazy(() => import('./pages/RankingReincidencia'));
const ScoreColaborador = lazy(() => import('./pages/ScoreColaborador'));
const Pendencias = lazy(() => import('./pages/Pendencias'));
const CentroAcoes = lazy(() => import('./pages/CentroAcoes'));
const AnaliseSetor = lazy(() => import('./pages/AnaliseSetor'));
const Relatorios = lazy(() => import('./pages/Relatorios'));
const Auditoria = lazy(() => import('./pages/Auditoria'));
const ImportarDados = lazy(() => import('./pages/ImportarDados'));
const Configuracoes = lazy(() => import('./pages/settings/Configuracoes'));

/* Estado de carregamento entre rotas. Discreto de propósito: o carregamento de um chunk local
 * dura milissegundos, e um spinner grande piscando a cada navegação incomodaria mais do que
 * informaria. */
function CarregandoRota() {
  return <div className="carregando-rota">Carregando…</div>;
}

/* Rotas públicas — não exigem sessão nem empresa ativa. Ficam fora do shell da aplicação (sem
 * barra lateral, sem seletor de empresa) porque quem as vê ainda não escolheu onde entrar.
 *
 * Portfólio e Apresentação são públicos por decisão de produto e NÃO tocam repositório nenhum:
 * não existe caminho pelo qual dado de empresa chegue até lá. */
function RotasPublicas() {
  return (
    <Suspense fallback={<CarregandoRota />}>
      <Routes>
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/apresentacao" element={<Apresentacao />} />
        <Route path="/entrar" element={<Entrar />} />
        <Route path="/criar-conta" element={<CriarConta />} />
        <Route path="/nova-empresa" element={<NovaEmpresa />} />
        {/* Destino do link do e-mail de convite. Precisa existir aqui, no lado público: quem foi
            convidado normalmente ainda não tem conta nenhuma. */}
        <Route path="/convite" element={<AceitarConvite />} />
        <Route path="/esqueci-senha" element={<EsqueciSenha />} />
        <Route path="/redefinir-senha" element={<RedefinirSenha />} />
        <Route path="/bem-vindo" element={<BemVindo />} />
        {/* Qualquer outra rota cai no portão: sem empresa ativa não há o que mostrar do sistema, e
            mandar para uma empresa qualquer seria exatamente o comportamento que queremos evitar. */}
        <Route path="*" element={<BemVindo />} />
      </Routes>
    </Suspense>
  );
}

/* Rotas da aplicação — só existem quando há empresa ativa E o dado dela já foi carregado. É essa
 * garantia que permite as treze telas chamarem `useWorkspace()` e lerem dado de forma síncrona,
 * sem tratar nulo nem carregamento uma a uma. */
function RotasDaAplicacao() {
  return (
    <Suspense fallback={<CarregandoRota />}>
      <Routes>
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/apresentacao" element={<Apresentacao />} />
        <Route path="/nova-empresa" element={<NovaEmpresa />} />
        <Route path="/convite" element={<AceitarConvite />} />
        {/* Um link de e-mail pode chegar com a pessoa já logada em outra aba. Redirecionar para o
            sistema faria o link parecer quebrado; a tela continua acessível. */}
        <Route path="/redefinir-senha" element={<RedefinirSenha />} />
        <Route path="/esqueci-senha" element={<EsqueciSenha />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/ponto" element={<ControlePonto />} />
          <Route path="/he1" element={<HorasExtras />} />
          <Route path="/horas-extras" element={<ControleHE />} />
          <Route path="/motor-he" element={<MotorHE />} />
          <Route path="/escalas" element={<Escalas />} />
          <Route path="/horarios-padrao" element={<HorariosPadrao />} />
          <Route path="/fila" element={<MinhaFila />} />
          {/* Fora do menu principal, e de propósito — mas as rotas continuam vivas. O Ranking é
              alcançado pelo Dashboard, pela Análise por Setor e pelos Relatórios; a tela antiga de
              Pendências continua acessível para quem tinha o link salvo. Tirar do menu não é
              apagar: qualquer link existente continua funcionando. */}
          <Route path="/reincidencia" element={<RankingReincidencia />} />
          <Route path="/score" element={<ScoreColaborador />} />
          <Route path="/pendencias" element={<Pendencias />} />
          <Route path="/centro-de-acoes" element={<CentroAcoes />} />
          <Route path="/setores" element={<AnaliseSetor />} />
          <Route path="/relatorios" element={<Relatorios />} />
          <Route path="/auditoria" element={<Auditoria />} />
          <Route path="/importar" element={<ImportarDados />} />
          <Route path="/configuracoes" element={<Configuracoes />} />
        </Route>
        {/* Já entrou numa empresa: o portão continua acessível (para trocar de empresa ou sair),
            mas as rotas de autenticação não fazem mais sentido. */}
        <Route path="/bem-vindo" element={<BemVindo />} />
        <Route path="/entrar" element={<Navigate to="/" replace />} />
        <Route path="/criar-conta" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

/* O guarda de rota.
 *
 * IMPORTANTE, e escrito aqui para quem for mexer depois: isto NÃO é segurança. Ele decide o que
 * montar na tela, e alguém que edite o JavaScript em memória consegue burlá-lo. A segurança de
 * verdade está no servidor, que valida sessão, empresa e permissão em CADA requisição — sem dado,
 * uma tela montada indevidamente fica vazia.
 *
 * O que ele resolve é experiência: não mostrar o shell da aplicação enquanto ainda não se sabe quem
 * é a pessoa, e não deixar o usuário olhando uma tela vazia enquanto o dado vem. */
function Roteador() {
  const { estado, recarregarSessao } = useAuth();
  const { workspaceIdAtivo, workspace, carregando, erroCarregamento, recarregar, sairDoWorkspace } = useSessao();

  /* "Ainda não sei quem é" é um estado próprio: tratá-lo como "não logado" faria o portão piscar a
   * cada recarga de página para quem tem sessão válida. */
  if (estado === 'verificando') return <Carregando texto="Abrindo o Jornada360…" />;

  /* O ERRO VEM ANTES do desvio para as rotas públicas, e a ordem aqui é o comportamento.
   *
   * `workspaceIdAtivo` só é exposto DEPOIS que o dado chega — então, quando o carregamento falha,
   * ele volta a ser nulo e a condição de baixo mandaria a pessoa de volta ao portão sem dizer
   * nada. Era o que acontecia com uma empresa suspensa: o clique parecia não funcionar. Falha de
   * carregamento tem explicação própria; portão é para quem ainda não escolheu. */
  if (erroCarregamento) {
    return (
      <div className="portao">
        <div className="portao-conteudo portao-conteudo--estreito">
          <ErroAoCarregar erro={erroCarregamento} aoTentar={() => void recarregar()} />
          {/* Relê a sessão ao voltar. O que motivou: uma empresa suspensa e depois reativada
              continuava marcada como suspensa no portão, porque a lista de empresas era a que
              veio no login. Quem acabou de ser reativado veria a etiqueta errada até recarregar
              a página na mão. */}
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => {
              sairDoWorkspace();
              void recarregarSessao();
            }}
          >
            Voltar para a escolha de empresa
          </button>
        </div>
      </div>
    );
  }

  if (!workspaceIdAtivo && !carregando) return <RotasPublicas />;

  if (!workspace) return <Carregando texto="Carregando os dados da empresa…" />;

  return <RotasDaAplicacao />;
}

export default function App() {
  return (
    <AuthProvider>
      <WorkspaceProvider>
        <AppStateProvider>
          <BrowserRouter>
            <Roteador />
          </BrowserRouter>
        </AppStateProvider>
      </WorkspaceProvider>
    </AuthProvider>
  );
}
