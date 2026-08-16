/* RBAC aplicado NO SERVIDOR.
 *
 * O que estes testes provam: esconder um botão na interface não é o controle de acesso — a rota
 * recusa mesmo quando o cliente chama direto. Cada papel é testado contra o que pode e contra o
 * que não pode. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { adicionarMembro } from './repositories/tenantRepository.js';
import { podeExecutar, PERMISSOES as P } from './lib/permissoes.js';
import { rmSync } from 'node:fs';

const DB = new URL('./__rbac.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;

let servidor, base, tenantId;
const tokens = {};

async function req(metodo, caminho, { token, corpo } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-jornada-cliente': 'api', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null };
}

/* Cria um usuário e o vincula ao MESMO tenant com o papel pedido — é assim que se testa papéis
 * diferentes sobre os mesmos dados. */
async function usuarioComPapel(papel) {
  const r = await req('POST', '/api/auth/registrar', {
    corpo: { email: `${papel}@rbac.test`, nome: papel, senha: 'senha-forte-123', nomeEmpresa: `Empresa do ${papel}` },
  });
  adicionarMembro(tenantId, r.corpo.usuario.id, papel);
  return r.corpo.token;
}

beforeAll(async () => {
  const app = criarApp();
  await new Promise((r) => { servidor = app.listen(0, r); });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const dono = await req('POST', '/api/auth/registrar', {
    corpo: { email: 'dono@rbac.test', nome: 'Dono', senha: 'senha-forte-123', nomeEmpresa: 'Empresa RBAC' },
  });
  tokens.administrador = dono.corpo.token;
  tenantId = dono.corpo.tenants[0].id;

  for (const papel of ['rh', 'gestor', 'auditor', 'colaborador']) {
    tokens[papel] = await usuarioComPapel(papel);
  }

  await req('POST', `/api/tenants/${tenantId}/setores`, { token: tokens.administrador, corpo: { nome: 'Produção' } });
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

describe('matriz de permissões', () => {
  it('administrador pode tudo', () => {
    for (const permissao of Object.values(P)) {
      expect(podeExecutar('administrador', permissao)).toBe(true);
    }
  });

  it('auditor lê e exporta, mas NÃO escreve nada', () => {
    expect(podeExecutar('auditor', P.CONFIG_LER)).toBe(true);
    expect(podeExecutar('auditor', P.AUDITORIA_LER)).toBe(true);
    expect(podeExecutar('auditor', P.RELATORIO_EXPORTAR)).toBe(true);
    expect(podeExecutar('auditor', P.CONFIG_ESCREVER)).toBe(false);
    expect(podeExecutar('auditor', P.PENDENCIA_TRATAR)).toBe(false);
    expect(podeExecutar('auditor', P.DADOS_ESCREVER)).toBe(false);
  });

  it('gestor trata pendências mas NÃO revisa — quem executa não aprova o próprio trabalho', () => {
    expect(podeExecutar('gestor', P.PENDENCIA_TRATAR)).toBe(true);
    expect(podeExecutar('gestor', P.PENDENCIA_REVISAR)).toBe(false);
  });

  it('somente administrador exclui a empresa', () => {
    expect(podeExecutar('administrador', P.TENANT_EXCLUIR)).toBe(true);
    for (const papel of ['rh', 'gestor', 'auditor', 'colaborador']) {
      expect(podeExecutar(papel, P.TENANT_EXCLUIR)).toBe(false);
    }
  });

  it('colaborador tem o acesso mais restrito', () => {
    expect(podeExecutar('colaborador', P.PENDENCIA_LER)).toBe(true);
    expect(podeExecutar('colaborador', P.CONFIG_ESCREVER)).toBe(false);
    expect(podeExecutar('colaborador', P.AUDITORIA_LER)).toBe(false);
  });
});

describe('autorização aplicada nas rotas (não só na interface)', () => {
  it('auditor consegue LER o cadastro', async () => {
    expect((await req('GET', `/api/tenants/${tenantId}/setores`, { token: tokens.auditor })).status).toBe(200);
  });

  it('auditor NÃO consegue escrever no cadastro, mesmo chamando a rota direto', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/setores`, {
      token: tokens.auditor,
      corpo: { nome: 'Setor proibido' },
    });
    expect(r.status).toBe(403);
    expect(r.corpo.erro).toBe('sem_permissao');
  });

  it('a escrita recusada realmente não gravou nada', async () => {
    const setores = await req('GET', `/api/tenants/${tenantId}/setores`, { token: tokens.administrador });
    expect(setores.corpo.map((s) => s.nome)).not.toContain('Setor proibido');
  });

  it('gestor NÃO consegue revisar uma pendência', async () => {
    const p = {
      id: 'pend-rbac-1', data: '2026-08-01', tipo: 'divergencia_he', categoria: '', status: 'justificado',
      prioridade: 'media', origem: 'motor_he', descricao: '', evidencias: [], criadaEm: new Date().toISOString(),
    };
    await req('PUT', `/api/tenants/${tenantId}/pendencias/pend-rbac-1`, { token: tokens.administrador, corpo: p });

    const r = await req('POST', `/api/tenants/${tenantId}/pendencias/pend-rbac-1/revisao`, {
      token: tokens.gestor,
      corpo: { decisao: 'aprovado' },
    });
    expect(r.status).toBe(403);
  });

  it('RH consegue revisar', async () => {
    const r = await req('POST', `/api/tenants/${tenantId}/pendencias/pend-rbac-1/revisao`, {
      token: tokens.rh,
      corpo: { decisao: 'aprovado', observacao: 'Conferido.' },
    });
    expect(r.status).toBe(200);
    expect(r.corpo.status).toBe('aprovado');
  });

  it('registra como revisor o usuário da SESSÃO, não um nome enviado pelo cliente', async () => {
    // Tentativa explícita de forjar o autor da revisão.
    const p = {
      id: 'pend-rbac-2', data: '2026-08-02', tipo: 'divergencia_he', categoria: '', status: 'justificado',
      prioridade: 'media', origem: 'motor_he', descricao: '', evidencias: [], criadaEm: new Date().toISOString(),
    };
    await req('PUT', `/api/tenants/${tenantId}/pendencias/pend-rbac-2`, { token: tokens.administrador, corpo: p });

    const r = await req('POST', `/api/tenants/${tenantId}/pendencias/pend-rbac-2/revisao`, {
      token: tokens.rh,
      corpo: { decisao: 'aprovado', revisadoPor: 'Diretor Inventado' },
    });
    expect(r.corpo.revisadoPor).toBe('rh');
    expect(r.corpo.revisadoPor).not.toBe('Diretor Inventado');
  });

  it('colaborador NÃO consegue ler a auditoria', async () => {
    expect((await req('GET', `/api/tenants/${tenantId}/auditoria`, { token: tokens.colaborador })).status).toBe(403);
  });

  it('RH NÃO consegue excluir a empresa', async () => {
    const r = await req('DELETE', `/api/tenants/${tenantId}`, { token: tokens.rh });
    expect(r.status).toBe(403);
    expect((await req('GET', `/api/tenants/${tenantId}`, { token: tokens.administrador })).status).toBe(200);
  });
});

describe('auditoria server-side', () => {
  it('grava o autor a partir da sessão autenticada', async () => {
    await req('POST', `/api/tenants/${tenantId}/setores`, { token: tokens.rh, corpo: { nome: 'Setor do RH' } });
    const trilha = await req('GET', `/api/tenants/${tenantId}/auditoria`, { token: tokens.administrador });
    const entrada = trilha.corpo.find((e) => e.entidade.includes('Setor do RH'));
    expect(entrada?.usuario).toBe('rh');
  });
});
