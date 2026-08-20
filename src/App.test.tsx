/* Testes de INTERFACE dos fluxos críticos (Fase 4).
 *
 * O que estes testes protegem, e que nenhum teste de regra de negócio protege: a pessoa certa
 * vendo a tela certa. Um erro aqui não é um número errado — é alguém entrando sem sessão, ou
 * ficando preso fora do sistema, ou vendo dados de uma empresa que não é dele.
 *
 * Cobertura deliberada: portão de entrada, login, logout, guarda de rota, escolha de empresa,
 * carregamento, erro de rede, sessão expirada, acesso negado, demonstração e isolamento visual.
 * Não se testa aparência: nada aqui verifica cor, espaçamento ou existência de `<div>`. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import {
  cenarioAutenticado,
  instalarServidorFalso,
  limparServidorFalso,
  responder,
  servidorForaDoAr,
  tenant,
  USUARIO,
  chamadas,
} from './testing/servidorFalso';

const fetchOriginal = globalThis.fetch;

/* "Dashboard Executivo" aparece três vezes na tela montada (link da barra lateral, título da barra
 * superior e cabeçalho da página). Buscar pelo CABEÇALHO é o que responde à pergunta certa: a
 * página abriu, e não apenas o link existe em algum menu. */
function esperarSistemaAberto() {
  return screen.findByRole('heading', { name: 'Dashboard Executivo', level: 1 }, { timeout: 3000 });
}

/* Configurações é uma rota carregada sob demanda: o clique no menu inicia o download do pedaço da
 * aplicação, e a aba só existe depois disso. Esperar pela aba (e não pelo clique) é o que torna
 * este caminho estável. */
async function abrirAbaDeConfiguracoes(nome: string) {
  await userEvent.click(screen.getByRole('link', { name: 'Configurações' }));
  const aba = await screen.findByRole('button', { name: nome }, { timeout: 3000 });
  await userEvent.click(aba);
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

/* ---------------------------------------------------------------- visitante */

describe('portão de entrada', () => {
  it('mostra os dois caminhos e NÃO coloca ninguém dentro de uma empresa', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'Sessão inválida.' } } : undefined));

    render(<App />);

    /* A entrada foi reduzida a dois caminhos de propósito: entrar, ou olhar a demonstração.
     * Criar empresa saiu da tela porque o servidor recusa em produção — oferecer um caminho que
     * termina em recusa é pior do que não oferecer. */
    expect(await screen.findByText('Entrar no Jornada360')).toBeDefined();
    expect(screen.getByText('Ver demonstração')).toBeDefined();
    expect(screen.queryByText('Criar minha empresa')).toBeNull();
    /* A barra lateral só existe dentro do sistema. Vê-la aqui significaria ter entrado sem escolher. */
    expect(screen.queryByRole('heading', { name: 'Dashboard Executivo', level: 1 })).toBeNull();
  });

  it('diz que o servidor está fora do ar em vez de deixar botões mortos sem explicação', async () => {
    servidorForaDoAr();
    render(<App />);

    expect(await screen.findByText(/Servidor indisponível/i)).toBeDefined();
    /* A demonstração é local: ela continua disponível justamente quando o servidor não está. */
    expect(screen.getByText('Ver demonstração')).toBeDefined();
  });
});

/* ---------------------------------------------------------------- login */

