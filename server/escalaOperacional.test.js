/* ESCALA OPERACIONAL — serviços, não jornada.
 *
 * O ERRO QUE ESTES TESTES EXISTEM PARA IMPEDIR
 * --------------------------------------------
 * Uma fase anterior tratou a escala como jornada: primeiro horário = entrada, último = saída,
 * e a escala vencia o horário padrão. Aplicado à escala real — 4,3 serviços por motorista por
 * dia, do primeiro às 05:40 ao último às 22:00 — isso produzia 16h20 de "jornada prevista" e
 * fazia a hora extra verdadeira desaparecer dentro dela.
 *
 * O CENÁRIO H abaixo é o teste que fixa a correção: padrão até 16:00, última rota às 14:30,
 * ponto encerrando 16:18. O sistema NÃO pode ler 14:30 como fim previsto da jornada.
 *
 * Os cenários seguem as letras do pedido, para que a conversa e o código usem o mesmo nome. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__escalaop.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
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
  try { return { status: r.status, corpo: t ? JSON.parse(t) : null }; }
  catch { return { status: r.status, corpo: t }; }
}

/* Um serviço da escala, no formato que o importador produz a partir da matriz da planilha. */
const svc = (data, empresa, linha, horario, descricao, colaborador, extra = {}) => ({
  data, empresa, filial: extra.filial ?? 'GTI', linha, horario, descricao, colaborador,
  rotulo: extra.rotulo ?? 'outro', seq: extra.seq ?? '', projecaoCarro: extra.carro ?? '',
  terceirizado: !!extra.terceirizado, horarioDescricao: extra.horarioDescricao ?? '',
  horarioCondicional: extra.condicional ?? '',
});

const ponto = (nome, batidas, heMin) => ({
  motorista: nome, he1min: heMin, he1str: '', status: 'forte', rastreioStatus: 'forte',
  detalhe: '', confirmadas: '', batidas, contexto: '', padraoStatus: 'acima',
  padraoMin: 60, excedenteMin: heMin, padraoDebug: '', padraoHorarios: [],
  setorAtual: 'Operacional', causaAtual: null, causaFonte: null, interjornada: '',
  diaAjustado: 0, temLacuna: false, precisaVerificar: false,
});

const dia = (dateKey, itens) => ({
  snapshot: {
    dateKey, dateLabel: dateKey, items: itens,
    totalHE: itens.reduce((s, i) => s + i.he1min, 0),
    acimaHE: itens.reduce((s, i) => s + i.he1min, 0),
    programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
  },
  caseState: {},
});

let A;
const T = (c) => `/api/tenants/${A.tenantId}${c}`;

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await req('POST', '/api/auth/registrar', {
    corpo: {
      email: 'op@escala.test', nome: 'Operação', senha: 'senha-forte-escala-op',
      nomeEmpresa: 'FICTICIA Operacional',
    },
  });
  expect(r.status).toBe(201);
  A = { token: r.corpo.token, tenantId: r.corpo.tenants[0].id };
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(DB + s); } catch { /* pode não existir */ }
  }
});

/* ================================================================ BLOQUEADOR — cenário H */

