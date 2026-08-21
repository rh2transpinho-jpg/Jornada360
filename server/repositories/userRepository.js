/* Contas de acesso e sessões. Único lugar que toca as tabelas `users` e `sessions`.
 *
 * Assíncrono desde a adaptação para hospedagem gratuita: o banco pode estar do outro lado da rede
 * (ver server/db/index.js). O hash de senha continua sendo scrypt no processo Node — é justamente
 * o que a Opção A preserva e o que uma migração para edge runtime teria obrigado a enfraquecer. */
import { consultar, consultarUm, executar } from '../db/index.js';
import { novoId, hashSenha, verificarSenha, gerarToken, hashToken } from '../lib/seguranca.js';

/* Duração da sessão. 12h é conservador para um sistema de RH: longo o bastante para cobrir um
 * turno de trabalho sem reautenticar, curto o bastante para que uma máquina esquecida aberta não
 * fique acessível indefinidamente. */
const HORAS_SESSAO = 12;

export async function criarUsuario({ email, nome, senha }) {
  const id = novoId('usr');
  await executar('INSERT INTO users (id, email, nome, password_hash, criado_em, ativo) VALUES (?, ?, ?, ?, ?, 1)',
    [id, email.toLowerCase().trim(), nome.trim(), hashSenha(senha), new Date().toISOString()]);
  return { id, email: email.toLowerCase().trim(), nome: nome.trim() };
}

export function buscarPorEmail(email) {
  return consultarUm('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
}

export function buscarUsuario(id) {
  return consultarUm('SELECT id, email, nome, ativo FROM users WHERE id = ?', [id]);
}

/* Autentica e devolve o usuário, ou null.
 *
 * Devolve `null` genérico tanto para e-mail inexistente quanto para senha errada: distinguir os
 * dois casos na resposta permitiria enumerar quais e-mails têm conta no sistema. */
export async function autenticar(email, senha) {
  const u = await buscarPorEmail(email);
  if (!u || !u.ativo) return null;
  if (!verificarSenha(senha, u.password_hash)) return null;
  return { id: u.id, email: u.email, nome: u.nome };
}

/* Cria a sessão e devolve o token CRU — é a única vez que ele existe fora do cliente. O banco
 * guarda apenas o hash. */
export async function criarSessao(userId) {
  const token = gerarToken();
  const agora = new Date();
  const expira = new Date(agora.getTime() + HORAS_SESSAO * 3600_000);

  await executar('INSERT INTO sessions (id, token_hash, user_id, criado_em, expira_em) VALUES (?, ?, ?, ?, ?)',
    [novoId('ses'), hashToken(token), userId, agora.toISOString(), expira.toISOString()]);

  return { token, expiraEm: expira.toISOString() };
}

/* Resolve o token numa sessão válida. Sessão expirada é APAGADA na hora, em vez de apenas
 * ignorada — evita acúmulo de lixo e garante que um token vencido nunca reviva. */
export async function sessaoValida(token) {
  if (!token) return null;
  const s = await consultarUm('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  if (!s) return null;

  if (new Date(s.expira_em) <= new Date()) {
    await executar('DELETE FROM sessions WHERE id = ?', [s.id]);
    return null;
  }

  const u = await buscarUsuario(s.user_id);
  if (!u || !u.ativo) return null;
  return { sessaoId: s.id, usuario: { id: u.id, email: u.email, nome: u.nome } };
}

export async function encerrarSessao(token) {
  if (!token) return;
  await executar('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

/* Troca a senha e ENCERRA TODAS AS SESSÕES da conta.
 *
 * As duas coisas juntas, de propósito: se a pessoa está trocando a senha porque alguém entrou na
 * conta dela, manter as sessões abertas anularia o esforço — o invasor continuaria dentro. */
/* Nome de EXIBIÇÃO. O e-mail continua sendo a identidade e o login — ele não é alterável por aqui,
 * de propósito: trocar e-mail é mudar quem a conta é, e envolve verificar o endereço novo. */
export async function atualizarNome(userId, nome) {
  await executar('UPDATE users SET nome = ? WHERE id = ?', [nome.trim(), userId]);
  return buscarUsuario(userId);
}

export async function trocarSenha(userId, novaSenha) {
  await executar('UPDATE users SET password_hash = ? WHERE id = ?', [hashSenha(novaSenha), userId]);
  await executar('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export async function limparSessoesExpiradas() {
  await executar('DELETE FROM sessions WHERE expira_em <= ?', [new Date().toISOString()]);
}

/* Usado só pela CLI do piloto, para listar contas sem passar por rota HTTP. */
export function listarUsuarios() {
  return consultar('SELECT id, email, nome, ativo, criado_em AS criadoEm FROM users ORDER BY criado_em');
}
