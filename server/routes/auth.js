/* Rotas de autenticação e de ciclo de vida de empresa.
 *
 * O fluxo de criação de conta cria, numa operação só: usuário + tenant + membership de
 * administrador. É o equivalente server-side de "Criar minha empresa" do portão de entrada.
 *
 * SESSÃO (Fase 4): a resposta define um cookie `HttpOnly` — o navegador passa a guardar a sessão
 * fora do alcance de JavaScript. O token só volta no corpo para quem se declara cliente de API
 * (`x-jornada-cliente: api`), como os testes e o curl. Ver server/lib/sessaoHttp.js. */
import { Router } from 'express';
import { autenticar, rota } from '../middlewares/index.js';
import * as usuarios from '../repositories/userRepository.js';
import * as tenants from '../repositories/tenantRepository.js';
import * as convites from '../repositories/conviteRepository.js';
import { permissoesDoPapel } from '../lib/permissoes.js';
import { limitar } from '../lib/limiteDeTaxa.js';
import * as recuperacao from '../repositories/recuperacaoRepository.js';
import { enviarEmail, mensagemRecuperacaoSenha } from '../lib/email.js';
import { carregarConfig } from '../config.js';
import { clienteQuerToken, definirCookieSessao, limparCookieSessao, tokenDaRequisicao } from '../lib/sessaoHttp.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENHA_MINIMA = 8;

/* Limites diferentes por rota porque o risco é diferente: adivinhar senha exige muitas tentativas
 * (limite apertado), criar conta em massa exige poucas (limite mais folgado, mas ainda limitado). */
const limiteLogin = limitar({
  nome: 'login',
  maximo: 10,
  janelaMs: 15 * 60 * 1000,
  mensagem: 'Muitas tentativas de entrada. Aguarde alguns minutos antes de tentar de novo.',
});

const limiteCadastro = limitar({
  nome: 'cadastro',
  maximo: 5,
  janelaMs: 60 * 60 * 1000,
  mensagem: 'Muitas contas criadas a partir deste acesso. Tente novamente mais tarde.',
});

function validarCadastro({ email, nome, senha, nomeEmpresa }) {
  if (!email || !EMAIL_RE.test(email)) return 'Informe um e-mail válido.';
  if (!nome || nome.trim().length < 2) return 'Informe seu nome.';
  if (!senha || senha.length < SENHA_MINIMA) return `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`;
  if (!nomeEmpresa || !nomeEmpresa.trim()) return 'Informe o nome da empresa.';
  return null;
}

/* Resposta de sessão: cookie sempre, token no corpo só para cliente de API. */
async function responderSessao(req, res, { usuario, token, expiraEm, status = 200 }) {
  definirCookieSessao(res, token, expiraEm);
  res.status(status).json({
    ...(clienteQuerToken(req) ? { token } : {}),
    expiraEm,
    usuario,
    tenants: (await tenants.tenantsDoUsuario(usuario.id)).map((t) => ({ ...t, permissoes: permissoesDoPapel(t.papel) })),
  });
}

/* POST /api/auth/registrar — cria conta + empresa. */
authRouter.post('/registrar', limiteCadastro, rota(async (req, res) => {
  const { email, nome, senha, nomeEmpresa } = req.body ?? {};

  /* PROGRAMA PILOTO: com o cadastro fechado, empresa nova só entra por liberação manual do
   * operador ou por convite. A recusa acontece AQUI, no servidor — esconder o botão no portão
   * seria só uma sugestão, e quem conhecesse a rota criaria a conta assim mesmo. */
  const config = carregarConfig();
  if (!config.cadastroAberto) {
    return res.status(403).json({
      erro: 'cadastro_fechado',
      mensagem:
        'O Jornada360 está em programa piloto, com um número limitado de empresas. ' +
        'O acesso é liberado por convite — fale conosco para participar.',
    });
  }

  const erro = validarCadastro({ email, nome, senha, nomeEmpresa });
  if (erro) return res.status(400).json({ erro: 'dados_invalidos', mensagem: erro });

  if (await usuarios.buscarPorEmail(email)) {
    return res.status(409).json({ erro: 'email_em_uso', mensagem: 'Já existe uma conta com este e-mail.' });
  }

  const usuario = await usuarios.criarUsuario({ email, nome, senha });
  /* O tenant criado aqui volta na lista montada por `responderSessao` — por isso o retorno de
   * `criarTenant` não é usado diretamente. */
  await tenants.criarTenant({ nome: nomeEmpresa.trim(), criadoPorUserId: usuario.id, papel: 'administrador' });
  const { token, expiraEm } = await usuarios.criarSessao(usuario.id);

  await responderSessao(req, res, { usuario, token, expiraEm, status: 201 });
}));

