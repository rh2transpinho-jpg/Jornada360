/* CONTROLE DE HORAS EXTRAS — o caso do Alex em 22/07/2026.
 *
 * A pergunta que este arquivo defende é a que motivou a funcionalidade:
 * "O Alex fez hora extra no dia 22/07. Qual foi a justificativa daquele dia?"
 *
 * E a promessa mais delicada dela: a resposta não pode sumir quando o ponto for reprocessado.
 * Uma justificativa escrita à mão é trabalho humano; um número recalculado é só um número. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__he.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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
  let corpoResposta = null;
  try {
    corpoResposta = t ? JSON.parse(t) : null;
  } catch {
    corpoResposta = t;
  }
  return { status: r.status, corpo: corpoResposta };
}

/* Um dia com HE de verdade: 06:00–16:00 previsto, 06:00–18:10 realizado, 2h10 de HE. */
function diaDoAlex(heMin = 130) {
  return {
    dateKey: '2026-07-22',
    dateLabel: '22/07/2026',
    items: [
      {
        motorista: 'Alex Ferreira', he1min: heMin, he1str: '02:10', status: 'forte',
        rastreioStatus: 'forte', detalhe: 'HE acima do padrão', confirmadas: '06:00–18:10',
        batidas: '06:00 12:00 13:00 18:10', contexto: 'Rota 12', padraoStatus: 'acima',
        padraoMin: 600, excedenteMin: heMin, padraoDebug: '', padraoHorarios: ['06:00', '16:00'],
        setorAtual: 'Operacional', causaAtual: null, causaFonte: null, interjornada: '',
        diaAjustado: 0, temLacuna: false, precisaVerificar: false,
      },
      {
        motorista: 'Bia Nunes', he1min: 20, he1str: '00:20', status: 'fraco',
        rastreioStatus: 'fraco', detalhe: '', confirmadas: '07:00–15:20', batidas: '07:00 15:20',
        contexto: '', padraoStatus: 'dentro', padraoMin: 480, excedenteMin: 0, padraoDebug: '',
        padraoHorarios: ['07:00', '15:00'], setorAtual: 'Administrativo', causaAtual: null,
        causaFonte: null, interjornada: '', diaAjustado: 0, temLacuna: false, precisaVerificar: false,
      },
    ],
    totalHE: heMin + 20, acimaHE: heMin, programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
  };
}

async function novaEmpresa(prefixo) {
  const r = await req('POST', '/api/auth/registrar', {
    corpo: { email: `${prefixo}@he.test`, nome: `Dono ${prefixo}`, senha: 'senha-forte-he1', nomeEmpresa: `Empresa ${prefixo}` },
  });
  expect(r.status).toBe(201);
  return { token: r.corpo.token, tenantId: r.corpo.tenants[0].id };
}

let A;
let ocorrenciaDoAlex;

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;

  A = await novaEmpresa('alfa');
  await req('PUT', `/api/tenants/${A.tenantId}/dias/2026-07-22`, { token: A.token, corpo: { snapshot: diaDoAlex(), caseState: {} } });
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

/* ---------------------------------------------------------------- identificação */

describe('a HE vira uma ocorrência com identidade própria', () => {
  it('processar o dia cria a ocorrência do Alex', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/he`, { token: A.token });
    expect(r.status).toBe(200);

    const alex = r.corpo.find((o) => o.colaborador === 'Alex Ferreira');
    expect(alex).toBeDefined();
    expect(alex.data).toBe('2026-07-22');
    expect(alex.heMin).toBe(130);
    expect(alex.status).toBe('pendente');
    /* O planejado e o realizado ficam lado a lado na própria ocorrência (requisito 6), sem
     * precisar reabrir o snapshot do dia. */
    expect(alex.escalaPrevista).toBe('06:00–16:00');
    expect(alex.jornadaRealizada).toBe('06:00–18:10');
    ocorrenciaDoAlex = alex.id;
  });

  it('reprocessar o mesmo dia NÃO duplica a ocorrência', async () => {
    await req('PUT', `/api/tenants/${A.tenantId}/dias/2026-07-22`, { token: A.token, corpo: { snapshot: diaDoAlex(), caseState: {} } });
    const r = await req('GET', `/api/tenants/${A.tenantId}/he?colaborador=Alex Ferreira`, { token: A.token });
    expect(r.corpo).toHaveLength(1);
    expect(r.corpo[0].id).toBe(ocorrenciaDoAlex);
  });

  it('a HE sem justificativa entra na Minha Fila', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/pendencias`, { token: A.token });
    const daAlex = r.corpo.filter((p) => p.tipo === 'he_sem_justificativa' && p.descricao.includes('Alex'));
    expect(daAlex).toHaveLength(1);
    expect(daAlex[0].status).toBe('aberta');
  });
});

