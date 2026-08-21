#!/usr/bin/env node
/* Verificação do projeto — uma rotina, tudo que já existe.
 *
 *   npm run verificar                          checagens locais
 *   npm run verificar -- --producao <url>      inclui prontidão e smoke da URL publicada
 *   npm run verificar -- --rapido              pula testes e build (só as checagens de segundos)
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * As checagens já existiam, espalhadas: `npm test`, `npm run build`, `npm run smoke`, o endpoint
 * de prontidão, a varredura de segredos que era feita à mão antes de cada commit. Fazer todas na
 * ordem certa dependia de lembrar de todas — e a que se esquece é justamente a que pega o
 * problema.
 *
 * ELE NÃO ALTERA NADA. Nenhum passo escreve arquivo, migra banco, faz deploy ou remove dado. É
 * leitura e execução de teste, e só. Deploy e ações sensíveis continuam sendo decisão de uma
 * pessoa, no fluxo que já existe — automação que faz mudança destrutiva sozinha é como se perde
 * um banco de produção numa terça-feira.
 *
 * Sai com código 1 se qualquer passo obrigatório falhar, para servir de portão em pipeline. */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const rapido = args.includes('--rapido');
const iProducao = args.indexOf('--producao');
const urlProducao = iProducao >= 0 ? (args[iProducao + 1] ?? '').replace(/\/$/, '') : null;

const VERDE = '\x1b[32m';
const VERMELHO = '\x1b[31m';
const AMARELO = '\x1b[33m';
const CINZA = '\x1b[90m';
const FIM = '\x1b[0m';

const resultados = [];

function passo(nome, fn, { obrigatorio = true } = {}) {
  process.stdout.write(`${CINZA}· ${nome}…${FIM}\n`);
  const inicio = Date.now();
  try {
    const detalhe = fn();
    const ms = Date.now() - inicio;
    console.log(`${VERDE}  ✓ ${nome}${FIM} ${CINZA}${detalhe ?? ''} (${ms}ms)${FIM}\n`);
    resultados.push({ nome, ok: true, obrigatorio });
    return true;
  } catch (e) {
    const ms = Date.now() - inicio;
    const cor = obrigatorio ? VERMELHO : AMARELO;
    const marca = obrigatorio ? '✗' : '!';
    console.log(`${cor}  ${marca} ${nome}${FIM} ${CINZA}(${ms}ms)${FIM}`);
    console.log(`${cor}    ${String(e.message).split('\n')[0]}${FIM}\n`);
    resultados.push({ nome, ok: false, obrigatorio, erro: e.message });
    return false;
  }
}

/* As ferramentas são chamadas pelo próprio Node, apontando para o arquivo real dentro de
 * `node_modules` — nunca via `npm`/`npx`.
 *
 * Duas razões. No Windows, `npm` e `npx` são `.cmd`, e o Node 24 recusa executá-los sem `shell`
 * (EINVAL); com `shell: true`, o Node avisa que os argumentos deixam de ser escapados. Chamar o
 * arquivo diretamente evita as duas coisas — e ainda pula uma camada de processo por passo. */
const FERRAMENTA = {
  tsc: 'node_modules/typescript/bin/tsc',
  vitest: 'node_modules/vitest/vitest.mjs',
  vite: 'node_modules/vite/bin/vite.js',
};

function rodarNode(ferramenta, argumentos) {
  return execFileSync(process.execPath, [join(RAIZ, FERRAMENTA[ferramenta]), ...argumentos], {
    cwd: RAIZ, encoding: 'utf8', stdio: 'pipe',
  });
}

function rodar(comando, argumentos) {
  return execFileSync(comando, argumentos, { cwd: RAIZ, encoding: 'utf8', stdio: 'pipe' });
}

/* ---------------------------------------------------------------- migrations */

/* Confere que a lista de migrations, os arquivos em disco e a lista de tabelas do backup contam a
 * mesma história. Foi um desencontro desses — uma cópia manual da lista de migrations dentro da
 * rotina de restauração — que fez o restore quebrar em silêncio. */
