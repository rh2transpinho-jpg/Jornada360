/* Testes da tela de Controle de Horas Extras.
 *
 * O que eles protegem é a promessa da tela, não a aparência dela:
 *
 *  1. quem abre a área vê PRIMEIRO o que exige análise (gestão por exceção);
 *  2. o recálculo depois de uma justificativa é DITO, com o valor anterior à vista;
 *  3. a tela NÃO recalcula nada — ela mostra o que o servidor mandou, mesmo que o número pareça
 *     estranho. Um segundo cálculo no frontend criaria duas verdades sobre hora extra.
 *
 * Nenhum teste aqui verifica cor, espaçamento ou existência de `<div>`. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import {
  cenarioAutenticado, limparServidorFalso, responder,
} from './testing/servidorFalso';

const fetchOriginal = globalThis.fetch;

/* Três ocorrências que cobrem os casos que a tela precisa distinguir. Os números vêm prontos,
 * como vêm do servidor de verdade. */
const PENDENTE = {
  id: 'heo-pendente', colaborador: 'Bia Parada', colaboradorChave: 'BIA PARADA',
  data: '2026-07-10', heMin: 95, excedenteMin: 95, padraoMin: 480,
  escalaPrevista: '07:00–15:00', jornadaRealizada: '07:00–16:35', batidas: '', setor: '', contexto: '',
  status: 'pendente', motivo: null, justificativa: null, origem: null, quemInformou: null,
  quemSolicitou: null, observacoes: null, justificadaEm: null, responsavel: null,
  criadaEm: '2026-07-10T09:00:00.000Z', atualizadaEm: '2026-07-10T09:00:00.000Z',
  recalculadaEm: null, heMinAnterior: null,
};

const RECALCULADA = {
  ...PENDENTE,
  id: 'heo-recalc', colaborador: 'Alex Recalculado', colaboradorChave: 'ALEX RECALCULADO',
  data: '2026-07-22', heMin: 175, excedenteMin: 175,
  escalaPrevista: '06:00–16:00', jornadaRealizada: '06:00–18:55',
  status: 'justificada', motivo: 'Quebra de veículo',
  justificativa: 'Veículo quebrou na rota e o motorista aguardou o guincho.',
  origem: 'Supervisor', responsavel: 'Julia', justificadaEm: '2026-07-23T12:00:00.000Z',
  /* O motor reprocessou DEPOIS da análise: 130 virou 175. */
  recalculadaEm: '2026-07-25T08:00:00.000Z', heMinAnterior: 130,
};

const TRATADA = {
  ...PENDENTE,
  id: 'heo-ok', colaborador: 'Caio Resolvido', colaboradorChave: 'CAIO RESOLVIDO',
  data: '2026-07-05', heMin: 40, excedenteMin: 40,
  status: 'justificada', motivo: 'Trânsito', justificativa: 'Congestionamento na volta.',
  responsavel: 'Julia', justificadaEm: '2026-07-06T10:00:00.000Z',
};

const RESUMO = {
  ocorrencias: 3, minutos: 310, minutosPendentes: 95, ocorrenciasPendentes: 1, colaboradores: 3,
  porStatus: {
    pendente: { ocorrencias: 1, minutos: 95 },
    justificada: { ocorrencias: 2, minutos: 215 },
    nao_autorizada: { ocorrencias: 0, minutos: 0 },
    em_analise: { ocorrencias: 0, minutos: 0 },
    abonada: { ocorrencias: 0, minutos: 0 },
  },
};

