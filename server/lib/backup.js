/* Backup e restauração do banco.
 *
 * POR QUE NÃO É SÓ COPIAR O ARQUIVO
 * ---------------------------------
 * O SQLite grava em WAL: parte do que já foi confirmado pode estar no arquivo `-wal`, ainda não
 * consolidado no `.db`. Copiar o `.db` com o servidor rodando produz, na melhor das hipóteses, um
 * backup desatualizado; na pior, um arquivo inconsistente que só se descobre inválido no dia da
 * restauração — que é exatamente o pior dia para descobrir.
 *
 * `VACUUM INTO` resolve: o SQLite escreve um banco novo, completo e consistente, respeitando a
 * transação em curso. É a operação que existe para isto.
 *
 * TODO BACKUP É VERIFICADO ANTES DE CONTAR COMO BACKUP. Gerar o arquivo e não abri-lo é ter uma
 * cópia cuja validade ninguém conhece. Aqui, logo após gerar, o arquivo é aberto e consultado; se
 * falhar, ele é descartado e o backup é reportado como falho. Backup que não foi lido é esperança,
 * não backup. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { conexaoSqlite, caminhoBanco } from '../db/index.js';
import { log } from './log.js';

/* Tabelas que precisam existir e ser consultáveis num backup válido. Se uma sumir, o arquivo não
 * serve — e é melhor saber agora. */
const TABELAS_ESSENCIAIS = ['users', 'tenants', 'memberships', 'sessions', 'companies', 'time_records', 'pendings', 'audit_log'];

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function sha256(caminho) {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}

/* Abre o arquivo como banco e confere que as tabelas essenciais respondem. */
export function verificarBackup(caminho) {
  let db;
  try {
    db = new DatabaseSync(caminho, { readOnly: true });

    const integridade = db.prepare('PRAGMA integrity_check').get();
    const resultado = integridade?.integrity_check ?? Object.values(integridade ?? {})[0];
    if (resultado !== 'ok') return { ok: false, erro: `integrity_check devolveu "${resultado}"` };

    const contagens = {};
    for (const tabela of TABELAS_ESSENCIAIS) {
      contagens[tabela] = db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
    }

    return { ok: true, contagens, bytes: statSync(caminho).size, sha256: sha256(caminho) };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try {
      db?.close();
    } catch {
      /* já fechado */
    }
  }
}

/* `async` desde que o banco passou a poder ser remoto: `conexaoSqlite()` recusa quando o driver
 * ativo é o libSQL, e recusar é a resposta certa — não existe arquivo local para copiar lá. O
 * backup do banco remoto é a exportação (`npm run exportar`), documentada em DEPLOY_GRATUITO.md. */
export async function gerarBackup(config, { rotulo = 'auto' } = {}) {
  const destinoDir = config.backup.diretorio;
  if (!destinoDir) return { ok: false, erro: 'JORNADA_BACKUP_DIR não definida.' };

  mkdirSync(destinoDir, { recursive: true });
  const destino = join(destinoDir, `jornada360-${rotulo}-${carimbo()}.db`);

  try {
    /* `VACUUM INTO` exige que o destino não exista. O carimbo com segundos garante isso, mas a
     * verificação evita um erro obscuro caso dois backups disparem no mesmo segundo. */
    if (existsSync(destino)) return { ok: false, erro: 'já existe um backup com este carimbo.' };

    (await conexaoSqlite()).exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  } catch (e) {
    return { ok: false, erro: `falha ao gerar: ${e.message}` };
  }

  const verificacao = verificarBackup(destino);
  if (!verificacao.ok) {
    /* Um backup que não abre é pior do que nenhum: cria a impressão de que existe uma cópia.
     * Apagar é a única resposta honesta. */
    try {
      unlinkSync(destino);
    } catch {
      /* nada a fazer */
    }
    return { ok: false, erro: `backup gerado mas INVÁLIDO (${verificacao.erro}) — arquivo descartado.` };
  }

  return { ok: true, caminho: destino, ...verificacao };
}

/* Apaga backups mais antigos que o limite. Guarda SEMPRE o mais recente, aconteça o que acontecer:
 * uma configuração errada de retenção não pode ser o que deixa o sistema sem nenhuma cópia. */
