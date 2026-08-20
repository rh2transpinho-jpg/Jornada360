/* TESTE DE ISOLAMENTO ENTRE TENANTS — o teste mais importante do backend.
 *
 * Exercita as ROTAS REAIS via requisição HTTP contra o app montado em memória. Não simula
 * middleware nem chama repositório direto: se o isolamento depender de algo que só a rota faz,
 * este teste percebe.
 *
 * O cenário é o do requisito: dois tenants, dois usuários, e a prova de que nenhum alcança o
 * dado do outro nem conhecendo o id. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

/* Banco próprio deste arquivo de teste — nunca o de trabalho. */
const DB = new URL('./__isolamento.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;

let app;
let servidor;
let base;

/* Cliente HTTP mínimo sobre fetch — evita uma dependência (supertest) só para montar requisição. */
async function req(metodo, caminho, { token, corpo } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      /* Identifica-se como cliente de API: é o que faz o servidor devolver o token no corpo em vez
       * de apenas no cookie. Um navegador não manda este cabeçalho e recebe só o cookie HttpOnly. */
      'x-jornada-cliente': 'api',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  return { status: r.status, corpo: texto ? JSON.parse(texto) : null };
}

const A = { email: 'ana@empresa-a.test', nome: 'Ana', senha: 'senha-forte-a', nomeEmpresa: 'Empresa A' };
const B = { email: 'bruno@empresa-b.test', nome: 'Bruno', senha: 'senha-forte-b', nomeEmpresa: 'Empresa B' };

let tokenA, tokenB, tenantA, tenantB;

beforeAll(async () => {
  app = criarApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const rA = await req('POST', '/api/auth/registrar', { corpo: A });
  tokenA = rA.corpo.token;
  tenantA = rA.corpo.tenants[0].id;

  const rB = await req('POST', '/api/auth/registrar', { corpo: B });
  tokenB = rB.corpo.token;
  tenantB = rB.corpo.tenants[0].id;

  /* Cada tenant recebe um dado próprio e identificável. */
  await req('POST', `/api/tenants/${tenantA}/setores`, { token: tokenA, corpo: { nome: 'Setor Exclusivo da A' } });
  await req('POST', `/api/tenants/${tenantB}/setores`, { token: tokenB, corpo: { nome: 'Setor Exclusivo da B' } });
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  try {
    rmSync(DB, { force: true });
    rmSync(`${DB}-wal`, { force: true });
    rmSync(`${DB}-shm`, { force: true });
  } catch { /* limpeza best-effort */ }
});

describe('cadastro e sessão', () => {
  it('cria conta + empresa + vínculo de administrador numa operação só', () => {
    expect(tokenA).toBeTruthy();
    expect(tenantA).toBeTruthy();
    expect(tenantA).not.toBe(tenantB);
  });

  it('recusa e-mail duplicado', async () => {
    const r = await req('POST', '/api/auth/registrar', { corpo: A });
    expect(r.status).toBe(409);
  });

  it('recusa senha curta', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { ...A, email: 'outro@test.com', senha: '123' },
    });
    expect(r.status).toBe(400);
  });

  it('autentica com a senha correta', async () => {
    const r = await req('POST', '/api/auth/entrar', { corpo: { email: A.email, senha: A.senha } });
    expect(r.status).toBe(200);
    expect(r.corpo.token).toBeTruthy();
  });

  it('recusa senha errada com mensagem genérica (não revela se o e-mail existe)', async () => {
    const existente = await req('POST', '/api/auth/entrar', { corpo: { email: A.email, senha: 'errada' } });
    const inexistente = await req('POST', '/api/auth/entrar', { corpo: { email: 'ninguem@x.com', senha: 'errada' } });
    expect(existente.status).toBe(401);
    expect(inexistente.status).toBe(401);
    expect(existente.corpo.mensagem).toBe(inexistente.corpo.mensagem);
  });

  it('nunca devolve o hash da senha em resposta alguma', async () => {
    const r = await req('GET', '/api/auth/eu', { token: tokenA });
    expect(JSON.stringify(r.corpo)).not.toContain('scrypt');
    expect(r.corpo.usuario.password_hash).toBeUndefined();
  });
});