function verificarMigrations() {
  const dir = join(RAIZ, 'server', 'db');
  const indice = readFileSync(join(dir, 'index.js'), 'utf8');

  const declaradas = [...indice.matchAll(/arquivo:\s*'([^']+)'/g)].map((m) => m[1]);
  if (!declaradas.length) throw new Error('Nenhuma migration declarada em server/db/index.js.');

  const faltando = declaradas.filter((a) => !existsSync(join(dir, a)));
  if (faltando.length) throw new Error(`Migration declarada e ausente em disco: ${faltando.join(', ')}`);

  const emDisco = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const naoDeclaradas = emDisco.filter((f) => !declaradas.includes(f));
  if (naoDeclaradas.length) {
    throw new Error(`Arquivo .sql em disco que NENHUMA migration aplica: ${naoDeclaradas.join(', ')}`);
  }

  return `${declaradas.length} migration(s), todas declaradas e presentes`;
}

/* ---------------------------------------------------------------- segredos */

/* Varredura de segredos no que está VERSIONADO. Olha os arquivos que o git conhece, não o disco
 * inteiro: um `.env` local não rastreado não é vazamento, e alarmar sobre ele treina a pessoa a
 * ignorar o aviso. */
function varrerSegredos() {
  const rastreados = rodar('git', ['ls-files']).split('\n').filter(Boolean);

  const PADROES = [
    { nome: 'token do Turso', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
    { nome: 'chave de aplicação Backblaze', re: /application[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{20,}/i },
    { nome: 'chave de API genérica', re: /\b(sk|api)[_-][A-Za-z0-9]{24,}\b/ },
    { nome: 'URL de banco com credencial', re: /libsql:\/\/[^\s'"]*:[^\s'"]*@/ },
    { nome: 'chave privada', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  ];

  const IGNORAR = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/i;
  const achados = [];

  for (const arquivo of rastreados) {
    if (IGNORAR.test(arquivo)) continue;
    const caminho = join(RAIZ, arquivo);
    if (!existsSync(caminho)) continue;
    let conteudo;
    try { conteudo = readFileSync(caminho, 'utf8'); } catch { continue; }
    for (const p of PADROES) {
      /* O ARQUIVO e o TIPO, nunca o valor. Imprimir o segredo para avisar que ele vazou é
       * vazá-lo de novo, agora no log do terminal e no histórico do shell. */
      if (p.re.test(conteudo)) achados.push(`${arquivo} (${p.nome})`);
    }
  }

  /* Dumps e bancos nunca deveriam estar versionados, com ou sem padrão de segredo dentro. */
  const proibidos = rastreados.filter((a) => /\.(db|sqlite|sqlite3)$/.test(a) || /^backups\//.test(a) || /\.sql\.enc$/.test(a));
  for (const a of proibidos) achados.push(`${a} (arquivo de banco ou backup versionado)`);

  if (achados.length) throw new Error(`Encontrado em arquivos versionados:\n    ${achados.join('\n    ')}`);
  return `${rastreados.length} arquivo(s) versionado(s) varridos`;
}

/* Confere que o .gitignore cobre o que nunca pode subir. */
function verificarGitignore() {
  const gi = readFileSync(join(RAIZ, '.gitignore'), 'utf8');
  const exigidos = ['.env', '/data/', 'backups/', 'node_modules'];
  const faltando = exigidos.filter((p) => !gi.split('\n').some((l) => l.trim() === p || l.trim() === p.replace(/\/$/, '')));
  if (faltando.length) throw new Error(`.gitignore não cobre: ${faltando.join(', ')}`);
  return exigidos.length + ' padrão(ões) confirmados';
}

/* ---------------------------------------------------------------- produção */

async function checarProntidao(url) {
  const r = await fetch(`${url}/api/prontidao`, { headers: { 'x-jornada-cliente': 'api' } });
  const corpo = await r.json();

  if (!r.ok || corpo.pronto === false) {
    throw new Error(`Prontidão respondeu ${r.status}: ${corpo.diagnostico ?? corpo.mensagem ?? JSON.stringify(corpo)}`);
  }

  const partes = [];
  if (corpo.banco) partes.push(`banco ${corpo.banco.modo ?? 'ok'}`);
  if (corpo.migracoes) partes.push(`migrations v${corpo.migracoes.versao ?? '?'}`);
  if (corpo.hospedagem?.commit) partes.push(`commit ${String(corpo.hospedagem.commit).slice(0, 7)}`);
  return partes.join(' · ');
}

async function checarBackup(url) {
  const r = await fetch(`${url}/api/prontidao`, { headers: { 'x-jornada-cliente': 'api' } });
  const corpo = await r.json();
  const b = corpo.backup ?? corpo.backupExterno;

  if (!b) return 'painel de backup não exposto nesta versão';
  if (b.configurado === false) throw new Error('Backup externo não configurado no ambiente.');

  const ultimo = b.ultimoEm ?? b.ultimo ?? null;
  if (!ultimo) throw new Error('Nenhum backup externo registrado ainda.');

  const horas = (Date.now() - new Date(ultimo).getTime()) / 3_600_000;
  if (horas > 48) throw new Error(`Último backup há ${Math.round(horas)}h — mais de 48h.`);
  return `último backup há ${Math.round(horas)}h`;
}

/* ---------------------------------------------------------------- execução */

console.log(`\n${CINZA}Jornada360 — verificação${urlProducao ? ` (+ produção: ${urlProducao})` : ''}${FIM}\n`);

passo('migrations coerentes', verificarMigrations);
passo('.gitignore cobre o essencial', verificarGitignore);
passo('nenhum segredo em arquivo versionado', varrerSegredos);
passo('tipos', () => { rodarNode('tsc', ['-b', '--force']); return 'sem erros'; });

if (!rapido) {
  const contarTestes = (saida) => {
    /* O vitest escreve o resumo no stderr; `execFileSync` com stdio 'pipe' só devolve o stdout,
     * então a contagem sai da linha de resultado quando ela aparece — e "ok" quando não. */
    const m = String(saida).match(/Tests\s+(\d+) passed/);
    return m ? `${m[1]} testes` : 'sem falhas';
  };

  passo('testes de interface', () => contarTestes(rodarNode('vitest', ['run'])));
  passo('testes de servidor', () => contarTestes(rodarNode('vitest', ['run', '--config', 'vitest.server.config.ts'])));

  passo('build', () => {
    rodarNode('vite', ['build']);
    return 'dist gerado';
  });
}

if (urlProducao) {
  /* Em série e com `await` de verdade: o `passo()` acima é síncrono e engoliria uma promessa
   * rejeitada, transformando uma produção fora do ar em "passou". A prontidão vem primeiro —
   * se o serviço não responde, as demais só produziriam outra versão do mesmo erro.
   *
   * O backup é AVISO, não falha: um backup atrasado merece atenção, mas não deve impedir a
   * publicação de uma correção urgente. */
  for (const [nome, fn, obrigatorio] of [
    ['produção: prontidão', () => checarProntidao(urlProducao), true],
    ['produção: backup externo', () => checarBackup(urlProducao), false],
  ]) {
    const inicio = Date.now();
    try {
      const detalhe = await fn();
      console.log(`${VERDE}  ✓ ${nome}${FIM} ${CINZA}${detalhe} (${Date.now() - inicio}ms)${FIM}\n`);
      resultados.push({ nome, ok: true, obrigatorio });
    } catch (e) {
      const cor = obrigatorio ? VERMELHO : AMARELO;
      console.log(`${cor}  ${obrigatorio ? '✗' : '!'} ${nome}${FIM}`);
      console.log(`${cor}    ${e.message}${FIM}\n`);
      resultados.push({ nome, ok: false, obrigatorio, erro: e.message });
    }
  }

  console.log(`${CINZA}  Para o smoke completo (cria contas de teste reais):${FIM}`);
  console.log(`${CINZA}    npm run smoke -- ${urlProducao}${FIM}\n`);
}

/* ---------------------------------------------------------------- resumo */

const falhas = resultados.filter((r) => !r.ok && r.obrigatorio);
const avisos = resultados.filter((r) => !r.ok && !r.obrigatorio);
const ok = resultados.filter((r) => r.ok);

console.log(`${CINZA}${'─'.repeat(52)}${FIM}`);
console.log(`${VERDE}${ok.length} passou${FIM}`
  + (avisos.length ? ` · ${AMARELO}${avisos.length} aviso${FIM}` : '')
  + (falhas.length ? ` · ${VERMELHO}${falhas.length} falhou${FIM}` : ''));

if (falhas.length) {
  console.log(`\n${VERMELHO}Não está pronto para publicar.${FIM}\n`);
  process.exit(1);
}
console.log(`\n${VERDE}Verificação concluída.${FIM} ${CINZA}Nada foi alterado.${FIM}\n`);
