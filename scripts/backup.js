#!/usr/bin/env node
/* Backup manual do banco.
 *
 *   npm run backup                 gera um backup verificado e limpa os antigos
 *   npm run backup -- --listar     mostra os backups existentes
 *
 * Serve para três situações: antes de um deploy, antes de uma migração de schema, e para quem
 * prefere agendar por cron externo em vez do agendamento interno do servidor.
 *
 * O código de saída é 0 só quando o backup foi gerado E verificado. Isso é o que permite usar este
 * script dentro de um cron ou de um pipeline: `npm run backup && deploy`. */
import { carregarConfig } from '../server/config.js';
import { gerarBackup, limparAntigos, listarBackups } from '../server/lib/backup.js';
import { fecharBanco, caminhoBanco } from '../server/db/index.js';

const config = carregarConfig();

if (!config.backup.diretorio) {
  console.error('\n✗ JORNADA_BACKUP_DIR não está definida — não há para onde gravar o backup.');
  console.error('  Defina no .env (ou no ambiente do container) e tente de novo. Ver DEPLOY.md.\n');
  process.exit(1);
}

function formatarBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
}

if (process.argv.includes('--listar')) {
  const lista = listarBackups(config);
  if (lista.length === 0) {
    console.log(`\nNenhum backup em ${config.backup.diretorio}.\n`);
  } else {
    console.log(`\n${lista.length} backup(s) em ${config.backup.diretorio}:\n`);
    for (const b of lista) console.log(`  ${b.em}   ${formatarBytes(b.bytes).padStart(9)}   ${b.nome}`);
    console.log('');
  }
  fecharBanco();
  process.exit(0);
}

const rotulo = process.argv.includes('--manual') ? 'manual' : 'manual';
console.log(`\nGerando backup de ${caminhoBanco()}…`);

const r = await gerarBackup(config, { rotulo });

if (!r.ok) {
  console.error(`\n✗ BACKUP FALHOU: ${r.erro}\n`);
  fecharBanco();
  process.exit(1);
}

const limpeza = limparAntigos(config);

console.log(`\n✓ Backup gerado E VERIFICADO`);
console.log(`  arquivo:  ${r.caminho}`);
console.log(`  tamanho:  ${formatarBytes(r.bytes)}`);
console.log(`  sha256:   ${r.sha256.slice(0, 16)}…`);
console.log(`\n  Conteúdo conferido lendo o arquivo gerado:`);
for (const [tabela, n] of Object.entries(r.contagens)) {
  console.log(`    ${tabela.padEnd(14)} ${String(n).padStart(6)}`);
}
if (limpeza.removidos) console.log(`\n  ${limpeza.removidos} backup(s) antigo(s) removido(s) (retenção: ${config.backup.manterDias} dias).`);
console.log('');

fecharBanco();
