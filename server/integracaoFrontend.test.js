/* Teste de integração: o CONTRATO que o frontend espera, exercitado contra o backend real.
 *
 * Prova que a promessa da arquitetura em camadas se sustenta: o mesmo contrato de repositório que
 * o frontend usa localmente funciona contra a API — só a implementação mudou.
 *
 * Roda em Node (não jsdom) e usa fetch direto contra o app em memória, replicando exatamente as
 * chamadas que `RemoteEmpresaRepository` faz. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { REGRAS_PADRAO } from './repositories/tenantRepository.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__integracao.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;

let servidor, base, token, tenantId;

async function req(metodo, caminho, corpo) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-jornada-cliente': 'api', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  const app = criarApp();
  await new Promise((r) => { servidor = app.listen(0, r); });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await req('POST', '/api/auth/registrar', {
    email: 'contrato@test.com', nome: 'Contrato', senha: 'senha-forte-123', nomeEmpresa: 'Empresa Contrato',
  });
  token = r.corpo.token;
  tenantId = r.corpo.tenants[0].id;
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

describe('carregarTudo — carga completa do cadastro numa requisição', () => {
  it('devolve todas as coleções que o WorkspaceConfig do frontend espera', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}`);
    const ws = r.corpo;

    // As mesmas chaves de src/domain/WorkspaceConfig.ts.
    for (const chave of ['company', 'units', 'departments', 'schedules', 'employees', 'integrations', 'users', 'rules', 'causaOpts']) {
      expect(ws).toHaveProperty(chave);
    }
    expect(ws.environment).toBe('real');
    expect(ws.papel).toBe('administrador');
  });

  it('as regras vêm com os mesmos 7 campos e valores de domain/Rules.ts', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}`);
    expect(r.corpo.rules).toEqual(REGRAS_PADRAO);
  });
});

describe('contrato de cadastro — mesmo formato do repositório local', () => {
  it('unidade: salvar devolve o objeto com id, listar traz de volta', async () => {
    const salva = await req('POST', `/api/tenants/${tenantId}/unidades`, {
      nome: 'Matriz', codigo: 'M1', localizacao: 'Porto Alegre/RS',
    });
    expect(salva.corpo.id).toBeTruthy();
    expect(salva.corpo.nome).toBe('Matriz');

    const lista = await req('GET', `/api/tenants/${tenantId}/unidades`);
    expect(lista.corpo.map((u) => u.nome)).toContain('Matriz');
  });

  it('setor: campo unidadeId chega em camelCase, como o domínio espera', async () => {
    const unidades = await req('GET', `/api/tenants/${tenantId}/unidades`);
    const salvo = await req('POST', `/api/tenants/${tenantId}/setores`, {
      nome: 'Produção', unidadeId: unidades.corpo[0].id, responsavel: 'Coordenação',
    });
    expect(salvo.corpo.unidadeId).toBe(unidades.corpo[0].id);

    const lista = await req('GET', `/api/tenants/${tenantId}/setores`);
    expect(lista.corpo[0]).toHaveProperty('unidadeId');
  });

  it('escala: arrays sobrevivem à ida e volta do banco', async () => {
    // dias_trabalhados/folgas são guardados como JSON em TEXT — precisam voltar como array.
    const salva = await req('POST', `/api/tenants/${tenantId}/escalas`, {
      nome: 'Turno padrão', entrada: '08:00', saida: '17:00',
      diasTrabalhados: ['seg', 'ter', 'qua'], folgas: ['sab', 'dom'], heProgramadaMin: 60,
    });
    expect(salva.status).toBe(201);

    const lista = await req('GET', `/api/tenants/${tenantId}/escalas`);
    expect(lista.corpo[0].diasTrabalhados).toEqual(['seg', 'ter', 'qua']);
    expect(lista.corpo[0].heProgramadaMin).toBe(60);
  });

  it('colaborador: vínculos com setor e unidade são preservados', async () => {
    const [unidades, setores] = await Promise.all([
      req('GET', `/api/tenants/${tenantId}/unidades`),
      req('GET', `/api/tenants/${tenantId}/setores`),
    ]);

    await req('POST', `/api/tenants/${tenantId}/colaboradores`, {
      nome: 'Maria Souza', matricula: 'MS01', cargo: 'Operadora',
      setorId: setores.corpo[0].id, unidadeId: unidades.corpo[0].id, status: 'ativo', escalaId: null,
    });

    const lista = await req('GET', `/api/tenants/${tenantId}/colaboradores`);
    expect(lista.corpo[0].setorId).toBe(setores.corpo[0].id);
    expect(lista.corpo[0].unidadeId).toBe(unidades.corpo[0].id);
  });

  it('excluir remove de verdade', async () => {
    const criada = await req('POST', `/api/tenants/${tenantId}/unidades`, { nome: 'Temporária' });
    await req('DELETE', `/api/tenants/${tenantId}/unidades/${criada.corpo.id}`);
    const lista = await req('GET', `/api/tenants/${tenantId}/unidades`);
    expect(lista.corpo.map((u) => u.id)).not.toContain(criada.corpo.id);
  });

  it('recusa cadastro sem nome, com mensagem legível', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, { nome: '  ' });
    expect(r.status).toBe(400);
    expect(r.corpo.mensagem).toBeTruthy();
    expect(r.corpo.mensagem).not.toContain('Error');
  });
});

describe('regras — alterar numa empresa não afeta outra', () => {
  it('persiste a alteração de tolerância', async () => {
    const atuais = await req('GET', `/api/tenants/${tenantId}/regras`);
    const r = await req('PUT', `/api/tenants/${tenantId}/regras`, {
      regras: { ...atuais.corpo.regras, toleranceMin: 25, dailyGoalMin: 600 },
      causaOpts: atuais.corpo.causaOpts,
    });
    expect(r.corpo.regras.toleranceMin).toBe(25);
    expect(r.corpo.regras.dailyGoalMin).toBe(600);
  });

  it('outra empresa continua com os defaults', async () => {
    const outra = await req('POST', '/api/auth/registrar', {
      email: 'outra@test.com', nome: 'Outra', senha: 'senha-forte-123', nomeEmpresa: 'Outra Empresa',
    });
    const tokenAnterior = token;
    token = outra.corpo.token;

    const regras = await req('GET', `/api/tenants/${outra.corpo.tenants[0].id}/regras`);
    expect(regras.corpo.regras.toleranceMin).toBe(10);
    expect(regras.corpo.regras.dailyGoalMin).toBe(0);

    token = tokenAnterior;
  });
});

describe('dados do motor HE — persistidos sem interpretação', () => {
  /* Snapshot no formato EXATO que o motor produz. O servidor não valida campo a campo nem
   * recalcula: é isso que permite o motor continuar intocado. */
  const snapshot = {
    dateKey: '2026-08-01',
    dateLabel: '01/08/2026',
    items: [{
      motorista: 'Maria Souza', he1min: 120, he1str: '02:00', status: 'forte', rastreioStatus: 'forte',
      detalhe: 'Ponto 19:00 sem rastreio perto', confirmadas: '3/4', batidas: '08:00✅ 12:00✅ 19:00❌',
      contexto: '', padraoStatus: 'acima', padraoMin: 60, excedenteMin: 60, padraoDebug: '',
      padraoHorarios: ['08:00–18:00'], setorAtual: 'Produção', causaAtual: null, causaFonte: null,
      interjornada: '', intervalo: '', diaAjustado: 0, temLacuna: false, precisaVerificar: true,
    }],
    totalHE: 120, acimaHE: 120, programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
  };

  it('devolve o snapshot byte a byte igual ao que foi gravado', async () => {
    await req('PUT', `/api/tenants/${tenantId}/dias/2026-08-01`, { snapshot, caseState: {} });
    const lido = await req('GET', `/api/tenants/${tenantId}/dias/2026-08-01`);
    expect(lido.corpo.snapshot).toEqual(snapshot);
  });

  it('atualiza um caso sem perder os demais campos do dia', async () => {
    await req('PATCH', `/api/tenants/${tenantId}/dias/2026-08-01/casos/MARIA SOUZA`, {
      setor: 'Produção', causa: 'Rastreador com defeito',
    });
    await req('PATCH', `/api/tenants/${tenantId}/dias/2026-08-01/casos/MARIA SOUZA`, {
      done: true, justificativa: 'Autorizado previamente.',
    });

    const dia = await req('GET', `/api/tenants/${tenantId}/dias/2026-08-01`);
    const caso = dia.corpo.caseState['MARIA SOUZA'];
    // O segundo patch não pode ter apagado setor/causa do primeiro.
    expect(caso.setor).toBe('Produção');
    expect(caso.causa).toBe('Rastreador com defeito');
    expect(caso.done).toBe(true);
    // E o snapshot continua intacto.
    expect(dia.corpo.snapshot.items[0].motorista).toBe('Maria Souza');
  });

  it('reprocessar o dia preserva o progresso já registrado', async () => {
    // Regravar o snapshot sem mandar caseState não pode apagar as justificativas.
    await req('PUT', `/api/tenants/${tenantId}/dias/2026-08-01`, { snapshot });
    const dia = await req('GET', `/api/tenants/${tenantId}/dias/2026-08-01`);
    expect(dia.corpo.caseState['MARIA SOUZA'].justificativa).toBe('Autorizado previamente.');
  });
});

describe('erros — sempre legíveis, nunca stack trace', () => {
  it('404 traz mensagem em português, sem detalhe interno', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}/dias/2099-01-01`);
    expect(r.status).toBe(404);
    expect(r.corpo.mensagem).toBeTruthy();
    expect(JSON.stringify(r.corpo)).not.toMatch(/at .*\.js:\d+|Error:/);
  });

  it('corpo inválido é recusado com 400 legível', async () => {
    const r = await req('PUT', `/api/tenants/${tenantId}/dias/2026-09-01`, { snapshot: { semItems: true } });
    expect(r.status).toBe(400);
    expect(r.corpo.mensagem).toBeTruthy();
  });
});
