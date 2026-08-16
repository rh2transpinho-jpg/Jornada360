/* TESTE DO FLUXO COMPLETO — ponta a ponta, contra a API real.
 *
 * Este é o teste que responde à pergunta central da Fase 4: uma pessoa consegue criar conta, montar
 * a empresa, trabalhar, sair, entrar de novo DE OUTRA MÁQUINA e encontrar tudo onde deixou? E o
 * dado dela continua invisível para outra empresa?
 *
 * Ele exercita as rotas reais, do jeito que o frontend as chama — inclusive na ordem em que ele as
 * chama. Nada é simulado: o banco é de verdade (arquivo próprio deste teste), a sessão é de
 * verdade, o isolamento é o mesmo do middleware.
 *
 * "Outra máquina" é representado por uma sessão nova e independente: nenhum estado local é
 * reaproveitado entre as duas, que é exatamente a diferença que importa. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__fluxo.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;

let servidor;
let base;

async function req(metodo, caminho, { token, corpo, versao } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      'x-jornada-cliente': 'api',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(versao ? { 'x-versao': versao } : {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null, versao: r.headers.get('x-versao') };
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
      /* arquivo pode não existir */
    }
  }
});

const DIA = {
  dateKey: '2026-08-10',
  snapshot: {
    dateKey: '2026-08-10',
    dateLabel: '10/08/2026',
    items: [
      {
        motorista: 'Ana Souza', he1min: 95, he1str: '01:35', status: 'forte', rastreioStatus: 'forte',
        detalhe: 'HE acima do padrão', confirmadas: '', batidas: '07:00 12:00 13:00 18:35',
        contexto: '', padraoStatus: 'acima', padraoMin: 60, excedenteMin: 35, padraoDebug: '',
        padraoHorarios: ['07:00', '18:00'], setorAtual: '', causaAtual: null, causaFonte: null,
        interjornada: '', diaAjustado: 0, temLacuna: false, precisaVerificar: false,
      },
    ],
    totalHE: 95, acimaHE: 95, programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
  },
  caseState: {},
};

