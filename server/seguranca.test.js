/* Testes das defesas acrescentadas na Fase 4: cookie de sessão, proteção contra CSRF, limite de
 * tentativas e cabeçalhos de resposta.
 *
 * Cada teste aqui corresponde a um ataque concreto, não a uma configuração genérica. É por isso
 * que os nomes descrevem o que o atacante tentaria fazer, e não o nome do mecanismo. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { _limparTudo } from './lib/limiteDeTaxa.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__seguranca.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;

let servidor;
let base;

async function req(metodo, caminho, { corpo, cabecalhos = {} } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null, cabecalhos: r.headers };
}

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      rmSync(DB + sufixo);
    } catch {
      /* pode não existir */
    }
  }
});

beforeEach(() => _limparTudo());

/* ---------------------------------------------------------------- sessão em cookie */

describe('a sessão viaja em cookie HttpOnly', () => {
  it('define o cookie com HttpOnly, SameSite e Path na criação da conta', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'cookie@seg.test', nome: 'Cookie', senha: 'senha-forte-c1', nomeEmpresa: 'Cookie Ltda' },
    });
    expect(r.status).toBe(201);

    const setCookie = r.cabecalhos.get('set-cookie') ?? '';
    expect(setCookie).toContain('jornada360_sessao=');
    /* HttpOnly é o ponto: com ele, um script injetado na página não consegue LER a sessão e
     * levá-la para outra máquina. */
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
  });

  /* Um navegador não manda `x-jornada-cliente: api`, então o token nunca chega ao JavaScript da
   * página — é isso que torna o HttpOnly efetivo, e não apenas decorativo. */
  it('NÃO devolve o token no corpo para um cliente de navegador', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'semtoken@seg.test', nome: 'Sem Token', senha: 'senha-forte-s1', nomeEmpresa: 'Sem Token Ltda' },
    });
    expect(r.corpo.token).toBeUndefined();
    expect(r.corpo.usuario.email).toBe('semtoken@seg.test');
  });

  it('devolve o token apenas para quem se declara cliente de API', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      cabecalhos: { 'x-jornada-cliente': 'api' },
      corpo: { email: 'comtoken@seg.test', nome: 'Com Token', senha: 'senha-forte-t1', nomeEmpresa: 'Com Token Ltda' },
    });
    expect(r.corpo.token).toBeTruthy();
  });

  it('o cookie sozinho autentica — sem nenhum cabeçalho de autorização', async () => {
    const entrada = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'so-cookie@seg.test', nome: 'Só Cookie', senha: 'senha-forte-k1', nomeEmpresa: 'Só Cookie Ltda' },
    });
    const cookie = (entrada.cabecalhos.get('set-cookie') ?? '').split(';')[0];

    const eu = await req('GET', '/api/auth/eu', { cabecalhos: { cookie } });
    expect(eu.status).toBe(200);
    expect(eu.corpo.usuario.email).toBe('so-cookie@seg.test');
  });

  it('sair apaga o cookie e invalida a sessão no servidor', async () => {
    const entrada = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'saida@seg.test', nome: 'Saída', senha: 'senha-forte-q1', nomeEmpresa: 'Saída Ltda' },
    });
    const cookie = (entrada.cabecalhos.get('set-cookie') ?? '').split(';')[0];

    const saiu = await req('POST', '/api/auth/sair', { cabecalhos: { cookie, 'x-jornada-cliente': 'web' } });
    expect(saiu.status).toBe(204);
    expect(saiu.cabecalhos.get('set-cookie')).toContain('Max-Age=0');

    /* O cookie antigo não revive: a sessão foi apagada do banco, não apenas do navegador. */
    expect((await req('GET', '/api/auth/eu', { cabecalhos: { cookie } })).status).toBe(401);
  });
});

/* ---------------------------------------------------------------- CSRF */

describe('proteção contra requisição forjada por outro site', () => {
  let cookie;
  let tenantId;

  beforeAll(async () => {
    const r = await req('POST', '/api/auth/registrar', {
      cabecalhos: { 'x-jornada-cliente': 'api' },
      corpo: { email: 'csrf@seg.test', nome: 'CSRF', senha: 'senha-forte-f1', nomeEmpresa: 'CSRF Ltda' },
    });
    cookie = (r.cabecalhos.get('set-cookie') ?? '').split(';')[0];
    tenantId = r.corpo.tenants[0].id;
  });

  /* O cenário real: a vítima está logada e visita um site malicioso, que dispara um POST para a
   * API. O navegador anexa o cookie sozinho — mas não consegue definir um cabeçalho customizado
   * sem passar por preflight de CORS, que a lista de origens recusa. */
  it('recusa uma escrita autenticada por cookie sem o cabeçalho do cliente web', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, {
      cabecalhos: { cookie },
      corpo: { id: 'forjado', nome: 'Setor forjado' },
    });
    expect(r.status).toBe(403);
    expect(r.corpo.erro).toBe('origem_nao_confiavel');
  });

  it('a mesma escrita passa quando vem da própria aplicação', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, {
      cabecalhos: { cookie, 'x-jornada-cliente': 'web' },
      corpo: { id: 'legitimo', nome: 'Setor legítimo' },
    });
    expect(r.status).toBe(201);
  });

  /* LEITURA não altera estado; exigir o cabeçalho nela só quebraria clientes sem ganho. */
  it('permite leitura por cookie sem o cabeçalho', async () => {
    expect((await req('GET', `/api/tenants/${tenantId}/setores`, { cabecalhos: { cookie } })).status).toBe(200);
  });

  /* Um Bearer não é enviado sozinho pelo navegador: não existe o vetor, então não há o que exigir. */
  it('não exige o cabeçalho de quem usa Bearer', async () => {
    const login = await req('POST', '/api/auth/entrar', {
      cabecalhos: { 'x-jornada-cliente': 'api' },
      corpo: { email: 'csrf@seg.test', senha: 'senha-forte-f1' },
    });
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, {
      cabecalhos: { authorization: `Bearer ${login.corpo.token}` },
      corpo: { id: 'via-api', nome: 'Via API' },
    });
    expect(r.status).toBe(201);
  });
});

