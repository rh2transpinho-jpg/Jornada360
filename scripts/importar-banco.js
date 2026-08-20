#!/usr/bin/env node
/* Importa um dump gerado por `npm run exportar` para o banco ATIVO.
 *
 * Uso:
 *   JORNADA_DB_URL=libsql://... JORNADA_DB_TOKEN=... npm run importar -- backups/dump.sql
 *   npm run importar -- backups/dump.sql --forcar     (destino não vazio)
 *
 * É a segunda metade da migração SQLite → Turso. O que ele garante, nesta ordem:
 *
 *  1. RECUSA UM DESTINO QUE JÁ TEM DADOS, a menos que você diga `--forcar`. Importar por cima de
 *     um banco povoado é a receita para duplicar empresas e misturar clientes.
 *  2. IMPORTA DENTRO DE UMA TRANSAÇÃO. Se qualquer linha falhar, nada é gravado — melhor um banco
 *     vazio e um erro claro do que um banco pela metade que parece pronto.
 *  3. CONFERE AS CONTAGENS declaradas no cabeçalho do dump contra o que existe no destino DEPOIS
 *     da carga. Uma migração que termina sem erro mas perde linhas é o pior desfecho possível,
 *     porque parece sucesso. Aqui ela é reprovada em voz alta.
 *  4. CONFERE O ISOLAMENTO: toda tabela de negócio precisa ter todas as linhas com `tenant_id`
 *     apontando para um tenant existente. Uma linha órfã seria dado sem dono — e num sistema
 *     multiempresa, dado sem dono é dado que pode aparecer para a empresa errada. */
import { readFileSync } from 'node:fs';
import { bd, consultarUm, consultar, fecharBanco, migrar, modoBanco } from '../server/db/index.js';
import { carregarCredenciais } from '../server/lib/env.js';

/* `.env` local (ignorado pelo Git). No Render as variáveis vêm do painel e isto não faz nada. */
carregarCredenciais();

const argumentos = process.argv.slice(2);
const arquivo = argumentos.find((a) => !a.startsWith('--'));
const forcar = argumentos.includes('--forcar');

if (!arquivo) {
  console.error('\nUso: npm run importar -- <arquivo.sql> [--forcar]\n');
  process.exit(1);
}

/* Tabelas que carregam dado de empresa. Toda linha delas precisa ter dono. */
const TABELAS_DE_EMPRESA = [
  'companies', 'units', 'departments', 'schedules', 'employees', 'workspace_rules',
  'integration_configs', 'time_records', 'pendings', 'audit_log', 'invites', 'feedback',
  'he_ocorrencias', 'he_historico',
];

const conteudo = readFileSync(arquivo, 'utf8');
const declaradas = (() => {
  const m = conteudo.match(/^-- contagens: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
})();

const instrucoes = conteudo
  .split('\n')
  .filter((l) => l.trim().startsWith('INSERT INTO '))
  .map((l) => l.trim().replace(/;$/, ''));

console.log(`\nImportando ${instrucoes.length} instrução(ões) de ${arquivo}`);
console.log(`Destino: ${modoBanco() === 'libsql' ? 'banco remoto' : 'arquivo local'}\n`);

await migrar();

/* ---------------------------------------------------------------- destino vazio? */

const existentes = await consultarUm('SELECT COUNT(*) AS n FROM tenants');
if (Number(existentes?.n ?? 0) > 0 && !forcar) {
  console.error(`✗ O destino já tem ${existentes.n} empresa(s).`);
  console.error('  Importar por cima duplicaria dados. Use --forcar se for realmente o que você quer.\n');
  await fecharBanco();
  process.exit(1);
}

/* ---------------------------------------------------------------- carga */

const banco = await bd();
try {
  await banco.emTransacao(async (tx) => {
    for (const instrucao of instrucoes) {
      await tx.executar(instrucao);
    }
  });
} catch (e) {
  console.error(`\n✗ IMPORTAÇÃO FALHOU: ${e.message}`);
  console.error('  Nada foi gravado — a transação foi desfeita inteira.\n');
  await fecharBanco();
  process.exit(1);
}

/* ---------------------------------------------------------------- conferência */

console.log('Conferindo…\n');

let ok = true;
const contagensDestino = {};

for (const tabela of Object.keys(declaradas ?? {})) {
  let n = 0;
  try {
    const r = await consultarUm(`SELECT COUNT(*) AS n FROM ${tabela}`);
    n = Number(r?.n ?? 0);
  } catch {
    n = -1;
  }
  contagensDestino[tabela] = n;

  const esperado = declaradas[tabela];
  /* `schema_migrations` não vem no dump: o destino cria a própria. Conferir que ele tem AO MENOS
   * as versões da origem garante que o schema do destino não está atrasado — que seria a forma
   * silenciosa de perder uma coluna na migração. */
  const tolerado = tabela === 'schema_migrations';
  const bate = n === esperado || (tolerado && n >= esperado);

  if (!bate) ok = false;
  console.log(`  ${bate ? '✓' : '✗'} ${tabela.padEnd(20)} origem ${String(esperado).padStart(6)}  destino ${String(n).padStart(6)}`);
}

/* ---------------------------------------------------------------- isolamento */

console.log('\nIsolamento (toda linha de negócio precisa ter empresa dona):\n');

for (const tabela of TABELAS_DE_EMPRESA) {
  try {
    const r = await consultarUm(
      `SELECT COUNT(*) AS n FROM ${tabela} WHERE tenant_id IS NULL
         OR tenant_id NOT IN (SELECT id FROM tenants)`,
    );
    const orfas = Number(r?.n ?? 0);
    if (orfas > 0) ok = false;
    console.log(`  ${orfas === 0 ? '✓' : '✗'} ${tabela.padEnd(20)} ${orfas} linha(s) órfã(s)`);
  } catch {
    /* tabela ausente numa versão anterior do schema */
  }
}

const empresas = await consultar('SELECT id, nome, status FROM tenants ORDER BY criado_em');
console.log(`\n${empresas.length} empresa(s) no destino:`);
for (const e of empresas) console.log(`  · ${e.nome}  [${e.status}]  ${e.id}`);

if (!ok) {
  console.error('\n✗ A conferência REPROVOU. NÃO use este banco: confira o dump e importe de novo num destino limpo.\n');
  await fecharBanco();
  process.exit(1);
}

console.log('\n✓ Importação conferida: contagens batem e nenhuma linha ficou sem empresa.');
console.log('  Só depois disto aponte a aplicação para este banco.\n');

await fecharBanco();
