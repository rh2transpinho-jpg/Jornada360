/* CICLO COMPLETO DO BACKUP EXTERNO — com um Backblaze de mentira.
 *
 * POR QUE UM DUBLÊ: o upload real exige credencial e rede. Um teste que depende dos dois falha
 * por motivo errado (chave rotacionada, bucket cheio, provedor fora do ar) e deixa de ser sinal.
 *
 * O que o dublê NÃO simula é justamente o que ele não precisa provar: a autenticação do B2, que
 * é verificada em produção. O que ele prova é tudo o que acontece DEPOIS dela — e é aí que mora
 * o risco de perder dado sem perceber: cifrar, subir, baixar, decifrar, conferir hash, restaurar
 * num banco de verdade e validar a estrutura.
 *
 * O dublê guarda os bytes exatos que recebeu e devolve os mesmos no download. Se o ciclo
 * corrompesse qualquer coisa, o teste falharia aqui — antes de falhar num dia de desastre. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { criarApp } from './app.js';
import { fecharBanco } from './db/index.js';
import * as b2 from './lib/backupExterno.js';
import { executarBackupExterno, testarRestauracaoExterna, gerarDump } from './lib/infraestrutura.js';

const DB = new URL('./__bkfluxo.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
process.env.JORNADA_DB_PATH = DB;
process.env.JORNADA_CADASTRO_ABERTO = '1';

const CFG = {
  keyId: 'chave-de-mentira',
  appKey: 'segredo-de-mentira',
  bucket: 'jornada360-teste-bucket',
  chave: randomBytes(32).toString('hex'),
  prefixo: 'jornada360',
};

/* ---------------------------------------------------------------- Backblaze de mentira */

const bucket = new Map();
const fetchOriginal = globalThis.fetch;

function instalarB2Falso({ falharUpload = false } = {}) {
  globalThis.fetch = (async (entrada, init = {}) => {
    const url = String(entrada);
    const json = (corpo, status = 200) =>
      new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

    if (url.includes('b2_authorize_account')) {
      return json({
        authorizationToken: 'token-de-sessao',
        apiInfo: {
          storageApi: {
            apiUrl: 'https://api-falso.test',
            downloadUrl: 'https://download-falso.test',
            bucketId: 'id-do-bucket',
            bucketName: CFG.bucket,
          },
        },
      });
    }

    if (url.includes('b2_get_upload_url')) {
      return json({ uploadUrl: 'https://upload-falso.test/enviar', authorizationToken: 'token-de-upload' });
    }

    if (url.includes('upload-falso.test')) {
      if (falharUpload) return new Response('indisponível', { status: 503 });
      const nome = decodeURIComponent(init.headers['X-Bz-File-Name']);
      const bytes = Buffer.from(init.body);
      bucket.set(nome, bytes);
      return json({
        fileId: 'id-' + bucket.size,
        contentLength: bytes.length,
        /* O SHA-1 devolvido é calculado sobre o que o dublê REALMENTE recebeu — se o envio
         * corrompesse os bytes, a conferência do lado de cá pegaria. */
        contentSha1: createHash('sha1').update(bytes).digest('hex'),
      });
    }

    if (url.includes('b2_list_file_names')) {
      return json({
        files: [...bucket.entries()].map(([nome, bytes]) => ({
          fileName: nome, fileId: 'id', contentLength: bytes.length,
          contentSha1: createHash('sha1').update(bytes).digest('hex'),
          uploadTimestamp: Date.now(),
        })),
      });
    }

    if (url.includes('download-falso.test')) {
      const caminho = decodeURIComponent(url.split(`/file/${CFG.bucket}/`)[1] ?? '');
      const bytes = bucket.get(caminho);
      if (!bytes) return new Response('não encontrado', { status: 404 });
      return new Response(bytes, { status: 200 });
    }

    return new Response('rota não simulada: ' + url, { status: 500 });
  });
}

let servidor;
let base;