/* ---------------------------------------------------------------- a pergunta central */

describe('responder "por que teve hora extra neste dia?"', () => {
  it('registra a justificativa com motivo, origem e responsável', async () => {
    const r = await req('PUT', `/api/tenants/${A.tenantId}/he/${ocorrenciaDoAlex}/justificativa`, {
      token: A.token,
      corpo: {
        status: 'justificada',
        motivo: 'Quebra de veículo',
        justificativa: 'Veículo quebrou na rota 12 e o motorista aguardou o guincho até as 18h.',
        origem: 'Supervisor',
        quemInformou: 'Carlos (supervisão)',
        quemSolicitou: 'Operacional',
        observacoes: 'Guincho acionado às 16h40.',
      },
    });

    expect(r.status).toBe(200);
    expect(r.corpo.status).toBe('justificada');
    expect(r.corpo.motivo).toBe('Quebra de veículo');
    /* O responsável vem da SESSÃO, não do corpo enviado. */
    expect(r.corpo.responsavel).toBe('Dono alfa');
    expect(r.corpo.justificadaEm).toBeTruthy();
  });

  it('pesquisar por "Alex" e filtrar 22/07/2026 devolve a justificativa', async () => {
    const busca = await req('GET', `/api/tenants/${A.tenantId}/he?busca=Alex`, { token: A.token });
    expect(busca.corpo.length).toBeGreaterThanOrEqual(1);

    const doDia = await req('GET', `/api/tenants/${A.tenantId}/he?busca=Alex&data=2026-07-22`, { token: A.token });
    expect(doDia.corpo).toHaveLength(1);
    expect(doDia.corpo[0].motivo).toBe('Quebra de veículo');
    expect(doDia.corpo[0].justificativa).toMatch(/guincho/i);
  });

  it('pesquisar só pela data devolve todas as HEs daquele dia', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/he?data=2026-07-22`, { token: A.token });
    expect(r.corpo.length).toBe(2);
    expect(r.corpo.map((o) => o.colaborador).sort()).toEqual(['Alex Ferreira', 'Bia Nunes']);
  });

  it('a Minha Fila é resolvida sozinha — não existe uma segunda verdade para manter', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/pendencias`, { token: A.token });
    const daAlex = r.corpo.find((p) => p.tipo === 'he_sem_justificativa' && p.descricao.includes('Alex'));
    expect(daAlex.status).toBe('justificado');
    expect(daAlex.resolvidaEm).toBeTruthy();
  });

  it('o detalhe traz o histórico de quem analisou e quando', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/he/${ocorrenciaDoAlex}`, { token: A.token });
    const eventos = r.corpo.historico.map((h) => h.evento);
    expect(eventos).toContain('identificada');
    expect(eventos).toContain('justificada');
  });
});

/* ---------------------------------------------------------------- a promessa do requisito 12 */

describe('reprocessar a jornada NÃO apaga a justificativa', () => {
  it('o número muda, a justificativa fica, e a mudança é sinalizada', async () => {
    /* Nova importação do MESMO dia, com HE diferente — 2h10 vira 2h40. */
    await req('PUT', `/api/tenants/${A.tenantId}/dias/2026-07-22`, {
      token: A.token,
      corpo: { snapshot: diaDoAlex(160), caseState: {} },
    });

    const r = await req('GET', `/api/tenants/${A.tenantId}/he/${ocorrenciaDoAlex}`, { token: A.token });

    /* O número novo entrou… */
    expect(r.corpo.heMin).toBe(160);
    /* …e a análise humana continua inteira. */
    expect(r.corpo.motivo).toBe('Quebra de veículo');
    expect(r.corpo.justificativa).toMatch(/guincho/i);
    expect(r.corpo.status).toBe('justificada');
    expect(r.corpo.responsavel).toBe('Dono alfa');

    /* E a tela tem como avisar que o cálculo mudou DEPOIS da justificativa. */
    expect(r.corpo.recalculadaEm).toBeTruthy();
    expect(r.corpo.heMinAnterior).toBe(130);
    expect(r.corpo.historico.map((h) => h.evento)).toContain('recalculada');
  });

  it('a ocorrência não volta para a Minha Fila depois do recálculo', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/pendencias`, { token: A.token });
    const abertas = r.corpo.filter((p) => p.tipo === 'he_sem_justificativa' && p.descricao.includes('Alex') && p.status === 'aberta');
    expect(abertas).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- perfil e relatório */