describe('CENÁRIO H — a última rota do dia NÃO é o fim da jornada', () => {
  it('prepara: padrão até 16:00, última rota às 14:30, ponto até 16:18', async () => {
    const p = await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Ademar dos Santos',
        marcacoes: ['06:00', '11:00', '12:00', '16:00'],
        cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
      },
    });
    expect(p.status).toBe(201);

    const imp = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'escala.xlsx', formato: 'xlsx',
        servicos: [
          svc('2026-08-21', 'VIEMAR', '103', '05:40', '103 - POA/Centro (ENTRADA 05:40)', 'Ademar dos Santos', { rotulo: 'entrada' }),
          svc('2026-08-21', 'VIEMAR', '403', '07:10', '403 - Humaitá (ENTRADA 07:10)', 'Ademar dos Santos', { rotulo: 'entrada' }),
          svc('2026-08-21', 'SHOPEE', '104', '11:20', '104 - Canoas (SAÍDA 11:20)', 'Ademar dos Santos', { rotulo: 'saida' }),
          svc('2026-08-21', 'VIEMAR', '205', '14:30', '205 - Gravataí (SAÍDA 14:30)', 'Ademar dos Santos', { rotulo: 'saida' }),
        ],
      },
    });
    expect(imp.status).toBe(200);
    expect(imp.corpo.novos).toBe(4);

    await req('PUT', T('/dias/2026-08-21'), {
      token: A.token,
      corpo: dia('2026-08-21', [ponto('Ademar dos Santos', '06:00 11:00 12:00 16:18', 18)]),
    });
  });

  it('a referência TRABALHISTA é o horário padrão — nunca a escala', async () => {
    const r = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const a = r.corpo.find((x) => x.colaborador === 'Ademar dos Santos');

    expect(a.referenciaTipo).toBe('padrao');
    expect(a.referenciaHorarios).toBe('06:00–11:00 · 12:00–16:00');
  });

  it('a saída é comparada contra 16:00 — NÃO contra 14:30', async () => {
    const r = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const a = r.corpo.find((x) => x.colaborador === 'Ademar dos Santos');
    const saida = a.divergencias.find((d) => d.tipo === 'saida_posterior');

    expect(saida).toBeDefined();
    /* O NÚMERO QUE PROVA A CORREÇÃO. Contra o padrão (16:00) dá +18.
     * Contra a última rota (14:30) daria +108 — e é esse 108 que este teste impede. */
    expect(saida.previsto).toBe('16:00');
    expect(saida.realizado).toBe('16:18');
    expect(saida.diferencaMin).toBe(18);
  });

  it('nenhum horário operacional aparece como previsto em divergência nenhuma', async () => {
    const r = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const a = r.corpo.find((x) => x.colaborador === 'Ademar dos Santos');

    const operacionais = ['05:40', '07:10', '11:20', '14:30'];
    for (const d of a.divergencias) {
      for (const h of operacionais) {
        expect(String(d.previsto)).not.toContain(h);
      }
    }
  });

  it('mas os serviços contam como CONTEXTO na análise', async () => {
    const r = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const a = r.corpo.find((x) => x.colaborador === 'Ademar dos Santos');
    expect(a.servicosNoDia).toBe(4);
  });

  it('a explicação separa referência trabalhista de contexto operacional', async () => {
    const lista = await req('GET', T('/analises?data=2026-08-21'), { token: A.token });
    const a = lista.corpo.find((x) => x.colaborador === 'Ademar dos Santos');
    const r = await req('GET', T(`/analises/${a.id}/explicacao`), { token: A.token });

    expect(r.status).toBe(200);
    expect(r.corpo.porQue).toMatch(/HOR[ÁA]RIO PADR[ÃA]O/i);
    /* E os serviços vêm junto, com nome próprio — nunca como "saída prevista". */
    expect(r.corpo.contextoOperacional.total).toBe(4);
    expect(r.corpo.contextoOperacional.servicos[0].horario).toBe('05:40');
  });
});

describe('quem tem horário padrão cadastrado é reconhecido', () => {
  it('não aparece como nome desconhecido na prévia', async () => {
    /* Defeito achado na validação em navegador: a prévia acusava como desconhecido justamente
     * quem estava melhor cadastrado — alguém com horário padrão digitado à mão no sistema. */
    const r = await req('POST', T('/servicos/importacao/previa'), {
      token: A.token,
      corpo: {
        servicos: [
          svc('2026-09-10', 'ACME', '500', '08:00', '500 - Rota', 'Ademar dos Santos'),
          svc('2026-09-10', 'ACME', '501', '08:00', '501 - Rota', 'Nunca Visto'),
        ],
      },
    });
    expect(r.corpo.motoristasNaoCadastrados).toEqual(['Nunca Visto']);
  });
});

/* ================================================================ cenários A–G */

