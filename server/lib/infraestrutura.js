/* Orquestração do backup externo, do teste de restauração e do painel de saúde.
 *
 * A REGRA QUE ORGANIZA ESTE ARQUIVO: backup externo é REDUNDÂNCIA, nunca DEPENDÊNCIA. Nenhuma
 * função daqui é chamada no caminho de uma requisição de usuário, e nenhuma falha daqui derruba
 * o sistema. Quando o Backblaze cai, o Jornada360 continua inteiro: o que acontece é um evento
 * `falha` registrado e um alerta na Minha Fila. */
import { consultar, consultarUm, executar, MIGRACOES } from '../db/index.js';
import { novoId } from './seguranca.js';
import { log } from './log.js';
import * as b2 from './backupExterno.js';

/* Tabelas exportadas, NA ORDEM EM QUE PODEM SER REINSERIDAS sem violar chave estrangeira.
 *
 * ESTA É A ÚNICA LISTA. `scripts/exportar.js` importa daqui — ele tinha a própria cópia, que
 * ficou para trás quando as tabelas de HE nasceram, e por isso o backup manual estava saindo SEM
 * nenhuma justificativa. Perder a explicação de uma hora extra e manter o número é o pior tipo
 * de perda: o backup parece completo.
 *
 * A ORDEM NÃO É ALFABÉTICA NEM ARBITRÁRIA. `he_ocorrencias` precisa vir antes de `pendings`,
 * porque uma pendência de HE aponta para a ocorrência; e `he_historico` vem logo depois da
 * ocorrência, pelo mesmo motivo. Isso foi descoberto por uma restauração real que falhou com
 * "FOREIGN KEY constraint failed" — quem acrescentar tabela aqui precisa pensar na ordem. */
export const TABELAS = [
  'users', 'tenants', 'memberships', 'companies', 'units', 'departments', 'schedules',
  'employees', 'workspace_rules', 'integration_configs', 'time_records',
  /* Ordem = dependência. `escala_importacoes` antes de `escalas_dia` porque a escala aponta para
     a importação que a trouxe; foi exatamente esse tipo de inversão que fez uma restauração falhar
     com FOREIGN KEY e revelou que o backup vinha perdendo dado. */
  'horarios_padrao', 'horarios_padrao_historico',
  'escala_importacoes', 'escalas_dia', 'escalas_historico',
  'he_ocorrencias', 'he_historico',
  /* Antes de `pendings`, que referencia a análise. */
  'jornada_analises',
  'pendings',
  'audit_log', 'invites', 'sessions', 'password_resets', 'feedback',
];

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/* ---------------------------------------------------------------- dump */

/* Gera o dump SQL do banco inteiro em memória.
 *
 * Funciona igual nos dois drivers — é por isso que o backup externo não depende de arquivo local
 * nem do disco do Render. O schema NÃO vai no dump: quem cria as tabelas no destino são as
 * migrations, e duplicar o DDL aqui criaria uma segunda definição para manter em dia. */
