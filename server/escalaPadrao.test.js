/* ESCALA × HORÁRIO PADRÃO × PONTO — a precedência que decide se uma hora extra existe.
 *
 * O CASO QUE ESTE ARQUIVO DEFENDE
 * ------------------------------
 * João tem horário habitual 06:00–16:00. Numa terça específica foi escalado para 06:00–17:00.
 * Saiu 17:18.
 *
 *   comparando contra o hábito → quase 80 minutos de "hora extra" que ninguém deve
 *   comparando contra a escala → 18 minutos, que é a verdade
 *
 * Comparar contra o horário errado não produz um número aproximado: produz uma cobrança falsa,
 * com nome e data, que alguém vai ter que desmentir. Os testes abaixo fixam as três garantias que
 * impedem isso: a precedência, a vigência histórica, e a preservação da análise humana. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__escala.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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

/* Um item de ponto do motor. `batidas` é o campo de onde a análise lê as marcações reais —
 * exatamente como o motor as grava. */
function ponto(nome, batidas, heMin, extras = {}) {
  return {
    motorista: nome, he1min: heMin, he1str: '', status: 'forte', rastreioStatus: 'forte',
    detalhe: '', confirmadas: '', batidas, contexto: '', padraoStatus: 'acima',
    padraoMin: extras.padraoMin ?? 60, excedenteMin: heMin, padraoDebug: '',
    padraoHorarios: extras.padraoHorarios ?? [], setorAtual: extras.setor ?? 'Operacional',
    causaAtual: null, causaFonte: null, interjornada: '', diaAjustado: 0,
    temLacuna: false, precisaVerificar: false,
  };
}

function dia(dateKey, itens) {
  return {
    dateKey, dateLabel: dateKey, items: itens,
    totalHE: itens.reduce((s, i) => s + i.he1min, 0),
    acimaHE: itens.reduce((s, i) => s + i.he1min, 0),
    programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
  };
}

async function novaEmpresa(prefixo) {
  const r = await req('POST', '/api/auth/registrar', {
    corpo: {
      email: `${prefixo}@escala.test`, nome: `Dono ${prefixo}`,
      senha: 'senha-forte-escala', nomeEmpresa: `Empresa ${prefixo}`,
    },
  });
  expect(r.status).toBe(201);
  return { token: r.corpo.token, tenantId: r.corpo.tenants[0].id };
}

let A;
const T = (c) => `/api/tenants/${A.tenantId}${c}`;

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
  A = await novaEmpresa('precedencia');
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const sufixo of ['', '-wal', '-shm']) {
    try { rmSync(DB + sufixo); } catch { /* pode não existir */ }
  }
});

/* ================================================================ BLOQUEADOR 1 */