describe('múltiplos serviços por motorista e por dia', () => {
  it('CENÁRIO A — um motorista, um serviço', async () => {
    const r = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: { arquivo: 'a.xlsx', servicos: [svc('2026-08-24', 'PERTO', '901', '08:00', '901 - Único', 'Solo Silva')] },
    });
    expect(r.corpo.novos).toBe(1);

    const p = await req('GET', T('/servicos/2026-08-24/Solo Silva'), { token: A.token });
    expect(p.corpo.total).toBe(1);
  });

  it('CENÁRIO B — um motorista, cinco serviços no mesmo dia', async () => {
    const cinco = ['05:00', '08:00', '12:00', '17:00', '21:00'].map((h, i) =>
      svc('2026-08-25', 'MUNDIAL', `10${i}`, h, `10${i} - Rota ${i}`, 'Multi Souza'));

    const r = await req('POST', T('/servicos/importacao'), {
      token: A.token, corpo: { arquivo: 'b.xlsx', servicos: cinco },
    });
    expect(r.corpo.novos).toBe(5);

    const p = await req('GET', T('/servicos/2026-08-25/Multi Souza'), { token: A.token });
    /* O modelo antigo guardaria UMA linha por pessoa/dia e recusaria as outras quatro. */
    expect(p.corpo.total).toBe(5);
    expect(p.corpo.servicos.map((s) => s.horario)).toEqual(['05:00', '08:00', '12:00', '17:00', '21:00']);
  });

  it('CENÁRIO C — três motoristas, mesma empresa, mesmo horário, rotas diferentes', async () => {
    const r = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'c.xlsx',
        servicos: [
          svc('2026-08-26', 'VIEMAR', '103', '07:10', '103 - Centro', 'João Um'),
          svc('2026-08-26', 'VIEMAR', 'AB', '07:10', 'AB - Zona Norte', 'Carlos Dois'),
          svc('2026-08-26', 'VIEMAR', '205', '07:10', '205 - Zona Sul', 'Pedro Três'),
        ],
      },
    });
    /* EMPRESA + HORÁRIO não identifica serviço. Se identificasse, dois destes três se
     * sobrescreveriam e a escala perderia dois motoristas. */
    expect(r.corpo.novos).toBe(3);

    const d = await req('GET', T('/servicos?data=2026-08-26'), { token: A.token });
    expect(d.corpo).toHaveLength(3);
    expect(new Set(d.corpo.map((s) => s.colaborador)).size).toBe(3);
  });

  it('CENÁRIO D e E — "X" e célula vazia não geram serviço nem ausência', async () => {
    /* O importador do frontend descarta essas células antes de enviar; aqui garantimos que, se
     * uma escapar, ela é recusada como serviço sem motorista — e não vira falta de ninguém. */
    const r = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'de.xlsx',
        servicos: [
          svc('2026-08-27', 'PERTO', '301', '06:00', '301 - Existe', 'Presente Silva'),
          svc('2026-08-27', 'PERTO', '302', '06:00', '302 - Não roda hoje', ''),
        ],
      },
    });
    expect(r.corpo.novos).toBe(1);
    expect(r.corpo.recusados).toBe(1);

    /* E nenhuma pendência de ausência foi criada por causa da linha vazia. */
    const fila = await req('GET', T('/fila?data=2026-08-27'), { token: A.token });
    expect(fila.corpo.some((p) => /não roda|302/i.test(p.descricao))).toBe(false);
  });

  it('CENÁRIO F — reimportar com outro motorista TROCA o responsável e guarda o anterior', async () => {
    const antes = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: { arquivo: 'f1.xlsx', servicos: [svc('2026-08-28', 'VIEMAR', '103', '07:10', '103 - Rota', 'João Antigo')] },
    });
    expect(antes.corpo.novos).toBe(1);

    const depois = await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: { arquivo: 'f2.xlsx', servicos: [svc('2026-08-28', 'VIEMAR', '103', '07:10', '103 - Rota', 'Carlos Novo')] },
    });
    expect(depois.corpo.trocados).toBe(1);
    expect(depois.corpo.novos).toBe(0);

    const lista = await req('GET', T('/servicos?data=2026-08-28'), { token: A.token });
    /* Um serviço, não dois. */
    expect(lista.corpo).toHaveLength(1);
    expect(lista.corpo[0].colaborador).toBe('Carlos Novo');

    const h = await req('GET', T(`/servicos/item/${lista.corpo[0].id}/historico`), { token: A.token });
    const troca = h.corpo.find((x) => x.evento === 'motorista_alterado');
    expect(troca).toBeDefined();
    expect(troca.valorAnterior).toBe('João Antigo');
    expect(troca.valorNovo).toBe('Carlos Novo');
  });

  it('CENÁRIO G — reimportar o MESMO arquivo não muda nada', async () => {
    const linhas = [
      svc('2026-08-31', 'HERC', '3D', '06:15', '3D - Canoas', 'Idem Silva'),
      svc('2026-08-31', 'HERC', '4F', '07:10', '4F - Gravataí', 'Idem Silva'),
    ];

    const um = await req('POST', T('/servicos/importacao'), { token: A.token, corpo: { arquivo: 'g.xlsx', servicos: linhas } });
    expect(um.corpo.novos).toBe(2);

    const dois = await req('POST', T('/servicos/importacao'), { token: A.token, corpo: { arquivo: 'g.xlsx', servicos: linhas } });
    /* Idempotente: nada novo, nada trocado, nada duplicado. */
    expect(dois.corpo.novos).toBe(0);
    expect(dois.corpo.trocados).toBe(0);
    expect(dois.corpo.semMudanca).toBe(2);

    const lista = await req('GET', T('/servicos?data=2026-08-31'), { token: A.token });
    expect(lista.corpo).toHaveLength(2);

    /* E o histórico não ganhou uma linha dizendo que houve alteração quando não houve. */
    const h = await req('GET', T(`/servicos/item/${lista.corpo[0].id}/historico`), { token: A.token });
    expect(h.corpo.filter((x) => x.evento === 'motorista_alterado')).toHaveLength(0);
  });
});

