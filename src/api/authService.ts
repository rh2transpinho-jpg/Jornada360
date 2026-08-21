/* Autenticação do lado do cliente.
 *
 * Não guarda senha, não guarda token, não decide permissão e não confia em nada que ele mesmo
 * calcule: quem autoriza é o servidor. Este service só conduz o fluxo (registrar/entrar/sair) e
 * expõe quem está logado e onde pode entrar.
 *
 * A sessão é um cookie `HttpOnly` — nada aqui a lê nem a escreve. É por isso que não existe
 * `guardarToken`/`obterToken` neste arquivo desde a Fase 4: se o JavaScript não tem acesso à
 * sessão, um script injetado também não tem.
 *
 * As permissões que chegam em `tenants[].permissoes` servem apenas para a interface esconder o
 * que não faz sentido oferecer. Elas NÃO são o controle de acesso — o backend recusa de novo em
 * cada rota (ver server/middlewares). */
import { api } from './client';

export interface UsuarioAutenticado {
  id: string;
  email: string;
  nome: string;
}

export type PapelUsuario = 'administrador' | 'rh' | 'gestor' | 'auditor' | 'colaborador';

export interface TenantDoUsuario {
  id: string;
  nome: string;
  environment: 'real' | 'demo';
  papel: PapelUsuario;
  permissoes: string[];
  /* 'suspensa' = acesso bloqueado pelo operador do piloto, dados preservados. Vem do servidor
   * para que a interface possa EXPLICAR em vez de fazer a empresa sumir da lista. */
  status?: 'ativa' | 'suspensa';
}

export interface RespostaSessao {
  expiraEm: string;
  usuario: UsuarioAutenticado;
  tenants: TenantDoUsuario[];
}

export function registrar(dados: {
  email: string;
  nome: string;
  senha: string;
  nomeEmpresa: string;
}): Promise<RespostaSessao> {
  return api.post<RespostaSessao>('/api/auth/registrar', dados);
}

export function entrar(email: string, senha: string): Promise<RespostaSessao> {
  return api.post<RespostaSessao>('/api/auth/entrar', { email, senha });
}

export async function sair(): Promise<void> {
  /* Falha aqui não impede o encerramento local: o AuthProvider limpa o estado de qualquer forma.
   * Uma sessão órfã no servidor expira sozinha; deixar o usuário preso numa tela logada porque a
   * rede caiu seria pior. */
  try {
    await api.post('/api/auth/sair');
  } catch {
    /* silenciado de propósito — ver acima */
  }
}

/* Nome de EXIBIÇÃO. O e-mail não é alterável: ele é a identidade e o login da conta. */
export function atualizarPerfil(nome: string): Promise<{ usuario: UsuarioAutenticado }> {
  return api.patch<{ usuario: UsuarioAutenticado }>('/api/auth/perfil', { nome });
}

/* Troca de senha de quem está logado.
 *
 * A senha atual vai junto e é conferida no SERVIDOR, pelo mesmo caminho do login. A resposta traz
 * uma sessão nova: o servidor derruba todas as sessões da conta ao trocar a senha (comportamento
 * que já valia para a redefinição por e-mail) e devolve uma sessão fresca para este dispositivo.
 * Quem trocou continua trabalhando; qualquer outro lugar logado cai. */
export function alterarSenha(dados: {
  senhaAtual: string;
  novaSenha: string;
  confirmacao: string;
}): Promise<RespostaSessao> {
  return api.post<RespostaSessao>('/api/auth/senha', dados);
}

/* Quem sou eu, segundo o servidor. Devolve null quando não há sessão — é como a aplicação
 * descobre, na abertura, se o cookie ainda vale. */
export async function quemSouEu(): Promise<{ usuario: UsuarioAutenticado; tenants: TenantDoUsuario[] } | null> {
  try {
    return await api.get<{ usuario: UsuarioAutenticado; tenants: TenantDoUsuario[] }>('/api/auth/eu');
  } catch {
    return null;
  }
}

/* Programa piloto: o portão pergunta ao servidor se a criação de conta está aberta, em vez de
 * supor. Se a consulta falhar, o padrão é `false` — oferecer um caminho fechado é pior do que
 * omitir um caminho aberto: no primeiro caso a pessoa preenche o cadastro inteiro para receber
 * uma recusa. Isto é apresentação; quem decide continua sendo o servidor, na rota de registro. */
export async function modoDeCadastro(): Promise<boolean> {
  try {
    const r = await api.get<{ cadastroAberto: boolean }>('/api/auth/modo');
    return r.cadastroAberto === true;
  } catch {
    return false;
  }
}

export function criarEmpresaRemota(nome: string): Promise<TenantDoUsuario> {
  return api.post<TenantDoUsuario>('/api/auth/tenants', { nome });
}

export function resgatarConvite(codigo: string): Promise<{ tenants: TenantDoUsuario[] }> {
  return api.post<{ tenants: TenantDoUsuario[] }>('/api/auth/convites/resgatar', { codigo });
}

/* Cria a conta a partir do convite, para quem ainda não tem nenhuma. O e-mail não vai aqui: quem
 * o define é o convite, no servidor. Aceitar um e-mail digitado permitiria usar um convite alheio
 * com outro endereço, que é justamente o que o convite nominal impede. */
export function aceitarConvite(dados: { codigo: string; nome: string; senha: string }): Promise<RespostaSessao> {
  return api.post<RespostaSessao>('/api/auth/convites/aceitar', dados);
}

/* ---------------------------------------------------------------- recuperação de senha */

/* A resposta é a MESMA exista ou não a conta — ver a rota no servidor. A tela mostra essa mensagem
 * literalmente, sem interpretar: qualquer variação aqui reintroduziria a diferença que o servidor
 * trabalhou para eliminar. */
export function pedirRecuperacao(email: string): Promise<{ ok: true; mensagem: string }> {
  return api.post<{ ok: true; mensagem: string }>('/api/auth/recuperar', { email });
}

/* Consultado ao abrir a tela do link, para não deixar a pessoa digitar uma senha nova e só então
 * descobrir que o link expirou. */
export function verificarLinkRecuperacao(codigo: string): Promise<{ ok: true }> {
  return api.get<{ ok: true }>(`/api/auth/recuperar/${encodeURIComponent(codigo)}`);
}

export function redefinirSenha(codigo: string, senha: string): Promise<{ ok: true; mensagem: string }> {
  return api.post<{ ok: true; mensagem: string }>('/api/auth/redefinir', { codigo, senha });
}
