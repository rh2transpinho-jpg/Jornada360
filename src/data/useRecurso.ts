import { useCallback, useEffect, useRef, useState } from 'react';
import { ErroApi, type TipoErroApi } from '../api/client';

/* Padrão único para carregar qualquer coisa que venha de fora.
 *
 * POR QUE EXISTIR: sem um padrão, cada uma das treze telas inventaria o seu — uma com `loading`,
 * outra com `carregando`, uma tratando erro, outra engolindo. O resultado seria uma interface que
 * se comporta de forma diferente dependendo de onde a pessoa está, e um bug de carregamento
 * precisando ser corrigido treze vezes.
 *
 * DUAS GARANTIAS QUE PARECEM DETALHE E NÃO SÃO:
 *
 * 1. Resposta atrasada de um pedido antigo NUNCA sobrescreve um pedido mais novo. Trocar de
 *    empresa rápido dispararia duas buscas; se a primeira demorasse mais, a tela mostraria os
 *    dados da empresa errada. O contador de geração descarta o que chegou fora de hora.
 *
 * 2. Nada é escrito depois que o componente saiu da tela — evita atualizar estado de algo que não
 *    existe mais. */

export type EstadoRecurso = 'ocioso' | 'carregando' | 'pronto' | 'erro';

export interface Recurso<T> {
  dados: T | null;
  estado: EstadoRecurso;
  erro: ErroApi | null;
  /** true no primeiro carregamento; false nas recargas (que mantêm os dados na tela). */
  primeiraCarga: boolean;
  recarregar: () => Promise<void>;
  /** Atualiza os dados em memória sem ir ao servidor — usado depois de uma gravação bem-sucedida
   *  que já devolveu o registro atualizado, evitando uma segunda ida à rede. */
  definir: (dados: T) => void;
}

export interface OpcoesRecurso {
  /** false adia a busca — útil quando ainda falta a sessão ou a empresa ativa. */
  habilitado?: boolean;
}

export function useRecurso<T>(
  buscar: () => Promise<T>,
  dependencias: unknown[],
  opcoes: OpcoesRecurso = {},
): Recurso<T> {
  const habilitado = opcoes.habilitado !== false;

  const [dados, setDados] = useState<T | null>(null);
  const [estado, setEstado] = useState<EstadoRecurso>(habilitado ? 'carregando' : 'ocioso');
  const [erro, setErro] = useState<ErroApi | null>(null);
  const [jaCarregou, setJaCarregou] = useState(false);

  const geracao = useRef(0);
  const montado = useRef(true);
  useEffect(() => {
    montado.current = true;
    return () => {
      montado.current = false;
    };
  }, []);

  /* `buscar` costuma ser uma função nova a cada render. Guardá-la numa ref e depender apenas das
   * dependências declaradas evita um laço infinito de recarga. */
  const buscarRef = useRef(buscar);
  buscarRef.current = buscar;

  const executar = useCallback(async () => {
    if (!habilitado) return;
    const minha = ++geracao.current;
    setEstado('carregando');
    setErro(null);
    try {
      const r = await buscarRef.current();
      if (!montado.current || minha !== geracao.current) return;
      setDados(r);
      setEstado('pronto');
      setJaCarregou(true);
    } catch (e) {
      if (!montado.current || minha !== geracao.current) return;
      setErro(e instanceof ErroApi ? e : new ErroApi('servidor', 'Não foi possível carregar.'));
      setEstado('erro');
    }
  }, [habilitado]);

  useEffect(() => {
    if (!habilitado) {
      setEstado('ocioso');
      /* O erro precisa sair junto. Ele descreve a última tentativa de buscar; sem empresa ativa
       * não há tentativa nenhuma, e mantê-lo prenderia a pessoa numa tela de erro depois de já ter
       * voltado para a escolha de empresa. */
      setErro(null);
      return;
    }
    void executar();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as dependências são declaradas por quem chama
  }, [habilitado, ...dependencias]);

  const definir = useCallback((novos: T) => {
    setDados(novos);
    setEstado('pronto');
    setJaCarregou(true);
  }, []);

  return { dados, estado, erro, primeiraCarga: estado === 'carregando' && !jaCarregou, recarregar: executar, definir };
}

/* ---------------------------------------------------------------- gravação */

export type EstadoGravacao = 'ocioso' | 'salvando' | 'salvo' | 'erro';

export interface Gravacao {
  estado: EstadoGravacao;
  erro: ErroApi | null;
  /** Tipo do erro, para a tela escolher entre "tente de novo" e "recarregue". */
  tipoErro: TipoErroApi | null;
  executar: <T>(acao: () => Promise<T>) => Promise<T | null>;
  limpar: () => void;
}

/* Contraparte de `useRecurso` para o que ALTERA dado. Existe pelo mesmo motivo: sem ela, "Salvando…",
 * "Salvo" e "Erro ao salvar" seriam escritos de forma diferente em cada formulário.
 *
 * Nada de interface otimista aqui: a tela só passa a mostrar o valor novo depois que o servidor
 * confirmou. Antecipar o sucesso exigiria saber desfazer, e um desfazer silencioso num sistema de
 * auditoria é pior do que meio segundo de espera. */
export function useGravacao(): Gravacao {
  const [estado, setEstado] = useState<EstadoGravacao>('ocioso');
  const [erro, setErro] = useState<ErroApi | null>(null);
  const emVoo = useRef(false);

  const executar = useCallback(async <T,>(acao: () => Promise<T>): Promise<T | null> => {
    /* Trava contra duplo clique: um segundo envio criaria uma empresa/registro duplicado antes de
     * o primeiro terminar. */
    if (emVoo.current) return null;
    emVoo.current = true;
    setEstado('salvando');
    setErro(null);
    try {
      const r = await acao();
      setEstado('salvo');
      return r;
    } catch (e) {
      setErro(e instanceof ErroApi ? e : new ErroApi('servidor', 'Não foi possível salvar.'));
      setEstado('erro');
      return null;
    } finally {
      emVoo.current = false;
    }
  }, []);

  const limpar = useCallback(() => {
    setEstado('ocioso');
    setErro(null);
  }, []);

  return { estado, erro, tipoErro: erro?.tipo ?? null, executar, limpar };
}
