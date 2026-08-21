/* Testes da Minha Fila e da explicação da ocorrência.
 *
 * O que eles protegem é a promessa da tela, não a aparência dela:
 *
 *  1. quem está OK não ocupa a fila — a operação é por exceção;
 *  2. o crítico vem antes do que é só atenção, na ordem que o servidor determinou;
 *  3. "por que isso apareceu?" mostra a referência USADA e a que NÃO foi usada, lado a lado —
 *     é o que responde "por que 17:00 e não 16:00?";
 *  4. a mensagem ao colaborador só existe a partir dos fatos; a tela não redige nada por conta.
 *
 * A ordenação e a classificação vêm prontas do servidor. Nenhum teste aqui recalcula prioridade —
 * fazer isso criaria uma segunda regra de urgência dentro do teste. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { cenarioAutenticado, limparServidorFalso, responder } from './testing/servidorFalso';

const fetchOriginal = globalThis.fetch;

/* Duas pendências, uma crítica e uma de atenção. Os scores vêm do servidor, já ordenados. */
const CRITICA = {
  id: 'pen-folga', data: '2026-08-21', tipo: 'trabalho_em_folga',
  rotuloTipo: 'Trabalho em dia de folga', categoria: 'trabalho_em_folga',
  status: 'aberta', prioridade: 'alta', gravidade: 'critico', origem: 'analise_automatica',
  descricao: 'Carla Folga — Trabalho em dia de folga: previsto Folga, registrado 08:00–17:00',
  evidencias: ['Referência utilizada: Escala do dia', 'Ponto: 08:00–17:00'],
  recomendacao: 'Confirmar se houve convocação e registrar a autorização.',
  prazo: '2026-08-24', criadaEm: '2026-08-21T09:00:00.000Z', atualizadaEm: '2026-08-21T09:00:00.000Z',
  resolvidaEm: null, resolucao: null, analiseId: 'anl-carla',
  prioridadeScore: 1_002_400, resolvidaAutomaticamente: false,
};

const ATENCAO = {
  ...CRITICA,
  id: 'pen-intervalo', tipo: 'intervalo_fora_do_previsto',
  rotuloTipo: 'Intervalo iniciado fora do previsto', categoria: 'intervalo_fora_do_previsto',
  prioridade: 'media', gravidade: 'atencao',
  descricao: 'Bruno Intervalo — Intervalo iniciado fora do previsto: previsto 12:00, registrado 12:27',
  evidencias: ['Referência utilizada: Horário padrão', 'Diferença: +27 min'],
  recomendacao: 'Confirmar com o colaborador o horário do intervalo.',
  analiseId: 'anl-bruno', prioridadeScore: 10_081,
};

const CONTADORES = {
  total: 2, criticos: 1, he: 0, intervalos: 1, escala: 1, semReferencia: 0,
  porTipo: { trabalho_em_folga: 1, intervalo_fora_do_previsto: 1 },
};

const RESUMO = {
  data: '2026-08-21', dataBr: '21/08/2026', processados: 4, ok: 1, atencao: 2, critico: 1,
  precisamAnalise: 3, heTotalMin: 120, heTotal: '2h00',
  porTipo: [{ tipo: 'trabalho_em_folga', rotulo: 'Trabalho em dia de folga', total: 1, gravidade: 'critico' }],
  referencias: { escala: 2, padrao: 2 },
  fila: { abertas: 2, criticas: 1 },
  linhas: [],
};

