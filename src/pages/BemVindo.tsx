/* Entrada do Jornada360.
 *
 * O QUE MUDOU, E POR QUÊ: esta tela contava a história técnica do produto — programa piloto,
 * onde os dados ficam, como funciona o isolamento entre empresas, link para o portfólio. Tudo
 * verdadeiro, e tudo irrelevante para quem chega. Quem abre um sistema de jornada quer entrar
 * nele; explicar arquitetura na porta faz o produto parecer um projeto.
 *
 * Sobraram dois caminhos, que são os dois únicos que existem de verdade: entrar, ou olhar a
 * demonstração. Cada informação removida daqui continua existindo onde tem função — o estado da
 * demonstração aparece dentro dela, e a recusa de cadastro continua sendo do servidor, não desta
 * tela.
 *
 * A ausência do servidor continua sendo dita. Não é texto técnico: é a diferença entre um botão
 * que parece quebrado e um sistema que explica o que está acontecendo. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, LogIn, PauseCircle, PlayCircle, ServerOff } from 'lucide-react';
import { useSessao, ID_DEMO } from '../workspace/WorkspaceContext';
import { useAuth } from '../auth/AuthContext';

export default function BemVindo() {
  const { setWorkspaceAtivo, empresas } = useSessao();
  const { estado, usuario, apiOnline, reconectar } = useAuth();
  const navigate = useNavigate();

  const [verificandoConexao, setVerificandoConexao] = useState(false);

  const autenticado = estado === 'autenticado';
  const empresasReais = empresas.filter((e) => e.environment !== 'demo');

  function abrir(id: string) {
    setWorkspaceAtivo(id);
    navigate('/');
  }

  async function tentarConectar() {
    setVerificandoConexao(true);
    await reconectar();
    setVerificandoConexao(false);
  }

  return (
    <div className="entrada">
      <div className="entrada__brilho" aria-hidden />

      <main className="entrada__conteudo">
        <header className="entrada__marca">
          <div className="entrada__logo" aria-hidden>J</div>
          <div>
            <h1 className="entrada__nome">JORNADA360</h1>
            <p className="entrada__assinatura">Gestão e auditoria de jornada</p>
          </div>
        </header>

        {estado === 'verificando' ? (
          <div className="entrada__carregando" role="status">Abrindo…</div>
        ) : autenticado ? (
          <>
            <p className="entrada__saudacao">
              Olá, <b>{usuario?.nome}</b>.
            </p>

            <nav className="entrada__caminhos">
              {empresasReais.map((e) => {
                /* Uma empresa suspensa continua na lista, marcada. Fazê-la sumir seria lido como
                 * "meus dados foram apagados" — e não foram. */
                const suspensa = e.status === 'suspensa';
                return (
                  <button
                    key={e.id}
                    className={`caminho ${suspensa ? 'caminho--pausado' : 'caminho--principal'}`}
                    onClick={() => abrir(e.id)}
                  >
                    <span className="caminho__icone" aria-hidden>
                      {suspensa ? <PauseCircle size={22} /> : <LogIn size={22} />}
                    </span>
                    <span className="caminho__texto">
                      <span className="caminho__titulo">{e.nome}</span>
                      <span className="caminho__desc">
                        {suspensa ? 'Acesso pausado — seus dados estão preservados' : 'Entrar'}
                      </span>
                    </span>
                    <ArrowRight size={18} className="caminho__seta" aria-hidden />
                  </button>
                );
              })}

              <button className="caminho" onClick={() => abrir(ID_DEMO)}>
                <span className="caminho__icone" aria-hidden><PlayCircle size={22} /></span>
                <span className="caminho__texto">
                  <span className="caminho__titulo">Ver demonstração</span>
                  <span className="caminho__desc">Ambiente de apresentação, separado da sua empresa</span>
                </span>
                <ArrowRight size={18} className="caminho__seta" aria-hidden />
              </button>
            </nav>
          </>
        ) : (
          <nav className="entrada__caminhos">
            <button
              className="caminho caminho--principal"
              onClick={() => navigate('/entrar')}
              disabled={!apiOnline}
            >
              <span className="caminho__icone" aria-hidden><LogIn size={22} /></span>
              <span className="caminho__texto">
                <span className="caminho__titulo">Entrar no Jornada360</span>
                <span className="caminho__desc">Acessar a sua empresa</span>
              </span>
              <ArrowRight size={18} className="caminho__seta" aria-hidden />
            </button>

            <button className="caminho" onClick={() => abrir(ID_DEMO)}>
              <span className="caminho__icone" aria-hidden><PlayCircle size={22} /></span>
              <span className="caminho__texto">
                <span className="caminho__titulo">Ver demonstração</span>
                <span className="caminho__desc">Conhecer o sistema com dados de exemplo</span>
              </span>
              <ArrowRight size={18} className="caminho__seta" aria-hidden />
            </button>
          </nav>
        )}

        {/* Servidor fora do ar é dito, não escondido: sem isto, o botão desabilitado pareceria
            defeito do sistema. A demonstração é local e continua disponível. */}
        {!apiOnline && estado !== 'verificando' && (
          <div className="entrada__aviso" role="status">
            <ServerOff size={15} aria-hidden />
            <span>
              Servidor indisponível no momento. A demonstração continua funcionando.
              <button className="btn-link" onClick={tentarConectar} disabled={verificandoConexao}>
                {verificandoConexao ? 'Verificando…' : 'Tentar novamente'}
              </button>
            </span>
          </div>
        )}
      </main>
    </div>
  );
}