describe('BLOQUEADOR — a escala do dia tem precedência sobre o horário padrão', () => {
  it('cadastra o horário padrão de João: 06:00–16:00', async () => {
    const r = await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'João da Silva',
        marcacoes: ['06:00', '11:00', '12:00', '16:00'],
        cargaPrevistaMin: 480,
        vigenciaInicio: '2026-01-01',
      },
    });
    expect(r.status).toBe(201);
    expect(r.corpo.faixa).toBe('06:00–11:00 · 12:00–16:00');
    /* 5h + 4h = 9h de presença, carga 8h → 60 min de extra habitual. Mesma conta do motor. */
    expect(r.corpo.extraMin).toBe(60);
  });

  it('sem escala no dia, a referência é o HORÁRIO PADRÃO', async () => {
    const r = await req('GET', T('/referencia/2026-08-20/João da Silva'), { token: A.token });
    expect(r.status).toBe(200);
    expect(r.corpo.tipo).toBe('padrao');
    expect(r.corpo.saidaPrevista).toBe('16:00');
  });

  it('com escala 06:00–17:00 no dia, a referência passa a ser a ESCALA', async () => {
    const r = await req('PUT', T('/escalas'), {
      token: A.token,
      corpo: {
        colaborador: 'João da Silva', data: '2026-08-20', situacao: 'alteracao_horario',
        marcacoes: ['06:00', '11:00', '12:00', '17:00'], cargaPrevistaMin: 480,
        turno: 'Manhã', setor: 'Operacional',
      },
    });
    expect(r.status).toBe(200);

    const ref = await req('GET', T('/referencia/2026-08-20/João da Silva'), { token: A.token });
    expect(ref.corpo.tipo).toBe('escala');
    /* O QUE ESTE TESTE EXISTE PARA FIXAR: a saída prevista do dia é 17:00, não 16:00. */
    expect(ref.corpo.saidaPrevista).toBe('17:00');
    expect(ref.corpo.extraMin).toBe(120);
  });

  it('o ponto encerrando 17:18 é comparado contra 17:00 — NÃO contra 16:00', async () => {
    const r = await req('PUT', T('/dias/2026-08-20'), {
      token: A.token,
      corpo: {
        snapshot: dia('2026-08-20', [ponto('João da Silva', '06:03 11:02 12:01 17:18', 136)]),
        caseState: {},
      },
    });
    expect(r.status).toBe(200);

    const analises = await req('GET', T('/analises?data=2026-08-20'), { token: A.token });
    const joao = analises.corpo.find((a) => a.colaborador === 'João da Silva');
    expect(joao).toBeDefined();

    /* A referência gravada na análise é a escala. */
    expect(joao.referenciaTipo).toBe('escala');
    expect(joao.referenciaHorarios).toBe('06:00–11:00 · 12:00–17:00');

    /* E o horário padrão continua registrado ao lado, para a explicação mostrar os dois. */
    expect(joao.padraoHorarios).toBe('06:00–11:00 · 12:00–16:00');

    const saida = joao.divergencias.find((d) => d.tipo === 'saida_posterior');
    expect(saida).toBeDefined();
    /* O NÚMERO QUE PROVA A PRECEDÊNCIA: +18 minutos sobre 17:00.
     * Contra o padrão (16:00) daria +78 — e é esse 78 que este teste existe para impedir. */
    expect(saida.previsto).toBe('17:00');
    expect(saida.realizado).toBe('17:18');
    expect(saida.diferencaMin).toBe(18);
  });

  it('a explicação diz, em texto, qual referência foi usada e por quê', async () => {
    const lista = await req('GET', T('/analises?data=2026-08-20'), { token: A.token });
    const joao = lista.corpo.find((a) => a.colaborador === 'João da Silva');

    const r = await req('GET', T(`/analises/${joao.id}/explicacao`), { token: A.token });
    expect(r.status).toBe(200);
    expect(r.corpo.porQue).toContain('ESCALA');
    expect(r.corpo.porQue).toContain('06:00–11:00 · 12:00–17:00');
    /* Precisa citar o padrão que NÃO foi usado: é o que responde "por que não 16:00?". */
    expect(r.corpo.porQue).toContain('06:00–11:00 · 12:00–16:00');
  });
});

/* ================================================================ BLOQUEADOR 2 */

