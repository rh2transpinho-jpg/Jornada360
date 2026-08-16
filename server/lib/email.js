/* Envio de e-mail.
 *
 * DOIS MODOS, E NENHUM DELES FINGE:
 *
 *   'smtp' — envia de verdade, por um servidor SMTP configurado. Se falhar, a falha aparece.
 *   'log'  — escreve o e-mail inteiro no console, incluindo o link. Serve para desenvolver sem
 *            provedor. O servidor RECUSA subir em produção neste modo (ver config.js), porque
 *            "recuperação de senha" que só escreve no console é pior do que não existir.
 *
 * Não existe um terceiro modo que engula silenciosamente. Se o e-mail não puder ser enviado, quem
 * chamou fica sabendo — e a interface diz a verdade para a pessoa.
 *
 * Por que `nodemailer` e não SMTP à mão: falar SMTP corretamente envolve TLS, autenticação,
 * codificação de cabeçalho e caracteres acentuados. Escrever isso à mão para economizar uma
 * dependência madura seria trocar risco por orgulho. */
import nodemailer from 'nodemailer';

let transporte = null;
let modoAtual = null;

function obterTransporte(config) {
  if (transporte && modoAtual === config.email.modo) return transporte;
  modoAtual = config.email.modo;

  if (config.email.modo === 'smtp') {
    /* A URL carrega host, porta, usuário e senha:
     *   smtps://usuario:senha@smtp.provedor.com:465
     * Ela é um SEGREDO — nunca aparece em log, nunca vai para o repositório. */
    transporte = nodemailer.createTransport(config.email.smtpUrl);
  } else {
    transporte = null;
  }
  return transporte;
}

/* Verifica a conexão SMTP sem enviar nada. Usado no diagnóstico (`/api/saude?detalhe=1`) para que
 * um problema de credencial apareça antes de alguém precisar recuperar a senha. */
export async function verificarEmail(config) {
  /* 'desativado' é um estado declarado, não uma falha: o sistema publica sem e-mail e diz isso.
   * O que NÃO é aceitável é fingir que enviou — por isso não existe um modo silencioso. */
  if (config.email.modo === 'desativado') {
    return { ok: true, modo: 'desativado', observacao: 'Sem envio de e-mail: recuperação de senha e convite pedem entrega manual do código.' };
  }
  if (config.email.modo !== 'smtp') return { ok: true, modo: config.email.modo };
  try {
    await obterTransporte(config).verify();
    return { ok: true, modo: 'smtp' };
  } catch (e) {
    return { ok: false, modo: 'smtp', erro: e.message };
  }
}

export async function enviarEmail(config, { para, assunto, texto, html }) {
  /* Recusa explícita: quem chamou recebe `enviado: false` e conta a verdade ao usuário. O código
   * do convite e o link de redefinição continuam aparecendo na tela de quem os gerou. */
  if (config.email.modo === 'desativado') {
    return { enviado: false, modo: 'desativado', erro: 'Envio de e-mail não configurado neste ambiente.' };
  }

  if (config.email.modo === 'log') {
    console.log('\n──────── E-MAIL (modo log — NÃO foi enviado) ────────');
    console.log(`Para:     ${para}`);
    console.log(`Assunto:  ${assunto}`);
    console.log(texto);
    console.log('─────────────────────────────────────────────────────\n');
    return { enviado: false, modo: 'log' };
  }

  await obterTransporte(config).sendMail({
    from: config.email.remetente,
    to: para,
    subject: assunto,
    text: texto,
    html,
  });
  return { enviado: true, modo: 'smtp' };
}

/* ---------------------------------------------------------------- mensagens */

/* HTML mínimo e em texto simples também: cliente de e-mail corporativo costuma bloquear estilo,
 * imagem e fonte externa. Um e-mail que só funciona com CSS carregado é um e-mail que não chega. */
function moldura(titulo, corpo, botao) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f6f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2b23">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<div style="font-weight:700;font-size:15px;letter-spacing:.06em;color:#22a875">JORNADA360</div>
<h1 style="font-size:19px;margin:14px 0 12px">${titulo}</h1>
${corpo}
${botao ? `<p style="margin:24px 0"><a href="${botao.url}" style="display:inline-block;background:#22a875;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${botao.rotulo}</a></p>
<p style="font-size:12px;color:#6b7c72;line-height:1.5">Se o botão não funcionar, copie este endereço:<br><span style="word-break:break-all">${botao.url}</span></p>` : ''}
</div></body></html>`;
}

export function mensagemRecuperacaoSenha({ nome, url, validadeMinutos }) {
  const texto = [
    `Olá, ${nome}.`,
    '',
    'Recebemos um pedido para redefinir a sua senha do Jornada360.',
    '',
    `Abra este endereço para escolher uma senha nova (vale por ${validadeMinutos} minutos):`,
    url,
    '',
    'Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma e nada foi alterado.',
  ].join('\n');

  return {
    assunto: 'Redefinir sua senha do Jornada360',
    texto,
    html: moldura(
      'Redefinir sua senha',
      `<p style="font-size:14px;line-height:1.6">Olá, ${nome}. Recebemos um pedido para redefinir a sua senha.</p>
       <p style="font-size:14px;line-height:1.6">O link vale por <b>${validadeMinutos} minutos</b> e só pode ser usado uma vez.</p>
       <p style="font-size:13px;line-height:1.6;color:#6b7c72">Se não foi você quem pediu, ignore este e-mail: sua senha continua a mesma e nada foi alterado.</p>`,
      { url, rotulo: 'Escolher nova senha' },
    ),
  };
}

export function mensagemConvite({ empresa, papel, url, quemConvidou, validadeDias }) {
  const texto = [
    `${quemConvidou} convidou você para acessar a empresa "${empresa}" no Jornada360.`,
    '',
    `Seu perfil de acesso será: ${papel}.`,
    '',
    `Abra este endereço para aceitar (vale por ${validadeDias} dias):`,
    url,
    '',
    'O convite é pessoal: só funciona para este endereço de e-mail.',
  ].join('\n');

  return {
    assunto: `Convite para acessar ${empresa} no Jornada360`,
    texto,
    html: moldura(
      `Convite para ${empresa}`,
      `<p style="font-size:14px;line-height:1.6"><b>${quemConvidou}</b> convidou você para acessar a empresa <b>${empresa}</b>.</p>
       <p style="font-size:14px;line-height:1.6">Seu perfil de acesso será: <b>${papel}</b>.</p>
       <p style="font-size:13px;line-height:1.6;color:#6b7c72">O convite vale por ${validadeDias} dias e é pessoal — só funciona para este endereço de e-mail.</p>`,
      { url, rotulo: 'Aceitar convite' },
    ),
  };
}