/* GET /api/auth/modo — o portão de entrada consulta isto para saber o que oferecer.
 *
 * Não expõe nada sensível: apenas se a criação de conta está aberta. Sem esta rota, a tela teria
 * de adivinhar — e ofereceria "Criar minha empresa" para receber uma recusa depois de a pessoa
 * preencher o formulário inteiro. */
authRouter.get('/modo', rota(async (_req, res) => {
  res.json({ cadastroAberto: carregarConfig().cadastroAberto });
}));

/* POST /api/auth/entrar */
authRouter.post('/entrar', limiteLogin, rota(async (req, res) => {
  const { email, senha } = req.body ?? {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe e-mail e senha.' });
  }

  const usuario = await usuarios.autenticar(email, senha);
  /* Mensagem genérica de propósito: distinguir "e-mail não existe" de "senha errada" permitiria
   * descobrir quais e-mails têm conta. */
  if (!usuario) {
    return res.status(401).json({ erro: 'credenciais_invalidas', mensagem: 'E-mail ou senha incorretos.' });
  }

  const { token, expiraEm } = await usuarios.criarSessao(usuario.id);
  await responderSessao(req, res, { usuario, token, expiraEm });
}));

/* POST /api/auth/sair */
authRouter.post('/sair', autenticar, rota(async (req, res) => {
  await usuarios.encerrarSessao(tokenDaRequisicao(req).token);
  limparCookieSessao(res);
  res.status(204).end();
}));

/* GET /api/auth/eu — quem sou, onde posso entrar e o que posso fazer em cada lugar. */
authRouter.get('/eu', autenticar, rota(async (req, res) => {
  const lista = await tenants.tenantsDoUsuario(req.usuario.id);
  res.json({
    usuario: req.usuario,
    tenants: lista.map((t) => ({ ...t, permissoes: permissoesDoPapel(t.papel) })),
  });
}));

/* PATCH /api/auth/perfil — muda o nome de EXIBIÇÃO.
 *
 * O e-mail não passa por aqui. Ele é a identidade e o login da conta, e trocá-lo exigiria
 * verificar o endereço novo antes — outra funcionalidade, com outro risco. O nome é só rótulo. */
authRouter.patch('/perfil', autenticar, rota(async (req, res) => {
  const nome = String(req.body?.nome ?? '').trim();
  if (nome.length < 2) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe um nome com pelo menos 2 caracteres.' });
  }
  if (nome.length > 80) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'O nome pode ter no máximo 80 caracteres.' });
  }
  const usuario = await usuarios.atualizarNome(req.usuario.id, nome);
  res.json({ usuario });
}));

/* POST /api/auth/senha — troca a senha de quem está logado.
 *
 * EXIGE A SENHA ATUAL, e a checagem é a MESMA de `entrar`: `usuarios.autenticar`, que usa
 * `verificarSenha` (scrypt + timingSafeEqual). Não existe segunda implementação de senha neste
 * arquivo — se houvesse, uma das duas ficaria para trás no dia em que os parâmetros mudassem.
 *
 * Pedir a senha atual não é burocracia: sem isso, um navegador deixado aberto vira uma troca de
 * senha que expulsa a dona da própria conta.
 *
 * SOBRE AS SESSÕES: `trocarSenha` encerra TODAS as sessões da conta — é o comportamento que já
 * valia para a redefinição por e-mail, e é o correto, porque trocar senha costuma ser reação a
 * suspeita de acesso indevido. Logo em seguida abrimos uma sessão NOVA para este dispositivo:
 * quem trocou continua trabalhando, e qualquer outro lugar logado cai. Deslogar também quem
 * acabou de digitar a senha certa seria punir o acerto. */
