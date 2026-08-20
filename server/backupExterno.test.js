/* BACKUP EXTERNO CRIPTOGRAFADO — o que ele promete e o que ele recusa.
 *
 * Duas promessas são testadas aqui, e as duas são do tipo que só se descobre quebrada no pior
 * dia possível:
 *
 *   1. O Backblaze NUNCA recebe dado legível, e um arquivo adulterado NÃO decifra em silêncio.
 *   2. Se o backup externo falhar, o Jornada360 CONTINUA FUNCIONANDO — redundância, não
 *      dependência (requisito 23).
 *
 * O upload real ao Backblaze não é exercitado aqui: exige credencial, e teste que depende de
 * rede externa falha por motivo errado. O que é testado é tudo o que acontece ANTES e DEPOIS do
 * upload — que é onde mora o risco de perder dado. O caminho de rede é validado à mão com
 * `npm run backup-externo` e `npm run restaurar-externo`. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import * as b2 from './lib/backupExterno.js';
import { gerarDump, executarBackupExterno, registrarEvento, painelInfraestrutura, sincronizarAlertas, ultimoEvento } from './lib/infraestrutura.js';

const DB = new URL('./__backupext.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;
process.env.JORNADA_CADASTRO_ABERTO = '1';

const CHAVE = randomBytes(32).toString('hex');

let servidor;
let base;
let tenantId;
let token;

async function req(metodo, caminho, { corpo, token: t } = {}) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-jornada-cliente': 'api', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const txt = await r.text();
  return { status: r.status, corpo: txt ? JSON.parse(txt) : null };
}

beforeAll(async () => {
  const app = criarApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;

  const r = await req('POST', '/api/auth/registrar', {
    corpo: { email: 'dono@backup.test', nome: 'Dona do Backup', senha: 'senha-forte-bk1', nomeEmpresa: 'Empresa do Backup' },
  });
  token = r.corpo.token;
  tenantId = r.corpo.tenants[0].id;
});

afterAll(async () => {
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const sufixo of ['', '-wal', '-shm']) {
    try {
      rmSync(DB + sufixo);
    } catch { /* pode não existir */ }
  }
});

/* ---------------------------------------------------------------- criptografia */

describe('o Backblaze nunca recebe dado legível', () => {
  it('o conteúdo cifrado não contém o texto original', () => {
    const original = "INSERT INTO users (email) VALUES ('ana@empresa.test');";
    const cifrado = b2.criptografar(original, CHAVE);
    expect(cifrado.toString('utf8')).not.toContain('ana@empresa.test');
    expect(cifrado.toString('latin1')).not.toContain('INSERT INTO');
  });

  it('decifrar devolve exatamente o original', () => {
    const original = 'linha 1\nlinha 2 com acento: ção\nlinha 3';
    expect(b2.descriptografar(b2.criptografar(original, CHAVE), CHAVE)).toBe(original);
  });

  it('um arquivo ADULTERADO não decifra — falha alto em vez de devolver lixo', () => {
    const cifrado = b2.criptografar('conteúdo importante', CHAVE);
    const adulterado = Buffer.from(cifrado);
    adulterado[adulterado.length - 3] ^= 0xff;
    /* É a autenticação do GCM. Num backup, "falhar alto" é a única resposta aceitável:
     * restaurar lixo silenciosamente destruiria o banco bom. */
    expect(() => b2.descriptografar(adulterado, CHAVE)).toThrow();
  });

  it('a chave errada não decifra', () => {
    const cifrado = b2.criptografar('segredo', CHAVE);
    expect(() => b2.descriptografar(cifrado, randomBytes(32).toString('hex'))).toThrow();
  });

  it('recusa chave em formato inválido em vez de cifrar mal', () => {
    expect(() => b2.criptografar('x', 'chave-curta')).toThrow(/64 caracteres/);
    expect(b2.chaveValida(CHAVE)).toBe(true);
    expect(b2.chaveValida('abc')).toBe(false);
  });

  it('não considera configurado sem TODAS as variáveis', () => {
    expect(b2.b2Configurado({ keyId: '', appKey: 'x', bucket: 'b', chave: CHAVE })).toBe(false);
    expect(b2.b2Configurado({ keyId: 'k', appKey: 'x', bucket: 'b', chave: 'curta' })).toBe(false);
    expect(b2.b2Configurado({ keyId: 'k', appKey: 'x', bucket: 'b', chave: CHAVE })).toBe(true);
  });
});

/* ---------------------------------------------------------------- dump */

describe('o dump carrega o banco inteiro, inclusive as ocorrências de HE', () => {
  it('inclui as tabelas de negócio e conta as linhas', async () => {
    const { sql, contagens } = await gerarDump();
    expect(contagens.tenants).toBeGreaterThanOrEqual(1);
    expect(contagens.users).toBeGreaterThanOrEqual(1);
    /* A tabela de HE precisa estar no backup: é onde vivem as justificativas, que são o dado
     * mais caro de reconstruir se for perdido. */
    expect(contagens).toHaveProperty('he_ocorrencias');
    expect(sql).toContain('INSERT INTO tenants');
  });

  it('o dump cifrado e decifrado volta idêntico', async () => {
    const { sql } = await gerarDump();
    const cifrado = b2.criptografar(sql, CHAVE);
    expect(b2.sha256(Buffer.from(b2.descriptografar(cifrado, CHAVE), 'utf8'))).toBe(b2.sha256(Buffer.from(sql, 'utf8')));
  });
});

