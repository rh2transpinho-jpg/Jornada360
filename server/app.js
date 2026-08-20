/* Montagem da aplicação Express.
 *
 * Separado de `index.js` (que só sobe a porta) para que os testes instanciem o app inteiro em
 * memória, sem abrir socket. É isso que permite testar isolamento entre tenants de verdade,
 * exercitando as rotas reais em vez de simular a resposta delas.
 *
 * EM PRODUÇÃO ESTE APP TAMBÉM SERVE O FRONTEND. Não é conveniência: é o que mantém a página e a
 * API na MESMA ORIGEM, e é a mesma origem que faz o cookie de sessão `HttpOnly` funcionar sem
 * `SameSite=None`. Separar os dois em domínios diferentes obrigaria a voltar ao token em cabeçalho,
 * com a perda de segurança descrita em AUTH.md. */
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth.js';
import { tenantRouter } from './routes/tenant.js';
import { autenticar, resolverTenant, tratarErros } from './middlewares/index.js';
import { garantirMigrado, consultarUm, caminhoBanco, modoBanco } from './db/index.js';
import { carregarConfig } from './config.js';
import { log, registrarRequisicoes } from './lib/log.js';
import { listarBackups } from './lib/backup.js';
import { verificarEmail } from './lib/email.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const INICIADO_EM = Date.now();

function pastaDoFrontend(config) {
  return resolve(config.caminhoFrontend || join(AQUI, '..', 'dist'));
}