describe('fluxo completo — do cadastro ao relatório, e de volta em outra sessão', () => {
  const conta = { email: 'operacao@aurora.test', nome: 'Ana Analista', senha: 'senha-forte-2026', nomeEmpresa: 'Transportadora Aurora' };
  let token;
  let tenantId;
  let versao;

  it('1. cria conta e empresa numa operação só', async () => {
    const r = await req('POST', '/api/auth/registrar', { corpo: conta });
    expect(r.status).toBe(201);
    expect(r.corpo.usuario.email).toBe(conta.email);
    expect(r.corpo.tenants).toHaveLength(1);

    token = r.corpo.token;
    tenantId = r.corpo.tenants[0].id;
    /* Quem cria a empresa é administrador dela — sem isso, ninguém conseguiria configurá-la. */
    expect(r.corpo.tenants[0].papel).toBe('administrador');
  });

  it('2. a empresa nasce VAZIA — nada de demonstração, nada herdado', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}`, { token });
    expect(r.status).toBe(200);
    expect(r.corpo.units).toHaveLength(0);
    expect(r.corpo.departments).toHaveLength(0);
    expect(r.corpo.employees).toHaveLength(0);
    expect(r.corpo.schedules).toHaveLength(0);
    /* Regras nos defaults neutros: meta diária ZERO significa "esta empresa ainda não definiu". */
    expect(r.corpo.rules.dailyGoalMin).toBe(0);
    expect(r.corpo.rules.toleranceMin).toBe(10);
    versao = r.corpo.versao;
  });

  it('3. monta a estrutura: unidade, setor, escala, colaborador', async () => {
    const unidade = await req('POST', `/api/tenants/${tenantId}/unidades`, { token, versao, corpo: { id: 'un-1', nome: 'Matriz', codigo: 'UN01', localizacao: 'Porto Alegre/RS' } });
    expect(unidade.status).toBe(201);
    versao = unidade.versao;

    const setor = await req('POST', `/api/tenants/${tenantId}/setores`, { token, versao, corpo: { id: 'set-1', nome: 'Operacional', unidadeId: 'un-1', responsavel: 'Carlos' } });
    expect(setor.status).toBe(201);
    versao = setor.versao;

    const escala = await req('POST', `/api/tenants/${tenantId}/escalas`, { token, versao, corpo: { id: 'esc-1', nome: 'Turno manhã', entrada: '07:00', saida: '17:00', diasTrabalhados: ['seg', 'ter', 'qua', 'qui', 'sex'], folgas: ['sab', 'dom'], heProgramadaMin: 60 } });
    expect(escala.status).toBe(201);
    versao = escala.versao;

    const colaborador = await req('POST', `/api/tenants/${tenantId}/colaboradores`, { token, versao, corpo: { id: 'col-1', nome: 'Ana Souza', matricula: '001', cargo: 'Motorista', setorId: 'set-1', unidadeId: 'un-1', status: 'ativo', escalaId: 'esc-1' } });
    expect(colaborador.status).toBe(201);
    versao = colaborador.versao;
  });

  it('4. configura as regras da empresa', async () => {
    const r = await req('PUT', `/api/tenants/${tenantId}/regras`, {
      token,
      versao,
      corpo: {
        regras: { toleranceMin: 15, dailyGoalMin: 120, recurrenceLimit: 3, intervalMinMin: 60, interjourneyMinHours: 11, prazoPadraoDias: 5, alertaAntecedenciaDias: 2 },
        causaOpts: ['Rastreador com defeito', 'Escala desatualizada'],
      },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.regras.toleranceMin).toBe(15);
    versao = r.versao;
  });

  it('5. envia um dia processado pelo motor (o backend guarda o snapshot sem interpretá-lo)', async () => {
    const r = await req('PUT', `/api/tenants/${tenantId}/dias/${DIA.dateKey}`, { token, corpo: { snapshot: DIA.snapshot, caseState: DIA.caseState } });
    expect(r.status).toBe(200);
    expect(r.corpo.snapshot.items).toHaveLength(1);
    /* O servidor devolve o snapshot EXATAMENTE como recebeu — é o que permite o motor HE
     * continuar sendo a única autoridade sobre o formato. */
    expect(r.corpo.snapshot.items[0].motorista).toBe('Ana Souza');
    expect(r.corpo.snapshot.items[0].padraoMin).toBe(60);
  });

  it('6. materializa a pendência daquele dia', async () => {
    const id = `pend-${tenantId}-${DIA.dateKey}-ana souza`;
    const agora = new Date().toISOString();
    const r = await req('PUT', `/api/tenants/${tenantId}/pendencias/${encodeURIComponent(id)}`, {
      token,
      corpo: {
        id, workspaceId: tenantId, colaboradorId: 'col-1', data: DIA.dateKey, tipo: 'divergencia_he',
        categoria: 'Não classificada', status: 'divergencia', prioridade: 'media', origem: 'motor_he',
        descricao: 'HE acima do padrão', evidencias: ['Batidas: 07:00 12:00 13:00 18:35'],
        recomendacao: null, responsavelId: null, prazo: null, criadaEm: agora, atualizadaEm: agora,
        resolvidaEm: null, resolucao: null, revisadoPor: null, revisadoEm: null, observacaoRevisao: null,
      },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.status).toBe('divergencia');
  });

  it('7. atribui prioridade, responsável e prazo', async () => {
    const lista = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    const p = lista.corpo[0];

    const r = await req('PUT', `/api/tenants/${tenantId}/pendencias/${encodeURIComponent(p.id)}`, {
      token,
      versao: p.atualizadaEm,
      corpo: { ...p, prioridade: 'alta', responsavelId: 'col-1', prazo: '2026-08-20' },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.prioridade).toBe('alta');
    expect(r.corpo.prazo).toBe('2026-08-20');
  });

  it('8. resolve a pendência', async () => {
    const lista = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    const p = lista.corpo[0];

    const r = await req('PUT', `/api/tenants/${tenantId}/pendencias/${encodeURIComponent(p.id)}`, {
      token,
      corpo: { ...p, status: 'justificado', resolvidaEm: new Date().toISOString(), resolucao: 'Autorizado pela coordenação.' },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.status).toBe('justificado');
  });

  /* A revisão tem rota própria justamente porque o AUTOR não pode vir do cliente. */
  it('9. aprova a resolução, e o revisor vem da sessão — não do corpo da requisição', async () => {
    const lista = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    const p = lista.corpo[0];

    const r = await req('POST', `/api/tenants/${tenantId}/pendencias/${encodeURIComponent(p.id)}/revisao`, {
      token,
      corpo: { decisao: 'aprovado', observacao: 'Conferido com a escala.', revisadoPor: 'NOME FALSIFICADO' },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.status).toBe('aprovado');
    /* Mesmo tendo mandado outro nome no corpo, quem fica registrado é quem estava logado. */
    expect(r.corpo.revisadoPor).toBe(conta.nome);
    expect(r.corpo.revisadoPor).not.toBe('NOME FALSIFICADO');
  });

  it('10. a auditoria registrou tudo, com o autor da sessão e carimbo do servidor', async () => {
    const r = await req('GET', `/api/tenants/${tenantId}/auditoria`, { token });
    expect(r.status).toBe(200);
    expect(r.corpo.length).toBeGreaterThan(0);

    for (const e of r.corpo) {
      expect(e.usuario).toBe(conta.nome);
      expect(e.timestamp).toBeTruthy();
    }
    expect(r.corpo.some((e) => e.acao === 'Pendência aprovada')).toBe(true);
  });

  it('11. registra a exportação do relatório', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/exportacoes`, { token, corpo: { relatorio: 'pendencias', escopo: 'Agosto/2026' } });
    expect(r.status).toBe(201);

    const trilha = await req('GET', `/api/tenants/${tenantId}/auditoria`, { token });
    expect(trilha.corpo.some((e) => e.acao === 'Relatório exportado')).toBe(true);
  });

  it('12. sai da conta — a sessão deixa de valer imediatamente', async () => {
    expect((await req('POST', '/api/auth/sair', { token })).status).toBe(204);
    expect((await req('GET', `/api/tenants/${tenantId}`, { token })).status).toBe(401);
  });

  /* O CRITÉRIO CENTRAL DA FASE 4. */
  it('13. entra de novo, com sessão nova (outra máquina), e encontra TUDO onde deixou', async () => {
    const entrada = await req('POST', '/api/auth/entrar', { corpo: { email: conta.email, senha: conta.senha } });
    expect(entrada.status).toBe(200);
    const novoToken = entrada.corpo.token;
    expect(novoToken).not.toBe(token);

    const cadastro = await req('GET', `/api/tenants/${tenantId}`, { token: novoToken });
    expect(cadastro.corpo.units.map((u) => u.nome)).toEqual(['Matriz']);
    expect(cadastro.corpo.departments.map((d) => d.nome)).toEqual(['Operacional']);
    expect(cadastro.corpo.employees.map((e) => e.nome)).toEqual(['Ana Souza']);
    expect(cadastro.corpo.rules.toleranceMin).toBe(15);
    expect(cadastro.corpo.causaOpts).toContain('Rastreador com defeito');

    const dias = await req('GET', `/api/tenants/${tenantId}/dias?completo=1`, { token: novoToken });
    expect(dias.corpo).toHaveLength(1);
    expect(dias.corpo[0].snapshot.items[0].motorista).toBe('Ana Souza');

    const pend = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token: novoToken });
    expect(pend.corpo[0].status).toBe('aprovado');
    expect(pend.corpo[0].revisadoPor).toBe(conta.nome);

    token = novoToken;
  });
});

