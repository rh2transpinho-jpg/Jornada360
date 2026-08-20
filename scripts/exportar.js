#!/usr/bin/env node
/* Exportação do banco inteiro para um arquivo SQL portátil.
 *
 * Uso:
 *   npm run exportar                       exporta o banco ativo para backups/
 *   npm run exportar -- --saida dump.sql   escolhe o arquivo
 *
 * DUAS RAZÕES PARA ELE EXISTIR
 * ----------------------------
 * 1. BACKUP DO BANCO REMOTO. `VACUUM INTO` copia um arquivo local; no Turso não há arquivo para
 *    copiar. Este dump é a cópia recuperável do banco remoto — e, ao contrário de um snapshot do
 *    provedor, você fica com ele na sua máquina.
 * 2. MIGRAÇÃO. É a primeira metade do caminho SQLite → Turso; a segunda é `npm run importar`.
 *
 * O dump traz apenas INSERTs de dados. O schema vem das migrations, que rodam sozinhas no destino
 * — reproduzir o DDL aqui criaria uma segunda definição do schema para manter em dia.
 *
 * As contagens saem no final e no cabeçalho do arquivo. São elas que o `importar` confere: uma
 * migração que "termina sem erro" mas com menos linhas do que a origem é o pior desfecho, porque
 * parece sucesso. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { consultar, fecharBanco, modoBanco, caminhoBanco } from '../server/db/index.js';
import { migrar } from '../server/db/index.js';
import { carregarCredenciais } from '../server/lib/env.js';

/* `.env` local (ignorado pelo Git). No Render as variáveis vêm do painel e isto não faz nada. */
carregarCredenciais();

/* A lista de tabelas e a ORDEM delas vem de server/lib/infraestrutura.js — fonte unica.
 *
 * Este arquivo tinha a propria copia, e ela ficou para tras quando as tabelas de HE nasceram:
 * o backup manual saia SEM nenhuma justificativa, parecendo completo. Duas listas para a mesma
 * coisa so ficam iguais ate a primeira tabela nova. */
import { TABELAS as TABELAS_DE_NEGOCIO } from '../server/lib/infraestrutura.js';

/* `schema_migrations` entra so na CONTAGEM: o destino aplica as proprias migrations antes da
 * carga, e reinseri-las quebraria a chave primaria. */
const TABELAS = [...TABELAS_DE_NEGOCIO, 'schema_migrations'];

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const argumentos = process.argv.slice(2);
function opcao(nome, padrao) {
  const i = argumentos.indexOf(nome);
  return i >= 0 && argumentos[i + 1] ? argumentos[i + 1] : padrao;
}

const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const saida = opcao('--saida', join(process.env.JORNADA_BACKUP_DIR || 'backups', `jornada360-export-${carimbo}.sql`));

await migrar();

console.log(`\nExportando (${modoBanco() === 'libsql' ? 'banco remoto' : caminhoBanco()})…\n`);

const partes = [];
const contagens = {};

for (const tabela of TABELAS) {
  let linhas;
  try {
    linhas = await consultar(`SELECT * FROM ${tabela}`);
  } catch (e) {
    /* Uma tabela ausente não é erro fatal: um banco de versão anterior pode não tê-la ainda. */
    console.warn(`  ! ${tabela}: ${e.message}`);
    continue;
  }

  contagens[tabela] = linhas.length;
  console.log(`  ${tabela.padEnd(20)} ${String(linhas.length).padStart(6)} linha(s)`);
  if (linhas.length === 0) continue;

  /* `schema_migrations` é contada mas NÃO exportada: o destino aplica as próprias migrations
   * antes da carga e já tem essas linhas. Reinseri-las quebraria a chave primária e derrubaria a
   * importação inteira — foi exatamente o que aconteceu no primeiro ensaio. */
  if (tabela === 'schema_migrations') continue;

  const colunas = Object.keys(linhas[0]);
  partes.push(`-- ${tabela} (${linhas.length})`);
  for (const linha of linhas) {
    const valores = colunas.map((c) => literal(linha[c])).join(', ');
    partes.push(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${valores});`);
  }
  partes.push('');
}

const cabecalho = [
  '-- Jornada360 — exportação de dados',
  `-- gerado em: ${new Date().toISOString()}`,
  `-- origem: ${modoBanco() === 'libsql' ? 'banco remoto' : caminhoBanco()}`,
  `-- contagens: ${JSON.stringify(contagens)}`,
  '--',
  '-- Importar com: npm run importar -- <este-arquivo>',
  '-- O schema NÃO está aqui: as migrations criam as tabelas no destino antes da carga.',
  '',
];

mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, cabecalho.concat(partes).join('\n'), 'utf8');

const total = Object.values(contagens).reduce((a, b) => a + b, 0);
console.log(`\n✓ ${total} linha(s) exportada(s) para ${saida}\n`);

await fecharBanco();