function cenarioHE(ocorrencias = [PENDENTE, RECALCULADA, TRATADA]) {
  cenarioAutenticado();
  responder((url) => (url.includes('/he/resumo') ? { status: 200, corpo: RESUMO } : undefined));
  responder((url) => (url.includes('/he/listas') ? { status: 200, corpo: { motivos: ['Quebra de veículo', 'Trânsito'], origens: ['Supervisor'] } } : undefined));
  responder((url) =>
    /\/he\/heo-[a-z]+$/.test(url.split('?')[0])
      ? {
          status: 200,
          corpo: {
            ...ocorrencias.find((o) => url.includes(o.id)),
            historico: [
              { id: 'h3', evento: 'recalculada', usuario: '', valorAnterior: '130 min', valorNovo: '175 min', observacao: 'A jornada foi reprocessada depois da análise.', criadoEm: '2026-07-25T08:00:00.000Z' },
              { id: 'h2', evento: 'justificada', usuario: 'Julia', valorAnterior: '', valorNovo: 'Quebra de veículo', observacao: '', criadoEm: '2026-07-23T12:00:00.000Z' },
              { id: 'h1', evento: 'identificada', usuario: '', valorAnterior: '', valorNovo: '130 min de HE', observacao: '', criadoEm: '2026-07-22T09:00:00.000Z' },
            ],
          },
        }
      : undefined,
  );
  responder((url) => (/\/he(\?|$)/.test(url) ? { status: 200, corpo: ocorrencias } : undefined));
}