describe('ISOLAMENTO — usuário A não alcança dados de B', () => {
  it('A lê os próprios dados', async () => {
    const r = await req('GET', `/api/tenants/${tenantA}/setores`, { token: tokenA });
    expect(r.status).toBe(200);
    expect(r.corpo[0].nome).toBe('Setor Exclusivo da A');
  });

  it('A NÃO lê dados de B, mesmo sabendo o id do tenant', async () => {
    const r = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenA });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.corpo)).not.toContain('Setor Exclusivo da B');
  });

  it('A NÃO escreve em B', async () => {
    const r = await req('POST', `/api/tenants/${tenantB}/setores`, {
      token: tokenA,
      corpo: { nome: 'Invasão' },
    });
    expect(r.status).toBe(404);

    const deB = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB });
    expect(deB.corpo.map((s) => s.nome)).not.toContain('Invasão');
  });

  it('A NÃO exclui recurso de B nem conhecendo o id do recurso', async () => {
    // IDOR clássico: o id do setor é válido, mas pertence a outro tenant.
    const setoresB = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB });
    const idDeB = setoresB.corpo[0].id;

    const r = await req('DELETE', `/api/tenants/${tenantA}/setores/${idDeB}`, { token: tokenA });
    expect([204, 404]).toContain(r.status);

    // O setor de B continua lá: o DELETE filtrou por tenant e não afetou nada.
    const depois = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB });
    expect(depois.corpo.map((s) => s.id)).toContain(idDeB);
  });

  it('A NÃO exclui a empresa de B', async () => {
    const r = await req('DELETE', `/api/tenants/${tenantB}`, { token: tokenA });
    expect(r.status).toBe(404);
    expect((await req('GET', `/api/tenants/${tenantB}`, { token: tokenB })).status).toBe(200);
  });

  it('B lê os próprios dados e não vê os de A', async () => {
    const r = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB });
    expect(r.corpo.map((s) => s.nome)).toContain('Setor Exclusivo da B');
    expect(r.corpo.map((s) => s.nome)).not.toContain('Setor Exclusivo da A');
  });

  it('B NÃO alcança dados de A', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/setores`, { token: tokenB })).status).toBe(404);
  });

  it('/api/auth/eu lista apenas os tenants do próprio usuário', async () => {
    const r = await req('GET', '/api/auth/eu', { token: tokenA });
    const ids = r.corpo.tenants.map((t) => t.id);
    expect(ids).toContain(tenantA);
    expect(ids).not.toContain(tenantB);
  });
});

describe('ISOLAMENTO — dados operacionais', () => {
  const dia = {
    snapshot: {
      dateKey: '2026-08-01',
      dateLabel: '01/08/2026',
      items: [{ motorista: 'Alguém da A', he1min: 120 }],
      totalHE: 120,
      acimaHE: 0,
      programadoHE: 0,
      semPadraoCount: 0,
      avisoPadrao: '',
    },
    caseState: {},
  };

  it('grava e lê um dia processado dentro do próprio tenant', async () => {
    const r = await req('PUT', `/api/tenants/${tenantA}/dias/2026-08-01`, { token: tokenA, corpo: dia });
    expect(r.status).toBe(200);

    const lido = await req('GET', `/api/tenants/${tenantA}/dias/2026-08-01`, { token: tokenA });
    expect(lido.corpo.snapshot.items[0].motorista).toBe('Alguém da A');
  });

  it('o dia de A não aparece em B', async () => {
    const datas = await req('GET', `/api/tenants/${tenantB}/dias`, { token: tokenB });
    expect(datas.corpo).toEqual([]);
    expect((await req('GET', `/api/tenants/${tenantB}/dias/2026-08-01`, { token: tokenB })).status).toBe(404);
  });

  it('B não consegue ler o dia de A nem com o id correto do tenant', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/dias/2026-08-01`, { token: tokenB })).status).toBe(404);
  });

  it('pendências ficam separadas por tenant', async () => {
    const p = {
      id: 'pend-a-1', data: '2026-08-01', tipo: 'divergencia_he', categoria: '', status: 'divergencia',
      prioridade: 'media', origem: 'motor_he', descricao: '', evidencias: [],
      criadaEm: new Date().toISOString(),
    };
    await req('PUT', `/api/tenants/${tenantA}/pendencias/pend-a-1`, { token: tokenA, corpo: p });

    /* O que este teste prova é ISOLAMENTO, não uma contagem exata: A enxerga a pendência que
     * criou, e B não enxerga NADA de A. Fixar "exatamente 1" tornava o teste refém de qualquer
     * pendência que o sistema passasse a gerar sozinho — foi o que aconteceu quando a HE sem
     * justificativa passou a abrir a própria pendência automaticamente. */
    const daA = (await req('GET', `/api/tenants/${tenantA}/pendencias`, { token: tokenA })).corpo;
    expect(daA.some((x) => x.id === 'pend-a-1')).toBe(true);

    const daB = (await req('GET', `/api/tenants/${tenantB}/pendencias`, { token: tokenB })).corpo;
    expect(daB.some((x) => x.id === 'pend-a-1')).toBe(false);
    expect(daB).toHaveLength(0);
  });

  it('auditoria fica separada por tenant', async () => {
    const a = await req('GET', `/api/tenants/${tenantA}/auditoria`, { token: tokenA });
    const b = await req('GET', `/api/tenants/${tenantB}/auditoria`, { token: tokenB });
    expect(a.corpo.length).toBeGreaterThan(0);
    expect(JSON.stringify(b.corpo)).not.toContain('Setor Exclusivo da A');
  });
});

