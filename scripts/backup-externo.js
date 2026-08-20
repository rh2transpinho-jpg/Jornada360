#!/usr/bin/env node
/* Backup externo: dump → integridade → AES-256-GCM → Backblaze B2 → confirmação.
 *
 * Uso: npm run backup-externo
 *
 * Não imprime chave, keyId nem conteúdo. Só carimbos, tamanhos e hash. */
import { executarBackupExterno, sincronizarAlertas } from '../server/lib/infraestrutura.js';
import { migrar, fecharBanco } from '../server/db/index.js';
import { b2Configurado, configuracaoB2 } from '../server/lib/backupExterno.js';
import { carregarCredenciais } from '../server/lib/env.js';

/* `.env` local (ignorado pelo Git). No Render as variáveis vêm do painel e isto não faz nada. */
carregarCredenciais();

await migrar();

const cfg = configuracaoB2();
console.log(`\nBackup externo — bucket "${cfg.bucket}", prefixo "${cfg.prefixo}"`);

if (!b2Configurado(cfg)) {
  console.error('\n✗ Não configurado. Faltam variáveis:');
  if (!cfg.keyId) console.error('    JORNADA_B2_KEY_ID');
  if (!cfg.appKey) console.error('    JORNADA_B2_APP_KEY');
  if (!cfg.bucket) console.error('    JORNADA_B2_BUCKET');
  if (!cfg.chave) console.error('    JORNADA_BACKUP_CHAVE  (gere com: npm run gerar-chave-backup)');
  console.error('\n  Ver DEPLOY_GRATUITO.md.\n');
  await fecharBanco();
  process.exit(1);
}

const r = await executarBackupExterno(cfg);

if (r.ok) {
  console.log(`\n✓ Enviado: ${r.arquivo}`);
  console.log(`  ${r.bytes} bytes cifrados · SHA-1 conferido com o que o Backblaze recebeu`);
  console.log(`  SHA-256 do conteúdo: ${r.hash.slice(0, 16)}…`);
  console.log(`  ${Object.values(r.contagens).reduce((a, b) => a + b, 0)} linha(s) · ${r.duracaoMs} ms\n`);
} else {
  console.error(`\n✗ FALHOU: ${r.erro}`);
  console.error('  O Jornada360 continua funcionando — backup externo é redundância, não dependência.\n');
}

await sincronizarAlertas();
await fecharBanco();
process.exit(r.ok ? 0 : 1);
