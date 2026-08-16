/* Configuração do servidor, lida do ambiente e VALIDADA.
 *
 * A ideia central deste arquivo: **em produção, uma configuração insegura impede o servidor de
 * subir.** Não avisa no log e continua — recusa.
 *
 * Isso é deliberado e vale explicar. A forma mais comum de um sistema ir para produção inseguro
 * não é alguém decidir isso: é um valor de desenvolvimento sobrando numa variável de ambiente que
 * ninguém conferiu. CORS apontando para localhost, cookie sem `Secure`, banco dentro da pasta do
 * código que o próximo deploy sobrescreve. Nada disso quebra nada — o sistema sobe, funciona, e
 * está errado.
 *
 * Um servidor que se recusa a subir é impossível de ignorar. Um aviso no log é fácil demais. */

const ehProducao = () => process.env.NODE_ENV === 'production';

function lista(valor) {
  return String(valor || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function booleano(valor, padrao = false) {
  if (valor === undefined || valor === '') return padrao;
  return valor === '1' || valor === 'true' || valor === 'sim';
}

export function carregarConfig(env = process.env) {
  const producao = env.NODE_ENV === 'production';

  const config = {
    producao,
    /* Hospedagem gratuita costuma escolher a porta e informá-la em PORT. Aceitar as duas evita
     * um serviço que sobe e nunca recebe requisição por estar ouvindo na porta errada. */
    porta: Number(env.JORNADA_PORT || env.PORT || 3333),
    caminhoBanco: env.JORNADA_DB_PATH || null,

    /* Banco remoto (libSQL/Turso). Quando definido, é ele que vale — e aí não existe arquivo
     * local, nem volume persistente, nem backup por cópia de arquivo. Ver DEPLOY_GRATUITO.md. */
    bancoRemoto: env.JORNADA_DB_URL || null,
    bancoRemotoToken: env.JORNADA_DB_TOKEN || null,

    /* Em produção não existe default: uma lista de origens que "veio de fábrica" é exatamente o
     * tipo de coisa que ninguém revisa. Em desenvolvimento, o Vite local. */
    corsOrigens: lista(env.JORNADA_CORS_ORIGENS) .length
      ? lista(env.JORNADA_CORS_ORIGENS)
      : (producao ? [] : ['http://localhost:5173']),

    cookieSeguro: booleano(env.JORNADA_COOKIE_SEGURO, producao),
    trustProxy: env.JORNADA_TRUST_PROXY || null,

    /* Servir o frontend construído pela própria API é o que mantém página e cookie na mesma
     * origem em produção. Ver DEPLOY.md. */
    servirFrontend: booleano(env.JORNADA_SERVIR_FRONTEND, producao),
    caminhoFrontend: env.JORNADA_FRONTEND_DIST || null,

    /* URL pública do sistema. Usada nos links de e-mail (recuperação de senha, convite) — sem ela
     * um e-mail sairia com link para lugar nenhum. */
    urlPublica: (env.JORNADA_URL_PUBLICA || '').replace(/\/$/, ''),

    /* PROGRAMA PILOTO: com o cadastro fechado, ninguém cria empresa sozinho pela URL pública.
     * As empresas entram por liberação manual (`npm run piloto liberar`) ou por convite.
     *
     * Por que fechado é o padrão em produção: um piloto é um conjunto PEQUENO e ESCOLHIDO de
     * empresas. Com cadastro aberto, qualquer pessoa que encontre o endereço cria uma conta, e o
     * operador perde justamente aquilo que precisa controlar — quem está usando e quantos são.
     * Em desenvolvimento fica aberto, senão não se testa o fluxo de criação. */
    cadastroAberto: booleano(env.JORNADA_CADASTRO_ABERTO, !producao),

    email: {
      /* 'smtp' envia de verdade. 'log' escreve no console — só para desenvolvimento, e o servidor
       * recusa esse modo em produção. Nenhum modo "finge que enviou". */
      modo: env.JORNADA_EMAIL_MODO || (producao ? 'smtp' : 'log'),
      smtpUrl: env.JORNADA_SMTP_URL || '',
      remetente: env.JORNADA_EMAIL_REMETENTE || 'Jornada360 <nao-responda@localhost>',
    },

    backup: {
      diretorio: env.JORNADA_BACKUP_DIR || null,
      manterDias: Number(env.JORNADA_BACKUP_MANTER_DIAS || 14),
      /* Intervalo do backup automático interno. 0 desliga (para quem prefere cron externo). */
      intervaloHoras: Number(env.JORNADA_BACKUP_INTERVALO_HORAS || (producao ? 6 : 0)),
    },
  };

  return config;
}

/* Devolve a lista de problemas. Vazia = pode subir. */
export function validarConfig(config) {
  const problemas = [];

  if (!config.producao) return problemas;

  if (config.corsOrigens.length === 0) {
    problemas.push(
      'JORNADA_CORS_ORIGENS não definida. Em produção é obrigatória: com a sessão em cookie, uma ' +
        'origem errada significa entregar o cookie da vítima ao site errado.',
    );
  }

  for (const origem of config.corsOrigens) {
    if (origem === '*') {
      problemas.push('JORNADA_CORS_ORIGENS contém "*". Com cookie de sessão isso é inaceitável.');
    }
    if (/localhost|127\.0\.0\.1/.test(origem)) {
      problemas.push(`JORNADA_CORS_ORIGENS contém uma origem de desenvolvimento ("${origem}").`);
    }
    if (origem.startsWith('http://')) {
      problemas.push(`JORNADA_CORS_ORIGENS contém origem sem HTTPS ("${origem}").`);
    }
  }

  if (!config.cookieSeguro) {
    problemas.push(
      'JORNADA_COOKIE_SEGURO desligado em produção. Sem o atributo Secure, o cookie de sessão ' +
        'trafega em conexão não criptografada.',
    );
  }

  if (!config.urlPublica) {
    problemas.push(
      'JORNADA_URL_PUBLICA não definida. Os links de recuperação de senha e de convite precisam ' +
        'dela — sem isso o e-mail sai com link quebrado.',
    );
  } else if (!config.urlPublica.startsWith('https://')) {
    problemas.push(`JORNADA_URL_PUBLICA precisa ser HTTPS em produção (recebido: "${config.urlPublica}").`);
  }

  if (config.email.modo === 'log') {
    problemas.push(
      'JORNADA_EMAIL_MODO=log em produção. Esse modo apenas escreve no console: recuperação de ' +
        'senha e convite pareceriam funcionar sem nunca chegar a ninguém. Use "smtp" para enviar ' +
        'de verdade, ou "desativado" para publicar sem e-mail (ver DEPLOY_GRATUITO.md).',
    );
  }

  if (config.email.modo === 'smtp' && !config.email.smtpUrl) {
    problemas.push('JORNADA_SMTP_URL não definida, mas o envio de e-mail está em modo smtp.');
  }

  if (!['smtp', 'log', 'desativado'].includes(config.email.modo)) {
    problemas.push(`JORNADA_EMAIL_MODO desconhecido ("${config.email.modo}"). Use smtp, desativado ou log.`);
  }

  /* PERSISTÊNCIA — duas formas válidas, e nenhuma terceira.
   *
   * (A) banco remoto (JORNADA_DB_URL): os dados vivem fora da máquina que roda o servidor. É o
   *     caminho da hospedagem gratuita, onde o disco é efêmero.
   * (B) arquivo em volume persistente (JORNADA_DB_PATH): o caminho do Docker/VPS.
   *
   * Sem nenhum dos dois, ou com um arquivo dentro da pasta do código, o próximo deploy apaga o
   * banco de todos os clientes — a forma mais silenciosa de perder tudo. */
  if (config.bancoRemoto) {
    if (!/^libsql:|^https:|^wss:|^file:/.test(config.bancoRemoto)) {
      problemas.push(`JORNADA_DB_URL com esquema inesperado ("${config.bancoRemoto}"). Use a URL libsql:// do provedor.`);
    }
    if (config.bancoRemoto.startsWith('file:')) {
      problemas.push(
        'JORNADA_DB_URL aponta para um arquivo local (file:). Em hospedagem sem disco persistente ' +
          'isso some no próximo deploy — use a URL remota do provedor.',
      );
    }
    if (!config.bancoRemotoToken && !config.bancoRemoto.startsWith('file:')) {
      problemas.push('JORNADA_DB_TOKEN não definida. Um banco remoto sem token de acesso não abre.');
    }
  } else if (!config.caminhoBanco) {
    problemas.push(
      'Nenhum banco persistente configurado. Defina JORNADA_DB_URL (banco remoto) ou ' +
        'JORNADA_DB_PATH (arquivo em volume persistente).',
    );
  } else if (/^\.?\/?data\//.test(config.caminhoBanco) || config.caminhoBanco.startsWith('./')) {
    problemas.push(
      `JORNADA_DB_PATH aponta para dentro da pasta do código ("${config.caminhoBanco}"). ` +
        'Um deploy novo apagaria o banco. Use um volume persistente.',
    );
  }

  /* Backup por cópia de arquivo só existe no banco em arquivo. Com banco remoto, a cópia é a
   * exportação (`npm run exportar`) e o histórico do próprio provedor — cobrar um diretório aqui
   * reprovaria uma configuração que está correta. */
  if (!config.bancoRemoto && !config.backup.diretorio) {
    problemas.push('JORNADA_BACKUP_DIR não definida. Sem ela não há backup automático.');
  }

  return problemas;
}

/* Chamado na subida. Em produção, encerra o processo se houver problema. */
export function exigirConfigValida(config, sair = () => process.exit(1)) {
  const problemas = validarConfig(config);
  if (problemas.length === 0) return true;

  console.error('\n[jornada360] O servidor NÃO subiu — configuração de produção inválida:\n');
  for (const p of problemas) console.error(`  ✗ ${p}`);
  console.error('\nVer DEPLOY.md. Corrija as variáveis e suba de novo.\n');
  sair();
  return false;
}

export { ehProducao };