describe('BLOQUEADOR — editar o horário de hoje não reescreve a análise de ontem', () => {
  it('o padrão de julho vale em julho', async () => {
    await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Maria Souza',
        marcacoes: ['05:40', '08:30', '16:00', '19:00'],
        cargaPrevistaMin: 480,
        vigenciaInicio: '2026-06-01',
        vigenciaFim: '2026-07-31',
      },
    });

    const r = await req('GET', T('/referencia/2026-07-15/Maria Souza'), { token: A.token });
    expect(r.corpo.tipo).toBe('padrao');
    expect(r.corpo.faixa).toBe('05:40–08:30 · 16:00–19:00');
  });

  it('um novo padrão a partir de agosto NÃO muda o que valia em julho', async () => {
    const novo = await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Maria Souza',
        marcacoes: ['06:00', '11:00', '12:00', '16:00'],
        cargaPrevistaMin: 480,
        vigenciaInicio: '2026-08-01',
      },
    });
    expect(novo.status).toBe(201);

    const julho = await req('GET', T('/referencia/2026-07-15/Maria Souza'), { token: A.token });
    const agosto = await req('GET', T('/referencia/2026-08-15/Maria Souza'), { token: A.token });

    /* A GARANTIA: a mesma pessoa, duas datas, dois horários. Uma edição de hoje não pode
     * reinterpretar um dia já analisado — horas extras de julho foram justificadas contra o
     * horário de julho. */
    expect(julho.corpo.faixa).toBe('05:40–08:30 · 16:00–19:00');
    expect(agosto.corpo.faixa).toBe('06:00–11:00 · 12:00–16:00');
  });

  it('abrir uma vigência nova encerra a anterior, sem buraco nem sobreposição', async () => {
    await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Pedro Lima',
        marcacoes: ['07:00', '15:00'], cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
      },
    });
    await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Pedro Lima',
        marcacoes: ['08:00', '16:00'], cargaPrevistaMin: 480, vigenciaInicio: '2026-05-01',
      },
    });

    const r = await req('GET', T('/padroes/colaborador/Pedro Lima'), { token: A.token });
    expect(r.corpo).toHaveLength(2);

    const antiga = r.corpo.find((p) => p.vigenciaInicio === '2026-01-01');
    /* 30/04, não 01/05: um dia antes do início do novo. Sem isso, 01/05 teria dois horários. */
    expect(antiga.vigenciaFim).toBe('2026-04-30');

    const abril = await req('GET', T('/referencia/2026-04-30/Pedro Lima'), { token: A.token });
    const maio = await req('GET', T('/referencia/2026-05-01/Pedro Lima'), { token: A.token });
    expect(abril.corpo.faixa).toBe('07:00–15:00');
    expect(maio.corpo.faixa).toBe('08:00–16:00');
  });

  it('sem escala e sem padrão vigente, o sistema DIZ que não sabe — não inventa horário', async () => {
    const r = await req('GET', T('/referencia/2026-08-20/Fulano Inexistente'), { token: A.token });
    expect(r.corpo.tipo).toBe('nao_encontrada');
    expect(r.corpo.marcacoes).toEqual([]);
    expect(r.corpo.saidaPrevista).toBe('');
  });
});

/* ================================================================ BLOQUEADOR 3 */