describe('fluxo completo — a empresa de outra pessoa permanece invisível', () => {
  let tokenA, tenantA, tokenB, tenantB;

  beforeAll(async () => {
    const a = await req('POST', '/api/auth/registrar', { corpo: { email: 'a@fluxo.test', nome: 'Alice', senha: 'senha-forte-a1', nomeEmpresa: 'Alpha' } });
    const b = await req('POST', '/api/auth/registrar', { corpo: { email: 'b@fluxo.test', nome: 'Bruno', senha: 'senha-forte-b1', nomeEmpresa: 'Beta' } });
    tokenA = a.corpo.token;
    tenantA = a.corpo.tenants[0].id;
    tokenB = b.corpo.token;
    tenantB = b.corpo.tenants[0].id;

    await req('POST', `/api/tenants/${tenantA}/setores`, { token: tokenA, corpo: { id: 'sa', nome: 'Só da Alpha' } });
    await req('POST', `/api/tenants/${tenantB}/setores`, { token: tokenB, corpo: { id: 'sb', nome: 'Só da Beta' } });
  });

  it('cada conta vê apenas a própria empresa na lista de acessos', async () => {
    const a = await req('GET', '/api/auth/eu', { token: tokenA });
    expect(a.corpo.tenants.map((t) => t.id)).toEqual([tenantA]);

    const b = await req('GET', '/api/auth/eu', { token: tokenB });
    expect(b.corpo.tenants.map((t) => t.id)).toEqual([tenantB]);
  });

  it('A lê A e B lê B', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/setores`, { token: tokenA })).corpo.map((s) => s.nome)).toEqual(['Só da Alpha']);
    expect((await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB })).corpo.map((s) => s.nome)).toEqual(['Só da Beta']);
  });

  /* 404 e não 403: um 403 confirmaria que aquele tenant existe, e isso já é informação vazada. */
  it('A NÃO lê B, e a resposta não confirma sequer que a empresa existe', async () => {
    const r = await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenA });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.corpo)).not.toContain('Beta');
  });

  it('B NÃO lê A', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/setores`, { token: tokenB })).status).toBe(404);
  });

  it('A não consegue ESCREVER em B', async () => {
    const r = await req('POST', `/api/tenants/${tenantB}/setores`, { token: tokenA, corpo: { id: 'invasor', nome: 'Invasor' } });
    expect(r.status).toBe(404);
    /* E de fato nada foi gravado. */
    expect((await req('GET', `/api/tenants/${tenantB}/setores`, { token: tokenB })).corpo.map((s) => s.nome)).toEqual(['Só da Beta']);
  });

  it('A não consegue EXCLUIR a empresa de B', async () => {
    expect((await req('DELETE', `/api/tenants/${tenantB}`, { token: tokenA })).status).toBe(404);
    expect((await req('GET', `/api/tenants/${tenantB}`, { token: tokenB })).status).toBe(200);
  });

  it('sem sessão nenhuma, nada é acessível', async () => {
    expect((await req('GET', `/api/tenants/${tenantA}/setores`)).status).toBe(401);
    expect((await req('GET', `/api/tenants/${tenantA}/setores`, { token: 'inventado' })).status).toBe(401);
  });
});