/* ================================================================ cenários I e J */

describe('CENÁRIOS I e J — horário operacional não é batida de ponto', () => {
  it('entrada operacional às 07:10 com ponto antes NÃO vira divergência', async () => {
    await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Pontual Lima', marcacoes: ['06:00', '11:00', '12:00', '16:00'],
        cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
      },
    });

    await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'i.xlsx',
        servicos: [
          svc('2026-09-01', 'AIVA', '404', '07:10', '404 - Alvorada (ENTRADA 07:10)', 'Pontual Lima', { rotulo: 'entrada' }),
          svc('2026-09-01', 'AIVA', '302', '07:10', '302 - Alvorada (SAÍDA 07:10)', 'Pontual Lima', { rotulo: 'saida' }),
        ],
      },
    });

    /* Ponto batido às 06:00, como o padrão manda — bem antes do serviço das 07:10.
     * O motorista precisa começar antes para estar posicionado; é o esperado, não um desvio. */
    await req('PUT', T('/dias/2026-09-01'), {
      token: A.token,
      corpo: dia('2026-09-01', [ponto('Pontual Lima', '06:00 11:00 12:00 16:00', 0)]),
    });

    const r = await req('GET', T('/analises?data=2026-09-01'), { token: A.token });
    const a = r.corpo.find((x) => x.colaborador === 'Pontual Lima');

    /* Bate exatamente com o padrão: nenhuma divergência. Se o sistema comparasse a batida com o
     * horário operacional, apareceria "entrada antecipada em 70 min" — falso. */
    expect(a.classificacao).toBe('ok');
    expect(a.divergencias).toHaveLength(0);
    expect(a.servicosNoDia).toBe(2);
  });
});

/* ================================================================ cenário K */