async function abrirControleHE() {
  render(<App />);
  await userEvent.click(await screen.findByText('Empresa Alpha'));
  await userEvent.click(await screen.findByRole('link', { name: 'Controle de HE' }, { timeout: 3000 }));
  return screen.findByRole('heading', { name: 'Controle de Horas Extras', level: 1 }, { timeout: 3000 });
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

describe('Controle de HE — gestão por exceção', () => {
  it('mostra primeiro quanto de HE está sem justificativa', async () => {
    cenarioHE();
    await abrirControleHE();

    /* É o número que a área existe para responder. 95 minutos = 01:35.
     * Buscado DENTRO do cartão, porque o mesmo valor aparece na tabela — e o que este teste
     * afirma é que ele está em destaque no topo, não que existe em algum lugar da página. */
    const rodape = await screen.findByText(/1 ocorrência\(s\) aguardando/);
    const cartao = rodape.closest('.kpi-card') as HTMLElement;
    expect(within(cartao).getByText('01:35')).toBeDefined();
    expect(within(cartao).getByText('Sem justificativa')).toBeDefined();
  });

  it('a ocorrência pendente aparece antes das já tratadas', async () => {
    cenarioHE();
    await abrirControleHE();

    await screen.findByText('Bia Parada');
    const linhas = screen.getAllByRole('row').slice(1);
    /* O filtro inicial é "Precisa de análise": a pendente e a recalculada entram, a tratada não. */
    expect(linhas[0].textContent).toContain('Bia Parada');
    expect(screen.queryByText('Caio Resolvido')).toBeNull();
  });

  it('o recálculo após a análise é DITO na lista, com o valor anterior', async () => {
    cenarioHE();
    await abrirControleHE();

    expect(await screen.findByText('Alex Recalculado')).toBeDefined();
    /* 130 min = 02:10. Sem isto, alguém olharia 02:55 sem saber que o número mudou depois de
     * a justificativa ter sido escrita. */
    expect(screen.getByText(/antes 02:10/)).toBeDefined();
  });

  it('"Todas" traz de volta o que já foi tratado', async () => {
    cenarioHE();
    await abrirControleHE();
    await screen.findByText('Bia Parada');

    await userEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(await screen.findByText('Caio Resolvido')).toBeDefined();
  });

  it('o filtro "Sem justificativa" isola o que ninguém analisou', async () => {
    cenarioHE();
    await abrirControleHE();
    await screen.findByText('Bia Parada');

    await userEvent.click(screen.getByRole('button', { name: 'Sem justificativa' }));
    expect(screen.getByText('Bia Parada')).toBeDefined();
    expect(screen.queryByText('Alex Recalculado')).toBeNull();
  });
});

describe('detalhe da ocorrência', () => {
  it('mostra planejado, realizado, justificativa, responsável e histórico', async () => {
    cenarioHE();
    await abrirControleHE();
    await screen.findByText('Alex Recalculado');

    const linha = screen.getByText('Alex Recalculado').closest('tr')!;
    await userEvent.click(within(linha).getByRole('button', { name: 'Abrir' }));

    /* Tudo é conferido DENTRO do painel: a escala também aparece na linha da tabela, e o teste
     * afirma que o detalhe reúne a informação — não que ela existe em algum lugar da página. */
    const painel = await screen.findByRole('dialog', { name: /Detalhe da ocorrência/i });

    /* Planejado x realizado lado a lado. */
    expect(within(painel).getByText('06:00–16:00')).toBeDefined();
    expect(within(painel).getByText('06:00–18:55')).toBeDefined();

    /* A análise humana, com quem assinou. */
    /* Aparece duas vezes de propósito: no bloco da análise registrada e já preenchida no campo
     * de edição — quem vai corrigir uma justificativa não deve reescrever tudo do zero. */
    expect(within(painel).getAllByText(/aguardou o guincho/).length).toBeGreaterThan(0);
    expect(within(painel).getByText('Julia')).toBeDefined();

    /* E o histórico, que responde "qual era a justificativa antes?". */
    expect(within(painel).getByText(/Ocorrência identificada pelo motor/)).toBeDefined();
    expect(within(painel).getByText(/Jornada reprocessada/)).toBeDefined();
  });

  it('avisa que o número mudou DEPOIS da análise, e que a justificativa foi preservada', async () => {
    cenarioHE();
    await abrirControleHE();
    await screen.findByText('Alex Recalculado');

    const linha = screen.getByText('Alex Recalculado').closest('tr')!;
    await userEvent.click(within(linha).getByRole('button', { name: 'Abrir' }));

    const painel = await screen.findByRole('dialog', { name: /Detalhe da ocorrência/i });

    /* A frase aparece no aviso e outra vez no histórico — as duas são intencionais. */
    expect(within(painel).getAllByText(/reprocessada depois da análise/i).length).toBeGreaterThan(0);

    /* O aviso precisa dizer que a justificativa continua — é a garantia comprovada em produção,
     * e a tela não pode sugerir o contrário. */
    expect(within(painel).getByText(/justificativa registrada foi preservada/i)).toBeDefined();
    /* E mostrar o valor antigo ao lado do novo. */
    expect(within(painel).getByText('02:10')).toBeDefined();
    expect(within(painel).getAllByText('02:55').length).toBeGreaterThan(0);
  });

  it('o formulário NÃO envia minutos — só a análise humana', async () => {
    cenarioHE();
    let corpoEnviado: unknown = null;
    responder((url, init) => {
      if (!url.includes('/justificativa')) return undefined;
      corpoEnviado = JSON.parse(String(init.body));
      return { status: 200, corpo: { ...PENDENTE, status: 'justificada', motivo: 'Trânsito' } };
    });

    await abrirControleHE();
    await screen.findByText('Bia Parada');

    const linha = screen.getByText('Bia Parada').closest('tr')!;
    await userEvent.click(within(linha).getByRole('button', { name: 'Abrir' }));

    await userEvent.selectOptions(await screen.findByLabelText('Motivo'), 'Trânsito');
    await userEvent.type(screen.getByLabelText('Justificativa'), 'Congestionamento na rodovia.');
    await userEvent.click(screen.getByRole('button', { name: /Registrar justificativa/i }));

    await waitFor(() => expect(corpoEnviado).not.toBeNull());

    const enviado = corpoEnviado as Record<string, unknown>;
    expect(enviado.motivo).toBe('Trânsito');
    expect(enviado.justificativa).toBe('Congestionamento na rodovia.');
    /* A REGRA QUE ESTE TESTE FIXA: a tela não tem como sobrescrever o cálculo do motor, porque
     * nunca manda número nenhum. É o que impede a interface de reintroduzir o defeito antigo. */
    expect(enviado).not.toHaveProperty('heMin');
    expect(enviado).not.toHaveProperty('excedenteMin');
    expect(enviado).not.toHaveProperty('heMinAnterior');
    /* E o responsável vem da sessão, no servidor — nunca do formulário. */
    expect(enviado).not.toHaveProperty('responsavel');
  });
});