authRouter.post('/senha', autenticar, limiteLogin, rota(async (req, res) => {
  const { senhaAtual, novaSenha, confirmacao } = req.body ?? {};

  if (!senhaAtual || !novaSenha) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe a senha atual e a nova senha.' });
  }
  if (novaSenha.length < SENHA_MINIMA) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: `A nova senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` });
  }
  /* A confirmação é conferida no servidor também. No cliente ela é conveniência; aqui é garantia
   * de que um erro de digitação não vira uma senha que ninguém conhece. */
  if (confirmacao !== undefined && confirmacao !== novaSenha) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'A confirmação não confere com a nova senha.' });
  }
  if (novaSenha === senhaAtual) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'A nova senha precisa ser diferente da atual.' });
  }

  const confere = await usuarios.autenticar(req.usuario.email, senhaAtual);
  if (!confere) {
    /* 400, NÃO 401 — e a diferença tem consequência prática.
     *
     * O cliente trata todo 401 como "a sessão caiu" e encerra a sessão em qualquer requisição
     * (ver src/api/client.ts). Com 401 aqui, errar a própria senha atual DESLOGAVA a pessoa: ela
     * digitava errado e era jogada para a tela de entrada, sem entender por quê. Aconteceu na
     * validação em navegador.
     *
     * E 401 estaria errado de qualquer forma: a sessão é perfeitamente válida. O que falhou foi um
     * campo do formulário. */
    return res.status(400).json({ erro: 'senha_incorreta', mensagem: 'A senha atual não confere.' });
  }

  await usuarios.trocarSenha(req.usuario.id, novaSenha);

  const { token, expiraEm } = await usuarios.criarSessao(req.usuario.id);
  await responderSessao(req, res, { usuario: req.usuario, token, expiraEm });
}));

/* POST /api/auth/tenants — cria mais uma empresa para o usuário logado. Nasce vazia, com os
 * defaults neutros, e nunca copia nada de outra empresa (ver tenantRepository.criarTenant). */
authRouter.post('/tenants', autenticar, rota(async (req, res) => {
  /* PROGRAMA PILOTO: mesmo portão do cadastro. Sem isto, fechar o registro não fecharia nada —
   * bastaria criar a conta por convite e abrir quantas empresas quisesse já autenticado, e o
   * operador perderia justamente o que precisa controlar: quais empresas existem. */
  if (!carregarConfig().cadastroAberto) {
    return res.status(403).json({
      erro: 'cadastro_fechado',
      mensagem:
        'Durante o programa piloto, novas empresas são liberadas pela equipe do Jornada360. ' +
        'Fale conosco para incluir mais uma.',
    });
  }

  const { nome } = req.body ?? {};
  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe o nome da empresa.' });
  }
  const tenant = await tenants.criarTenant({ nome: nome.trim(), criadoPorUserId: req.usuario.id, papel: 'administrador' });
  res.status(201).json({ ...tenant, papel: 'administrador', permissoes: permissoesDoPapel('administrador') });
}));


/* ---------------------------------------------------------------- recuperação de senha */

const limiteRecuperacao = limitar({
  nome: 'recuperar-senha',
  maximo: 5,
  janelaMs: 60 * 60 * 1000,
  mensagem: 'Muitos pedidos de recuperação a partir deste acesso. Tente novamente mais tarde.',
});

/* POST /api/auth/recuperar — pede o link de redefinição.
 *
 * RESPONDE SEMPRE 200, exista ou não a conta. Dizer "e-mail não cadastrado" transformaria esta
 * rota num verificador de quem tem conta no sistema — que é justamente o que a mensagem genérica
 * do login existe para evitar. A pessoa que digitou errado descobre porque o e-mail não chega. */
authRouter.post('/recuperar', limiteRecuperacao, rota(async (req, res) => {
  const { email } = req.body ?? {};
  const config = carregarConfig();

  const respostaGenerica = {
    ok: true,
    mensagem: 'Se existir uma conta com este e-mail, o link de redefinição foi enviado. Confira sua caixa de entrada e o spam.',
  };

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe um e-mail válido.' });
  }

  const usuario = await usuarios.buscarPorEmail(email);
  if (!usuario || !usuario.ativo) return res.json(respostaGenerica);

  const { token } = await recuperacao.criarPedido(usuario.id, req.ip);
  const url = `${config.urlPublica}/redefinir-senha?codigo=${encodeURIComponent(token)}`;
  const msg = mensagemRecuperacaoSenha({
    nome: usuario.nome,
    url,
    validadeMinutos: recuperacao.VALIDADE_MINUTOS,
  });

  try {
    await enviarEmail(config, { para: usuario.email, ...msg });
  } catch (e) {
    /* Falha de SMTP é problema NOSSO, não do usuário — e precisa aparecer no log do servidor.
     * A resposta continua genérica: revelar a falha aqui também revelaria que a conta existe. */
    console.error('[jornada360] falha ao enviar e-mail de recuperação:', e.message);
  }

  res.json(respostaGenerica);
}));

/* GET /api/auth/recuperar/:codigo — o link é válido? Consultado ao abrir a tela, para não deixar
 * a pessoa digitar uma senha nova e só então descobrir que o link expirou. */
const MOTIVO_RECUPERACAO = {
  invalido: 'Este link de redefinição não é válido. Confira se copiou o endereço inteiro.',
  usado: 'Este link já foi utilizado. Peça um novo se ainda precisar trocar a senha.',
  expirado: 'Este link expirou. Peça um novo para continuar.',
};

