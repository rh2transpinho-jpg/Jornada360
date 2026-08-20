/* Backup externo criptografado — Backblaze B2.
 *
 * POR QUE ELE EXISTE, se já há backup interno
 * -------------------------------------------
 * O backup interno protege contra erro humano (apagar uma empresa por engano) e contra corrupção
 * do banco. Não protege contra perder o PROVEDOR: se a conta do Turso sumir, o backup que vive
 * dentro do Turso some junto. Backup externo é a cópia que sobrevive à perda de tudo o mais.
 *
 * O QUE VAI PARA O BACKBLAZE
 * --------------------------
 * Um dump SQL do banco inteiro, CRIPTOGRAFADO antes de sair daqui. O Backblaze nunca recebe dado
 * legível: se o bucket vazar, o atacante leva bytes sem sentido. A chave nunca é enviada junto,
 * nunca aparece em log e nunca entra no Git.
 *
 * AES-256-GCM, e não AES-CBC: GCM é criptografia AUTENTICADA. Ele não só esconde o conteúdo, ele
 * detecta adulteração — descriptografar um arquivo alterado FALHA em vez de devolver lixo que
 * parece dado. Num backup, "falhar alto" é a única resposta aceitável.
 *
 * REDUNDÂNCIA, NÃO DEPENDÊNCIA (requisito 23)
 * -------------------------------------------
 * Se o Backblaze estiver fora do ar, o Jornada360 continua funcionando: o banco responde, os
 * usuários entram, o processamento roda. A falha é registrada e vira alerta — nunca derruba
 * nada. Nenhuma função deste arquivo é chamada no caminho de uma requisição de usuário. */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_IV = 12;   // 96 bits — o recomendado para GCM
const TAMANHO_TAG = 16;  // 128 bits

/* Formato do arquivo cifrado: [IV | authTag | conteúdo].
 * Tudo o que é preciso para decifrar (menos a chave) viaja junto — um backup que depende de
 * metadado guardado em outro lugar é um backup que não se restaura sozinho. */

export function chaveValida(hex) {
  return typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex.trim());
}

export function criptografar(conteudo, chaveHex) {
  if (!chaveValida(chaveHex)) {
    throw new Error('Chave de criptografia inválida: são esperados 64 caracteres hexadecimais (256 bits).');
  }
  const chave = Buffer.from(chaveHex.trim(), 'hex');
  const iv = randomBytes(TAMANHO_IV);
  const cifrador = createCipheriv(ALGORITMO, chave, iv);
  const cifrado = Buffer.concat([cifrador.update(Buffer.from(conteudo, 'utf8')), cifrador.final()]);
  return Buffer.concat([iv, cifrador.getAuthTag(), cifrado]);
}

export function descriptografar(buffer, chaveHex) {
  if (!chaveValida(chaveHex)) {
    throw new Error('Chave de criptografia inválida: são esperados 64 caracteres hexadecimais (256 bits).');
  }
  if (buffer.length < TAMANHO_IV + TAMANHO_TAG) {
    throw new Error('Arquivo cifrado truncado ou corrompido.');
  }
  const chave = Buffer.from(chaveHex.trim(), 'hex');
  const iv = buffer.subarray(0, TAMANHO_IV);
  const tag = buffer.subarray(TAMANHO_IV, TAMANHO_IV + TAMANHO_TAG);
  const cifrado = buffer.subarray(TAMANHO_IV + TAMANHO_TAG);

  const decifrador = createDecipheriv(ALGORITMO, chave, iv);
  decifrador.setAuthTag(tag);
  /* Se o conteúdo foi adulterado, `final()` LANÇA. É a autenticação do GCM em ação: melhor um
   * erro barulhento do que um "backup restaurado" cheio de lixo. */
  return Buffer.concat([decifrador.update(cifrado), decifrador.final()]).toString('utf8');
}

export function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ---------------------------------------------------------------- Backblaze B2 */

/* API nativa do B2 por `fetch`, sem SDK. Uma dependência a menos para auditar e atualizar, e o
 * protocolo é simples: autorizar, pedir uma URL de upload, enviar. */

export function configuracaoB2(env = process.env) {
  return {
    keyId: env.JORNADA_B2_KEY_ID || '',
    appKey: env.JORNADA_B2_APP_KEY || '',
    /* SEM PADRÃO, de propósito. Um nome de bucket "de fábrica" faria o sistema tentar enviar
     * backup para um bucket que talvez não seja seu — e falhar com um erro do Backblaze que não
     * explica que a variável simplesmente não foi preenchida. Sem `JORNADA_B2_BUCKET`, o backup
     * externo se declara não configurado, que é a verdade.
     *
     * Nomes de bucket são globais no Backblaze: o seu provavelmente inclui algo que o torne único. */
    bucket: env.JORNADA_B2_BUCKET || '',
    chave: env.JORNADA_BACKUP_CHAVE || '',
    prefixo: env.JORNADA_B2_PREFIXO || 'jornada360',
  };
}

export function b2Configurado(cfg = configuracaoB2()) {
  return !!(cfg.keyId && cfg.appKey && cfg.bucket && chaveValida(cfg.chave));
}

