/* TESTES DO PROGRAMA PILOTO — controle de acesso comercial e canal de feedback.
 *
 * A promessa que este arquivo defende é uma frase que será dita a um cliente pagante:
 * "se o acesso for suspenso, seus dados continuam aqui e voltam intactos quando você voltar".
 * Uma suspensão que apaga, corrompe ou some com dado destrói a confiança do piloto inteiro —
 * por isso o teste central não verifica só o bloqueio, verifica o que sobrevive a ele.
 *
 * O segundo grupo defende a outra ponta: o feedback de uma empresa nunca pode aparecer para
 * outra. Ele carrega reclamação, nome de gente e descrição de processo interno — vazá-lo seria
 * pior do que vazar um relatório, porque ninguém escreve um relatório achando que é privado. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import * as piloto from './repositories/pilotoRepository.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__piloto.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;
/* O cadastro nasce aberto neste arquivo porque a maior parte dos testes precisa de empresas
 * criadas pela rota normal. O bloco que testa o fechamento liga a trava explicitamente. */
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
  return { status: r.status, corpo: t ? JSON.parse(t) : null };
}

async function novaEmpresa(prefixo) {
  const r = await req('POST', '/api/auth/registrar', {
    corpo: {
      email: `${prefixo}@piloto.test`,
      nome: `Dono ${prefixo}`,
      senha: 'senha-forte-p1',
      nomeEmpresa: `Empresa ${prefixo}`,
    },
  });
  expect(r.status).toBe(201);
  return { token: r.corpo.token, tenantId: r.corpo.tenants[0].id, usuario: r.corpo.usuario };
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

/* ---------------------------------------------------------------- suspensão e reativação */

describe('suspender uma empresa bloqueia o acesso sem tocar nos dados', () => {
  it('bloqueia leitura e escrita enquanto suspensa, e devolve tudo ao reativar', async () => {
    const { token, tenantId } = await novaEmpresa('suspensao');

    /* Trabalho real antes da suspensão: é isto que precisa sobreviver. */
    await req('POST', `/api/tenants/${tenantId}/setores`, { token, corpo: { nome: 'Operacional' } });
    await req('POST', `/api/tenants/${tenantId}/setores`, { token, corpo: { nome: 'Manutenção' } });
    const antes = await req('GET', `/api/tenants/${tenantId}/setores`, { token });
    expect(antes.corpo.map((s) => s.nome).sort()).toEqual(['Manutenção', 'Operacional']);

    await piloto.suspender(tenantId, 'Piloto encerrado');

    /* A sessão antiga morre junto com a suspensão. Sem isso, quem já estava dentro continuaria
     * trabalhando até o token expirar — a suspensão só valeria horas depois. */
    const comSessaoVelha = await req('GET', `/api/tenants/${tenantId}/setores`, { token });
    expect(comSessaoVelha.status).toBe(401);

    /* Entrar continua funcionando: o problema é da empresa, não da conta. */
    const novoLogin = await req('POST', '/api/auth/entrar', {
      corpo: { email: 'suspensao@piloto.test', senha: 'senha-forte-p1' },
    });
    expect(novoLogin.status).toBe(200);
    const token2 = novoLogin.corpo.token;

    const bloqueado = await req('GET', `/api/tenants/${tenantId}/setores`, { token: token2 });
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.corpo.erro).toBe('empresa_suspensa');
    /* A mensagem precisa dizer que o dado está preservado — é a primeira pergunta de quem vê a
     * tela travada, e uma recusa seca faria a pessoa achar que perdeu o trabalho. */
    expect(bloqueado.corpo.mensagem).toMatch(/preservados/i);
    expect(bloqueado.corpo.motivo).toBe('Piloto encerrado');

    const escritaBloqueada = await req('POST', `/api/tenants/${tenantId}/setores`, {
      token: token2,
      corpo: { nome: 'Setor durante a suspensão' },
    });
    expect(escritaBloqueada.status).toBe(403);

    await piloto.reativar(tenantId);

    const login3 = await req('POST', '/api/auth/entrar', {
      corpo: { email: 'suspensao@piloto.test', senha: 'senha-forte-p1' },
    });
    const depois = await req('GET', `/api/tenants/${tenantId}/setores`, { token: login3.corpo.token });
    expect(depois.status).toBe(200);
    /* Dois setores, exatamente os dois de antes: nada apagado e nada criado durante o bloqueio. */
    expect(depois.corpo.map((s) => s.nome).sort()).toEqual(['Manutenção', 'Operacional']);
  });

  it('continua listando a empresa suspensa em /auth/eu, marcada como suspensa', async () => {
    const { tenantId } = await novaEmpresa('listagem');
    await piloto.suspender(tenantId, null);

    const login = await req('POST', '/api/auth/entrar', {
      corpo: { email: 'listagem@piloto.test', senha: 'senha-forte-p1' },
    });
    const eu = await req('GET', '/api/auth/eu', { token: login.corpo.token });
    const empresa = eu.corpo.tenants.find((t) => t.id === tenantId);

    /* Sumir da lista seria a saída fácil e a errada: a pessoa concluiria que a empresa foi
     * excluída. Ela aparece, com o motivo à vista. */
    expect(empresa).toBeDefined();
    expect(empresa.status).toBe('suspensa');

    await piloto.reativar(tenantId);
  });

  it('não afeta as outras empresas', async () => {
    const a = await novaEmpresa('vizinha-a');
    const b = await novaEmpresa('vizinha-b');

    await piloto.suspender(a.tenantId, 'teste');

    const outra = await req('GET', `/api/tenants/${b.tenantId}/setores`, { token: b.token });
    expect(outra.status).toBe(200);

    await piloto.reativar(a.tenantId);
  });
});

