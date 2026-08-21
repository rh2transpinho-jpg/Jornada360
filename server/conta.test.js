/* MINHA CONTA — nome de exibição e troca de senha.
 *
 * O que estes testes protegem:
 *
 *  1. o nome é editável, e o e-mail NÃO — e-mail é identidade e login;
 *  2. trocar a senha exige a senha atual, conferida pelo MESMO caminho do login;
 *  3. depois da troca, a senha antiga não entra mais e a nova entra;
 *  4. as outras sessões da conta caem, e a de quem trocou continua valendo;
 *  5. nenhuma senha volta em resposta nenhuma, em texto puro ou hash.
 *
 * O item 4 é o mais fácil de errar: é tentador manter todas as sessões vivas "para não incomodar",
 * e aí trocar a senha por suspeita de invasão não expulsa o invasor. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__conta.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;
process.env.JORNADA_CADASTRO_ABERTO = '1';

let servidor;
let base;

async function req(metodo, caminho, { token, corpo } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      'x-jornada-cliente': 'api',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  try {
    return { status: r.status, corpo: t ? JSON.parse(t) : null };
  } catch {
    return { status: r.status, corpo: t };
  }
}

const CONTA = {
  email: 'dona@conta.test',
  nome: 'Dona Inicial',
  senha: 'senha-inicial-2026',
  nomeEmpresa: 'Empresa da Conta',
};

let token;
let tenantId;

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await req('POST', '/api/auth/registrar', { corpo: CONTA });
  expect(r.status).toBe(201);
  token = r.corpo.token;
  tenantId = r.corpo.tenants[0].id;
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const sufixo of ['', '-wal', '-shm']) {
    try { rmSync(DB + sufixo); } catch { /* pode não existir */ }
  }
});

/* ---------------------------------------------------------------- nome */

describe('nome de exibição', () => {
  it('é editável', async () => {
    const r = await req('PATCH', '/api/auth/perfil', { token, corpo: { nome: 'Rita Ferreira' } });
    expect(r.status).toBe(200);
    expect(r.corpo.usuario.nome).toBe('Rita Ferreira');

    /* E vale para quem perguntar depois, não só na resposta imediata. */
    const eu = await req('GET', '/api/auth/eu', { token });
    expect(eu.corpo.usuario.nome).toBe('Rita Ferreira');
  });

  it('espaços em volta são removidos', async () => {
    const r = await req('PATCH', '/api/auth/perfil', { token, corpo: { nome: '   Rita F. Ferreira   ' } });
    expect(r.corpo.usuario.nome).toBe('Rita F. Ferreira');
  });

  it('recusa nome vazio ou curto demais', async () => {
    for (const nome of ['', '   ', 'R']) {
      const r = await req('PATCH', '/api/auth/perfil', { token, corpo: { nome } });
      expect(r.status).toBe(400);
    }
    /* E o nome anterior continua valendo. */
    const eu = await req('GET', '/api/auth/eu', { token });
    expect(eu.corpo.usuario.nome).toBe('Rita F. Ferreira');
  });

  it('o E-MAIL não é alterável por esta rota', async () => {
    await req('PATCH', '/api/auth/perfil', { token, corpo: { nome: 'Rita F. Ferreira', email: 'outra@conta.test' } });
    const eu = await req('GET', '/api/auth/eu', { token });
    /* O e-mail é a identidade e o login. Aceitar a troca aqui, sem verificar o endereço novo,
     * deixaria alguém se mudar para um e-mail que não controla. */
    expect(eu.corpo.usuario.email).toBe(CONTA.email);
  });

  it('exige sessão', async () => {
    const r = await req('PATCH', '/api/auth/perfil', { corpo: { nome: 'Invasor' } });
    expect(r.status).toBe(401);
  });
});

/* ---------------------------------------------------------------- senha */