describe('BLOQUEADOR — reprocessar preserva a análise humana', () => {
  let ocorrencia;

  it('a HE do dia vira ocorrência, com a referência registrada', async () => {
    const r = await req('GET', T('/he?busca=João'), { token: A.token });
    const joao = r.corpo.find((o) => o.data === '2026-08-20');
    expect(joao).toBeDefined();
    expect(joao.referenciaTipo).toBe('escala');
    expect(joao.referenciaHorarios).toBe('06:00–11:00 · 12:00–17:00');
    expect(joao.referenciaExtraMin).toBe(120);
    ocorrencia = joao.id;
  });

  it('alguém justifica', async () => {
    const r = await req('PUT', T(`/he/${ocorrencia}/justificativa`), {
      token: A.token,
      corpo: {
        status: 'justificada', motivo: 'Demanda da operação',
        justificativa: 'Cliente liberou a carga com atraso; o motorista aguardou no pátio.',
        origem: 'Supervisor', quemInformou: 'Carlos',
      },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.responsavel).toBeTruthy();
  });

  it('a escala é corrigida e o dia reprocessado — a HE muda, a justificativa fica', async () => {
    /* Correção da escala: a saída prevista passa a ser 18:00. */
    await req('PUT', T('/escalas'), {
      token: A.token,
      corpo: {
        colaborador: 'João da Silva', data: '2026-08-20', situacao: 'alteracao_horario',
        marcacoes: ['06:00', '11:00', '12:00', '18:00'], cargaPrevistaMin: 480,
        motivo: 'Escala corrigida pela supervisão',
      },
    });

    await req('PUT', T('/dias/2026-08-20'), {
      token: A.token,
      corpo: {
        snapshot: dia('2026-08-20', [ponto('João da Silva', '06:03 11:02 12:01 17:18', 196)]),
        caseState: {},
      },
    });

    const r = await req('GET', T(`/he/${ocorrencia}`), { token: A.token });
    expect(r.status).toBe(200);

    /* O número mudou... */
    expect(r.corpo.heMin).toBe(196);
    expect(r.corpo.heMinAnterior).toBe(136);
    expect(r.corpo.recalculadaEm).toBeTruthy();

    /* ...e TUDO que uma pessoa escreveu continua exatamente onde estava. */
    expect(r.corpo.status).toBe('justificada');
    expect(r.corpo.motivo).toBe('Demanda da operação');
    expect(r.corpo.justificativa).toContain('aguardou no pátio');
    expect(r.corpo.origem).toBe('Supervisor');
    expect(r.corpo.quemInformou).toBe('Carlos');
    expect(r.corpo.responsavel).toBeTruthy();

    /* E o histórico registra a mudança, com o valor anterior. */
    const eventos = r.corpo.historico.map((h) => h.evento);
    expect(eventos).toContain('justificada');
    expect(eventos).toContain('recalculada');
  });

  it('a nova referência também ficou registrada na ocorrência', async () => {
    const r = await req('GET', T(`/he/${ocorrencia}`), { token: A.token });
    expect(r.corpo.referenciaHorarios).toBe('06:00–11:00 · 12:00–18:00');
  });
});

/* ================================================================ fluxo completo */

describe('processamento automático separa o que precisa de gente do que não precisa', () => {
  const DIA = '2026-08-21';

  beforeAll(async () => {
    /* Padrões para quatro pessoas. */
    for (const nome of ['Ana Correta', 'Bruno Intervalo', 'Carla Folga', 'Diego SemRef']) {
      if (nome === 'Diego SemRef') continue; /* de propósito: fica sem referência */
      await req('POST', T('/padroes'), {
        token: A.token,
        corpo: {
          colaborador: nome, marcacoes: ['08:00', '12:00', '13:00', '17:00'],
          cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
        },
      });
    }

    /* Carla está de folga nesse dia. */
    await req('PUT', T('/escalas'), {
      token: A.token,
      corpo: { colaborador: 'Carla Folga', data: DIA, situacao: 'folga', marcacoes: [] },
    });

    await req('PUT', T(`/dias/${DIA}`), {
      token: A.token,
      corpo: {
        snapshot: dia(DIA, [
          /* bate certinho */
          ponto('Ana Correta', '08:00 12:00 13:00 17:00', 0),
          /* intervalo começou 27 min atrasado */
          ponto('Bruno Intervalo', '08:00 12:27 13:27 17:00', 0),
          /* trabalhou na folga */
          ponto('Carla Folga', '08:00 12:00 13:00 17:00', 0),
          /* nenhuma referência cadastrada */
          ponto('Diego SemRef', '08:00 12:00 13:00 19:00', 120),
        ]),
        caseState: {},
      },
    });
  });

  it('quem está correto NÃO ocupa a fila', async () => {
    const r = await req('GET', T(`/analises?data=${DIA}`), { token: A.token });
    const ana = r.corpo.find((a) => a.colaborador === 'Ana Correta');
    expect(ana.classificacao).toBe('ok');
    expect(ana.divergencias).toHaveLength(0);

    const fila = await req('GET', T(`/fila?data=${DIA}`), { token: A.token });
    expect(fila.corpo.some((p) => p.descricao.includes('Ana Correta'))).toBe(false);
  });

  it('o intervalo iniciado fora do previsto é detectado com previsto e realizado', async () => {
    const r = await req('GET', T(`/analises?data=${DIA}`), { token: A.token });
    const bruno = r.corpo.find((a) => a.colaborador === 'Bruno Intervalo');

    const d = bruno.divergencias.find((x) => x.tipo === 'intervalo_fora_do_previsto');
    expect(d).toBeDefined();
    expect(d.previsto).toBe('12:00');
    expect(d.realizado).toBe('12:27');
    expect(d.diferencaMin).toBe(27);
  });

  it('trabalho em dia de folga é crítico', async () => {
    const r = await req('GET', T(`/analises?data=${DIA}`), { token: A.token });
    const carla = r.corpo.find((a) => a.colaborador === 'Carla Folga');
    expect(carla.classificacao).toBe('critico');
    expect(carla.divergencias.some((d) => d.tipo === 'trabalho_em_folga')).toBe(true);
  });

  it('sem referência, o sistema diz que não pode concluir — e não calcula contra nada', async () => {
    const r = await req('GET', T(`/analises?data=${DIA}`), { token: A.token });
    const diego = r.corpo.find((a) => a.colaborador === 'Diego SemRef');
    expect(diego.referenciaTipo).toBe('nao_encontrada');
    expect(diego.classificacao).toBe('critico');
    expect(diego.divergencias.some((d) => d.tipo === 'sem_referencia')).toBe(true);
  });

  it('o resumo do dia bate com as análises', async () => {
    const r = await req('GET', T(`/resumo/diario/${DIA}`), { token: A.token });
    expect(r.status).toBe(200);
    expect(r.corpo.processados).toBe(4);
    expect(r.corpo.ok).toBe(1);
    expect(r.corpo.precisamAnalise).toBe(3);
  });

  it('a fila prioriza: o crítico vem antes do que é só atenção', async () => {
    const r = await req('GET', T(`/fila?data=${DIA}`), { token: A.token });
    expect(r.corpo.length).toBeGreaterThan(0);

    const scores = r.corpo.map((p) => p.prioridadeScore);
    /* Ordenada de forma decrescente: quem abre a fila vê primeiro o mais urgente. */
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(r.corpo[0].gravidade).toBe('critico');
  });

  it('os filtros rápidos recortam a fila', async () => {
    const criticos = await req('GET', T('/fila?rapido=criticos'), { token: A.token });
    expect(criticos.corpo.every((p) => p.gravidade === 'critico')).toBe(true);

    const intervalos = await req('GET', T('/fila?rapido=intervalos'), { token: A.token });
    expect(intervalos.corpo.every((p) => p.tipo.startsWith('intervalo') || p.tipo === 'sem_intervalo')).toBe(true);
  });
});

/* ================================================================ resolução automática */

describe('a pendência se encerra sozinha quando a causa deixa de existir', () => {
  const DIA = '2026-08-22';

  it('ponto sem referência gera pendência crítica', async () => {
    await req('PUT', T(`/dias/${DIA}`), {
      token: A.token,
      corpo: {
        snapshot: dia(DIA, [ponto('Elias Novo', '07:00 11:00 12:00 16:40', 40)]),
        caseState: {},
      },
    });

    const fila = await req('GET', T(`/fila?data=${DIA}`), { token: A.token });
    expect(fila.corpo.some((p) => p.tipo === 'sem_referencia' || p.tipo === 'ponto_sem_escala')).toBe(true);
  });

  it('importar a escala do dia resolve a pendência SEM ninguém fechar à mão', async () => {
    const r = await req('POST', T('/escalas/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'escala-agosto.xlsx',
        formato: 'xlsx',
        linhas: [{
          colaborador: 'Elias Novo', data: DIA, situacao: 'trabalha',
          marcacoes: ['07:00', '11:00', '12:00', '16:00'], cargaPrevistaMin: 480,
        }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.criadas).toBe(1);
    /* A importação reprocessa os dias afetados — é isso que dispara a resolução. */
    expect(r.corpo.reprocesso.dias).toBeGreaterThan(0);

    const fila = await req('GET', T(`/fila?data=${DIA}`), { token: A.token });
    expect(fila.corpo.some((p) => p.tipo === 'sem_referencia')).toBe(false);

    const resolvidas = await req('GET', T(`/fila?data=${DIA}&incluirResolvidas=1`), { token: A.token });
    const auto = resolvidas.corpo.find((p) => p.tipo === 'sem_referencia');
    expect(auto.status).toBe('resolvida');
    /* Fechada pelo SISTEMA, não por uma pessoa — a distinção fica registrada. */
    expect(auto.resolvidaAutomaticamente).toBe(true);
  });

  it('e a jornada passa a ser analisada contra a escala importada', async () => {
    const r = await req('GET', T(`/analises?data=${DIA}`), { token: A.token });
    const elias = r.corpo.find((a) => a.colaborador === 'Elias Novo');
    expect(elias.referenciaTipo).toBe('escala');
    expect(elias.divergencias.some((d) => d.tipo === 'saida_posterior')).toBe(true);
  });
});

/* ================================================================ importação */

describe('importar escala não sobrescreve em silêncio', () => {
  it('a prévia mostra o que mudaria, sem gravar', async () => {
    const r = await req('POST', T('/escalas/importacao/previa'), {
      token: A.token,
      corpo: {
        linhas: [{
          colaborador: 'Elias Novo', data: '2026-08-22', situacao: 'trabalha',
          marcacoes: ['07:00', '11:00', '12:00', '17:00'], cargaPrevistaMin: 480,
        }],
      },
    });

    expect(r.corpo.substituicoes).toBe(1);
    const item = r.corpo.itens[0];
    expect(item.acao).toBe('substitui');
    /* O antes e o depois lado a lado: é o que permite decidir antes de confirmar. */
    expect(item.anterior.faixa).toBe('07:00–11:00 · 12:00–16:00');
    expect(item.faixa).toBe('07:00–11:00 · 12:00–17:00');

    /* E nada foi gravado. */
    const atual = await req('GET', T('/referencia/2026-08-22/Elias Novo'), { token: A.token });
    expect(atual.corpo.faixa).toBe('07:00–11:00 · 12:00–16:00');
  });

  it('linha com horário inválido é recusada, e o resto entra', async () => {
    const r = await req('POST', T('/escalas/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'escala-torta.csv', formato: 'csv',
        linhas: [
          { colaborador: 'Fabio Ok', data: '2026-08-25', situacao: 'trabalha', marcacoes: ['08:00', '17:00'], cargaPrevistaMin: 480 },
          { colaborador: 'Gina Torta', data: '2026-08-25', situacao: 'trabalha', marcacoes: ['8h', '25:99'], cargaPrevistaMin: 480 },
        ],
      },
    });

    expect(r.corpo.criadas).toBe(1);
    expect(r.corpo.ignoradas).toBe(1);
    expect(r.corpo.problemas[0].colaborador).toBe('Gina Torta');
  });

  it('duas linhas para a mesma pessoa e data são apontadas como duplicidade', async () => {
    const r = await req('POST', T('/escalas/importacao/previa'), {
      token: A.token,
      corpo: {
        linhas: [
          { colaborador: 'Hugo Duplo', data: '2026-08-26', situacao: 'trabalha', marcacoes: ['08:00', '17:00'] },
          { colaborador: 'Hugo Duplo', data: '2026-08-26', situacao: 'trabalha', marcacoes: ['09:00', '18:00'] },
        ],
      },
    });

    const segundo = r.corpo.itens[1];
    expect(segundo.problemas.some((p) => p.tipo === 'duplicado_no_arquivo')).toBe(true);
    expect(segundo.acao).toBe('erro');
  });

  it('suporta 6 registros — jornada com dois intervalos não é achatada', async () => {
    const r = await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Iara SeisBatidas',
        marcacoes: ['06:00', '09:00', '10:00', '13:00', '14:00', '17:00'],
        cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
      },
    });
    expect(r.status).toBe(201);
    expect(r.corpo.marcacoes).toHaveLength(6);
    expect(r.corpo.faixa).toBe('06:00–09:00 · 10:00–13:00 · 14:00–17:00');
    /* 3h + 3h + 3h = 9h, carga 8h → 60 min. */
    expect(r.corpo.extraMin).toBe(60);
  });
});