/* ---------------------------------------------------------------- limite de tentativas */

describe('limite de tentativas', () => {
  /* Em teste o limite fica desligado — uma suíte que cria dezenas de contas em segundos esbarraria
   * nele e falharia por um motivo que não é o do teste. Aqui ele é ligado de propósito, para
   * provar que existe e funciona. */
  const ambienteAnterior = process.env.NODE_ENV;
  const vitestAnterior = process.env.VITEST;

  const cadastroAnterior = process.env.JORNADA_CADASTRO_ABERTO;

  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    process.env.VITEST = 'false';
    /* Em produção o cadastro nasce FECHADO (programa piloto). Aqui ele é aberto de propósito:
     * o que está sob teste é o limite de tentativas, não o portão do piloto. */
    process.env.JORNADA_CADASTRO_ABERTO = '1';
  });

  afterAll(() => {
    process.env.NODE_ENV = ambienteAnterior;
    process.env.VITEST = vitestAnterior;
    process.env.JORNADA_CADASTRO_ABERTO = cadastroAnterior;
  });

  it('bloqueia após tentativas repetidas de senha e diz quando tentar de novo', async () => {
    await req('POST', '/api/auth/registrar', {
      cabecalhos: { 'x-jornada-cliente': 'api' },
      corpo: { email: 'alvo@seg.test', nome: 'Alvo', senha: 'senha-forte-a1', nomeEmpresa: 'Alvo Ltda' },
    });
    _limparTudo();

    const respostas = [];
    for (let i = 0; i < 12; i += 1) {
      respostas.push(await req('POST', '/api/auth/entrar', { corpo: { email: 'alvo@seg.test', senha: 'chute-errado' } }));
    }

    expect(respostas.filter((r) => r.status === 401).length).toBe(10);
    const bloqueada = respostas.find((r) => r.status === 429);
    expect(bloqueada).toBeTruthy();
    expect(bloqueada.corpo.erro).toBe('muitas_tentativas');
    expect(bloqueada.cabecalhos.get('retry-after')).toBeTruthy();

    /* A senha CORRETA também é barrada enquanto o bloqueio vale — se ela passasse, o limite não
     * atrapalharia em nada quem estivesse adivinhando. Vai no mesmo teste porque depende do estado
     * deixado pelas tentativas acima. */
    const comSenhaCerta = await req('POST', '/api/auth/entrar', { corpo: { email: 'alvo@seg.test', senha: 'senha-forte-a1' } });
    expect(comSenhaCerta.status).toBe(429);
  });

  it('limita a criação de contas em massa a partir do mesmo acesso', async () => {
    _limparTudo();
    const respostas = [];
    for (let i = 0; i < 7; i += 1) {
      respostas.push(
        await req('POST', '/api/auth/registrar', {
          corpo: { email: `massa${i}@seg.test`, nome: `Massa ${i}`, senha: 'senha-forte-m1', nomeEmpresa: `Massa ${i}` },
        }),
      );
    }
    expect(respostas.filter((r) => r.status === 201).length).toBe(5);
    expect(respostas.filter((r) => r.status === 429).length).toBe(2);
  });
});

/* ---------------------------------------------------------------- respostas */

describe('o que o servidor devolve', () => {
  it('define os cabeçalhos de segurança em toda resposta', async () => {
    const r = await req('GET', '/api/saude');
    expect(r.cabecalhos.get('x-content-type-options')).toBe('nosniff');
    expect(r.cabecalhos.get('x-frame-options')).toBe('DENY');
    expect(r.cabecalhos.get('referrer-policy')).toBe('no-referrer');
  });

  it('nunca devolve stack trace nem caminho interno ao cliente', async () => {
    const r = await req('POST', '/api/auth/entrar', { corpo: { email: 'x' } });
    const texto = JSON.stringify(r.corpo);
    expect(texto).not.toMatch(/at \w+ \(/);
    expect(texto).not.toContain('\\server\\');
    expect(texto).not.toContain('/server/');
    expect(r.corpo.mensagem).toBeTruthy();
  });

  it('a senha nunca volta em resposta nenhuma', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      cabecalhos: { 'x-jornada-cliente': 'api' },
      corpo: { email: 'segredo@seg.test', nome: 'Segredo', senha: 'senha-super-secreta-9', nomeEmpresa: 'Segredo Ltda' },
    });
    const texto = JSON.stringify(r.corpo);
    expect(texto).not.toContain('senha-super-secreta-9');
    expect(texto).not.toMatch(/password|scrypt/i);
  });
});