describe('troca de senha', () => {
  const NOVA = 'senha-nova-forte-2026';
  let tokenDeOutroDispositivo;

  it('recusa sem a senha atual', async () => {
    const r = await req('POST', '/api/auth/senha', { token, corpo: { novaSenha: NOVA } });
    expect(r.status).toBe(400);
  });

  it('recusa quando a senha atual está errada — SEM deslogar quem errou', async () => {
    const r = await req('POST', '/api/auth/senha', {
      token, corpo: { senhaAtual: 'chute-errado-123', novaSenha: NOVA, confirmacao: NOVA },
    });

    /* 400, não 401. O cliente encerra a sessão em qualquer 401, então devolver 401 aqui fazia
     * um erro de digitação expulsar a pessoa para a tela de entrada — aconteceu na validação em
     * navegador. E a sessão está válida: o que falhou foi um campo. */
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toBe('senha_incorreta');

    /* A sessão continua valendo... */
    expect((await req('GET', '/api/auth/eu', { token })).status).toBe(200);
    /* ...e a senha continua sendo a antiga. */
    const login = await req('POST', '/api/auth/entrar', { corpo: { email: CONTA.email, senha: CONTA.senha } });
    expect(login.status).toBe(200);
  });

  it('recusa quando a confirmação não confere', async () => {
    const r = await req('POST', '/api/auth/senha', {
      token, corpo: { senhaAtual: CONTA.senha, novaSenha: NOVA, confirmacao: 'outra-coisa-2026' },
    });
    expect(r.status).toBe(400);
  });

  it('recusa senha nova curta demais', async () => {
    const r = await req('POST', '/api/auth/senha', {
      token, corpo: { senhaAtual: CONTA.senha, novaSenha: 'curta', confirmacao: 'curta' },
    });
    expect(r.status).toBe(400);
  });

  it('recusa repetir a senha atual', async () => {
    const r = await req('POST', '/api/auth/senha', {
      token, corpo: { senhaAtual: CONTA.senha, novaSenha: CONTA.senha, confirmacao: CONTA.senha },
    });
    expect(r.status).toBe(400);
  });

  it('troca com a senha atual correta', async () => {
    /* Uma segunda sessão, simulando a mesma conta aberta noutro aparelho. */
    const outro = await req('POST', '/api/auth/entrar', { corpo: { email: CONTA.email, senha: CONTA.senha } });
    tokenDeOutroDispositivo = outro.corpo.token;
    expect((await req('GET', `/api/tenants/${tenantId}`, { token: tokenDeOutroDispositivo })).status).toBe(200);

    const r = await req('POST', '/api/auth/senha', {
      token, corpo: { senhaAtual: CONTA.senha, novaSenha: NOVA, confirmacao: NOVA },
    });
    expect(r.status).toBe(200);

    /* A resposta traz uma sessão nova para ESTE dispositivo. */
    expect(r.corpo.token).toBeTruthy();
    expect(r.corpo.token).not.toBe(token);
    token = r.corpo.token;
  });

  it('a senha ANTIGA não entra mais', async () => {
    const r = await req('POST', '/api/auth/entrar', { corpo: { email: CONTA.email, senha: CONTA.senha } });
    expect(r.status).toBe(401);
  });

  it('a senha NOVA entra', async () => {
    const r = await req('POST', '/api/auth/entrar', { corpo: { email: CONTA.email, senha: NOVA } });
    expect(r.status).toBe(200);
    expect(r.corpo.usuario.email).toBe(CONTA.email);
  });

  it('quem trocou continua trabalhando', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}`, { token });
    expect(r.status).toBe(200);
  });

  it('o OUTRO dispositivo foi desconectado', async () => {
    /* É o ponto da funcionalidade: trocar a senha por suspeita de acesso indevido precisa
     * expulsar o acesso indevido. Manter as outras sessões vivas anularia a troca. */
    const r = await req('GET', `/api/tenants/${tenantId}`, { token: tokenDeOutroDispositivo });
    expect(r.status).toBe(401);
  });

  it('nenhuma resposta devolve senha, hash ou sal', async () => {
    const eu = await req('GET', '/api/auth/eu', { token });
    const texto = JSON.stringify(eu.corpo);
    expect(texto).not.toContain(NOVA);
    expect(texto).not.toContain(CONTA.senha);
    expect(texto).not.toMatch(/scrypt\$/);
    expect(texto).not.toMatch(/password_hash|passwordHash/);
  });

  it('exige sessão', async () => {
    const r = await req('POST', '/api/auth/senha', {
      corpo: { senhaAtual: NOVA, novaSenha: 'outra-senha-qualquer', confirmacao: 'outra-senha-qualquer' },
    });
    expect(r.status).toBe(401);
  });
});
