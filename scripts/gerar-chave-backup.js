#!/usr/bin/env node
/* Gera a chave de criptografia do backup externo do Jornada360.
 *
 * A chave é ESCRITA EM ARQUIVO, nunca impressa na tela. O motivo é prático: o que aparece no
 * terminal fica no histórico do shell, no scrollback e em qualquer transcrição da sessão. Um
 * arquivo você abre, copia para o Render e apaga.
 *
 * ELA NÃO PODE SER PERDIDA. Sem a chave, todo backup no Backblaze vira lixo indecifrável — a
 * criptografia é autenticada e não tem porta dos fundos. Guarde-a fora da máquina também
 * (gerenciador de senhas).
 *
 * NÃO reutilize a chave do RH360: os dois sistemas precisam de isolamento de backup, e uma chave
 * compartilhada faz o vazamento de um expor o outro. */
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const destino = resolve(process.argv[2] || 'CHAVE-BACKUP-JORNADA360.txt');

if (existsSync(destino)) {
  console.error(`\n✗ ${destino} já existe.`);
  console.error('  Não vou sobrescrever: se esta chave já estiver em uso, trocá-la torna os backups atuais indecifráveis.');
  console.error('  Apague o arquivo à mão se tiver certeza de que quer uma chave nova.\n');
  process.exit(1);
}

const chave = randomBytes(32).toString('hex');

writeFileSync(destino, [
  'JORNADA360 — CHAVE DE CRIPTOGRAFIA DO BACKUP EXTERNO',
  '',
  'Coloque este valor no Render, na variável:',
  '',
  '  JORNADA_BACKUP_CHAVE',
  '',
  chave,
  '',
  '--------------------------------------------------------------------',
  'AVISOS',
  '',
  '1. Sem esta chave, os backups no Backblaze NÃO podem ser restaurados.',
  '   Guarde uma cópia fora desta máquina (gerenciador de senhas).',
  '2. Este arquivo NÃO pode entrar no Git. Ele já está no .gitignore.',
  '3. Depois de copiar para o Render, apague este arquivo.',
  '4. NÃO use esta chave em nenhum outro sistema (RH360 tem a dele).',
  '',
], { encoding: 'utf8', flag: 'wx' });

console.log(`\n✓ Chave gerada em: ${destino}`);
console.log('  Ela NÃO foi impressa aqui de propósito — abra o arquivo, copie para o Render e apague.\n');