describe('login', () => {
  it('entra com e-mail e senha e passa a mostrar as empresas da conta', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'Sessão inválida.' } } : undefined));
    responder((url) =>
      url.includes('/api/auth/entrar')
        ? { status: 200, corpo: { expiraEm: '2030-01-01T00:00:00Z', usuario: USUARIO, tenants: [tenant()] } }
        : undefined,
    );

    render(<App />);
    await userEvent.click(await screen.findByText('Entrar no Jornada360'));

    await userEvent.type(await screen.findByLabelText('E-mail'), 'ana@empresa.test');
    await userEvent.type(screen.getByLabelText('Senha'), 'senha-forte-123');
    await userEvent.click(screen.getByRole('button', { name: /Entrar/i }));

    expect(await screen.findByText(/Olá,/)).toBeDefined();
    expect(screen.getByText('Empresa Alpha')).toBeDefined();
  });

  it('mostra a recusa do servidor sem revelar se o e-mail existe', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'x' } } : undefined));
    responder((url) =>
      url.includes('/api/auth/entrar')
        ? { status: 401, corpo: { erro: 'credenciais_invalidas', mensagem: 'E-mail ou senha incorretos.' } }
        : undefined,
    );

    render(<App />);
    await userEvent.click(await screen.findByText('Entrar no Jornada360'));
    await userEvent.type(await screen.findByLabelText('E-mail'), 'ana@empresa.test');
    await userEvent.type(screen.getByLabelText('Senha'), 'errada12345');
    await userEvent.click(screen.getByRole('button', { name: /Entrar/i }));

    const erro = await screen.findByRole('alert');
    expect(erro.textContent).toBe('E-mail ou senha incorretos.');
    /* Nunca "e-mail não cadastrado": distinguir permitiria descobrir quem tem conta. */
    expect(erro.textContent).not.toMatch(/não cadastrado|não existe/i);
  });

  it('nunca guarda a senha nem o token no armazenamento do navegador', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'x' } } : undefined));
    responder((url) =>
      url.includes('/api/auth/entrar')
        ? { status: 200, corpo: { expiraEm: '2030-01-01T00:00:00Z', usuario: USUARIO, tenants: [tenant()] } }
        : undefined,
    );

    render(<App />);
    await userEvent.click(await screen.findByText('Entrar no Jornada360'));
    await userEvent.type(await screen.findByLabelText('E-mail'), 'ana@empresa.test');
    await userEvent.type(screen.getByLabelText('Senha'), 'senha-forte-123');
    await userEvent.click(screen.getByRole('button', { name: /Entrar/i }));
    await screen.findByText(/Olá,/);

    const tudo = JSON.stringify(Object.entries(localStorage));
    expect(tudo).not.toContain('senha-forte-123');
    expect(tudo).not.toMatch(/token/i);
  });
});

/* ---------------------------------------------------------------- guarda de rota */

describe('guarda de rota', () => {
  it('não monta o sistema para quem não está autenticado, mesmo indo direto na URL', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'x' } } : undefined));

    window.history.pushState({}, '', '/configuracoes');
    render(<App />);

    expect(await screen.findByText('Entrar no Jornada360')).toBeDefined();
    expect(screen.queryByText('Configurações')).toBeNull();
  });

  /* A empresa ativa guardada no navegador não é autorização: se a conta não tem mais acesso a ela,
   * o certo é voltar ao portão, não tentar carregar e mostrar erro. */
  it('descarta a empresa salva localmente quando ela não pertence mais à conta', async () => {
    localStorage.setItem('jornada360:activeWorkspaceId', 'ten-de-outra-pessoa');
    cenarioAutenticado();

    render(<App />);

    expect(await screen.findByText(/Olá,/)).toBeDefined();
    expect(localStorage.getItem('jornada360:activeWorkspaceId')).toBeNull();
  });

  it('as páginas públicas continuam abertas sem sessão', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'x' } } : undefined));

    window.history.pushState({}, '', '/portfolio');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Portfólio' }, { timeout: 3000 })).toBeDefined();
  });
});

/* ---------------------------------------------------------------- empresa ativa */

