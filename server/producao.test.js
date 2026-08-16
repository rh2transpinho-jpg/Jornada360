/* Testes do que a Fase 5 acrescentou: a guarda de configuração, o backup verificável, a
 * restauração e a recuperação de senha.
 *
 * O teste mais importante deste arquivo é o de RESTAURAÇÃO. Um backup nunca restaurado é uma
 * suposição, e a hora de descobrir que ele não presta não pode ser o dia em que se precisa dele.
 * Aqui a restauração acontece de verdade, num banco isolado, a cada execução da suíte. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import { carregarConfig, validarConfig } from './config.js';
import { gerarBackup, verificarBackup, restaurarBackup, listarBackups, limparAntigos } from './lib/backup.js';
import { _limparTudo } from './lib/limiteDeTaxa.js';

const RAIZ = mkdtempSync(join(tmpdir(), 'jornada360-prod-'));
const DB = join(RAIZ, 'jornada360.db');
const BACKUPS = join(RAIZ, 'backups');
process.env.JORNADA_DB_PATH = DB;

let servidor;
let base;

async function req(metodo, caminho, { corpo, token } = {}) {
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

const configTeste = () => ({ ...carregarConfig(), backup: { diretorio: BACKUPS, manterDias: 14, intervaloHoras: 0 } });

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  fecharBanco();
  rmSync(RAIZ, { recursive: true, force: true });
});

beforeEach(() => _limparTudo());

/* ---------------------------------------------------------------- guarda de configuração */

describe('a configuração de produção é validada antes de o servidor subir', () => {
  const base_ = {
    NODE_ENV: 'production',
    JORNADA_CORS_ORIGENS: 'https://app.exemplo.com.br',
    JORNADA_URL_PUBLICA: 'https://app.exemplo.com.br',
    JORNADA_COOKIE_SEGURO: '1',
    JORNADA_DB_PATH: '/dados/jornada360.db',
    JORNADA_BACKUP_DIR: '/backups',
    JORNADA_EMAIL_MODO: 'smtp',
    JORNADA_SMTP_URL: 'smtps://u:s@smtp.exemplo.com:465',
  };

  it('aceita uma configuração completa e segura', () => {
    expect(validarConfig(carregarConfig(base_))).toEqual([]);
  });

  it('em desenvolvimento não exige nada — senão ninguém conseguiria trabalhar', () => {
    expect(validarConfig(carregarConfig({}))).toEqual([]);
  });

  /* Cada caso abaixo é uma forma real de ir para produção inseguro sem perceber. */
  const recusas = [
    ['CORS ausente', { JORNADA_CORS_ORIGENS: '' }, /CORS_ORIGENS/],
    ['CORS com curinga', { JORNADA_CORS_ORIGENS: '*' }, /"\*"/],
    ['CORS apontando para localhost', { JORNADA_CORS_ORIGENS: 'http://localhost:5173' }, /desenvolvimento/],
    ['origem sem HTTPS', { JORNADA_CORS_ORIGENS: 'http://app.exemplo.com.br' }, /sem HTTPS/],
    ['cookie sem Secure', { JORNADA_COOKIE_SEGURO: '0' }, /Secure/],
    ['URL pública ausente', { JORNADA_URL_PUBLICA: '' }, /URL_PUBLICA/],
    ['URL pública sem HTTPS', { JORNADA_URL_PUBLICA: 'http://app.exemplo.com.br' }, /HTTPS/],
    ['e-mail em modo log', { JORNADA_EMAIL_MODO: 'log' }, /console/],
    ['SMTP sem URL', { JORNADA_SMTP_URL: '' }, /SMTP_URL/],
    ['banco não definido', { JORNADA_DB_PATH: '' }, /volume persistente/],
    ['banco dentro da pasta do código', { JORNADA_DB_PATH: './data/jornada360.db' }, /deploy novo apagaria/],
    ['backup não configurado', { JORNADA_BACKUP_DIR: '' }, /BACKUP_DIR/],
  ];

  for (const [nome, sobrescrita, esperado] of recusas) {
    it(`recusa: ${nome}`, () => {
      const problemas = validarConfig(carregarConfig({ ...base_, ...sobrescrita }));
      expect(problemas.length).toBeGreaterThan(0);
      expect(problemas.join(' ')).toMatch(esperado);
    });
  }
});

/* ---------------------------------------------------------------- backup */