/* ---------------------------------------------------------------- cadastro fechado */

describe('com o cadastro fechado, ninguém entra sozinho', () => {
  it('recusa criar conta e criar empresa nova, e anuncia isso em /auth/modo', async () => {
    const jaLogado = await novaEmpresa('antes-do-fechamento');

    process.env.JORNADA_CADASTRO_ABERTO = '0';
    try {
      const modo = await req('GET', '/api/auth/modo');
      expect(modo.corpo.cadastroAberto).toBe(false);

      const registro = await req('POST', '/api/auth/registrar', {
        corpo: { email: 'intruso@piloto.test', nome: 'Intruso', senha: 'senha-forte-x1', nomeEmpresa: 'Intrusa Ltda' },
      });
      expect(registro.status).toBe(403);
      expect(registro.corpo.erro).toBe('cadastro_fechado');

      /* A trava não pode valer só para quem está de fora. Um cliente já liberado abrindo empresas
       * à vontade tiraria do operador exatamente o controle que o piloto exige. */
      const novaPelaConta = await req('POST', '/api/auth/tenants', {
        token: jaLogado.token,
        corpo: { nome: 'Empresa extra' },
      });
      expect(novaPelaConta.status).toBe(403);
      expect(novaPelaConta.corpo.erro).toBe('cadastro_fechado');

      /* Quem já foi liberado continua trabalhando normalmente — fechar a porta não é fechar a casa. */
      const trabalho = await req('GET', `/api/tenants/${jaLogado.tenantId}/setores`, { token: jaLogado.token });
      expect(trabalho.status).toBe(200);
    } finally {
      process.env.JORNADA_CADASTRO_ABERTO = '1';
    }
  });

  it('o convite continua funcionando com o cadastro fechado', async () => {
    const dono = await novaEmpresa('convidante');
    const convite = await req('POST', `/api/tenants/${dono.tenantId}/convites`, {
      token: dono.token,
      corpo: { email: 'convidado@piloto.test', papel: 'rh' },
    });
    expect(convite.status).toBe(201);

    process.env.JORNADA_CADASTRO_ABERTO = '0';
    try {
      /* Convite é o caminho oficial de entrada no piloto: quem foi chamado por um cliente
       * liberado precisa conseguir entrar mesmo com o cadastro aberto ao público fechado. */
      const aceite = await req('POST', '/api/auth/convites/aceitar', {
        corpo: {
          codigo: convite.corpo.codigo,
          nome: 'Convidado',
          senha: 'senha-forte-c9',
        },
      });
      expect([200, 201]).toContain(aceite.status);
    } finally {
      process.env.JORNADA_CADASTRO_ABERTO = '1';
    }
  });
});

