/* O QUE ACONTECE QUANDO O BANCO FICA INDISPONÍVEL.
 *
 * O CASO REAL QUE ORIGINOU ESTE ARQUIVO
 * -------------------------------------
 * O Turso passou a recusar leituras ("BLOCKED: SQL read operations are forbidden"). O processo
 * continuou vivo — `/api/saude` respondia 200 — mas a URL pública passou a devolver
 * `{"erro":"erro_interno"}` no navegador, no lugar do sistema.
 *
 * A causa não foi o banco: foi a trava de migração, que valia para TODA rota que não fosse saúde
 * ou prontidão, inclusive `/`. `index.html`, JS e CSS são arquivos estáticos que não tocam o
 * banco — segurá-los atrás da migração transformou uma indisponibilidade de DADOS numa
 * indisponibilidade TOTAL, e tirou da pessoa até a tela que sabe dizer que o servidor caiu.
 *
 * Os testes abaixo simulam o banco fora do ar e fixam o comportamento certo:
 *
 *   a interface CARREGA;
 *   a saúde diz que o processo vive;
 *   a prontidão diz qual componente caiu;
 *   as rotas de dados falham de forma limpa, sem derrubar o resto. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST = mkdtempSync(join(tmpdir(), 'jornada-dist-'));
mkdirSync(join(DIST, 'assets'), { recursive: true });
writeFileSync(join(DIST, 'index.html'), '<!doctype html><title>Jornada360</title><div id="root"></div>');
writeFileSync(join(DIST, 'assets', 'index-abc12345.js'), 'console.log(1)');

const DB = new URL('./__forado.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;
process.env.JORNADA_SERVIR_FRONTEND = '1';
process.env.JORNADA_FRONTEND_DIST = DIST;

let servidor;
let base;
let db;

async function req(caminho) {
  const r = await fetch(base + caminho, { headers: { 'x-jornada-cliente': 'api' } });
  const t = await r.text();
  let corpo = t;
  try { corpo = t ? JSON.parse(t) : null; } catch { /* html */ }
  return { status: r.status, tipo: r.headers.get('content-type') ?? '', corpo };
}

beforeAll(async () => {
  const { criarApp } = await import('./app.js');
  db = await import('./db/index.js');
  await db.migrar();

  const app = criarApp();
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await db.fecharBanco();
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(DB + s); } catch { /* pode não existir */ }
  }
  try { rmSync(DIST, { recursive: true }); } catch { /* idem */ }
  delete process.env.JORNADA_SERVIR_FRONTEND;
  delete process.env.JORNADA_FRONTEND_DIST;
});

describe('com o banco NO AR', () => {
  it('serve a interface na raiz', async () => {
    const r = await req('/');
    expect(r.status).toBe(200);
    expect(r.tipo).toContain('text/html');
  });

  it('a saúde responde', async () => {
    expect((await req('/api/saude')).status).toBe(200);
  });
});

describe('com o banco FORA DO AR', () => {
  beforeAll(async () => {
    /* A QUEDA É DE VERDADE, e reproduz o incidente.
     *
     * Aponta o banco para um host libSQL inalcançável: `modoBanco()` passa a 'libsql' e toda
     * consulta falha na rede — que é exatamente o que aconteceu quando o Turso passou a recusar
     * operações.
     *
     * A primeira versão deste teste apontava `JORNADA_DB_PATH` para um diretório inexistente. Não
     * funcionou: `node:sqlite` simplesmente CRIA o arquivo, o banco subia normalmente e os testes
     * passavam sem provar nada. Um teste que passa pelo motivo errado é pior do que nenhum. */
    await db.fecharBanco();
    process.env.JORNADA_DB_URL = 'libsql://banco-que-nao-existe.invalid';
    process.env.JORNADA_DB_TOKEN = 'token-invalido';
  });

  afterAll(() => {
    delete process.env.JORNADA_DB_URL;
    delete process.env.JORNADA_DB_TOKEN;
  });

  it('A INTERFACE CONTINUA CARREGANDO', async () => {
    /* O teste que este arquivo existe para ter. Antes da correção, isto devolvia
     * {"erro":"erro_interno"} com content-type JSON — um erro cru no navegador. */
    const r = await req('/');
    expect(r.status).toBe(200);
    expect(r.tipo).toContain('text/html');
    expect(String(r.corpo)).toContain('<div id="root">');
  });

  it('as rotas do React Router também carregam', async () => {
    for (const rota of ['/entrar', '/fila', '/escalas', '/minha-conta']) {
      const r = await req(rota);
      expect(r.status, `rota ${rota}`).toBe(200);
      expect(r.tipo, `rota ${rota}`).toContain('text/html');
    }
  });

  it('os arquivos estáticos continuam sendo servidos', async () => {
    const r = await req('/assets/index-abc12345.js');
    expect(r.status).toBe(200);
  });

  it('a saúde continua dizendo que o PROCESSO está vivo', async () => {
    const r = await req('/api/saude');
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
  });

  it('a prontidão diz que o BANCO caiu, e não mente sobre estar tudo bem', async () => {
    const r = await req('/api/prontidao');
    expect(r.status).toBe(503);
    expect(r.corpo.ok).toBe(false);
    expect(r.corpo.componentes.banco.ok).toBe(false);
  });

  it('as rotas de dados falham de forma limpa', async () => {
    /* Elas DEVEM falhar — não há banco. O que não pode acontecer é a falha vazar para o
     * frontend, que é o que os testes acima garantem. */
    const r = await req('/api/auth/eu');
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