describe('empresa ativa', () => {
  it('entra na empresa escolhida e carrega o dado dela do servidor', async () => {
    cenarioAutenticado();
    render(<App />);

    await userEvent.click(await screen.findByText('Empresa Alpha'));

    expect(await esperarSistemaAberto()).toBeDefined();
    /* O cadastro veio da API — nenhuma tela leu `localStorage` para montar isto. */
    expect(chamadas.some((c) => /\/api\/tenants\/ten-1$/.test(c.url))).toBe(true);
  });

  it('envia o tenant na URL e NUNCA no corpo da requisição', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    for (const c of chamadas) {
      const corpo = JSON.stringify(c.corpo ?? {});
      expect(corpo).not.toContain('tenantId');
      expect(corpo).not.toContain('ten-1');
    }
  });

  it('toda requisição leva o cabeçalho anti-CSRF que o servidor exige', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) {
      if (c.url.includes('/api/saude')) continue;
      expect(c.cabecalhos['x-jornada-cliente']).toBe('web');
    }
  });

  it('mostra o seletor com as empresas da conta mais a demonstração', async () => {
    cenarioAutenticado({ tenants: [tenant(), tenant({ id: 'ten-2', nome: 'Empresa Beta' })] });
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    const opcoes = [...document.querySelectorAll('.topbar option')].map((o) => o.textContent);
    expect(opcoes.some((t) => t?.includes('Empresa Alpha'))).toBe(true);
    expect(opcoes.some((t) => t?.includes('Empresa Beta'))).toBe(true);
    expect(opcoes.some((t) => t?.includes('Demo'))).toBe(true);
  });
});

/* ---------------------------------------------------------------- estados de rede */

describe('estados de carregamento e falha', () => {
  it('mostra que está carregando enquanto o dado da empresa não chegou', async () => {
    cenarioAutenticado();
    /* Segura o cadastro para que o estado de carregamento fique visível. */
    let liberar: () => void = () => {};
    const espera = new Promise<void>((r) => {
      liberar = r;
    });
    const fetchAnterior = globalThis.fetch;
    globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = String(entrada);
      if (/\/api\/tenants\/[^/]+$/.test(url)) await espera;
      return fetchAnterior(entrada, init);
    }) as typeof fetch;

    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));

    expect(await screen.findByText(/Carregando os dados da empresa/i)).toBeDefined();
    liberar();
    expect(await esperarSistemaAberto()).toBeDefined();
  });

  it('quando o servidor cai ao abrir a empresa, explica e oferece voltar — não mostra tela vazia', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    servidorForaDoAr();
    await userEvent.click(screen.getByTitle(/Buscar as alterações mais recentes/i));

    expect(await screen.findByText(/Não foi possível conectar ao servidor/i)).toBeDefined();
    expect(screen.getByText(/Voltar para a escolha de empresa/i)).toBeDefined();
  });

  /* Sessão que cai no meio do uso precisa levar de volta ao login. Sem isso a tela ficaria montada
   * com dado velho e todo clique falharia em silêncio. */
  it('derruba a sessão quando qualquer requisição responde 401', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    limparServidorFalso();
    instalarServidorFalso();
    responder(() => ({ status: 401, corpo: { erro: 'nao_autenticado', mensagem: 'Sessão inválida ou expirada.' } }));

    await userEvent.click(screen.getByTitle(/Buscar as alterações mais recentes/i));

    await waitFor(
      () => expect(screen.queryByRole('heading', { name: 'Dashboard Executivo', level: 1 })).toBeNull(),
      { timeout: 3000 },
    );
    expect(await screen.findByText('Entrar no Jornada360')).toBeDefined();
  });
});

/* ---------------------------------------------------------------- RBAC na interface */