authRouter.get('/recuperar/:codigo', rota(async (req, res) => {
  const r = await recuperacao.validarToken(req.params.codigo);
  if (r.erro) return res.status(400).json({ erro: 'link_invalido', motivo: r.erro, mensagem: MOTIVO_RECUPERACAO[r.erro] });
  res.json({ ok: true });
}));

/* POST /api/auth/redefinir — troca a senha e encerra TODAS as sessões da conta. */
authRouter.post('/redefinir', rota(async (req, res) => {
  const { codigo, senha } = req.body ?? {};

  if (!senha || senha.length < SENHA_MINIMA) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` });
  }

  const r = await recuperacao.validarToken(codigo);
  if (r.erro) return res.status(400).json({ erro: 'link_invalido', motivo: r.erro, mensagem: MOTIVO_RECUPERACAO[r.erro] });

  await usuarios.trocarSenha(r.pedido.user_id, senha);
  await recuperacao.marcarUsado(r.pedido.id);

  /* Não abre sessão automaticamente: quem acabou de trocar a senha deve entrar com ela, e isso
   * confirma que a nova senha realmente funciona antes de a pessoa fechar a página. */
  res.json({ ok: true, mensagem: 'Senha alterada. Entre com a nova senha.' });
}));

/* POST /api/auth/convites/resgatar — entra numa empresa para a qual você foi convidado.
 * O código é nominal e de uso único; ver conviteRepository. */
const MOTIVO_CONVITE = {
  invalido: 'Código de convite não encontrado.',
  ja_usado: 'Este convite já foi utilizado.',
  expirado: 'Este convite expirou. Peça um novo ao administrador.',
  outro_email: 'Este convite foi emitido para outro e-mail.',
};

/* POST /api/auth/convites/aceitar — cria a conta A PARTIR de um convite, para quem ainda não tem.
 *
 * Existe por causa do programa piloto. Com o cadastro fechado, a única porta era `/registrar`, que
 * cria conta E empresa — então um colega convidado por um cliente liberado não conseguia sequer
 * existir no sistema, e "configurar os usuários da empresa" ficava impossível na prática.
 *
 * Isto NÃO reabre o cadastro: o convite é a credencial. Ele é nominal, de uso único, expira em 7
 * dias, e o e-mail da conta criada é o do convite — não o que o visitante digitar. Ninguém entra
 * sem ter sido escolhido por um administrador de uma empresa que já está no piloto. */
authRouter.post('/convites/aceitar', limiteCadastro, rota(async (req, res) => {
  const { codigo, nome, senha } = req.body ?? {};

  const convite = await convites.consultarConvite(codigo);
  if (convite.erro) {
    return res.status(400).json({ erro: 'convite_invalido', mensagem: MOTIVO_CONVITE[convite.erro] });
  }

  if (!nome || nome.trim().length < 2) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe seu nome.' });
  }
  if (!senha || senha.length < SENHA_MINIMA) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` });
  }

  /* Quem já tem conta precisa ENTRAR e resgatar de dentro. Criar uma segunda conta com o mesmo
   * e-mail duplicaria a pessoa e deixaria o histórico dela partido em dois. */
  if (await usuarios.buscarPorEmail(convite.email)) {
    return res.status(409).json({
      erro: 'email_em_uso',
      mensagem: 'Já existe uma conta com este e-mail. Entre com ela e use "Entrar em outra empresa".',
    });
  }

  const usuario = await usuarios.criarUsuario({ email: convite.email, nome: nome.trim(), senha });
  const r = await convites.resgatarConvite(codigo, usuario);
  if (r.erro) {
    return res.status(400).json({ erro: 'convite_invalido', mensagem: MOTIVO_CONVITE[r.erro] });
  }
  await tenants.adicionarMembro(r.tenantId, usuario.id, r.papel);

  const { token, expiraEm } = await usuarios.criarSessao(usuario.id);
  await responderSessao(req, res, { usuario, token, expiraEm, status: 201 });
}));

authRouter.post('/convites/resgatar', autenticar, rota(async (req, res) => {
  const { codigo } = req.body ?? {};
  const r = await convites.resgatarConvite(codigo, req.usuario);
  if (r.erro) {
    return res.status(400).json({ erro: 'convite_invalido', mensagem: MOTIVO_CONVITE[r.erro] });
  }
  await tenants.adicionarMembro(r.tenantId, req.usuario.id, r.papel);
  res.json({
    tenants: (await tenants.tenantsDoUsuario(req.usuario.id)).map((t) => ({ ...t, permissoes: permissoesDoPapel(t.papel) })),
  });
}));