/* ================================================================ mensagem */

describe('a mensagem ao colaborador usa somente fatos apurados', () => {
  it('gera o texto a partir da divergência, sem IA configurada', async () => {
    const lista = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const bruno = lista.corpo.find((a) => a.colaborador === 'Bruno Intervalo');

    const r = await req('POST', T(`/analises/${bruno.id}/mensagem`), {
      token: A.token,
      corpo: { tipo: 'intervalo_fora_do_previsto' },
    });

    expect(r.status).toBe(200);
    /* Sem credencial de IA o sistema continua entregando a mensagem — nunca bloqueia operação. */
    expect(r.corpo.origem).toBe('deterministica');
    expect(r.corpo.mensagem).toContain('12:00');
    expect(r.corpo.mensagem).toContain('12:27');
    expect(r.corpo.revisaoObrigatoria).toBe(true);
  });

  it('a guarda recusa texto que cite horário inexistente nos fatos', async () => {
    const { textoRespeitaOsFatos } = await import('./services/ia.js');
    const fatos = 'Previsto: 12:00\nRegistrado: 12:27';

    expect(textoRespeitaOsFatos('O intervalo iniciou às 12:27 em vez de 12:00.', fatos).ok).toBe(true);

    /* Um horário que ninguém apurou é alucinação — e numa mensagem ao colaborador vira acusação
     * falsa. Este é o teste que sustenta a regra do requisito 8. */
    const r = textoRespeitaOsFatos('O intervalo iniciou às 13:45.', fatos);
    expect(r.ok).toBe(false);
    expect(r.invento).toBe('13:45');
  });
});