describe('CENÁRIO K — a justificativa sobrevive à mudança da escala', () => {
  let ocorrencia;

  it('há uma HE justificada', async () => {
    await req('POST', T('/padroes'), {
      token: A.token,
      corpo: {
        colaborador: 'Justifica Costa', marcacoes: ['06:00', '11:00', '12:00', '16:00'],
        cargaPrevistaMin: 480, vigenciaInicio: '2026-01-01',
      },
    });
    await req('PUT', T('/dias/2026-09-02'), {
      token: A.token,
      corpo: dia('2026-09-02', [ponto('Justifica Costa', '06:00 11:00 12:00 17:30', 150)]),
    });

    const he = await req('GET', T('/he?busca=Justifica'), { token: A.token });
    ocorrencia = he.corpo[0].id;

    const j = await req('PUT', T(`/he/${ocorrencia}/justificativa`), {
      token: A.token,
      corpo: {
        status: 'justificada', motivo: 'Demanda da operação',
        justificativa: 'Cliente liberou a carga com atraso.',
        origem: 'Supervisor', quemInformou: 'Portaria',
      },
    });
    expect(j.status).toBe(200);
  });

  it('a escala do dia muda e é reimportada — a análise humana continua intacta', async () => {
    await req('POST', T('/servicos/importacao'), {
      token: A.token,
      corpo: {
        arquivo: 'k.xlsx',
        servicos: [svc('2026-09-02', 'PERTO', '777', '19:00', '777 - Rota nova (SAÍDA 19:00)', 'Justifica Costa', { rotulo: 'saida' })],
      },
    });

    const r = await req('GET', T(`/he/${ocorrencia}`), { token: A.token });

    expect(r.corpo.status).toBe('justificada');
    expect(r.corpo.justificativa).toContain('Cliente liberou a carga');
    expect(r.corpo.origem).toBe('Supervisor');
    expect(r.corpo.quemInformou).toBe('Portaria');
    expect(r.corpo.responsavel).toBeTruthy();
    expect(r.corpo.historico.some((h) => h.evento === 'justificada')).toBe(true);
  });

  it('e a rota das 19:00 NÃO virou fim de jornada', async () => {
    const lista = await req('GET', T('/analises?data=2026-09-02'), { token: A.token });
    const a = lista.corpo.find((x) => x.colaborador === 'Justifica Costa');

    expect(a.referenciaTipo).toBe('padrao');
    const saida = a.divergencias.find((d) => d.tipo === 'saida_posterior');
    expect(saida.previsto).toBe('16:00');
  });
});

/* ================================================================ consultas */

describe('consulta operacional', () => {
  it('por data, por motorista, por empresa e por linha', async () => {
    const porData = await req('GET', T('/servicos?data=2026-08-26'), { token: A.token });
    expect(porData.corpo).toHaveLength(3);

    const porMotorista = await req('GET', T('/servicos?colaborador=Multi Souza'), { token: A.token });
    expect(porMotorista.corpo).toHaveLength(5);

    const porEmpresa = await req('GET', T('/servicos?empresa=VIEMAR&data=2026-08-26'), { token: A.token });
    expect(porEmpresa.corpo).toHaveLength(3);

    const porLinha = await req('GET', T('/servicos?linha=103'), { token: A.token });
    expect(porLinha.corpo.length).toBeGreaterThanOrEqual(1);
    expect(porLinha.corpo.every((s) => s.linha === '103')).toBe(true);
  });

  it('o panorama do dia conta serviços, motoristas, empresas e linhas', async () => {
    const r = await req('GET', T('/servicos/panorama/2026-08-26'), { token: A.token });
    expect(r.corpo.servicos).toBe(3);
    expect(r.corpo.motoristas).toBe(3);
    expect(r.corpo.empresas).toBe(1);
    expect(r.corpo.linhas).toBe(3);
  });

  it('a programação do dia traz o horário padrão IDENTIFICADO como outra fonte', async () => {
    const r = await req('GET', T('/servicos/2026-08-21/Ademar dos Santos'), { token: A.token });

    expect(r.corpo.total).toBe(4);
    /* As duas coisas na mesma resposta, com nomes diferentes — é o que impede alguém de ler a
     * escala como jornada. */
    expect(r.corpo.referenciaTrabalhista.tipo).toBe('padrao');
    expect(r.corpo.referenciaTrabalhista.faixa).toBe('06:00–11:00 · 12:00–16:00');
  });
});

/* ================================================================ isolamento */

describe('a escala operacional respeita o isolamento entre empresas', () => {
  it('outra empresa não vê serviço nenhum', async () => {
    const r = await req('POST', '/api/auth/registrar', {
      corpo: { email: 'vizinho@escala.test', nome: 'Vizinho', senha: 'senha-forte-viz', nomeEmpresa: 'Vizinha' },
    });
    expect(r.status, JSON.stringify(r.corpo)).toBe(201);
    const B = { token: r.corpo.token, tenantId: r.corpo.tenants[0].id };

    const meus = await req('GET', `/api/tenants/${B.tenantId}/servicos`, { token: B.token });
    expect(meus.corpo).toHaveLength(0);

    const invasao = await req('GET', T('/servicos'), { token: B.token });
    expect(invasao.status).toBe(404);
  });
});