/* A explicação do caso do João: escala 17:00 venceu o padrão 16:00. */
const EXPLICACAO = {
  id: 'anl-bruno', colaborador: 'Bruno Intervalo', colaboradorChave: 'BRUNO INTERVALO',
  data: '2026-08-21',
  referenciaTipo: 'escala', referenciaId: 'esc-1', referenciaSituacao: 'alteracao_horario',
  referenciaHorarios: '06:00–11:00 · 12:00–17:00',
  padraoHorarios: '06:00–11:00 · 12:00–16:00',
  cargaPrevistaMin: 480, extraPrevistoMin: 120,
  pontoMarcacoes: '06:03–11:02 · 12:01–17:18',
  jornadaRealizadaMin: 616, heMin: 136, excedenteMin: 16,
  classificacao: 'atencao', rotuloClasse: 'Precisa de análise',
  divergencias: [{
    tipo: 'intervalo_fora_do_previsto', rotulo: 'Intervalo iniciado fora do previsto',
    previsto: '12:00', realizado: '12:27', diferencaMin: 27,
    detalhe: 'O intervalo estava previsto para iniciar às 12:00 e foi registrado às 12:27.',
  }],
  prioridade: 10_081, analisadoEm: '2026-08-21T09:00:00.000Z',
  reincidencia: {
    janelaDias: 30, de: '2026-07-22', ate: '2026-08-21', diasComDivergencia: 5, total: 5,
    itens: [{ tipo: 'intervalo_fora_do_previsto', rotulo: 'Intervalo iniciado fora do previsto', total: 5, ultima: '2026-08-14' }],
    ultimaSemelhante: '2026-08-14',
  },
  porQue: 'A jornada foi comparada contra a ESCALA do dia (06:00–11:00 · 12:00–17:00), e não contra o horário padrão (06:00–11:00 · 12:00–16:00), porque existe escala específica para esta data.',
};

function cenarioFila(itens: unknown[] = [CRITICA, ATENCAO]) {
  cenarioAutenticado();
  responder((url) => (url.includes('/fila/contadores') ? { status: 200, corpo: CONTADORES } : undefined));
  responder((url) => (url.includes('/resumo/diario/') ? { status: 200, corpo: RESUMO } : undefined));
  responder((url) => (url.includes('/explicacao') ? { status: 200, corpo: EXPLICACAO } : undefined));
  responder((url) => (/\/fila(\?|$)/.test(url) ? { status: 200, corpo: itens } : undefined));
}

async function abrirFila() {
  render(<App />);
  await userEvent.click(await screen.findByText('Empresa Alpha'));
  await userEvent.click(await screen.findByRole('link', { name: 'Minha Fila' }, { timeout: 3000 }));
  return screen.findByRole('heading', { name: 'Minha Fila', level: 1 }, { timeout: 3000 });
}

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/bem-vindo');
});

afterEach(() => {
  cleanup();
  limparServidorFalso();
  globalThis.fetch = fetchOriginal;
  vi.restoreAllMocks();
});

describe('Minha Fila — operação por exceção', () => {
  it('mostra só o que precisa de gente, na ordem que o servidor mandou', async () => {
    cenarioFila();
    await abrirFila();

    const itens = await screen.findAllByRole('listitem');
    const daFila = itens.filter((li) => li.className.includes('fila-item'));
    expect(daFila).toHaveLength(2);

    /* A crítica vem primeiro. A ordem é do servidor — a tela não reordena. */
    expect(daFila[0].textContent).toContain('Carla Folga');
    expect(daFila[1].textContent).toContain('Bruno Intervalo');
  });

  it('o resumo do dia diz quantos NÃO precisam de análise', async () => {
    cenarioFila();
    await abrirFila();

    /* É o número que justifica a fila existir: 4 processados, 1 sem divergência. */
    const resumo = (await screen.findByText('jornadas analisadas')).closest('.resumo-dia__numeros') as HTMLElement;
    expect(within(resumo).getByText('4')).toBeDefined();
    expect(within(resumo).getByText('sem divergências')).toBeDefined();
  });

  it('fila vazia com jornadas processadas é BOA notícia, não falta de dado', async () => {
    cenarioAutenticado();
    responder((url) => (url.includes('/fila/contadores') ? { status: 200, corpo: { ...CONTADORES, total: 0, criticos: 0 } } : undefined));
    responder((url) => (url.includes('/resumo/diario/') ? { status: 200, corpo: { ...RESUMO, processados: 4, ok: 4, atencao: 0, critico: 0, precisamAnalise: 0 } } : undefined));
    responder((url) => (/\/fila(\?|$)/.test(url) ? { status: 200, corpo: [] } : undefined));

    await abrirFila();

    /* NÃO pode dizer "seu ambiente não possui dados": há 4 jornadas, todas certas. */
    expect(await screen.findByText(/Nada pendente/i)).toBeDefined();
    expect(screen.queryByText(/ainda não possui dados/i)).toBeNull();
  });

  it('os filtros rápidos mostram quanto há em cada recorte', async () => {
    cenarioFila();
    await abrirFila();

    const criticos = await screen.findByRole('button', { name: /Críticos/ });
    expect(criticos.textContent).toContain('1');
  });
});

