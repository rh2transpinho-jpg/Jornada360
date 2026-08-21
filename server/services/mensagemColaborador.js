/* Mensagem para o colaborador, construída sobre fatos — nunca sobre suposição.
 *
 * O RISCO QUE ESTE ARQUIVO EXISTE PARA CONTER
 * -------------------------------------------
 * Uma mensagem sobre ponto é uma cobrança. Se o texto disser "seu intervalo foi registrado às
 * 12:27" e o horário estiver errado, a empresa acusou alguém de algo que não aconteceu — e a
 * pessoa vai ter que provar o contrário.
 *
 * Por isso a geração tem dois estágios e uma guarda:
 *
 *   1. `fatosDaOcorrencia()` monta um objeto estruturado a partir do que o motor calculou e do que
 *      está no banco. Nada aqui é inferido;
 *   2. `rascunhoDeterministico()` escreve a mensagem por template. Funciona sempre, sem IA;
 *   3. `gerar()` pode pedir à IA que reescreva o rascunho em linguagem mais natural — e só aceita
 *      a resposta se `textoRespeitaOsFatos` confirmar que ela não introduziu nenhum horário ou
 *      data que não estivesse nos fatos. Reprovou, usa o determinístico.
 *
 * A IA aqui é redator, não apurador. */
import { ROTULO_DIVERGENCIA } from './referenciaJornada.js';
import * as ia from './ia.js';