/* ---------------------------------------------------------------- resiliência (requisito 23) */

describe('quando o backup externo falha, o Jornada360 continua inteiro', () => {
  it('sem configuração, devolve erro e REGISTRA — não lança', async () => {
    const r = await executarBackupExterno({ keyId: '', appKey: '', bucket: '', chave: '' });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/não configurado/i);

    const evento = await ultimoEvento('backup_externo');
    expect(evento.resultado).toBe('falha');
  });

  it('com credencial inválida, falha sem derrubar nada', async () => {
    const r = await executarBackupExterno({
      keyId: 'chave-que-nao-existe', appKey: 'tambem-nao', bucket: 'jornada360-backups', chave: CHAVE, prefixo: 'teste',
    });
    expect(r.ok).toBe(false);
    /* A mensagem não pode ecoar a credencial. */
    expect(r.erro).not.toContain('chave-que-nao-existe');
  });

  it('o sistema responde normalmente DEPOIS da falha do backup', async () => {
    /* É esta a prova do requisito 23: login, leitura e escrita continuam. */
    const entrar = await req('POST', '/api/auth/entrar', { corpo: { email: 'dono@backup.test', senha: 'senha-forte-bk1' } });
    expect(entrar.status).toBe(200);

    const escrita = await req('POST', `/api/tenants/${tenantId}/setores`, { token, corpo: { nome: 'Setor durante a falha' } });
    expect(escrita.status).toBe(201);

    const leitura = await req('GET', `/api/tenants/${tenantId}/setores`, { token });
    expect(leitura.status).toBe(200);
    expect(leitura.corpo.map((s) => s.nome)).toContain('Setor durante a falha');
  });
});

/* ---------------------------------------------------------------- painel e alertas */

describe('painel de Segurança e Backup', () => {
  it('exige sessão', async () => {
    expect((await req('GET', '/api/infraestrutura')).status).toBe(401);
  });

  it('mostra o estado sem expor NENHUM segredo', async () => {
    const r = await req('GET', '/api/infraestrutura', { token });
    expect(r.status).toBe(200);

    const texto = JSON.stringify(r.corpo);
    expect(texto).not.toContain(CHAVE);
    expect(texto.toLowerCase()).not.toContain('applicationkey');
    expect(texto).not.toMatch(/libsql:\/\//);

    expect(r.corpo).toHaveProperty('backupExterno');
    expect(r.corpo).toHaveProperty('restauracaoTestada');
    expect(r.corpo).toHaveProperty('integridade');
  });

  it('backup atrasado ou falho NÃO aparece como ok', async () => {
    const r = await req('GET', '/api/infraestrutura', { token });
    /* As falhas registradas nos testes acima são as mais recentes. */
    expect(r.corpo.backupExterno.ok).toBe(false);
    expect(r.corpo.backupExterno.erro).toBeTruthy();
  });
});

describe('alertas na Minha Fila', () => {
  it('sem empresa operadora definida, NÃO cria pendência em ninguém', async () => {
    /* Falha de backup é assunto de quem opera o sistema. Criar essa pendência na fila de um
     * cliente exporia um problema que ele não pode resolver. */
    const r = await sincronizarAlertas(undefined);
    expect(r.criados).toBe(0);

    const fila = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    expect(fila.corpo.filter((p) => p.tipo === 'infraestrutura')).toHaveLength(0);
  });

  it('com empresa operadora, cria o alerta — e NÃO duplica ao rodar de novo', async () => {
    const primeira = await sincronizarAlertas(tenantId);
    expect(primeira.criados).toBeGreaterThan(0);

    const segunda = await sincronizarAlertas(tenantId);
    expect(segunda.criados).toBe(0);

    const fila = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    const alertas = fila.corpo.filter((p) => p.tipo === 'infraestrutura' && p.status === 'aberta');
    expect(alertas.length).toBeGreaterThan(0);
    expect(new Set(alertas.map((a) => a.categoria)).size).toBe(alertas.length);
  });

  it('quando normaliza, o alerta é resolvido sozinho', async () => {
    await registrarEvento({ tipo: 'backup_externo', resultado: 'ok', detalhe: 'simulado', hash: 'abc', destino: 'teste/ok.enc' });
    await registrarEvento({ tipo: 'restauracao_teste', resultado: 'ok', detalhe: 'simulado', destino: 'teste/ok.enc' });

    const r = await sincronizarAlertas(tenantId);
    expect(r.resolvidos).toBeGreaterThan(0);

    const fila = await req('GET', `/api/tenants/${tenantId}/pendencias`, { token });
    expect(fila.corpo.filter((p) => p.tipo === 'infraestrutura' && p.status === 'aberta')).toHaveLength(0);
  });

  it('depois de normalizar, o painel fica verde', async () => {
    const r = await req('GET', '/api/infraestrutura', { token });
    expect(r.corpo.backupExterno.ok).toBe(true);
    expect(r.corpo.restauracaoTestada.ok).toBe(true);
  });
});