/* ================================================================ sem IA */

describe('o sistema opera inteiro sem IA', () => {
  it('o estado da IA é informado sem expor credencial', async () => {
    const r = await req('GET', T('/ia/estado'), { token: A.token });
    expect(r.status).toBe(200);
    expect(r.corpo.configurado).toBe(false);
    expect(JSON.stringify(r.corpo)).not.toMatch(/sk-|api[-_]?key/i);
  });

  it('resumo semanal e análise gerencial respondem com números reais', async () => {
    const semanal = await req('GET', T('/resumo/semanal/2026-08-22'), { token: A.token });
    expect(semanal.status).toBe(200);
    expect(semanal.corpo.processados).toBeGreaterThan(0);

    const r = await req('POST', T('/analise-gerencial'), {
      token: A.token,
      corpo: { pergunta: 'Por que aumentaram as horas extras esta semana?', ate: '2026-08-22' },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.origem).toBe('deterministica');
    /* A leitura determinística cita os números apurados — não é um "indisponível". */
    expect(r.corpo.resposta).toContain('jornadas');
    expect(r.corpo.dados.jornadasAnalisadas).toBeGreaterThan(0);
  });
});

/* ================================================================ isolamento */

describe('BLOQUEADOR — nada disso cruza empresas', () => {
  it('outra empresa não vê escala, padrão, análise nem fila da primeira', async () => {
    const B = await novaEmpresa('vizinha');
    const TB = (c) => `/api/tenants/${B.tenantId}${c}`;

    for (const caminho of ['/escalas', '/padroes', '/analises', '/fila']) {
      const r = await req('GET', TB(caminho), { token: B.token });
      expect(r.status).toBe(200);
      expect(r.corpo).toHaveLength(0);
    }

    /* E não alcança a empresa A nem apontando direto para o id dela. */
    const invasao = await req('GET', T('/analises'), { token: B.token });
    expect(invasao.status).toBe(404);
  });

  it('a análise gerencial de uma empresa não recebe dado da outra', async () => {
    const B = await novaEmpresa('vizinha2');
    const r = await req('POST', `/api/tenants/${B.tenantId}/analise-gerencial`, {
      token: B.token,
      corpo: { pergunta: 'Quais casos precisam de atenção hoje?' },
    });
    expect(r.status).toBe(200);
    /* Empresa recém-criada: nenhuma jornada. Se vazasse dado da outra, este número não seria 0. */
    expect(r.corpo.dados.jornadasAnalisadas).toBe(0);
    expect(r.corpo.dados.horaExtraTotalMin).toBe(0);
  });
});