function dataBr(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? '';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function minutosLegiveis(min) {
  const n = Math.abs(Number(min ?? 0));
  if (!n) return '';
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} minuto${m === 1 ? '' : 's'}`;
  if (!m) return `${h} hora${h === 1 ? '' : 's'}`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/* Os fatos, e só eles. Tudo vem da análise já gravada — nada é recalculado aqui, para que a
 * mensagem não possa discordar da ocorrência que a originou. */
export function fatosDaOcorrencia(analise, divergencia) {
  return {
    colaborador: analise.colaborador,
    data: analise.data,
    dataBr: dataBr(analise.data),
    referencia: analise.referenciaTipo ?? analise.referencia?.tipo,
    referenciaRotulo: analise.rotuloReferencia ?? analise.referencia?.rotulo ?? '',
    horarioPrevisto: analise.referenciaHorarios ?? analise.referencia?.faixa ?? '',
    horarioPadrao: analise.padraoHorarios ?? '',
    pontoRegistrado: analise.pontoMarcacoes ?? '',
    divergencia: {
      tipo: divergencia.tipo,
      rotulo: divergencia.rotulo ?? ROTULO_DIVERGENCIA[divergencia.tipo] ?? divergencia.tipo,
      previsto: divergencia.previsto ?? '',
      realizado: divergencia.realizado ?? '',
      diferencaMin: divergencia.diferencaMin ?? null,
      detalhe: divergencia.detalhe ?? '',
    },
    heMin: analise.heMin ?? 0,
    excedenteMin: analise.excedenteMin ?? 0,
  };
}

/* Serializa os fatos em texto — é contra ESTE texto que a guarda confere o que a IA escreveu. */
export function fatosComoTexto(f) {
  return [
    `Colaborador: ${f.colaborador}`,
    `Data: ${f.dataBr}`,
    `Referência utilizada: ${f.referenciaRotulo}`,
    f.horarioPadrao ? `Horário padrão: ${f.horarioPadrao}` : '',
    f.horarioPrevisto ? `Horário previsto no dia: ${f.horarioPrevisto}` : '',
    f.pontoRegistrado ? `Ponto registrado: ${f.pontoRegistrado}` : '',
    `Divergência: ${f.divergencia.rotulo}`,
    f.divergencia.previsto ? `Previsto: ${f.divergencia.previsto}` : '',
    f.divergencia.realizado ? `Registrado: ${f.divergencia.realizado}` : '',
    f.divergencia.diferencaMin !== null ? `Diferença: ${f.divergencia.diferencaMin} minutos` : '',
    f.divergencia.detalhe ? `Detalhe: ${f.divergencia.detalhe}` : '',
  ].filter(Boolean).join('\n');
}

/* ---------------------------------------------------------------- rascunho determinístico */

/* Frase específica por tipo de divergência. Textos separados porque a pergunta muda: um intervalo
 * atrasado pede conferência de horário; uma hora extra pede justificativa; um dia de folga
 * trabalhado pede confirmação de convocação. Um texto genérico serviria mal a todos. */
const CORPO = {
  intervalo_fora_do_previsto: (f) =>
    `no dia ${f.dataBr} seu intervalo estava previsto para iniciar às ${f.divergencia.previsto}, `
    + `porém o registro foi realizado às ${f.divergencia.realizado}.`,

  intervalo_divergente: (f) =>
    `no dia ${f.dataBr} o intervalo previsto era ${f.divergencia.previsto} e o registrado foi ${f.divergencia.realizado}.`,

  intervalo_insuficiente: (f) =>
    `no dia ${f.dataBr} o intervalo registrado foi de ${f.divergencia.realizado}, abaixo do ${f.divergencia.previsto}.`,

  sem_intervalo: (f) =>
    `no dia ${f.dataBr} não localizamos o registro do intervalo, previsto para ${f.divergencia.previsto}.`,

  entrada_atrasada: (f) =>
    `no dia ${f.dataBr} sua entrada estava prevista para ${f.divergencia.previsto} e foi registrada às ${f.divergencia.realizado}.`,

  entrada_antecipada: (f) =>
    `no dia ${f.dataBr} sua entrada estava prevista para ${f.divergencia.previsto} e foi registrada às ${f.divergencia.realizado}.`,

  saida_antecipada: (f) =>
    `no dia ${f.dataBr} sua saída estava prevista para ${f.divergencia.previsto} e foi registrada às ${f.divergencia.realizado}.`,

  saida_posterior: (f) =>
    `no dia ${f.dataBr} sua saída estava prevista para ${f.divergencia.previsto} e foi registrada às ${f.divergencia.realizado}`
    + `${f.divergencia.diferencaMin ? `, ${minutosLegiveis(f.divergencia.diferencaMin)} depois do previsto` : ''}.`,

  he_potencial: (f) =>
    `no dia ${f.dataBr} identificamos ${minutosLegiveis(f.heMin)} de hora extra`
    + `${f.horarioPrevisto ? `, considerando o horário previsto de ${f.horarioPrevisto}` : ''}.`,

  trabalho_em_folga: (f) =>
    `no dia ${f.dataBr} consta registro de ponto (${f.pontoRegistrado}) em um dia programado como folga.`,

  jornada_incompleta: (f) =>
    `no dia ${f.dataBr} sua jornada consta sem a marcação de saída correspondente (${f.pontoRegistrado}).`,

  registros_incompativeis: (f) =>
    `no dia ${f.dataBr} os registros de ponto (${f.pontoRegistrado}) não fecham em pares de entrada e saída.`,

  escala_sem_ponto: (f) =>
    `no dia ${f.dataBr} havia jornada programada (${f.horarioPrevisto}) e não localizamos registro de ponto.`,

  jornada_diferente: (f) =>
    `no dia ${f.dataBr} a jornada registrada foi diferente da programada (previsto ${f.divergencia.previsto}, registrado ${f.divergencia.realizado}).`,
};

const PEDIDO = {
  he_potencial: 'Poderia, por gentileza, informar o motivo para registrarmos a justificativa?',
  trabalho_em_folga: 'Poderia, por gentileza, confirmar se houve convocação para esse dia?',
  escala_sem_ponto: 'Poderia, por gentileza, verificar e nos informar o ocorrido?',
  jornada_incompleta: 'Poderia, por gentileza, verificar e realizar o ajuste?',
  registros_incompativeis: 'Poderia, por gentileza, verificar e realizar o ajuste?',
};

const PEDIDO_PADRAO = 'Poderia, por gentileza, verificar e realizar o ajuste ou justificar a divergência?';

function saudacao(agora = new Date()) {
  const h = agora.getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function rascunhoDeterministico(f, opcoes = {}) {
  const corpo = CORPO[f.divergencia.tipo];
  const trecho = corpo
    ? corpo(f)
    /* Sem texto específico, descreve pelo rótulo em vez de inventar uma narrativa. */
    : `no dia ${f.dataBr} identificamos a seguinte divergência: ${f.divergencia.rotulo}`
      + `${f.divergencia.previsto ? ` (previsto ${f.divergencia.previsto}` : ''}`
      + `${f.divergencia.realizado ? `, registrado ${f.divergencia.realizado})` : f.divergencia.previsto ? ')' : ''}.`;

  const pedido = PEDIDO[f.divergencia.tipo] ?? PEDIDO_PADRAO;
  return `${opcoes.saudacao ?? saudacao()}, ${trecho} ${pedido}`;
}

/* ---------------------------------------------------------------- geração */

const SISTEMA = `Você reescreve avisos internos de RH sobre registro de ponto, em português do Brasil.

REGRAS ABSOLUTAS:
- Use SOMENTE os fatos fornecidos. Nunca invente, arredonde ou altere horários, datas, durações ou nomes.
- Nunca acrescente motivo, causa ou justificativa: o motivo é justamente o que está sendo perguntado.
- Nunca afirme consequência, advertência, desconto ou penalidade.
- Nunca use tom acusatório. É uma solicitação de verificação, não uma cobrança.
- Mantenha entre 1 e 3 frases, tratamento formal e cordial.
- Devolva apenas o texto da mensagem, sem saudação de assinatura e sem comentários.`;

/* Gera a mensagem. Sempre devolve algo utilizável.
 *
 * `origem` diz qual caminho produziu o texto — a tela mostra isso, porque quem revisa antes de
 * enviar tem o direito de saber se aquilo passou por um modelo de linguagem. */
export async function gerar(analise, divergencia, opcoes = {}) {
  const fatos = fatosDaOcorrencia(analise, divergencia);
  const texto = fatosComoTexto(fatos);
  const deterministico = rascunhoDeterministico(fatos, opcoes);

  if (!ia.disponivel() || opcoes.usarIA === false) {
    return {
      mensagem: deterministico,
      origem: 'deterministica',
      fatos,
      revisaoObrigatoria: true,
      observacao: ia.disponivel()
        ? 'Texto gerado por modelo determinístico.'
        : 'IA não configurada: texto gerado pelo modelo determinístico do sistema.',
    };
  }

  try {
    const gerado = await ia.completar({
      sistema: SISTEMA,
      mensagem: `FATOS APURADOS PELO SISTEMA:\n${texto}\n\nRASCUNHO ATUAL:\n${deterministico}\n\nReescreva o rascunho de forma natural e profissional, sem alterar nenhum fato.`,
      maxTokens: 400,
    });

    /* A guarda. Um horário que não está nos fatos é alucinação, e alucinação aqui vira acusação
     * falsa — o texto determinístico é infinitamente preferível. */
    const veredito = ia.textoRespeitaOsFatos(gerado, texto);
    if (!veredito.ok) {
      return {
        mensagem: deterministico,
        origem: 'deterministica',
        fatos,
        revisaoObrigatoria: true,
        observacao: `A versão gerada por IA foi descartada: citava "${veredito.invento}", que não consta nos fatos apurados.`,
      };
    }

    return {
      mensagem: gerado,
      origem: 'ia',
      fatos,
      revisaoObrigatoria: true,
      observacao: 'Texto redigido por IA a partir dos fatos apurados pelo sistema. Revise antes de enviar.',
    };
  } catch (e) {
    return {
      mensagem: deterministico,
      origem: 'deterministica',
      fatos,
      revisaoObrigatoria: true,
      observacao: `IA indisponível (${e.message}). Texto gerado pelo modelo determinístico.`,
    };
  }
}
