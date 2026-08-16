#!/usr/bin/env node
/* Diagnóstico da conexão com o Turso — NÃO altera nada, só investiga.
 *
 * Uso (na sua máquina, com as mesmas variáveis do Render):
 *
 *   JORNADA_DB_URL=libsql://... JORNADA_DB_TOKEN=... npm run diagnostico-turso
 *
 * POR QUE ELE EXISTE
 * ------------------
 * O `@libsql/client` engole a resposta do servidor e devolve só "SERVER_ERROR: HTTP status 400".
 * Esse 400 pode ser três coisas muito diferentes — token inválido, endpoint/protocolo errado, ou
 * SQL recusado — e sem ver o corpo da resposta não dá para saber qual. Este script pergunta ao
 * servidor diretamente e MOSTRA o que ele responde.
 *
 * SEGREDOS: o token NUNCA é impresso. O que aparece são características dele (comprimento, se tem
 * espaço sobrando, se tem o formato de JWT) — o suficiente para diagnosticar sem expor nada.
 * A URL aparece só como esquema + host, sem query string. */

const url = process.env.JORNADA_DB_URL;
const token = process.env.JORNADA_DB_TOKEN;

if (!url || !token) {
  console.error('\nDefina JORNADA_DB_URL e JORNADA_DB_TOKEN antes de rodar.\n');
  process.exit(1);
}

const linha = (t = '') => console.log(t);
const titulo = (t) => { linha(); linha(`── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`); };

/* ---------------------------------------------------------------- 1. o que chegou pelo ambiente */

titulo('1. O QUE O AMBIENTE ENTREGOU');

const urlLimpa = url.trim();
const tokenLimpo = token.trim();

let host = '(não foi possível interpretar)';
let esquema = '(desconhecido)';
let temQuery = false;
let temCaminho = false;
try {
  const u = new URL(urlLimpa.replace(/^libsql:/, 'https:'));
  host = u.host;
  esquema = urlLimpa.split(':')[0];
  temQuery = u.search.length > 0;
  temCaminho = u.pathname !== '/' && u.pathname !== '';
} catch (e) {
  linha(`  ✗ URL não é uma URL válida: ${e.message}`);
}

linha(`  esquema da URL ............ ${esquema}   ${esquema === 'libsql' || esquema === 'https' ? '✓' : '✗ esperado libsql: ou https:'}`);
linha(`  host ...................... ${host}`);
linha(`  URL tem query string? ..... ${temQuery ? '✗ SIM — o token não deve ir na URL' : 'não ✓'}`);
linha(`  URL tem caminho? .......... ${temCaminho ? '✗ SIM — a URL do banco não leva caminho' : 'não ✓'}`);
linha(`  URL tinha espaço sobrando?  ${url !== urlLimpa ? '✗ SIM — provável colagem com espaço/quebra de linha' : 'não ✓'}`);
linha();
linha(`  token — comprimento ....... ${token.length} caracteres`);
linha(`  token — espaço sobrando? .. ${token !== tokenLimpo ? '✗ SIM — provável colagem com espaço/quebra de linha' : 'não ✓'}`);
linha(`  token — formato JWT? ...... ${tokenLimpo.split('.').length === 3 ? 'sim ✓ (3 partes)' : `✗ NÃO (${tokenLimpo.split('.').length} parte(s)) — token de banco do Turso é um JWT`}`);
linha(`  token — começa com "Bearer"? ${/^bearer\s/i.test(tokenLimpo) ? '✗ SIM — a palavra Bearer não deve ser colada junto' : 'não ✓'}`);

/* ---------------------------------------------------------------- 2. o servidor responde o quê */

async function sondar(caminho, corpo, comToken = true) {
  const alvo = `https://${host}/${caminho}`;
  try {
    const r = await fetch(alvo, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(comToken ? { authorization: `Bearer ${tokenLimpo}` } : {}),
      },
      body: JSON.stringify(corpo),
    });
    const texto = (await r.text()).slice(0, 400);
    return { status: r.status, texto };
  } catch (e) {
    return { erro: e.message };
  }
}

const PEDIDO = {
  baton: null,
  requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }, { type: 'close' }],
};

titulo('2. O QUE O SERVIDOR RESPONDE (HTTP cru — aqui aparece a mensagem real)');

for (const caminho of ['v2/pipeline', 'v3/pipeline']) {
  const r = await sondar(caminho, PEDIDO);
  if (r.erro) {
    linha(`  /${caminho.padEnd(12)} ✗ falha de rede: ${r.erro}`);
  } else {
    linha(`  /${caminho.padEnd(12)} HTTP ${r.status}`);
    linha(`      resposta: ${r.texto || '(vazia)'}`);
  }
}

titulo('3. MESMO PEDIDO, SEM TOKEN (separa autenticação de protocolo)');

const semToken = await sondar('v2/pipeline', PEDIDO, false);
if (semToken.erro) linha(`  ✗ falha de rede: ${semToken.erro}`);
else {
  linha(`  HTTP ${semToken.status}`);
  linha(`      resposta: ${semToken.texto || '(vazia)'}`);
  linha();
  linha('  Leitura: se COM token dá 400 e SEM token dá 401, o protocolo está certo e o problema');
  linha('           é o token. Se os dois dão 400, o problema é o pedido/endpoint, não o token.');
}

/* ---------------------------------------------------------------- 4. pelo driver de produção */

titulo('4. PELO MESMO DRIVER QUE A PRODUÇÃO USA');

process.env.JORNADA_DB_URL = urlLimpa;
process.env.JORNADA_DB_TOKEN = tokenLimpo;

const { consultar, executar, fecharBanco, modoBanco } = await import('../server/db/index.js');
linha(`  modo do banco: ${modoBanco()}`);

function classificar(e) {
  const m = String(e?.message ?? e);
  if (/401|unauthorized|jwt|auth/i.test(m)) return 'AUTENTICAÇÃO — token inválido, expirado ou de outro banco';
  if (/404|not found/i.test(m)) return 'ENDPOINT — a URL não aponta para um banco existente';
  if (/400/.test(m)) return 'PROTOCOLO/PEDIDO — o servidor recusou a requisição antes de olhar o SQL';
  if (/SQLITE_|syntax|no such/i.test(m)) return 'SQL — a instrução em si foi recusada';
  return 'INDEFINIDO';
}

const passos = [
  ['SELECT 1', () => consultar('SELECT 1 AS ok')],
  ['CREATE TABLE IF NOT EXISTS teste_conexao (id INTEGER PRIMARY KEY)', () => executar('CREATE TABLE IF NOT EXISTS teste_conexao (id INTEGER PRIMARY KEY)')],
  ['DROP TABLE IF EXISTS teste_conexao', () => executar('DROP TABLE IF EXISTS teste_conexao')],
];

for (const [rotulo, executarPasso] of passos) {
  try {
    await executarPasso();
    linha(`  ✓ ${rotulo}`);
  } catch (e) {
    linha(`  ✗ ${rotulo}`);
    linha(`      ${String(e.message).split('\n')[0]}`);
    linha(`      classificação: ${classificar(e)}`);
    break;
  }
}

try {
  await fecharBanco();
} catch {
  /* nada a fazer */
}

titulo('FIM');
linha('Cole a saída acima. Ela não contém token nem dado de cliente.');
linha();