export async function gerarDump() {
  const partes = [];
  const contagens = {};

  for (const tabela of TABELAS) {
    let linhas;
    try {
      linhas = await consultar(`SELECT * FROM ${tabela}`);
    } catch {
      continue; /* tabela ainda não existe nesta versão do schema */
    }
    contagens[tabela] = linhas.length;
    if (linhas.length === 0) continue;

    const colunas = Object.keys(linhas[0]);
    partes.push(`-- ${tabela} (${linhas.length})`);
    for (const linha of linhas) {
      partes.push(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${colunas.map((c) => literal(linha[c])).join(', ')});`);
    }
    partes.push('');
  }

  const cabecalho = [
    '-- Jornada360 — backup completo',
    `-- gerado em: ${new Date().toISOString()}`,
    `-- contagens: ${JSON.stringify(contagens)}`,
    '-- Restaurar com: npm run importar -- <arquivo>',
    '',
  ];

  return { sql: cabecalho.concat(partes).join('\n'), contagens };
}

/* ---------------------------------------------------------------- registro de eventos */

export async function registrarEvento({ tipo, resultado, detalhe = '', bytes = null, hash = null, destino = '', duracaoMs = null }) {
  await executar(
    `INSERT INTO infra_eventos (id, tipo, resultado, detalhe, bytes, hash, destino, duracao_ms, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [novoId('inf'), tipo, resultado, detalhe, bytes, hash, destino, duracaoMs, new Date().toISOString()],
  );
}

export function ultimoEvento(tipo) {
  return consultarUm(
    `SELECT tipo, resultado, detalhe, bytes, hash, destino, duracao_ms AS duracaoMs, criado_em AS criadoEm
     FROM infra_eventos WHERE tipo = ? ORDER BY criado_em DESC LIMIT 1`,
    [tipo],
  );
}

export function eventosRecentes(limite = 20) {
  return consultar(
    `SELECT tipo, resultado, detalhe, bytes, destino, criado_em AS criadoEm
     FROM infra_eventos ORDER BY criado_em DESC LIMIT ?`,
    [limite],
  );
}

/* ---------------------------------------------------------------- backup externo */

/* Fluxo completo do requisito 21: dump → integridade → criptografia → upload → confirmação.
 *
 * NUNCA lança. Devolve `{ ok: false, erro }` e registra o evento — porque quem chama é um
 * agendador, e uma exceção não tratada num agendador derruba o processo do servidor. */
export async function executarBackupExterno(cfg = b2.configuracaoB2()) {
  const inicio = Date.now();

  if (!b2.b2Configurado(cfg)) {
    const erro = 'Backup externo não configurado (JORNADA_B2_KEY_ID, JORNADA_B2_APP_KEY, JORNADA_B2_BUCKET, JORNADA_BACKUP_CHAVE).';
    await registrarEvento({ tipo: 'backup_externo', resultado: 'falha', detalhe: erro, destino: 'backblaze-b2' });
    return { ok: false, erro };
  }

  try {
    const { sql, contagens } = await gerarDump();

    /* Integridade ANTES de cifrar: é este hash que a restauração confere depois de decifrar.
     * Comparar hashes do arquivo cifrado provaria só que o transporte funcionou; comparar o do
     * conteúdo prova que voltou o MESMO dado. */
    const hashConteudo = b2.sha256(Buffer.from(sql, 'utf8'));

    const cifrado = b2.criptografar(sql, cfg.chave);

    /* Prova local de que o que foi cifrado volta idêntico. Um backup que não decifra é pior do
     * que backup nenhum: cria a impressão de que existe uma cópia. */
    const conferencia = b2.descriptografar(cifrado, cfg.chave);
    if (b2.sha256(Buffer.from(conferencia, 'utf8')) !== hashConteudo) {
      throw new Error('O conteúdo cifrado não voltou idêntico na conferência local. Upload cancelado.');
    }

    const nome = `jornada360-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.sql.enc`;
    const envio = await b2.enviar(nome, cifrado, cfg);

    if (envio.sha1Remoto && envio.sha1Remoto !== envio.sha1Local) {
      throw new Error('O Backblaze registrou um SHA-1 diferente do enviado — o objeto no bucket não confere.');
    }

    const duracaoMs = Date.now() - inicio;
    const totalLinhas = Object.values(contagens).reduce((a, b) => a + b, 0);
    await registrarEvento({
      tipo: 'backup_externo',
      resultado: 'ok',
      detalhe: `${totalLinhas} linha(s) em ${Object.keys(contagens).length} tabela(s)`,
      bytes: envio.bytes,
      hash: hashConteudo,
      destino: envio.arquivo,
      duracaoMs,
    });

    log.info('backup externo concluído', { arquivo: envio.arquivo, bytes: envio.bytes, duracaoMs });
    return { ok: true, ...envio, hash: hashConteudo, contagens, duracaoMs };
  } catch (e) {
    await registrarEvento({
      tipo: 'backup_externo',
      resultado: 'falha',
      detalhe: e.message,
      destino: 'backblaze-b2',
      duracaoMs: Date.now() - inicio,
    });
    log.erro('backup externo FALHOU', { erro: e.message });
    return { ok: false, erro: e.message };
  }
}

/* ---------------------------------------------------------------- restauração testada */

/* Requisito 22: baixar do B2, conferir hash, decifrar, abrir num banco TEMPORÁRIO e validar a
 * estrutura. Nunca toca no banco de produção — o teste roda contra um arquivo descartável. */
export async function testarRestauracaoExterna(arquivo, cfg = b2.configuracaoB2()) {
  const inicio = Date.now();

  if (!b2.b2Configurado(cfg)) {
    return { ok: false, erro: 'Backup externo não configurado.' };
  }

  try {
    const alvo = arquivo ?? (await b2.listar(cfg, 1))[0]?.arquivo;
    if (!alvo) throw new Error('Nenhum backup encontrado no bucket.');

    const cifrado = await b2.baixar(alvo, cfg);
    const sql = b2.descriptografar(cifrado, cfg.chave);
    const hash = b2.sha256(Buffer.from(sql, 'utf8'));

    /* Confere contra o hash registrado quando o backup foi criado. É o que fecha o ciclo:
     * o que saiu daqui é exatamente o que voltou. */
    const evento = await consultarUm(
      'SELECT hash FROM infra_eventos WHERE tipo = ? AND destino = ? ORDER BY criado_em DESC LIMIT 1',
      ['backup_externo', alvo],
    );
    const hashConfere = !evento?.hash || evento.hash === hash;
    if (!hashConfere) throw new Error('O conteúdo restaurado não bate com o hash registrado na criação do backup.');

    /* Abertura real, em banco temporário e isolado. */
    const { DatabaseSync } = await import('node:sqlite');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rmSync } = await import('node:fs');

    const caminho = join(tmpdir(), `jornada360-restauracao-${Date.now()}.db`);
    let db;
    let contagens = {};
    try {
      db = new DatabaseSync(caminho);
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname } = await import('node:path');
      const raizDb = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

      /* O schema vem das migrations, exatamente como no destino real — e a LISTA vem de
       * `db/index.js`, não de uma cópia escrita aqui. Uma cópia local já existiu e transformou
       * "adicionar uma migration" em "quebrar a restauração sem ninguém perceber". */
      for (const m of MIGRACOES) {
        db.exec(readFileSync(join(raizDb, m.arquivo), 'utf8').replace(/^\s*PRAGMA[^;]*;/gim, ''));
      }
      for (const instrucao of sql.split('\n').filter((l) => l.trim().startsWith('INSERT INTO '))) {
        db.exec(instrucao);
      }

      const integridade = db.prepare('PRAGMA integrity_check').get();
      const resultado = integridade?.integrity_check ?? Object.values(integridade ?? {})[0];
      if (resultado !== 'ok') throw new Error(`integrity_check devolveu "${resultado}"`);

      for (const t of ['users', 'tenants', 'memberships', 'he_ocorrencias']) {
        contagens[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      }
      /* VALIDAÇÃO ESTRUTURAL: o backup restaurado precisa ter o que o backup DIZ que tem.
       *
       * Antes, esta checagem reprovava qualquer backup sem empresa nem usuário — e isso estava
       * errado. Uma produção recém-publicada, ainda sem o primeiro cliente, gera legitimamente um
       * backup vazio; reprovar aquilo é alarme falso, e alarme falso treina a pessoa a ignorar o
       * painel. Aconteceu na primeira restauração real deste sistema.
       *
       * A comparação certa é contra as contagens que o próprio dump declarou na hora em que foi
       * gerado. Ela é mais forte, não mais frouxa: pega restauração PARCIAL — um backup que diz
       * ter 40 empresas e restaura 12 é reprovado, coisa que a checagem anterior deixava passar. */
      const declarado = sql.match(/^-- contagens: (.+)$/m);
      if (declarado) {
        const esperado = JSON.parse(declarado[1]);
        for (const [tabela, n] of Object.entries(contagens)) {
          if (esperado[tabela] !== undefined && esperado[tabela] !== n) {
            throw new Error(
              `Restauração INCOMPLETA em "${tabela}": o backup declara ${esperado[tabela]} linha(s) e restaurou ${n}.`,
            );
          }
        }
        contagens.origemDeclarada = Object.values(esperado).reduce((a, b) => a + b, 0);
      }
    } finally {
      try {
        db?.close();
      } catch { /* já fechado */ }
      for (const sufixo of ['', '-wal', '-shm']) {
        try {
          rmSync(caminho + sufixo);
        } catch { /* pode não existir */ }
      }
    }

    const duracaoMs = Date.now() - inicio;
    await registrarEvento({
      tipo: 'restauracao_teste',
      resultado: 'ok',
      detalhe: `${contagens.tenants} empresa(s), ${contagens.users} usuário(s), ${contagens.he_ocorrencias ?? 0} ocorrência(s) de HE`,
      bytes: cifrado.length,
      hash,
      destino: alvo,
      duracaoMs,
    });

    return { ok: true, arquivo: alvo, hash, contagens, duracaoMs };
  } catch (e) {
    await registrarEvento({
      tipo: 'restauracao_teste',
      resultado: 'falha',
      detalhe: e.message,
      destino: arquivo ?? '(último)',
      duracaoMs: Date.now() - inicio,
    });
    return { ok: false, erro: e.message };
  }
}

/* ---------------------------------------------------------------- painel (requisito 24) */

/* Estado operacional para a tela de Segurança e Backup. NUNCA devolve segredo: só carimbos,
 * tamanhos e se a peça está configurada — nunca a chave, nunca o keyId, nunca a URL do banco. */
export async function painelInfraestrutura(config) {
  const [externo, restauracao, interno] = await Promise.all([
    ultimoEvento('backup_externo'),
    ultimoEvento('restauracao_teste'),
    ultimoEvento('backup_interno'),
  ]);

  const horasDesde = (e) => (e ? (Date.now() - new Date(e.criadoEm).getTime()) / 3600_000 : null);
  const cfg = b2.configuracaoB2();

  return {
    banco: { ok: true, modo: config?.producao ? '(oculto)' : 'local' },
    backupInterno: {
      configurado: !!config?.backup?.diretorio,
      ok: interno?.resultado === 'ok',
      em: interno?.criadoEm ?? null,
    },
    backupExterno: {
      configurado: b2.b2Configurado(cfg),
      /* "Configurado mas atrasado" é falha operacional silenciosa — o tipo que só aparece no dia
       * em que alguém precisa restaurar. Aqui ele fica visível antes disso. */
      ok: externo?.resultado === 'ok' && horasDesde(externo) < 48,
      em: externo?.criadoEm ?? null,
      bytes: externo?.bytes ?? null,
      destino: externo?.destino ?? null,
      erro: externo?.resultado === 'falha' ? externo.detalhe : null,
    },
    integridade: {
      ok: !!externo?.hash,
      hashParcial: externo?.hash ? `${externo.hash.slice(0, 12)}…` : null,
    },
    restauracaoTestada: {
      ok: restauracao?.resultado === 'ok',
      em: restauracao?.criadoEm ?? null,
      detalhe: restauracao?.detalhe ?? null,
      erro: restauracao?.resultado === 'falha' ? restauracao.detalhe : null,
    },
    eventos: await eventosRecentes(10),
  };
}

/* ---------------------------------------------------------------- alertas (requisito 25) */

/* Alerta de infraestrutura na Minha Fila.
 *
 * DECISÃO QUE PRECISA DE EXPLICAÇÃO: o alerta NÃO é criado em todas as empresas. Falha de backup
 * é assunto de quem OPERA o Jornada360, não de quem o usa — mostrar "backup externo falhou" na
 * fila de um cliente seria expor um problema que ele não pode resolver e que assustaria sem
 * motivo. O alerta vai para a empresa indicada em `JORNADA_TENANT_OPERADOR`; sem essa variável,
 * ele existe apenas no painel de Segurança e Backup.
 *
 * Também NÃO duplica: enquanto o mesmo alerta estiver aberto, ele é atualizado em vez de
 * reaberto — e some sozinho quando a situação normaliza. */
const ALERTAS = {
  backup_externo_falhou: { prioridade: 'critica', descricao: 'Backup externo falhou', recomendacao: 'Conferir credenciais do Backblaze e rodar `npm run backup-externo`.' },
  backup_externo_atrasado: { prioridade: 'alta', descricao: 'Backup externo atrasado (mais de 48h)', recomendacao: 'Rodar `npm run backup-externo` e conferir o agendamento.' },
  restauracao_nao_testada: { prioridade: 'media', descricao: 'Restauração externa nunca testada (ou falhou)', recomendacao: 'Rodar `npm run restaurar-externo` — backup não testado é esperança, não backup.' },
};

export async function sincronizarAlertas(tenantOperador = process.env.JORNADA_TENANT_OPERADOR) {
  if (!tenantOperador) return { criados: 0, resolvidos: 0, motivo: 'JORNADA_TENANT_OPERADOR não definida' };

  const externo = await ultimoEvento('backup_externo');
  const restauracao = await ultimoEvento('restauracao_teste');
  const horas = (e) => (e ? (Date.now() - new Date(e.criadoEm).getTime()) / 3600_000 : Infinity);

  const ativos = new Set();
  if (externo?.resultado === 'falha') ativos.add('backup_externo_falhou');
  else if (externo && horas(externo) > 48) ativos.add('backup_externo_atrasado');
  if (!restauracao || restauracao.resultado === 'falha') ativos.add('restauracao_nao_testada');

  const agora = new Date().toISOString();
  let criados = 0;
  let resolvidos = 0;

  for (const [chave, alerta] of Object.entries(ALERTAS)) {
    const aberta = await consultarUm(
      "SELECT id FROM pendings WHERE tenant_id = ? AND tipo = 'infraestrutura' AND categoria = ? AND resolvida_em IS NULL",
      [tenantOperador, chave],
    );

    if (ativos.has(chave) && !aberta) {
      await executar(
        `INSERT INTO pendings (id, tenant_id, data, tipo, categoria, status, prioridade, origem,
           descricao, evidencias, recomendacao, criada_em, atualizada_em)
         VALUES (?, ?, ?, 'infraestrutura', ?, 'aberta', ?, 'sistema', ?, '[]', ?, ?, ?)`,
        [novoId('pen'), tenantOperador, agora.slice(0, 10), chave, alerta.prioridade,
         alerta.descricao, alerta.recomendacao, agora, agora],
      );
      criados += 1;
    } else if (!ativos.has(chave) && aberta) {
      /* Normalizou: a pendência é RESOLVIDA sozinha. Um alerta que só some quando alguém clica
       * treina a pessoa a ignorar a fila. */
      await executar(
        "UPDATE pendings SET status = 'justificado', resolvida_em = ?, atualizada_em = ?, resolucao = ? WHERE id = ?",
        [agora, agora, 'Situação normalizada automaticamente.', aberta.id],
      );
      resolvidos += 1;
    }
  }

  return { criados, resolvidos, ativos: [...ativos] };
}

/* ---------------------------------------------------------------- agendamento */

/* Backup externo automático, disparado na SUBIDA do processo.
 *
 * POR QUE NA SUBIDA, E NÃO SÓ POR CRONÔMETRO: no plano gratuito o serviço hiberna depois de
 * quinze minutos sem acesso. Um `setInterval` de 12h dorme junto e simplesmente nunca dispara —
 * o backup "automático" existiria só no papel. Já a subida acontece toda vez que alguém abre o
 * sistema, que é exatamente quando há algo novo para copiar.
 *
 * A TRAVA DE INTERVALO é o que impede o excesso: se já existe backup bem-sucedido recente, a
 * subida não gera outro. Sem ela, num dia de uso normal o serviço acorda dezenas de vezes e
 * encheria o bucket com cópias idênticas.
 *
 * Depois do backup, a RESTAURAÇÃO é testada contra o arquivo recém-enviado. Backup que nunca foi
 * restaurado é esperança, não backup — e testar só de vez em quando adia a descoberta de que a
 * cópia não presta para o dia em que ela é a única coisa que resta.
 *
 * Nada aqui derruba o servidor: tudo roda depois de a porta já estar escutando, e as duas funções
 * chamadas devolvem `{ ok: false }` em vez de lançar. */
export function agendarBackupExterno({ intervaloHoras = 12, atrasoInicialMs = 20_000 } = {}) {
  if (!b2.b2Configurado()) {
    log.aviso('backup externo DESLIGADO — variáveis do Backblaze não configuradas');
    return () => {};
  }

  let rodando = false;

  const executar = async (motivo) => {
    if (rodando) return;
    rodando = true;
    try {
      const ultimo = await ultimoEvento('backup_externo');
      const horas = ultimo?.resultado === 'ok'
        ? (Date.now() - new Date(ultimo.criadoEm).getTime()) / 3600_000
        : Infinity;

      if (horas < intervaloHoras) {
        log.info('backup externo ainda recente, pulando', { horasDesdeUltimo: Number(horas.toFixed(1)) });
      } else {
        log.info('backup externo iniciando', { motivo });
        const r = await executarBackupExterno();
        if (r.ok) {
          /* Testa a restauração do arquivo que ACABOU de subir. */
          const t = await testarRestauracaoExterna(r.arquivo);
          log.info('restauração testada', { ok: t.ok, arquivo: r.arquivo });
        }
      }

      await sincronizarAlertas();
    } catch (e) {
      /* Rede indisponível, credencial trocada, bucket removido — nada disso pode derrubar o
       * processo que está atendendo usuários. */
      log.erro('rotina de backup externo falhou', { erro: e.message });
    } finally {
      rodando = false;
    }
  };

  /* O atraso inicial deixa o servidor terminar de subir e responder ao health check antes de
   * gastar CPU com criptografia — num plano gratuito, o orquestrador está esperando resposta. */
  const inicial = setTimeout(() => void executar('subida do processo'), atrasoInicialMs);
  const periodico = setInterval(() => void executar('cronômetro'), intervaloHoras * 3600_000);
  inicial.unref?.();
  periodico.unref?.();

  return () => {
    clearTimeout(inicial);
    clearInterval(periodico);
  };
}
