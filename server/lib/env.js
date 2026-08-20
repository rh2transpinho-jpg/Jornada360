/* Carrega variáveis de um `.env` local — sem dependência nova.
 *
 * POR QUE EXISTE: credencial não pode viajar na linha de comando. No PowerShell (e em qualquer
 * shell), o comando inteiro fica no histórico, no scrollback e em qualquer transcrição da sessão.
 * Um token colado num arquivo ignorado pelo Git some do histórico e não aparece em log.
 *
 * POR QUE NÃO `dotenv`: o projeto tem duas dependências de runtime no servidor, de propósito.
 * Um parser de arquivo `CHAVE=valor` cabe em vinte linhas e não precisa ser auditado nem
 * atualizado. O `process.loadEnvFile()` do Node 24 também serviria, mas a precedência dele em
 * relação a variáveis já definidas não é óbvia — e aqui a regra precisa ser explícita.
 *
 * A REGRA: o AMBIENTE REAL SEMPRE VENCE o arquivo.
 *
 * É o que torna seguro chamar esta função em qualquer lugar. No Render as variáveis vêm do painel
 * e não existe `.env` — a função não faz nada. Na sua máquina, o `.env` preenche o que falta. Se
 * um dia os dois existirem, o do servidor prevalece, e nunca acontece de um arquivo esquecido na
 * máquina sobrescrever a configuração de produção. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function carregarEnvLocal(caminho = join(RAIZ, '.env')) {
  if (!existsSync(caminho)) return { carregadas: 0, arquivo: null };

  let carregadas = 0;
  for (const linha of readFileSync(caminho, 'utf8').split('\n')) {
    const texto = linha.trim();
    if (!texto || texto.startsWith('#')) continue;

    const igual = texto.indexOf('=');
    if (igual < 1) continue;

    const chave = texto.slice(0, igual).trim();
    let valor = texto.slice(igual + 1).trim();

    /* Aspas em volta do valor são removidas: quem cola um token costuma trazê-las junto, e um
     * token com aspas no meio é recusado pelo servidor com um erro que não explica nada. */
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }

    if (!valor) continue;
    /* O ambiente real vence. */
    if (process.env[chave] !== undefined && process.env[chave] !== '') continue;

    process.env[chave] = valor;
    carregadas += 1;
  }

  return { carregadas, arquivo: caminho };
}
