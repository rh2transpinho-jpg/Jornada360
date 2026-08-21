/* Minha conta — nome de exibição e senha.
 *
 * DUAS OPERAÇÕES, DOIS RISCOS DIFERENTES, DOIS BLOCOS SEPARADOS
 * ------------------------------------------------------------
 * Trocar o nome é cosmético e reversível. Trocar a senha derruba as outras sessões da conta.
 * Juntar as duas num formulário só faria a pessoa salvar as duas coisas quando queria mudar uma —
 * e descobrir depois que foi deslogada do celular por ter corrigido um acento no próprio nome.
 *
 * O E-MAIL NÃO É EDITÁVEL, e isso está escrito na tela. Ele é a identidade e o login da conta;
 * trocá-lo é outra funcionalidade, que precisa verificar o endereço novo antes de valer.
 *
 * NENHUMA SENHA É CALCULADA, COMPARADA OU GUARDADA AQUI. O formulário envia o que foi digitado e
 * o servidor confere com o mesmo caminho do login (scrypt + comparação em tempo constante). */
import { useState } from 'react';
import { Check, KeyRound, Mail, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useGravacao } from '../data/useRecurso';
import { FeedbackGravacao } from '../components/ui/EstadosAsync';
import { alterarSenha, atualizarPerfil } from '../api/authService';

const SENHA_MINIMA = 8;

export default function MinhaConta() {
  const { usuario, recarregarSessao } = useAuth();

  const [nome, setNome] = useState(usuario?.nome ?? '');
  const perfil = useGravacao();
  const [nomeSalvo, setNomeSalvo] = useState(false);

  const [senhaAtual, setSenhaAtual] = useState('');
  const [novaSenha, setNovaSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erroLocal, setErroLocal] = useState('');
  const [senhaTrocada, setSenhaTrocada] = useState(false);
  const senha = useGravacao();

  async function salvarNome() {
    setNomeSalvo(false);
    const r = await perfil.executar(() => atualizarPerfil(nome));
    if (r) {
      /* Relê a sessão para que o topo e todo o resto passem a mostrar o nome novo sem recarregar
       * a página na mão. */
      await recarregarSessao();
      setNomeSalvo(true);
    }
  }

  async function salvarSenha() {
    setErroLocal('');
    setSenhaTrocada(false);

    /* Conferências locais são conveniência — o servidor refaz todas elas. Existem aqui só para a
     * pessoa não descobrir um erro de digitação depois de uma ida à rede. */
    if (novaSenha.length < SENHA_MINIMA) {
      return setErroLocal(`A nova senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`);
    }
    if (novaSenha !== confirmacao) {
      return setErroLocal('A confirmação não confere com a nova senha.');
    }
    if (novaSenha === senhaAtual) {
      return setErroLocal('A nova senha precisa ser diferente da atual.');
    }

    const r = await senha.executar(() => alterarSenha({ senhaAtual, novaSenha, confirmacao }));
    if (r) {
      setSenhaAtual('');
      setNovaSenha('');
      setConfirmacao('');
      setSenhaTrocada(true);
      await recarregarSessao();
    }
    return undefined;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Minha conta</h1>
          <p className="page-subtitle">Seu nome no sistema e a sua senha de acesso</p>
        </div>
      </div>

      <div className="conta-grid">
        {/* ---------------------------------------------------------------- perfil */}
        <section className="card card-pad">
          <h2 className="card-title"><span><User size={15} /> Identificação</span></h2>

          <label className="field-label" htmlFor="conta-nome">Nome de exibição</label>
          <input
            id="conta-nome"
            className="input"
            style={{ width: '100%' }}
            value={nome}
            maxLength={80}
            onChange={(e) => { setNome(e.target.value); setNomeSalvo(false); }}
            placeholder="Como você quer aparecer no sistema"
          />
          <p className="text-faint" style={{ fontSize: 11.5, margin: '4px 0 14px' }}>
            É o nome que aparece no topo, na trilha de auditoria e ao lado das justificativas que
            você registra.
          </p>

          <label className="field-label" htmlFor="conta-email">E-mail</label>
          <input
            id="conta-email"
            className="input"
            style={{ width: '100%' }}
            value={usuario?.email ?? ''}
            disabled
            readOnly
          />
          <p className="text-faint" style={{ fontSize: 11.5, margin: '4px 0 14px' }}>
            <Mail size={11} /> O e-mail identifica a sua conta e é com ele que você entra. Ele não
            é alterável por aqui.
          </p>

          <FeedbackGravacao estado={perfil.estado} erro={perfil.erro} />

          <button
            className="btn btn-primary"
            disabled={nome.trim().length < 2 || nome.trim() === usuario?.nome || perfil.estado === 'salvando'}
            onClick={() => void salvarNome()}
          >
            <Check size={15} /> Salvar nome
          </button>

          {nomeSalvo && (
            <p className="feedback feedback--ok" role="status" style={{ marginTop: 10 }}>
              <Check size={13} /> Nome atualizado.
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- senha */}
        <section className="card card-pad">
          <h2 className="card-title"><span><KeyRound size={15} /> Alterar senha</span></h2>

          <label className="field-label" htmlFor="conta-atual">Senha atual</label>
          <input
            id="conta-atual"
            type="password"
            className="input"
            style={{ width: '100%', marginBottom: 12 }}
            autoComplete="current-password"
            value={senhaAtual}
            onChange={(e) => { setSenhaAtual(e.target.value); setErroLocal(''); setSenhaTrocada(false); }}
          />

          <label className="field-label" htmlFor="conta-nova">Nova senha</label>
          <input
            id="conta-nova"
            type="password"
            className="input"
            style={{ width: '100%' }}
            autoComplete="new-password"
            value={novaSenha}
            onChange={(e) => { setNovaSenha(e.target.value); setErroLocal(''); setSenhaTrocada(false); }}
          />
          <p className="text-faint" style={{ fontSize: 11.5, margin: '4px 0 12px' }}>
            Pelo menos {SENHA_MINIMA} caracteres.
          </p>

          <label className="field-label" htmlFor="conta-confirma">Confirmar nova senha</label>
          <input
            id="conta-confirma"
            type="password"
            className="input"
            style={{ width: '100%', marginBottom: 12 }}
            autoComplete="new-password"
            value={confirmacao}
            onChange={(e) => { setConfirmacao(e.target.value); setErroLocal(''); setSenhaTrocada(false); }}
          />

          {/* Dito ANTES de trocar, não depois: alguém que usa o sistema no celular e no computador
              precisa saber que vai ter que entrar de novo no outro aparelho. */}
          <p className="conta-aviso">
            <ShieldCheck size={15} />
            <span>
              Ao trocar a senha, todos os <strong>outros</strong> dispositivos onde a sua conta
              estiver aberta serão desconectados. Aqui você continua conectada.
            </span>
          </p>

          {erroLocal && <p className="feedback feedback--erro" role="alert">{erroLocal}</p>}
          <FeedbackGravacao estado={senha.estado} erro={senha.erro} />

          <button
            className="btn btn-primary"
            disabled={!senhaAtual || !novaSenha || !confirmacao || senha.estado === 'salvando'}
            onClick={() => void salvarSenha()}
          >
            <KeyRound size={15} /> Alterar senha
          </button>

          {senhaTrocada && (
            <p className="feedback feedback--ok" role="status" style={{ marginTop: 10 }}>
              <Check size={13} /> Senha alterada. Guarde a nova senha — o envio de e-mail está
              desativado, então a recuperação depende do operador.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