/* ---------------------------------------------------------------- feedback */

describe('feedback do piloto', () => {
  it('registra com categoria, tela e autor', async () => {
    const { token, tenantId, usuario } = await novaEmpresa('feedback');

    const r = await req('POST', `/api/tenants/${tenantId}/feedback`, {
      token,
      corpo: { categoria: 'dificuldade', mensagem: 'Não achei onde exportar o relatório.', tela: '/relatorios' },
    });
    expect(r.status).toBe(201);

    const lista = await req('GET', `/api/tenants/${tenantId}/feedback`, { token });
    expect(lista.corpo).toHaveLength(1);
    expect(lista.corpo[0].categoria).toBe('dificuldade');
    expect(lista.corpo[0].tela).toBe('/relatorios');
    /* O autor vai junto porque a resposta volta para uma pessoa, não para uma caixa anônima. */
    expect(lista.corpo[0].usuario).toBe(usuario.nome);
  });

  it('recusa categoria inventada e mensagem vazia', async () => {
    const { token, tenantId } = await novaEmpresa('feedback-invalido');

    const categoriaErrada = await req('POST', `/api/tenants/${tenantId}/feedback`, {
      token,
      corpo: { categoria: 'reclamacao', mensagem: 'algo aqui não funciona' },
    });
    expect(categoriaErrada.status).toBe(400);

    const vazio = await req('POST', `/api/tenants/${tenantId}/feedback`, {
      token,
      corpo: { categoria: 'erro', mensagem: '   ' },
    });
    expect(vazio.status).toBe(400);
  });

  it('não deixa uma empresa ler o feedback de outra', async () => {
    const a = await novaEmpresa('feedback-a');
    const b = await novaEmpresa('feedback-b');

    await req('POST', `/api/tenants/${a.tenantId}/feedback`, {
      token: a.token,
      corpo: { categoria: 'erro', mensagem: 'Segredo comercial da empresa A.' },
    });

    /* 404, não 403: confirmar a existência da empresa alheia já seria informação a mais. */
    const espiada = await req('GET', `/api/tenants/${a.tenantId}/feedback`, { token: b.token });
    expect(espiada.status).toBe(404);

    const propria = await req('GET', `/api/tenants/${b.tenantId}/feedback`, { token: b.token });
    expect(propria.corpo).toHaveLength(0);
  });

  it('o painel do operador enxerga o feedback de todas as empresas', async () => {
    /* A visão cruzada existe só aqui, fora do HTTP. Uma rota que devolvesse o feedback de todo
     * mundo seria uma porta permanente para o teste de isolamento acima falhar um dia. */
    const todos = await piloto.listarTodoFeedback({});
    expect(todos.length).toBeGreaterThanOrEqual(2);
    expect(new Set(todos.map((f) => f.tenantId)).size).toBeGreaterThanOrEqual(2);
  });
});

/* ---------------------------------------------------------------- panorama do operador */

describe('panorama de acompanhamento', () => {
  it('mostra uso por empresa e marca as suspensas', async () => {
    const { tenantId } = await novaEmpresa('panorama');
    await piloto.suspender(tenantId, 'em análise');

    const linhas = await piloto.panorama();
    const linha = linhas.find((l) => l.id === tenantId);

    expect(linha).toBeDefined();
    expect(linha.status).toBe('suspensa');
    expect(linha.usuarios).toBeGreaterThanOrEqual(1);
    /* Sem "última atividade" não há como saber se um cliente piloto está usando ou abandonou —
     * e acompanhar a implantação é justamente o que o operador precisa fazer toda semana. */
    expect(linha).toHaveProperty('ultimaAtividade');

    await piloto.reativar(tenantId);
  });
});