describe('concorrência — a alteração de uma pessoa não some por causa da outra', () => {
  let token, tenantId;

  beforeAll(async () => {
    const r = await req('POST', '/api/auth/registrar', { corpo: { email: 'conc@fluxo.test', nome: 'Clara', senha: 'senha-forte-c1', nomeEmpresa: 'Concorrente' } });
    token = r.corpo.token;
    tenantId = r.corpo.tenants[0].id;
  });

  it('recusa a segunda gravação quando o cadastro mudou no meio do caminho', async () => {
    /* Duas pessoas abrem a mesma tela e leem a MESMA versão. */
    const versaoLidaPorAmbas = (await req('GET', `/api/tenants/${tenantId}`, { token })).corpo.versao;

    const primeira = await req('POST', `/api/tenants/${tenantId}/setores`, { token, versao: versaoLidaPorAmbas, corpo: { id: 's1', nome: 'Setor da primeira pessoa' } });
    expect(primeira.status).toBe(201);

    /* A segunda ainda tem a versão antiga: gravar agora apagaria, em silêncio, o que a primeira fez. */
    const segunda = await req('POST', `/api/tenants/${tenantId}/setores`, { token, versao: versaoLidaPorAmbas, corpo: { id: 's2', nome: 'Setor da segunda pessoa' } });
    expect(segunda.status).toBe(409);
    expect(segunda.corpo.erro).toBe('conflito');
    /* A mensagem diz o que fazer, não apenas que falhou. */
    expect(segunda.corpo.mensagem).toMatch(/[Rr]ecarregue/);
  });

  it('depois de recarregar, a mesma gravação passa', async () => {
    const versaoAtual = (await req('GET', `/api/tenants/${tenantId}`, { token })).corpo.versao;
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, { token, versao: versaoAtual, corpo: { id: 's2', nome: 'Setor da segunda pessoa' } });
    expect(r.status).toBe(201);

    const setores = await req('GET', `/api/tenants/${tenantId}/setores`, { token });
    expect(setores.corpo.map((s) => s.nome).sort()).toEqual(['Setor da primeira pessoa', 'Setor da segunda pessoa']);
  });

  it('um cliente que não participa do controle continua funcionando', async () => {
    /* Sem o cabeçalho, não há o que comparar — é o caso de um script de integração. */
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, { token, corpo: { id: 's3', nome: 'Via integração' } });
    expect(r.status).toBe(201);
  });
});