describe('permissões na interface', () => {
  it('quem não pode escrever no cadastro não recebe o botão de adicionar habilitado', async () => {
    /* Auditor: lê e exporta, nunca altera. O servidor recusaria de qualquer forma — isto é
     * conveniência, para não oferecer o que vai ser negado. */
    const auditor = tenant({ papel: 'auditor', permissoes: ['config:ler', 'dados:ler', 'pendencia:ler', 'auditoria:ler', 'relatorio:exportar'] });
    cenarioAutenticado({
      tenants: [auditor],
      cadastro: { papel: 'auditor', permissoes: auditor.permissoes },
    });

    window.history.pushState({}, '', '/bem-vindo');
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    await abrirAbaDeConfiguracoes('Setores');

    const adicionar = await screen.findByRole('button', { name: 'Adicionar' }, { timeout: 3000 });
    expect((adicionar as HTMLButtonElement).disabled).toBe(true);
  });

  it('administrador recebe o botão habilitado', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));
    await esperarSistemaAberto();

    await abrirAbaDeConfiguracoes('Setores');

    const adicionar = await screen.findByRole('button', { name: 'Adicionar' }, { timeout: 3000 });
    expect((adicionar as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ---------------------------------------------------------------- demonstração */

describe('demonstração', () => {
  it('abre sem conta e sem servidor', async () => {
    servidorForaDoAr();
    render(<App />);

    await userEvent.click(await screen.findByText('Ver demonstração'));

    expect(await esperarSistemaAberto()).toBeDefined();
    expect(screen.getByText(/AMBIENTE DEMONSTRAÇÃO/)).toBeDefined();
  });

  it('não pede nenhuma requisição de empresa ao servidor — é inteiramente local', async () => {
    cenarioAutenticado();
    render(<App />);
    await userEvent.click(await screen.findByText('Ver demonstração'));
    await esperarSistemaAberto();

    expect(chamadas.some((c) => c.url.includes('/api/tenants/'))).toBe(false);
  });
});

/* ---------------------------------------------------------------- programa piloto */

describe('programa piloto na interface', () => {
  it('com o cadastro fechado, o portão não oferece criar empresa e explica por quê', async () => {
    instalarServidorFalso();
    responder((url) => (url.includes('/api/saude') ? { status: 200, corpo: { ok: true } } : undefined));
    responder((url) => (url.includes('/api/auth/modo') ? { status: 200, corpo: { cadastroAberto: false } } : undefined));
    responder((url) => (url.includes('/api/auth/eu') ? { status: 401, corpo: { mensagem: 'Sessão inválida.' } } : undefined));

    render(<App />);

    /* A demonstração e a entrada continuam abertas: fechar o cadastro fecha a porta de quem chega
     * sozinho, não a de quem já foi convidado nem a de quem só quer conhecer. */
    /* A entrada não fala mais de programa piloto: virou tela de produto, não de projeto.
     * A garantia real nunca esteve aqui — está no servidor, que recusa o cadastro com 403
     * (ver server/piloto.test.js). Esta tela só não oferece o caminho. */
    expect(await screen.findByText('Ver demonstração')).toBeDefined();
    expect(screen.getByText('Entrar no Jornada360')).toBeDefined();
    expect(screen.queryByText('Criar minha empresa')).toBeNull();
    expect(screen.queryByText(/Programa piloto/i)).toBeNull();
  });

  it('mostra a empresa suspensa na lista, marcada, em vez de fazê-la sumir', async () => {
    /* Sumir seria lido como "minha empresa foi excluída". A pessoa precisa ver que ela existe e
     * que o acesso é que está pausado. */
    cenarioAutenticado({ tenants: [tenant({ status: 'suspensa' })] });

    render(<App />);

    expect(await screen.findByText('Empresa Alpha')).toBeDefined();
    expect(screen.getByText(/dados estão preservados/i)).toBeDefined();
  });

  it('traduz a recusa por empresa suspensa em explicação, não em "acesso negado"', async () => {
    cenarioAutenticado({ tenants: [tenant({ status: 'suspensa' })] });
    /* O carregamento do cadastro passa a receber a recusa do servidor. Esta rota entra na frente
     * da que `cenarioAutenticado` instalou. */
    responder((url, init) =>
      /\/api\/tenants\/[^/]+$/.test(url) && (init.method ?? 'GET') === 'GET'
        ? {
            status: 403,
            corpo: {
              erro: 'empresa_suspensa',
              mensagem: 'O acesso desta empresa está suspenso. Seus dados estão preservados — fale com o Jornada360 para reativar.',
            },
          }
        : undefined,
    );

    render(<App />);
    await userEvent.click(await screen.findByText('Empresa Alpha'));

    expect(await screen.findByText(/acesso desta empresa está suspenso/i, undefined, { timeout: 3000 })).toBeDefined();
    expect(screen.queryByText(/Seu perfil não permite/i)).toBeNull();

    /* E dá para sair de lá. Sem limpar o erro ao soltar a empresa, o botão parecia não funcionar:
     * a tela de erro voltava a se desenhar por cima do portão. */
    await userEvent.click(screen.getByRole('button', { name: /Voltar para a escolha de empresa/i }));
    expect(await screen.findByText('Ver demonstração')).toBeDefined();
  });
});