beforeAll(async () => {
  const app = criarApp();
  await new Promise((r) => { servidor = app.listen(0, r); });
  base = `http://127.0.0.1:${servidor.address().port}`;

  /* Uma empresa com dado real de negócio, para o backup ter o que carregar. */
  const r = await fetch(base + '/api/auth/registrar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jornada-cliente': 'api' },
    body: JSON.stringify({ email: 'dono@fluxo.test', nome: 'Dona do Fluxo', senha: 'senha-forte-fx1', nomeEmpresa: 'Empresa do Fluxo' }),
  });
  const { token, tenants } = await r.json();
  const cabecalhos = { 'content-type': 'application/json', 'x-jornada-cliente': 'api', authorization: `Bearer ${token}` };
  await fetch(`${base}/api/tenants/${tenants[0].id}/colaboradores`, {
    method: 'POST', headers: cabecalhos,
    body: JSON.stringify({ nome: 'Colaborador do Fluxo', matricula: 'FX-1' }),
  });

  /* Um dia com HE — isto cria uma ocorrência E uma pendência que APONTA para ela.
   *
   * É o caso que quebrou a primeira restauração real: a exportação listava `pendings` antes de
   * `he_ocorrencias`, e a carga falhava com "FOREIGN KEY constraint failed". Sem uma pendência
   * ligada a uma ocorrência, o teste passava e o defeito só aparecia no dia do desastre. */
  await fetch(`${base}/api/tenants/${tenants[0].id}/dias/2026-07-22`, {
    method: 'PUT', headers: cabecalhos,
    body: JSON.stringify({
      snapshot: {
        dateKey: '2026-07-22', dateLabel: '22/07/2026',
        items: [{
          motorista: 'Alex do Fluxo', he1min: 130, he1str: '02:10', status: 'forte',
          rastreioStatus: 'forte', detalhe: '', confirmadas: '06:00-18:10', batidas: '',
          contexto: '', padraoStatus: 'acima', padraoMin: 600, excedenteMin: 130,
          padraoDebug: '', padraoHorarios: ['06:00', '16:00'], setorAtual: '', causaAtual: null,
          causaFonte: null, interjornada: '', diaAjustado: 0, temLacuna: false, precisaVerificar: false,
        }],
        totalHE: 130, acimaHE: 130, programadoHE: 0, semPadraoCount: 0, avisoPadrao: '',
      },
      caseState: {},
    }),
  });
});

afterAll(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
  await fecharBanco();
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(DB + s); } catch { /* pode não existir */ }
  }
});

/* ---------------------------------------------------------------- o ciclo */

describe('ciclo completo: cifra, sobe, baixa, decifra, restaura', () => {
  let enviado;

  it('o backup sobe e o SHA-1 do destino confere com o daqui', async () => {
    instalarB2Falso();
    const r = await executarBackupExterno(CFG);

    expect(r.ok).toBe(true);
    expect(r.sha1Remoto).toBe(r.sha1Local);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.arquivo).toMatch(/^jornada360\/jornada360-.*\.sql\.enc$/);
    enviado = r;
  });

  it('o que ficou no bucket é ILEGÍVEL', () => {
    const bytes = bucket.get(enviado.arquivo);
    expect(bytes).toBeDefined();
    const comoTexto = bytes.toString('latin1');
    /* O nome de um colaborador real não pode aparecer no arquivo que saiu daqui. */
    expect(comoTexto).not.toContain('Colaborador do Fluxo');
    expect(comoTexto).not.toContain('INSERT INTO');
    expect(comoTexto).not.toContain('dono@fluxo.test');
  });

  it('baixar e decifrar devolve exatamente o conteúdo original', async () => {
    const baixado = await b2.baixar(enviado.arquivo, CFG);
    const sql = b2.descriptografar(baixado, CFG.chave);
    expect(b2.sha256(Buffer.from(sql, 'utf8'))).toBe(enviado.hash);
    expect(sql).toContain('Colaborador do Fluxo');
  });

  it('a restauração isolada abre o banco e valida a estrutura', async () => {
    const r = await testarRestauracaoExterna(enviado.arquivo, CFG);

    expect(r.ok).toBe(true);
    expect(r.hash).toBe(enviado.hash);
    expect(r.contagens.tenants).toBeGreaterThanOrEqual(1);
    expect(r.contagens.users).toBeGreaterThanOrEqual(1);
    /* A ocorrência de HE precisa voltar: é onde vivem as justificativas, o dado mais caro de
     * reconstruir se for perdido. */
    expect(r.contagens.he_ocorrencias).toBeGreaterThanOrEqual(1);
  });

  it('a restauração RECUSA um arquivo adulterado no bucket', async () => {
    /* Alguém (ou algum defeito) mexeu no objeto depois do upload. */
    const bytes = Buffer.from(bucket.get(enviado.arquivo));
    bytes[bytes.length - 4] ^= 0xff;
    bucket.set(enviado.arquivo, bytes);

    const r = await testarRestauracaoExterna(enviado.arquivo, CFG);
    /* Falha ALTO. Restaurar lixo em silêncio destruiria o banco bom. */
    expect(r.ok).toBe(false);
    expect(r.erro).toBeTruthy();
  });
});

describe('falha do Backblaze não derruba nada', () => {
  it('upload recusado vira evento de falha, não exceção', async () => {
    instalarB2Falso({ falharUpload: true });
    const r = await executarBackupExterno(CFG);
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/503|recusado/i);
  });

  it('o dump continua funcionando depois da falha', async () => {
    const { contagens } = await gerarDump();
    expect(contagens.tenants).toBeGreaterThanOrEqual(1);
  });
});
