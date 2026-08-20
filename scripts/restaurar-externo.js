#!/usr/bin/env node
/* Teste REAL de restauração: Backblaze → download → hash → decifra → banco temporário →
 * integridade → validação estrutural.
 *
 * Uso: npm run restaurar-externo            (usa o backup mais recente)
 *      npm run restaurar-externo -- <arquivo>
 *
 * NUNCA toca no banco de produção: a restauração acontece num arquivo temporário, descartado no
 * fim. Backup que nunca foi restaurado é esperança, não backup — este script é o que transforma
 * um no outro. */
import { testarRestauracaoExterna, sincronizarAlertas } from '../server/lib/infraestrutura.js';
import { migrar, fecharBanco } from '../server/db/index.js';
import { listar, b2Configurado, configuracaoB2 } from '../server/lib/backupExterno.js';

await migrar();

const cfg = configuracaoB2();
if (!b2Configurado(cfg)) {
  console.error('\n✗ Backup externo não configurado. Ver DEPLOY_GRATUITO.md.\n');
  await fecharBanco();
  process.exit(1);
}

const alvo = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!alvo) {
  const disponiveis = await listar(cfg, 5);
  console.log('\nBackups no bucket:');
  for (const f of disponiveis) console.log(`  · ${f.arquivo}  ${f.bytes} bytes  ${f.em.slice(0, 19)}`);
}

console.log('\nRestaurando em ambiente isolado…');
const r = await testarRestauracaoExterna(alvo, cfg);

if (r.ok) {
  console.log(`\n✓ RESTAURAÇÃO VALIDADA — ${r.arquivo}`);
  console.log(`  hash confere com o registrado na criação do backup`);
  console.log(`  banco temporário abriu, integrity_check ok`);
  console.log(`  ${r.contagens.tenants} empresa(s) · ${r.contagens.users} usuário(s) · ${r.contagens.he_ocorrencias ?? 0} ocorrência(s) de HE`);
  console.log(`  ${r.duracaoMs} ms — o banco de produção não foi tocado\n`);
} else {
  console.error(`\n✗ RESTAURAÇÃO FALHOU: ${r.erro}\n`);
}

await sincronizarAlertas();
await fecharBanco();
process.exit(r.ok ? 0 : 1);