describe('"por que isso apareceu?"', () => {
  it('mostra a referência usada E a que não foi usada, lado a lado', async () => {
    cenarioFila();
    await abrirFila();

    await screen.findByText(/Bruno Intervalo/);
    const botoes = await screen.findAllByRole('button', { name: /Por que isso apareceu/i });
    await userEvent.click(botoes[1]);

    const painel = await screen.findByRole('dialog', { name: /Por que isso apareceu/i });

    /* A frase que responde diretamente. */
    expect(within(painel).getByText(/comparada contra a ESCALA do dia/)).toBeDefined();

    /* E os dois horários visíveis: o usado e o preterido. Sem o segundo, ninguém consegue
     * responder "por que 17:00 e não 16:00?". */
    expect(within(painel).getAllByText(/12:00–17:00/).length).toBeGreaterThan(0);
    expect(within(painel).getAllByText(/12:00–16:00/).length).toBeGreaterThan(0);

    /* O ponto real também. */
    expect(within(painel).getByText(/12:01–17:18/)).toBeDefined();
  });

  it('a divergência aparece com previsto, realizado e diferença', async () => {
    cenarioFila();
    await abrirFila();

    const botoes = await screen.findAllByRole('button', { name: /Por que isso apareceu/i });
    await userEvent.click(botoes[1]);

    const painel = await screen.findByRole('dialog', { name: /Por que isso apareceu/i });
    /* O rótulo aparece duas vezes de propósito — na etiqueta do topo, que diz do que se trata, e
     * na lista de divergências, que diz os números. Este teste é sobre a segunda. */
    const divergencias = painel.querySelector('.divergencias') as HTMLElement;
    const lista = within(divergencias).getByText('Intervalo iniciado fora do previsto').closest('li') as HTMLElement;

    expect(within(lista).getByText('12:00')).toBeDefined();
    expect(within(lista).getByText('12:27')).toBeDefined();
    expect(within(lista).getByText('+00:27')).toBeDefined();
  });

  it('a reincidência aparece dentro da ocorrência, não numa tela separada', async () => {
    cenarioFila();
    await abrirFila();

    const botoes = await screen.findAllByRole('button', { name: /Por que isso apareceu/i });
    await userEvent.click(botoes[1]);

    const painel = await screen.findByRole('dialog', { name: /Por que isso apareceu/i });
    /* "É a quinta vez este mês" é o que muda a conversa com o colaborador. */
    expect(within(painel).getByText(/Reincidência/i)).toBeDefined();
    expect(within(painel).getByText('5')).toBeDefined();
  });

  it('a mensagem é pedida ao servidor — a tela não redige nada', async () => {
    cenarioFila();
    let pediu = false;
    responder((url) => {
      if (!url.includes('/mensagem')) return undefined;
      pediu = true;
      return {
        status: 200,
        corpo: {
          mensagem: 'Bom dia, no dia 21/08 seu intervalo estava previsto para iniciar às 12:00, porém o registro foi realizado às 12:27.',
          origem: 'deterministica',
          revisaoObrigatoria: true,
          observacao: 'IA não configurada: texto gerado pelo modelo determinístico do sistema.',
          fatos: {},
        },
      };
    });

    await abrirFila();
    const botoes = await screen.findAllByRole('button', { name: /Por que isso apareceu/i });
    await userEvent.click(botoes[1]);

    const painel = await screen.findByRole('dialog', { name: /Por que isso apareceu/i });
    await userEvent.click(within(painel).getByRole('button', { name: /Gerar mensagem/i }));

    expect(pediu).toBe(true);
    /* E o texto que aparece é o que o servidor devolveu, editável antes de sair daqui. */
    const caixa = await within(painel).findByDisplayValue(/o registro foi realizado às 12:27/);
    expect(caixa).toBeDefined();
    expect(within(painel).getByText(/Revise antes de enviar/i)).toBeDefined();
  });
});
