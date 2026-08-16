/* Driver libSQL/Turso — o banco da Opção A (publicação gratuita).
 *
 * POR QUE ELE EXISTE: hospedagem gratuita de Node não oferece disco persistente. Um arquivo SQLite
 * ali viveria até o próximo deploy ou reinício e sumiria com os dados do cliente — o oposto da
 * promessa do piloto. O Turso guarda o banco fora da máquina que roda o servidor, então reiniciar
 * o serviço não perde nada.
 *
 * POR QUE libSQL E NÃO POSTGRES: libSQL é um fork do SQLite e fala o MESMO dialeto. O schema, as
 * migrations e as 84 consultas escritas na Fase 3 continuam valendo letra por letra. Trocar para
 * Postgres exigiria reescrever SQL — exatamente o tipo de reconstrução que esta fase evita.
 *
 * A ÚNICA diferença real de comportamento é que agora existe rede entre o servidor e o banco.
 * É isso que obrigou os repositórios a virarem assíncronos. */
import { createClient } from '@libsql/client';

/* As linhas do libSQL vêm como objetos indexados por nome E por posição. Copiar só as colunas
 * declaradas devolve um objeto limpo, igual ao que o `node:sqlite` entrega — sem isso, qualquer
 * código que faça `Object.entries` numa linha veria os índices numéricos também. */
function linhas(resultado) {
  return resultado.rows.map((linha) => {
    const objeto = {};
    for (const coluna of resultado.columns) objeto[coluna] = linha[coluna];
    return objeto;
  });
}

function args(params) {
  return params.map((v) => (v === undefined ? null : v));
}

export function criarDriverLibsql({ url, token }) {
  const cliente = createClient({ url, authToken: token });

  function api(executor) {
    return {
      modo: 'libsql',
      caminho: url,
      conexao: null,

      async consultar(sql, params = []) {
        return linhas(await executor.execute({ sql, args: args(params) }));
      },

      async consultarUm(sql, params = []) {
        const r = linhas(await executor.execute({ sql, args: args(params) }));
        return r[0] ?? null;
      },

      async executar(sql, params = []) {
        const r = await executor.execute({ sql, args: args(params) });
        return { alteradas: Number(r.rowsAffected ?? 0) };
      },

      async executarMultiplos(sql) {
        await executor.executeMultiple(sql);
      },

      /* Transação interativa de verdade — o libSQL suporta, ao contrário de alguns bancos
       * serverless que só oferecem lote. É o que mantém a criação de empresa tudo-ou-nada.
       *
       * Transação aninhada não abre outra: já estamos dentro de uma, e abrir uma segunda seria
       * erro. Executa no mesmo escopo, que é o comportamento correto. */
      async emTransacao(fn) {
        if (executor !== cliente) return fn(api(executor));

        const tx = await cliente.transaction('write');
        try {
          const r = await fn(api(tx));
          await tx.commit();
          return r;
        } catch (e) {
          await tx.rollback();
          throw e;
        }
      },

      async fechar() {
        cliente.close();
      },
    };
  }

  return api(cliente);
}
