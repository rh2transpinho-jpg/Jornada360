/* Driver SQLite local — `node:sqlite`, embutido no Node 22+.
 *
 * É o driver da Opção B (Docker/VPS, arquivo em volume persistente) e o único usado pelos testes:
 * um arquivo próprio por suíte, criado e apagado sem depender de rede. Continua sendo o caminho
 * mais rápido e mais simples; a Opção A (Turso) existe porque hospedagem gratuita não oferece
 * disco persistente, não porque este driver tenha algum problema.
 *
 * As funções são `async` mesmo sendo síncronas por dentro. Isso é de propósito: o contrato é o
 * mesmo do driver remoto, e é o que permite trocar de banco sem tocar em nenhum repositório. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* `undefined` não é um valor que o SQLite entenda — vira `null`, que é o que o schema espera nas
 * colunas opcionais. Sem esta normalização, um campo não preenchido derruba a query. */
function args(params) {
  return params.map((v) => (v === undefined ? null : v));
}

export function criarDriverSqlite(caminho) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });

  const db = new DatabaseSync(caminho);
  /* WAL melhora leitura concorrente; foreign_keys precisa ser ligado por conexão no SQLite
   * (não é padrão), senão as chaves estrangeiras do schema seriam decorativas. */
  if (caminho !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const api = {
    modo: 'sqlite',
    caminho,
    /** Conexão crua. Só para quem é inerentemente específico de SQLite (backup por VACUUM INTO). */
    conexao: db,

    async consultar(sql, params = []) {
      return db.prepare(sql).all(...args(params));
    },

    async consultarUm(sql, params = []) {
      return db.prepare(sql).get(...args(params)) ?? null;
    },

    async executar(sql, params = []) {
      const r = db.prepare(sql).run(...args(params));
      return { alteradas: Number(r.changes ?? 0) };
    },

    /** Script com várias instruções — usado só pelas migrations. */
    async executarMultiplos(sql, rotulo = 'script') {
      try {
        db.exec(sql);
      } catch (e) {
        throw new Error(`${rotulo}: ${e.message}`, { cause: e });
      }
    },

    /* Transação real. Existe para que criar uma empresa (tenant + company + regras + integrações
     * + membership) seja tudo-ou-nada: meia empresa gravada é um estado que ninguém conserta pela
     * interface. */
    async emTransacao(fn) {
      db.exec('BEGIN');
      try {
        const r = await fn(api);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    async fechar() {
      db.close();
    },
  };

  return api;
}
