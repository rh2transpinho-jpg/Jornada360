/* Conexão com o banco e mecanismo de migrations.
 *
 * DOIS DRIVERS, UM CONTRATO. O mesmo SQL roda em dois lugares:
 *
 *   - `node:sqlite`  — arquivo local. É a Opção B (Docker/VPS) e o que os testes usam.
 *   - libSQL/Turso   — banco remoto. É a Opção A (publicação gratuita), onde não existe disco
 *                      persistente e um arquivo local sumiria no primeiro reinício.
 *
 * A escolha é por variável de ambiente e acontece UMA vez, na abertura. Nenhum repositório sabe
 * em qual dos dois está — é a mesma ideia da fábrica de repositórios do frontend (ver
 * FRONTEND_BACKEND.md), aplicada do lado do servidor.
 *
 * TUDO É ASSÍNCRONO, inclusive no driver local, que por dentro é síncrono. Ter duas assinaturas
 * diferentes para a mesma operação obrigaria cada repositório a saber qual driver está ativo — e
 * seria a porta de entrada para uma consulta que funciona num ambiente e quebra no outro.
 *
 * As migrations são versionadas e idempotentes: rodar duas vezes não quebra nem duplica. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarDriverSqlite } from './driverSqlite.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

let driver = null;
let migrado = false;

/* O caminho vem de variável de ambiente para que test/dev/prod usem bancos diferentes sem
 * nenhuma troca de código — e para que o teste nunca escreva por cima do banco de trabalho. */
export function caminhoBanco() {
  return process.env.JORNADA_DB_PATH || join(AQUI, '..', '..', 'data', 'jornada360.db');
}

/** 'libsql' quando há um banco remoto configurado; 'sqlite' no arquivo local. */
export function modoBanco() {
  if (process.env.JORNADA_DB_URL) return 'libsql';
  /* `JORNADA_DB_DRIVER=libsql` faz o cliente libSQL abrir o arquivo LOCAL, sem rede.
   *
   * Existe para os testes: com esta variável, as mesmas 143 provas de backend rodam contra o
   * driver que a publicação gratuita usa. Sem isso, o driver remoto só seria exercitado em
   * produção — que é o pior lugar para descobrir uma diferença de comportamento entre os dois. */
  if (process.env.JORNADA_DB_DRIVER === 'libsql') return 'libsql';
  return 'sqlite';
}

/* O driver remoto é importado sob demanda: quem roda em SQLite (todos os testes, o Docker, o
 * desenvolvimento local) não paga por uma dependência que não usa, e o projeto continua rodando
 * mesmo se `@libsql/client` não estiver instalado. */
async function criarDriver() {
  if (modoBanco() === 'libsql') {
    const { criarDriverLibsql } = await import('./driverLibsql.js');
    /* Sem `JORNADA_DB_URL`, o arquivo local vira uma URL `file:` — o mesmo cliente, sem rede. */
    const url = process.env.JORNADA_DB_URL || `file:${caminhoBanco()}`;
    return criarDriverLibsql({ url, token: process.env.JORNADA_DB_TOKEN });
  }
  return criarDriverSqlite(caminhoBanco());
}

export async function bd() {
  if (!driver) driver = await criarDriver();
  return driver;
}

/* Conexão crua do SQLite. Só existe para o backup por `VACUUM INTO`, que é inerentemente
 * específico do arquivo local. Em modo remoto não há arquivo para copiar — o backup de lá é a
 * exportação (`npm run exportar`), documentado em DEPLOY_GRATUITO.md. */
export async function conexaoSqlite() {
  const d = await bd();
  if (d.modo !== 'sqlite') {
    throw new Error('Operação disponível apenas no banco em arquivo (SQLite). Use `npm run exportar` no banco remoto.');
  }
  return d.conexao;
}

export async function fecharBanco() {
  if (driver) {
    await driver.fechar();
    driver = null;
    migrado = false;
  }
}

/* ---------------------------------------------------------------- acesso */

export async function consultar(sql, params = []) {
  return (await bd()).consultar(sql, params);
}

export async function consultarUm(sql, params = []) {
  return (await bd()).consultarUm(sql, params);
}

export async function executar(sql, params = []) {
  return (await bd()).executar(sql, params);
}

/* Executa uma função dentro de uma transação. Usado onde uma operação toca várias tabelas
 * (criar tenant + empresa + regras + integrações + membership), para não deixar meia empresa
 * gravada se algo falhar no meio.
 *
 * A função recebe um objeto com o MESMO contrato (`consultar`/`consultarUm`/`executar`) ligado à
 * transação. Usar o acesso global lá dentro escreveria fora dela — e o rollback não desfaria. */
export async function emTransacao(fn) {
  return (await bd()).emTransacao(fn);
}

/* ---------------------------------------------------------------- migrations */

const MIGRACOES = [
  { versao: 1, arquivo: 'schema.sql' },
  { versao: 2, arquivo: '002_fase4.sql' },
  { versao: 3, arquivo: '003_fase5.sql' },
  { versao: 4, arquivo: '004_piloto.sql' },
];

/* Executa o schema. É idempotente (todo CREATE usa IF NOT EXISTS) e registra a versão aplicada,
 * para que uma migração futura saiba de onde continuar em vez de recriar tudo. */
export async function migrar() {
  const d = await bd();

  await d.executarMultiplos(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      versao     INTEGER PRIMARY KEY,
      aplicada_em TEXT NOT NULL
    );
  `);

  const aplicadas = await d.consultar('SELECT versao FROM schema_migrations');
  const jaAplicadas = new Set(aplicadas.map((r) => Number(r.versao)));

  for (const m of MIGRACOES) {
    if (jaAplicadas.has(m.versao)) continue;
    await d.executarMultiplos(readFileSync(join(AQUI, m.arquivo), 'utf8'));
    await d.executar('INSERT INTO schema_migrations (versao, aplicada_em) VALUES (?, ?)', [
      m.versao,
      new Date().toISOString(),
    ]);
  }

  migrado = true;
  return d;
}

/* Garante que o schema existe antes da primeira requisição.
 *
 * Existe porque `criarApp()` é síncrono e não pode esperar a migração terminar. Sem esta trava,
 * uma requisição que chegasse no primeiro segundo do processo consultaria uma tabela ainda não
 * criada — cenário real em hospedagem gratuita, onde o serviço acorda já com gente batendo. */
export async function garantirMigrado() {
  if (!migrado) await migrar();
}
