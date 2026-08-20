/* Ponto de entrada do servidor.
 *
 * Responsabilidades, nesta ordem:
 *   1. validar a configuração — e RECUSAR subir se ela for insegura em produção;
 *   2. abrir a porta;
 *   3. agendar o backup automático;
 *   4. encerrar com calma quando o orquestrador mandar parar.
 *
 * A montagem do app continua em `app.js`, para que os testes o instanciem sem abrir socket. */
import { criarApp } from './app.js';
import { caminhoBanco, fecharBanco } from './db/index.js';
import { carregarConfig, exigirConfigValida } from './config.js';
import { agendarBackupAutomatico } from './lib/backup.js';
import { log } from './lib/log.js';
import { carregarEnvLocal } from './lib/env.js';

/* `.env` local (ignorado pelo Git). No Render as variáveis vêm do painel e isto não faz nada. */
carregarEnvLocal();

const config = carregarConfig();

/* Em produção, configuração insegura impede a subida. Ver server/config.js para o porquê. */
exigirConfigValida(config);

const app = criarApp(config);

const servidor = app.listen(config.porta, () => {
  log.info('servidor no ar', {
    porta: config.porta,
    ambiente: config.producao ? 'produção' : 'desenvolvimento',
    banco: caminhoBanco(),
    servindoFrontend: config.servirFrontend,
    urlPublica: config.urlPublica || '(não definida)',
    /* O modo de e-mail aparece no log de subida de propósito: é a informação que explica, meses
     * depois, por que ninguém recebeu o link de recuperação de senha. */
    email: config.email.modo,
  });
});

const pararBackup = agendarBackupAutomatico(config);

/* Encerramento gracioso.
 *
 * Sem isto, `docker stop` ou `systemctl restart` matam o processo no meio de uma requisição: quem
 * estava salvando recebe conexão cortada, e o SQLite pode ficar com o WAL por consolidar. Fechar o
 * servidor primeiro (parar de aceitar), depois o banco, evita os dois.
 *
 * O limite de 10s existe porque um encerramento que nunca termina é pior que um abrupto: o
 * orquestrador acaba matando com SIGKILL de qualquer forma, só que mais tarde. */
let encerrando = false;

function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  log.info('encerrando', { sinal });

  const prazo = setTimeout(() => {
    log.erro('encerramento demorou demais — forçando saída');
    process.exit(1);
  }, 10_000);
  prazo.unref();

  pararBackup();
  servidor.close(() => {
    fecharBanco();
    log.info('encerrado com sucesso');
    process.exit(0);
  });
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

/* Um erro não tratado deixa o processo num estado que ninguém consegue descrever. O certo é
 * registrar e sair: o supervisor (Docker/systemd) reinicia limpo. Continuar rodando "torto" é o
 * que produz corrupção difícil de rastrear. */
process.on('uncaughtException', (e) => {
  log.erro('exceção não capturada — encerrando para o supervisor reiniciar', { erro: e.message, stack: e.stack });
  encerrar('uncaughtException');
});

process.on('unhandledRejection', (e) => {
  log.erro('promessa rejeitada sem tratamento', { erro: e instanceof Error ? e.message : String(e) });
});