export function criarApp(configExterna) {
  const config = configExterna ?? carregarConfig();

  const app = express();

  /* A migração agora é assíncrona (o banco pode estar do outro lado da rede) e `criarApp` não pode
   * esperar por ela. Este middleware segura a PRIMEIRA requisição até o schema existir.
   *
   * Não é detalhe: em hospedagem gratuita o serviço hiberna e acorda já com gente batendo na
   * porta. Sem esta trava, a requisição que acorda o serviço consultaria uma tabela ainda não
   * criada e o cliente veria um erro no exato momento em que o sistema estava subindo. */
  /* `/api/saude` FICA DE FORA desta trava, e isso é o ponto.
   *
   * A saúde existe para dizer se o PROCESSO está vivo, sem tocar no banco — é ela que o Render
   * consulta para decidir se reinicia o serviço. Deixá-la depender da migração inverteu o
   * significado: com o banco inacessível, a saúde passou a responder 500 e o orquestrador
   * concluía que o processo estava morto, quando o processo estava perfeitamente vivo e só o
   * banco não respondia. Descoberto em produção, com todas as rotas em 500 ao mesmo tempo.
   *
   * Quem diz a verdade sobre o banco é `/api/prontidao`, que toca nele de propósito. */
  app.use((req, _res, proximo) => {
    if (req.path === '/api/saude') return proximo();
    garantirMigrado().then(() => proximo(), proximo);
  });

  /* Atrás de um proxy reverso, `req.ip` é o IP do proxy — o que faria o limite de tentativas
   * tratar todo mundo como a mesma pessoa. Só é ligado por configuração explícita: confiar no
   * cabeçalho `X-Forwarded-For` sem proxy na frente permitiria forjar o IP. */
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  /* Não anunciar o framework. Não impede ataque nenhum sozinho, mas não há razão para entregar
   * de graça a informação de qual pilha está rodando. */
  app.disable('x-powered-by');

  app.use(registrarRequisicoes());

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    /* Em produção, instrui o navegador a só falar HTTPS com este domínio pelos próximos 180 dias —
     * inclusive se alguém digitar `http://`. Fora de produção seria um tiro no pé: o navegador
     * passaria a recusar `http://localhost`. */
    if (config.producao) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  /* CORS por lista de origens, com credenciais.
   *
   * Quando a API serve o próprio frontend, a origem é a mesma e o CORS praticamente não é
   * exercitado — ele permanece para o caso de um cliente legítimo em outro domínio. `*` é recusado
   * pela validação de config antes mesmo daqui. */
  app.use(cors({
    origin: config.corsOrigens.length ? config.corsOrigens : false,
    credentials: true,
    exposedHeaders: ['x-versao'],
    allowedHeaders: ['content-type', 'authorization', 'x-jornada-cliente', 'x-versao'],
  }));

  /* Limite de corpo: um dia processado é grande (dezenas de colaboradores com batidas), mas 5 MB é
   * folgado o bastante e impede um envio gigante derrubar o processo. */
  app.use(express.json({ limit: '5mb' }));

  /* ---------------------------------------------------------------- saúde e prontidão */

  /* `/api/saude` — o verificador do orquestrador. Responde rápido, sem tocar no banco, e serve
   * para o Docker/systemd saber se o processo está vivo. */
  app.get('/api/saude', (_req, res) => {
    res.json({ ok: true, versao: 3, tempoNoArSegundos: Math.round((Date.now() - INICIADO_EM) / 1000) });
  });

  /* `/api/prontidao` — o diagnóstico de operação. Toca o banco de verdade e confere o e-mail.
   *
   * Separado da saúde por um motivo prático: se o verificador do orquestrador consultasse o banco
   * a cada poucos segundos, uma lentidão momentânea de disco reiniciaria um processo saudável.
   * Prontidão é para quem está investigando, e para o monitoramento externo.
   *
   * NÃO EXIGE SESSÃO, e por isso não revela nada sobre os dados: devolve se as peças respondem,
   * nunca quantos clientes existem ou quem são. */
  app.get('/api/prontidao', async (_req, res) => {
    const relatorio = { ok: true, verificado_em: new Date().toISOString(), componentes: {} };

    try {
      await consultarUm('SELECT 1 AS ok');
      relatorio.componentes.banco = {
        ok: true,
        modo: modoBanco(),
        caminho: config.producao || modoBanco() === 'libsql' ? '(oculto)' : caminhoBanco(),
      };
    } catch (e) {
      relatorio.ok = false;
      relatorio.componentes.banco = { ok: false, erro: e.message };
    }

    const email = await verificarEmail(config);
    relatorio.componentes.email = email;
    /* E-mail indisponível não derruba o sistema — só impede recuperação de senha e convite.
     * Marcar como não-pronto faria um orquestrador reiniciar o processo sem necessidade. */
    if (!email.ok) relatorio.componentes.email.observacao = 'Recuperação de senha e convites não funcionarão.';

    /* Com o banco remoto não há arquivo local para copiar: o backup de lá é a exportação
     * (`npm run exportar`) mais o point-in-time restore do próprio provedor. Cobrar um backup em
     * disco aqui marcaria como "não pronto" um sistema que está perfeitamente protegido. */
    if (modoBanco() === 'libsql') {
      relatorio.componentes.backup = {
        ok: true,
        modo: 'remoto',
        observacao: 'Banco gerenciado: exportar com `npm run exportar`. Ver DEPLOY_GRATUITO.md.',
      };
    } else if (config.backup.diretorio) {
      const backups = listarBackups(config);
      const ultimo = backups[0];
      const horasDesde = ultimo ? (Date.now() - new Date(ultimo.em).getTime()) / 3600_000 : null;
      /* Um backup velho demais é uma falha operacional silenciosa — o tipo que só aparece no dia
       * em que alguém precisa restaurar. Aqui ele fica visível antes disso. */
      relatorio.componentes.backup = {
        ok: !!ultimo && horasDesde < config.backup.intervaloHoras * 3 + 1,
        quantidade: backups.length,
        ultimoHaHoras: horasDesde === null ? null : Number(horasDesde.toFixed(1)),
      };
      if (!relatorio.componentes.backup.ok) relatorio.ok = false;
    } else {
      relatorio.componentes.backup = { ok: !config.producao, configurado: false };
      if (config.producao) relatorio.ok = false;
    }

    res.status(relatorio.ok ? 200 : 503).json(relatorio);
  });

  /* ---------------------------------------------------------------- API */

  /* Painel de Segurança e Backup (requisito 24). Exige sessão, mas NÃO é por empresa: descreve o
   * SISTEMA. Por isso não devolve nada de nenhum cliente — só carimbos, tamanhos e se cada peça
   * está configurada. Nunca segredo: nem chave, nem keyId, nem URL de banco. */
  app.get('/api/infraestrutura', autenticar, async (_req, res, next) => {
    try {
      const { painelInfraestrutura } = await import('./lib/infraestrutura.js');
      res.json(await painelInfraestrutura(config));
    } catch (e) {
      next(e);
    }
  });

  app.use('/api/auth', authRouter);

  /* A ordem aqui É a segurança: autenticar → resolver tenant (valida membership) → rotas.
   * Nenhuma rota de dados é alcançável sem passar pelos dois. */
  app.use('/api/tenants/:tenantId', autenticar, resolverTenant, tenantRouter);

  /* Qualquer rota /api não atendida é 404 em JSON — nunca cai no HTML do frontend, que faria um
   * cliente receber uma página inteira onde esperava um objeto. */
  app.use('/api', (_req, res) => res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Recurso não encontrado.' }));

  /* ---------------------------------------------------------------- frontend */

  if (config.servirFrontend) {
    const dist = pastaDoFrontend(config);

    if (!existsSync(join(dist, 'index.html'))) {
      /* Subir sem o frontend construído entregaria 404 na página inicial — o cliente veria um erro
       * cru. Melhor falhar aqui, na subida, com a instrução do que fazer. */
      throw new Error(
        `Frontend não encontrado em ${dist}. Rode "npm run build" antes de subir em produção, ` +
          'ou aponte JORNADA_FRONTEND_DIST para a pasta construída.',
      );
    }

    /* Os arquivos com hash no nome (index-a1b2c3.js) podem ser guardados para sempre: um conteúdo
     * novo gera um nome novo. Já o index.html NUNCA pode ser guardado — é ele que aponta para os
     * hashes, e um index.html em cache manteria a pessoa numa versão antiga depois do deploy. */
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, caminho) => {
        if (/-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(caminho)) {
          res.set('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.set('Cache-Control', 'no-cache');
        }
      },
    }));

    /* Rotas do navegador (/entrar, /pendencias, /redefinir-senha…) são resolvidas pelo React
     * Router no cliente. O servidor devolve o index.html para qualquer caminho que não seja
     * arquivo — sem isso, recarregar a página em `/pendencias` daria 404. */
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(join(dist, 'index.html'));
    });

    log.info('servindo o frontend', { pasta: dist });
  }

  app.use((_req, res) => res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Recurso não encontrado.' }));
  app.use(tratarErros);

  return app;
}