export function limparAntigos(config) {
  const dir = config.backup.diretorio;
  if (!dir || !existsSync(dir)) return { removidos: 0 };

  const limite = Date.now() - config.backup.manterDias * 86400_000;
  const arquivos = readdirSync(dir)
    .filter((f) => f.startsWith('jornada360-') && f.endsWith('.db'))
    .map((f) => ({ nome: f, caminho: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  let removidos = 0;
  for (const arquivo of arquivos.slice(1)) {
    if (arquivo.mtime >= limite) continue;
    unlinkSync(arquivo.caminho);
    removidos += 1;
  }
  return { removidos, restantes: arquivos.length - removidos };
}

export function listarBackups(config) {
  const dir = config.backup.diretorio;
  if (!dir || !existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.startsWith('jornada360-') && f.endsWith('.db'))
    .map((f) => {
      const caminho = join(dir, f);
      const st = statSync(caminho);
      return { nome: f, caminho, bytes: st.size, em: new Date(st.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.em < b.em ? 1 : -1));
}

/* Restaura um backup POR CIMA do banco atual.
 *
 * Antes de tocar em qualquer coisa: verifica o backup. Restaurar um arquivo corrompido destruiria
 * o banco bom para colocar um ruim no lugar — o pior desfecho possível de uma restauração.
 *
 * E antes de sobrescrever, guarda o banco atual como `pre-restauracao`. Se a restauração for a
 * decisão errada (backup velho demais, arquivo trocado), ainda existe caminho de volta. */
export function restaurarBackup(caminhoBackup, { destino = caminhoBanco() } = {}) {
  if (!existsSync(caminhoBackup)) return { ok: false, erro: `backup não encontrado: ${caminhoBackup}` };

  const verificacao = verificarBackup(caminhoBackup);
  if (!verificacao.ok) {
    return { ok: false, erro: `backup INVÁLIDO (${verificacao.erro}) — restauração cancelada, o banco atual não foi tocado.` };
  }

  let seguranca = null;
  if (existsSync(destino)) {
    seguranca = `${destino}.pre-restauracao-${carimbo()}`;
    copyFileSync(destino, seguranca);
  }

  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(caminhoBackup, destino);

  /* O WAL e o SHM antigos pertencem ao banco que acabou de ser substituído. Deixá-los para trás
   * faria o SQLite tentar aplicar, sobre o banco restaurado, transações de outro banco. */
  for (const sufixo of ['-wal', '-shm']) {
    if (existsSync(destino + sufixo)) unlinkSync(destino + sufixo);
  }

  const conferencia = verificarBackup(destino);
  if (!conferencia.ok) {
    return { ok: false, erro: `o banco restaurado não abriu (${conferencia.erro}).`, copiaDeSeguranca: seguranca };
  }

  return { ok: true, restauradoDe: caminhoBackup, copiaDeSeguranca: seguranca, contagens: conferencia.contagens };
}

/* Backup automático dentro do próprio processo.
 *
 * Escolha consciente: um `setInterval` aqui funciona em qualquer lugar onde o processo rode —
 * container, VPS, plataforma gerenciada — sem depender de cron do sistema, que muitas plataformas
 * sequer expõem. A troca é que ele só roda enquanto o processo está de pé; para quem tem cron
 * externo, `JORNADA_BACKUP_INTERVALO_HORAS=0` desliga e `npm run backup` faz o mesmo trabalho.
 *
 * O primeiro backup sai poucos segundos após a subida, e não daqui a seis horas: um deploy que
 * quebrasse antes do primeiro intervalo deixaria o dia inteiro sem cópia. */
export function agendarBackupAutomatico(config) {
  const horas = config.backup.intervaloHoras;
  if (!horas || !config.backup.diretorio) {
    if (config.producao) log.aviso('backup automático DESLIGADO', { intervaloHoras: horas, diretorio: config.backup.diretorio });
    return () => {};
  }

  const executar = async () => {
    const r = await gerarBackup(config, { rotulo: 'auto' });
    if (r.ok) {
      const limpeza = limparAntigos(config);
      log.info('backup automático concluído', {
        arquivo: r.caminho,
        bytes: r.bytes,
        tenants: r.contagens.tenants,
        antigosRemovidos: limpeza.removidos,
      });
    } else {
      log.erro('backup automático FALHOU', { erro: r.erro });
    }
  };

  const inicial = setTimeout(executar, 15_000);
  const periodico = setInterval(executar, horas * 3600_000);
  inicial.unref();
  periodico.unref();

  log.info('backup automático agendado', { aCada: `${horas}h`, diretorio: config.backup.diretorio, manterDias: config.backup.manterDias });

  return () => {
    clearTimeout(inicial);
    clearInterval(periodico);
  };
}
