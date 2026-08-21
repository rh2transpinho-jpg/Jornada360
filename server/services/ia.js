/* Camada de IA — opcional por construção.
 *
 * A REGRA ARQUITETURAL DESTA FASE
 * -------------------------------
 *   regra objetiva          → motor determinístico
 *   cálculo                 → backend
 *   classificação previsível→ backend
 *   automação               → backend
 *   explicação / texto      → IA, quando agregar valor
 *
 * Nada essencial passa por aqui. Ponto, escala, horário padrão, HE, divergências, pendências,
 * fila e relatórios numéricos funcionam com este arquivo inteiro fora do ar — e existe teste que
 * prova isso. `disponivel()` é falso quando não há credencial configurada, e todo chamador tem um
 * caminho determinístico para esse caso.
 *
 * POR QUE NÃO HÁ SDK AQUI
 * -----------------------
 * Mesma decisão do Backblaze: `fetch` direto contra a API HTTP. Uma dependência a mais no
 * `package.json` é uma superfície a mais para auditar, e a chamada é uma requisição só.
 *
 * A CHAVE NUNCA É IMPRESSA, nem em erro, nem em log de diagnóstico. */

const MODELO_PADRAO = 'claude-sonnet-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 20_000;

export function configuracao() {
  const chave = process.env.JORNADA_IA_CHAVE ?? '';
  return {
    /* A checagem é de PRESENÇA, não de formato: validar formato aqui só produziria um diagnóstico
     * errado quando o provedor mudar o padrão da chave — foi o que aconteceu com o keyID do B2. */
    configurado: chave.trim().length > 0,
    modelo: process.env.JORNADA_IA_MODELO || MODELO_PADRAO,
    provedor: process.env.JORNADA_IA_PROVEDOR || 'anthropic',
  };
}

export function disponivel() {
  return configuracao().configurado;
}

/* Estado para o painel: diz se o recurso está ligado sem revelar nada sobre a credencial. */
export function estado() {
  const c = configuracao();
  return {
    configurado: c.configurado,
    provedor: c.provedor,
    modelo: c.configurado ? c.modelo : null,
    observacao: c.configurado
      ? 'Recursos de explicação e análise em linguagem natural ativos.'
      : 'Sem credencial de IA configurada. O sistema opera normalmente; apenas os textos gerados usam o modo determinístico.',
  };
}

/* Erro tipado para que o chamador distinga "IA indisponível" (cai no determinístico, sem alarde)
 * de "IA respondeu errado" (vale registrar). */
export class IaIndisponivel extends Error {
  constructor(motivo) {
    super(motivo);
    this.codigo = 'ia_indisponivel';
  }
}

/* Chamada crua. Devolve texto. Lança `IaIndisponivel` em qualquer falha de transporte, credencial
 * ou limite — o chamador NUNCA precisa tratar HTTP. */
export async function completar({ sistema, mensagem, maxTokens = 700, temperatura = 0.2 }) {
  const c = configuracao();
  if (!c.configurado) throw new IaIndisponivel('Sem credencial de IA configurada.');

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controle.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.JORNADA_IA_CHAVE,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: c.modelo,
        max_tokens: maxTokens,
        temperature: temperatura,
        system: sistema,
        messages: [{ role: 'user', content: mensagem }],
      }),
    });

    if (!r.ok) {
      /* Só o código HTTP e o `type` do erro do provedor. Corpo completo pode ecoar o payload
       * enviado, e o payload carrega dado de colaborador. */
      let tipo = '';
      try {
        const corpo = await r.json();
        tipo = corpo?.error?.type ?? '';
      } catch { /* corpo não-JSON: o status já basta */ }
      throw new IaIndisponivel(`Provedor de IA recusou a requisição (HTTP ${r.status}${tipo ? `, ${tipo}` : ''}).`);
    }

    const corpo = await r.json();
    const texto = (corpo?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!texto) throw new IaIndisponivel('O provedor de IA respondeu sem texto.');
    return texto;
  } catch (e) {
    if (e instanceof IaIndisponivel) throw e;
    if (e.name === 'AbortError') throw new IaIndisponivel('O provedor de IA não respondeu no tempo esperado.');
    throw new IaIndisponivel(`Falha ao falar com o provedor de IA: ${e.message}`);
  } finally {
    clearTimeout(relogio);
  }
}

/* ---------------------------------------------------------------- guarda de fatos */

/* Todo horário que aparece num texto. */
export function horariosCitados(texto) {
  return new Set((String(texto).match(/\b\d{1,2}:\d{2}\b/g) ?? []));
}

/* Todo número "solto" que possa ser passado por minuto/quantidade. */
export function numerosCitados(texto) {
  return new Set(
    (String(texto).match(/\b\d+\b/g) ?? []).filter((n) => n.length <= 4),
  );
}

/* A GUARDA QUE TORNA A GERAÇÃO SEGURA.
 *
 * A IA reescreve os fatos em linguagem natural; ela não pode ACRESCENTAR nenhum. Esta função
 * confere que todo horário e toda data no texto gerado já existiam nos fatos estruturados que o
 * sistema calculou. Um horário novo significa alucinação — e um horário alucinado numa mensagem
 * enviada ao colaborador é uma acusação falsa.
 *
 * Reprovar aqui não é erro do usuário: o chamador simplesmente usa o texto determinístico. */
export function textoRespeitaOsFatos(texto, fatosPermitidos) {
  const permitidos = horariosCitados(fatosPermitidos);
  for (const h of horariosCitados(texto)) {
    if (!permitidos.has(h)) return { ok: false, invento: h };
  }

  const datasTexto = String(texto).match(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g) ?? [];
  const datasPermitidas = new Set(String(fatosPermitidos).match(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g) ?? []);
  for (const d of datasTexto) {
    if (!datasPermitidas.has(d)) return { ok: false, invento: d };
  }

  return { ok: true };
}