describe('sessão e acesso não autenticado', () => {
  it('recusa acesso sem token', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/setores`)).status).toBe(401);
  });

  it('recusa token inválido', async () => {
    const r = await req('GET', `/api/tenants/${tenantA}/setores`, { token: 'token-falso' });
    expect(r.status).toBe(401);
  });

  it('invalida a sessão ao sair', async () => {
    const login = await req('POST', '/api/auth/entrar', { corpo: { email: B.email, senha: B.senha } });
    const t = login.corpo.token;

    expect((await req('GET', '/api/auth/eu', { token: t })).status).toBe(200);
    await req('POST', '/api/auth/sair', { token: t });
    expect((await req('GET', '/api/auth/eu', { token: t })).status).toBe(401);
  });
});

describe('defaults neutros da empresa criada via API', () => {
  it('nasce com cadastro vazio (exceto o que o próprio teste criou)', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'novo@test.com', nome: 'Novo', senha: 'senha-forte-x', nomeEmpresa: 'Empresa Nova' },
    });
    const t = r.corpo.tenants[0].id;
    const ws = await req('GET', `/api/tenants/${t}`, { token: r.corpo.token });

    expect(ws.corpo.units).toHaveLength(0);
    expect(ws.corpo.departments).toHaveLength(0);
    expect(ws.corpo.employees).toHaveLength(0);
    expect(ws.corpo.schedules).toHaveLength(0);
  });

  it('nasce com as regras nos defaults neutros e meta diária zerada', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'novo2@test.com', nome: 'Novo2', senha: 'senha-forte-y', nomeEmpresa: 'Empresa Nova 2' },
    });
    const t = r.corpo.tenants[0].id;
    const regras = await req('GET', `/api/tenants/${t}/regras`, { token: r.corpo.token });

    expect(regras.corpo.regras.toleranceMin).toBe(10);
    expect(regras.corpo.regras.dailyGoalMin).toBe(0);
    expect(regras.corpo.regras.interjourneyMinHours).toBe(11);
  });

  it('nasce como ambiente real, nunca demo', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'novo3@test.com', nome: 'Novo3', senha: 'senha-forte-z', nomeEmpresa: 'Empresa Nova 3' },
    });
    expect(r.corpo.tenants[0].environment).toBe('real');
  });
});