describe('migração dos dados que estavam no navegador', () => {
  let token, tenantId;

  beforeAll(async () => {
    const r = await req('POST', '/api/auth/registrar', { corpo: { email: 'migra@fluxo.test', nome: 'Marta', senha: 'senha-forte-m1', nomeEmpresa: 'Migrada' } });
    token = r.corpo.token;
    tenantId = r.corpo.tenants[0].id;
  });

  it('recebe os dias locais e devolve a contagem LIDA DO BANCO, não a enviada', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/importar`, { token, corpo: { dias: [DIA], pendencias: [] } });
    expect(r.status).toBe(201);
    expect(r.corpo.diasGravados).toBe(1);
    /* É esta contagem que permite ao cliente conferir ANTES de oferecer a limpeza local. */
    expect(r.corpo.diasNoServidor).toBe(1);
  });

  it('importar duas vezes não duplica — o dia é identificado pela data', async () => {
    await req('POST', `/api/tenants/${tenantId}/importar`, { token, corpo: { dias: [DIA], pendencias: [] } });
    const r = await req('GET', `/api/tenants/${tenantId}/dias`, { token });
    expect(r.corpo).toEqual([DIA.dateKey]);
  });

  it('registra a importação na auditoria — dado entrando é evento tanto quanto dado saindo', async () => {
    const trilha = await req('GET', `/api/tenants/${tenantId}/auditoria`, { token });
    expect(trilha.corpo.some((e) => e.acao === 'Dados do navegador importados')).toBe(true);
  });

  it('não aceita importar para a empresa de outra pessoa', async () => {
    const outra = await req('POST', '/api/auth/registrar', { corpo: { email: 'outra@fluxo.test', nome: 'Outra', senha: 'senha-forte-o1', nomeEmpresa: 'Outra Empresa' } });
    const r = await req('POST', `/api/tenants/${tenantId}/importar`, { token: outra.corpo.token, corpo: { dias: [DIA], pendencias: [] } });
    expect(r.status).toBe(404);
  });
});

describe('gestão de acesso — membros e convites', () => {
  let tokenDono, tenantId, tokenConvidada;

  beforeAll(async () => {
    const dono = await req('POST', '/api/auth/registrar', { corpo: { email: 'dono@acesso.test', nome: 'Dona', senha: 'senha-forte-d1', nomeEmpresa: 'Empresa com Equipe' } });
    tokenDono = dono.corpo.token;
    tenantId = dono.corpo.tenants[0].id;

    const convidada = await req('POST', '/api/auth/registrar', { corpo: { email: 'convidada@acesso.test', nome: 'Convidada', senha: 'senha-forte-x1', nomeEmpresa: 'Empresa Dela' } });
    tokenConvidada = convidada.corpo.token;
  });

  it('vincula uma conta existente com o papel escolhido', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/membros`, { token: tokenDono, corpo: { email: 'convidada@acesso.test', papel: 'auditor' } });
    expect(r.status).toBe(201);
    expect(r.corpo.some((m) => m.email === 'convidada@acesso.test' && m.papel === 'auditor')).toBe(true);
  });

  it('o papel concedido vale de verdade: auditor lê mas não escreve', async () => {
    expect((await req('GET', `/api/tenants/${tenantId}/setores`, { token: tokenConvidada })).status).toBe(200);
    expect((await req('POST', `/api/tenants/${tenantId}/setores`, { token: tokenConvidada, corpo: { id: 'x', nome: 'Tentativa' } })).status).toBe(403);
  });

  it('não vincula quem ainda não tem conta — orienta a usar convite', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/membros`, { token: tokenDono, corpo: { email: 'ninguem@acesso.test', papel: 'gestor' } });
    expect(r.status).toBe(404);
    expect(r.corpo.mensagem).toMatch(/convite/i);
  });

  it('emite convite e devolve o código UMA vez', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/convites`, { token: tokenDono, corpo: { email: 'nova@acesso.test', papel: 'gestor' } });
    expect(r.status).toBe(201);
    expect(r.corpo.codigo).toBeTruthy();

    /* A listagem NÃO devolve o código — o banco só tem o hash. */
    const lista = await req('GET', `/api/tenants/${tenantId}/convites`, { token: tokenDono });
    expect(JSON.stringify(lista.corpo)).not.toContain(r.corpo.codigo);
  });

  it('o convite é nominal: outra conta não consegue resgatá-lo', async () => {
    const convite = await req('POST', `/api/tenants/${tenantId}/convites`, { token: tokenDono, corpo: { email: 'nominal@acesso.test', papel: 'gestor' } });
    const r = await req('POST', '/api/auth/convites/resgatar', { token: tokenConvidada, corpo: { codigo: convite.corpo.codigo } });
    expect(r.status).toBe(400);
    expect(r.corpo.mensagem).toMatch(/outro e-mail/i);
  });

  it('resgatado pela conta certa, o acesso passa a existir', async () => {
    const nova = await req('POST', '/api/auth/registrar', { corpo: { email: 'nova2@acesso.test', nome: 'Nova', senha: 'senha-forte-n1', nomeEmpresa: 'Empresa da Nova' } });
    const convite = await req('POST', `/api/tenants/${tenantId}/convites`, { token: tokenDono, corpo: { email: 'nova2@acesso.test', papel: 'rh' } });

    const r = await req('POST', '/api/auth/convites/resgatar', { token: nova.corpo.token, corpo: { codigo: convite.corpo.codigo } });
    expect(r.status).toBe(200);
    expect(r.corpo.tenants.some((t) => t.id === tenantId && t.papel === 'rh')).toBe(true);
  });

  it('o mesmo convite não serve duas vezes', async () => {
    const nova = await req('POST', '/api/auth/registrar', { corpo: { email: 'unica@acesso.test', nome: 'Única', senha: 'senha-forte-u1', nomeEmpresa: 'Empresa Única' } });
    const convite = await req('POST', `/api/tenants/${tenantId}/convites`, { token: tokenDono, corpo: { email: 'unica@acesso.test', papel: 'gestor' } });

    expect((await req('POST', '/api/auth/convites/resgatar', { token: nova.corpo.token, corpo: { codigo: convite.corpo.codigo } })).status).toBe(200);
    const segunda = await req('POST', '/api/auth/convites/resgatar', { token: nova.corpo.token, corpo: { codigo: convite.corpo.codigo } });
    expect(segunda.status).toBe(400);
    expect(segunda.corpo.mensagem).toMatch(/já foi utilizado/i);
  });

  /* Uma empresa sem administrador fica sem ninguém capaz de gerir acesso — e desfazer isso
   * exigiria mexer no banco à mão. */
  it('impede remover ou rebaixar o último administrador', async () => {
    const membros = await req('GET', `/api/tenants/${tenantId}`, { token: tokenDono });
    const dona = membros.corpo.users.find((u) => u.email === 'dono@acesso.test');

    const rebaixar = await req('PUT', `/api/tenants/${tenantId}/membros/${dona.id}`, { token: tokenDono, corpo: { papel: 'gestor' } });
    expect(rebaixar.status).toBe(400);
    expect(rebaixar.corpo.erro).toBe('ultimo_administrador');

    const remover = await req('DELETE', `/api/tenants/${tenantId}/membros/${dona.id}`, { token: tokenDono });
    expect(remover.status).toBe(400);
  });
});