async function autorizar(cfg) {
  const credencial = Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64');
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { authorization: `Basic ${credencial}` },
  });
  if (!r.ok) {
    /* A mensagem do B2 NÃO é repassada inteira: ela pode ecoar o keyId.
     *
     * O que vai junto é o FORMATO do que foi recebido — comprimentos e presença de espaço. É o
     * que permite descobrir uma colagem truncada ou o campo errado sem que nenhum valor apareça.
     * Um keyID do B2 tem 25 caracteres; uma applicationKey tem 31. Quem cola o "keyName" no
     * lugar do keyID descobre aqui, em vez de num 401 mudo. */
    const forma = (v) => {
      if (!v) return 'VAZIO';
      const limpo = v.trim();
      const aviso = limpo !== v ? ' COM ESPAÇO SOBRANDO' : '';
      return `${limpo.length} caracteres${aviso}`;
    };
    throw new Error(
      `Backblaze recusou a autenticação (HTTP ${r.status}). ` +
      `JORNADA_B2_KEY_ID recebeu ${forma(cfg.keyId)} (o esperado são 25); ` +
      `JORNADA_B2_APP_KEY recebeu ${forma(cfg.appKey)} (o esperado são 31). ` +
      'Se os tamanhos batem, a chave provavelmente foi revogada ou é de outra conta.',
    );
  }
  const dados = await r.json();
  const api = dados.apiInfo?.storageApi ?? dados;
  return {
    token: dados.authorizationToken,
    apiUrl: api.apiUrl,
    downloadUrl: api.downloadUrl,
    /* Uma Application Key restrita a um bucket já vem com o bucketId — é o caminho recomendado,
     * porque a chave não consegue tocar em nenhum outro bucket da conta. */
    bucketId: api.bucketId ?? null,
    bucketName: api.bucketName ?? cfg.bucket,
  };
}

async function resolverBucketId(sessao, cfg) {
  if (sessao.bucketId) return sessao.bucketId;
  const r = await fetch(`${sessao.apiUrl}/b2api/v3/b2_list_buckets?accountId=${encodeURIComponent(sessao.accountId ?? '')}&bucketName=${encodeURIComponent(cfg.bucket)}`, {
    headers: { authorization: sessao.token },
  });
  if (!r.ok) throw new Error(`Não foi possível localizar o bucket "${cfg.bucket}" (HTTP ${r.status}).`);
  const dados = await r.json();
  const bucket = (dados.buckets ?? [])[0];
  if (!bucket) throw new Error(`Bucket "${cfg.bucket}" não encontrado nesta conta.`);
  return bucket.bucketId;
}

export async function enviar(nomeArquivo, conteudoCifrado, cfg = configuracaoB2()) {
  const sessao = await autorizar(cfg);
  const bucketId = await resolverBucketId(sessao, cfg);

  const urlUpload = await fetch(`${sessao.apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${encodeURIComponent(bucketId)}`, {
    headers: { authorization: sessao.token },
  });
  if (!urlUpload.ok) throw new Error(`Backblaze não liberou URL de upload (HTTP ${urlUpload.status}).`);
  const { uploadUrl, authorizationToken } = await urlUpload.json();

  const caminho = `${cfg.prefixo}/${nomeArquivo}`;
  const envio = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(caminho),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(conteudoCifrado.length),
      'X-Bz-Content-Sha1': sha1(conteudoCifrado),
    },
    body: conteudoCifrado,
  });
  if (!envio.ok) throw new Error(`Upload recusado pelo Backblaze (HTTP ${envio.status}).`);

  const info = await envio.json();
  return {
    arquivo: caminho,
    fileId: info.fileId,
    bytes: Number(info.contentLength ?? conteudoCifrado.length),
    /* O SHA-1 é o que o próprio B2 calculou do que RECEBEU. Comparar com o nosso é o que
     * transforma "o upload não deu erro" em "o objeto que está lá é o que eu mandei". */
    sha1Remoto: info.contentSha1,
    sha1Local: sha1(conteudoCifrado),
  };
}

export async function baixar(caminhoArquivo, cfg = configuracaoB2()) {
  const sessao = await autorizar(cfg);
  const url = `${sessao.downloadUrl}/file/${encodeURIComponent(sessao.bucketName || cfg.bucket)}/${caminhoArquivo.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { authorization: sessao.token } });
  if (!r.ok) throw new Error(`Download recusado pelo Backblaze (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

export async function listar(cfg = configuracaoB2(), limite = 20) {
  const sessao = await autorizar(cfg);
  const bucketId = await resolverBucketId(sessao, cfg);
  const r = await fetch(
    `${sessao.apiUrl}/b2api/v3/b2_list_file_names?bucketId=${encodeURIComponent(bucketId)}&prefix=${encodeURIComponent(cfg.prefixo + '/')}&maxFileCount=${limite}`,
    { headers: { authorization: sessao.token } },
  );
  if (!r.ok) throw new Error(`Não foi possível listar o bucket (HTTP ${r.status}).`);
  const dados = await r.json();
  return (dados.files ?? []).map((f) => ({
    arquivo: f.fileName,
    fileId: f.fileId,
    bytes: Number(f.contentLength ?? 0),
    sha1: f.contentSha1,
    em: new Date(Number(f.uploadTimestamp ?? 0)).toISOString(),
  })).sort((a, b) => (a.em < b.em ? 1 : -1));
}

export async function apagar(arquivo, fileId, cfg = configuracaoB2()) {
  const sessao = await autorizar(cfg);
  const r = await fetch(`${sessao.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: 'POST',
    headers: { authorization: sessao.token, 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: arquivo, fileId }),
  });
  if (!r.ok) throw new Error(`Não foi possível remover ${arquivo} (HTTP ${r.status}).`);
  return true;
}