describe('perfil do colaborador e relatório', () => {
  it('o histórico do Alex soma HE e separa por situação', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/he/colaborador/Alex Ferreira`, { token: A.token });
    expect(r.corpo.ocorrencias).toBe(1);
    expect(r.corpo.totalMin).toBe(160);
    expect(r.corpo.justificadas).toBe(1);
    expect(r.corpo.pendentes).toBe(0);
  });

  it('o resumo responde "quantas HE ainda estão sem justificativa?"', async () => {
    const r = await req('GET', `/api/tenants/${A.tenantId}/he/resumo`, { token: A.token });
    expect(r.corpo.ocorrencias).toBe(2);
    /* A Bia continua sem justificativa — é ela que sobra no indicador. */
    expect(r.corpo.ocorrenciasPendentes).toBe(1);
    expect(r.corpo.minutosPendentes).toBe(20);
  });

  it('o relatório exporta em CSV, e o recorte "sem justificativa" existe', async () => {
    const todos = await req('GET', `/api/tenants/${A.tenantId}/he/relatorio/csv`, { token: A.token });
    expect(todos.status).toBe(200);
    expect(todos.corpo).toContain('Alex Ferreira');
    expect(todos.corpo).toContain('Quebra de veículo');

    const pendentes = await req('GET', `/api/tenants/${A.tenantId}/he/relatorio/csv?status=pendente`, { token: A.token });
    expect(pendentes.corpo).toContain('Bia Nunes');
    expect(pendentes.corpo).not.toContain('Alex Ferreira');
  });

  it('os motivos e as origens são configuráveis pela empresa', async () => {
    const padrao = await req('GET', `/api/tenants/${A.tenantId}/he/listas`, { token: A.token });
    expect(padrao.corpo.motivos).toContain('Quebra de veículo');

    const salvo = await req('PUT', `/api/tenants/${A.tenantId}/he/listas`, {
      token: A.token,
      corpo: { motivos: ['Quebra de veículo', 'Motivo só desta empresa'], origens: ['Motorista'] },
    });
    expect(salvo.corpo.motivos).toContain('Motivo só desta empresa');
  });
});

/* ---------------------------------------------------------------- isolamento */

describe('Empresa A × Empresa B — HE e justificativas não atravessam', () => {
  it('B não vê a HE de A, e não alcança a ocorrência nem pelo id', async () => {
    const B = await novaEmpresa('beta');
    await req('PUT', `/api/tenants/${B.tenantId}/dias/2026-07-22`, {
      token: B.token,
      corpo: {
        snapshot: {
          dateKey: '2026-07-22', dateLabel: '22/07/2026',
          items: [{
            motorista: 'Outro da Empresa B', he1min: 90, he1str: '01:30', status: 'forte',
            rastreioStatus: 'forte', detalhe: '', confirmadas: '', batidas: '', contexto: '',
            padraoStatus: 'acima', padraoMin: 480, excedenteMin: 90, padraoDebug: '',
            padraoHorarios: [], setorAtual: '', causaAtual: null, causaFonte: null,
            interjornada: '', diaAjustado: 0, temLacuna: false, precisaVerificar: false,
          }],
          totalHE: 90, acimaHE: 90, programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
        },
        caseState: {},
      },
    });

    const listaB = await req('GET', `/api/tenants/${B.tenantId}/he`, { token: B.token });
    expect(listaB.corpo.map((o) => o.colaborador)).toEqual(['Outro da Empresa B']);

    /* Mesmo com o id exato da ocorrência de A na mão: 404, não 403. */
    const espiada = await req('GET', `/api/tenants/${B.tenantId}/he/${ocorrenciaDoAlex}`, { token: B.token });
    expect(espiada.status).toBe(404);

    /* E pela URL da empresa alheia, o middleware barra antes de chegar aqui. */
    const cruzada = await req('GET', `/api/tenants/${A.tenantId}/he`, { token: B.token });
    expect(cruzada.status).toBe(404);

    /* Nem justificar a ocorrência de A. */
    const escrita = await req('PUT', `/api/tenants/${B.tenantId}/he/${ocorrenciaDoAlex}/justificativa`, {
      token: B.token,
      corpo: { motivo: 'Invasão', justificativa: 'não deveria funcionar' },
    });
    expect(escrita.status).toBe(404);

    /* A justificativa de A continua exatamente como estava. */
    const conferencia = await req('GET', `/api/tenants/${A.tenantId}/he/${ocorrenciaDoAlex}`, { token: A.token });
    expect(conferencia.corpo.motivo).toBe('Quebra de veículo');
  });
});