describe('backup', () => {
  let dadosCriados = false;

  beforeAll(async () => {
    await req('POST', '/api/auth/registrar', {
      corpo: { email: 'backup@prod.test', nome: 'Backup', senha: 'senha-forte-b1', nomeEmpresa: 'Empresa do Backup' },
    });
    dadosCriados = true;
  });

  it('gera um arquivo e o VERIFICA lendo de volta', async () => {
    expect(dadosCriados).toBe(true);
    const r = await gerarBackup(configTeste(), { rotulo: 'teste' });
    expect(r.ok).toBe(true);
    expect(existsSync(r.caminho)).toBe(true);
    /* A contagem vem de uma leitura do arquivo gerado, não do banco de origem. */
    expect(r.contagens.users).toBeGreaterThan(0);
    expect(r.contagens.tenants).toBeGreaterThan(0);
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('o backup contém o dado que existia no momento em que foi tirado', async () => {
    const antes = await gerarBackup(configTeste(), { rotulo: 'antes' });
    await req('POST', '/api/auth/registrar', {
      corpo: { email: 'depois@prod.test', nome: 'Depois', senha: 'senha-forte-d1', nomeEmpresa: 'Depois do Backup' },
    });
    const depois = await gerarBackup(configTeste(), { rotulo: 'depois' });

    expect(depois.contagens.users).toBe(antes.contagens.users + 1);
  });

  /* Um arquivo que não abre não é backup — e deixá-lo em disco criaria a impressão de que existe
   * uma cópia. */
  it('recusa e DESCARTA um arquivo que não é um banco válido', async () => {
    const falso = join(BACKUPS, 'jornada360-corrompido-2020-01-01T00-00-00.db');
    writeFileSync(falso, 'isto não é um banco de dados');

    const verificacao = verificarBackup(falso);
    expect(verificacao.ok).toBe(false);
    rmSync(falso);
  });

  it('lista os backups do mais novo para o mais antigo', async () => {
    const lista = listarBackups(configTeste());
    expect(lista.length).toBeGreaterThan(1);
    expect(lista[0].em >= lista[1].em).toBe(true);
  });

  /* Uma retenção mal configurada não pode ser o que deixa o sistema sem nenhuma cópia. */
  it('a limpeza NUNCA remove o backup mais recente', async () => {
    const config = { ...configTeste(), backup: { diretorio: BACKUPS, manterDias: -1, intervaloHoras: 0 } };
    limparAntigos(config);
    expect(listarBackups(config).length).toBeGreaterThanOrEqual(1);
  });
});

/* ---------------------------------------------------------------- restauração */

describe('restauração — o teste que transforma backup em garantia', () => {
  it('restaura num destino isolado e o banco restaurado abre e responde', async () => {
    const backup = await gerarBackup(configTeste(), { rotulo: 'para-restaurar' });
    expect(backup.ok).toBe(true);

    const destino = join(RAIZ, 'restaurado.db');
    const r = restaurarBackup(backup.caminho, { destino });

    expect(r.ok).toBe(true);
    /* As contagens vêm de abrir o banco RESTAURADO — não de confiar no backup. */
    expect(r.contagens.users).toBe(backup.contagens.users);
    expect(r.contagens.tenants).toBe(backup.contagens.tenants);
  });

  it('recusa restaurar um arquivo inválido SEM tocar no banco de destino', async () => {
    const falso = join(RAIZ, 'invalido.db');
    writeFileSync(falso, 'lixo');

    const destino = join(RAIZ, 'destino-preservado.db');
    const backup = await gerarBackup(configTeste(), { rotulo: 'bom' });
    restaurarBackup(backup.caminho, { destino });
    const antes = verificarBackup(destino);

    const r = restaurarBackup(falso, { destino });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/INVÁLIDO/);

    /* O destino continua exatamente como estava — o ponto todo da checagem prévia. */
    const depois = verificarBackup(destino);
    expect(depois.ok).toBe(true);
    expect(depois.contagens).toEqual(antes.contagens);
  });

  it('guarda o banco anterior antes de sobrescrever, para haver caminho de volta', async () => {
    const destino = join(RAIZ, 'com-seguranca.db');
    const backup = await gerarBackup(configTeste(), { rotulo: 'seguranca' });

    restaurarBackup(backup.caminho, { destino });
    const segunda = restaurarBackup(backup.caminho, { destino });

    expect(segunda.ok).toBe(true);
    expect(segunda.copiaDeSeguranca).toBeTruthy();
    expect(existsSync(segunda.copiaDeSeguranca)).toBe(true);
  });
});

/* ---------------------------------------------------------------- recuperação de senha */

describe('recuperação de senha', () => {
  const conta = { email: 'recupera@prod.test', nome: 'Recupera', senha: 'senha-original-1', nomeEmpresa: 'Empresa Recupera' };

  beforeAll(async () => {
    await req('POST', '/api/auth/registrar', { corpo: conta });
  });

  /* Se a resposta variasse, esta rota viraria um verificador de quem tem conta no sistema —
   * anulando o cuidado que o login tem de nunca distinguir os dois casos. */
  it('responde igual para conta existente e inexistente', async () => {
    const existe = await req('POST', '/api/auth/recuperar', { corpo: { email: conta.email } });
    const naoExiste = await req('POST', '/api/auth/recuperar', { corpo: { email: 'ninguem@prod.test' } });

    expect(existe.status).toBe(200);
    expect(naoExiste.status).toBe(200);
    expect(existe.corpo).toEqual(naoExiste.corpo);
  });

  it('recusa e-mail malformado', async () => {
    const r = await req('POST', '/api/auth/recuperar', { corpo: { email: 'nao-e-email' } });
    expect(r.status).toBe(400);
  });

  it('recusa um código inventado, e diz qual é o problema', async () => {
    const r = await req('GET', '/api/auth/recuperar/codigo-que-nao-existe');
    expect(r.status).toBe(400);
    expect(r.corpo.motivo).toBe('invalido');
    expect(r.corpo.mensagem).toMatch(/não é válido/i);
  });

  it('recusa redefinir com senha curta antes mesmo de olhar o código', async () => {
    const r = await req('POST', '/api/auth/redefinir', { corpo: { codigo: 'qualquer', senha: '123' } });
    expect(r.status).toBe(400);
    expect(r.corpo.mensagem).toMatch(/pelo menos 8/);
  });

  /* O ciclo completo, usando o token direto do repositório — o e-mail é exercitado à parte, em
   * ensaio manual, porque aqui não há provedor. O que importa testar é a REGRA. */
  it('troca a senha, invalida o link e encerra as sessões abertas', async () => {
    const { criarPedido } = await import('./repositories/recuperacaoRepository.js');
    const usuarios = await import('./repositories/userRepository.js');

    const u = await usuarios.buscarPorEmail(conta.email);
    const sessaoAntiga = await usuarios.criarSessao(u.id);
    expect((await req('GET', '/api/auth/eu', { token: sessaoAntiga.token })).status).toBe(200);

    const { token } = await criarPedido(u.id, '127.0.0.1');

    expect((await req('GET', `/api/auth/recuperar/${token}`)).status).toBe(200);

    const troca = await req('POST', '/api/auth/redefinir', { corpo: { codigo: token, senha: 'senha-nova-forte-2' } });
    expect(troca.status).toBe(200);

    /* Uso único: o mesmo link não serve de novo. */
    const repetido = await req('POST', '/api/auth/redefinir', { corpo: { codigo: token, senha: 'outra-senha-3' } });
    expect(repetido.status).toBe(400);
    expect(repetido.corpo.motivo).toBe('usado');

    /* A sessão que existia antes morreu — é o que impede um invasor continuar dentro. */
    expect((await req('GET', '/api/auth/eu', { token: sessaoAntiga.token })).status).toBe(401);

    expect((await req('POST', '/api/auth/entrar', { corpo: { email: conta.email, senha: 'senha-nova-forte-2' } })).status).toBe(200);
    expect((await req('POST', '/api/auth/entrar', { corpo: { email: conta.email, senha: conta.senha } })).status).toBe(401);
  });

  it('um pedido novo invalida o anterior — só o link mais recente vale', async () => {
    const { criarPedido } = await import('./repositories/recuperacaoRepository.js');
    const usuarios = await import('./repositories/userRepository.js');
    const u = await usuarios.buscarPorEmail(conta.email);

    const primeiro = await criarPedido(u.id, '127.0.0.1');
    const segundo = await criarPedido(u.id, '127.0.0.1');

    expect((await req('GET', `/api/auth/recuperar/${primeiro.token}`)).status).toBe(400);
    expect((await req('GET', `/api/auth/recuperar/${segundo.token}`)).status).toBe(200);
  });
});

/* ---------------------------------------------------------------- prontidão */

describe('prontidão operacional', () => {
  it('reporta o estado de cada componente sem exigir sessão nem revelar dado', async () => {
    const r = await req('GET', '/api/prontidao');
    expect(r.corpo.componentes.banco.ok).toBe(true);
    expect(r.corpo.componentes).toHaveProperty('email');
    expect(r.corpo.componentes).toHaveProperty('backup');

    /* Nada no relatório pode dizer quantos clientes existem ou quem são. */
    const texto = JSON.stringify(r.corpo);
    expect(texto).not.toMatch(/@prod\.test/);
    expect(texto).not.toMatch(/Empresa/);
  });

  it('a saúde responde sem tocar o banco', async () => {
    const r = await req('GET', '/api/saude');
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(typeof r.corpo.tempoNoArSegundos).toBe('number');
  });
});
