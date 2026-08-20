-- Registro operacional de infraestrutura: backups, integridade, restaurações testadas.
--
-- POR QUE EM TABELA, E NÃO EM ARQUIVO
-- ----------------------------------
-- O disco do Render é efêmero: um arquivo de estado ali é apagado no próximo deploy, e o painel
-- passaria a dizer "nenhum backup" logo depois de um deploy bem-sucedido — a mentira mais
-- perigosa possível num painel de backup. Na tabela, o registro vive onde os dados vivem.
--
-- ESTA TABELA NÃO É DE EMPRESA. Ela descreve o SISTEMA, não um cliente, e por isso não carrega
-- `tenant_id` — é a única exceção à regra do schema, e está anotada aqui de propósito para que
-- ninguém a use como modelo. Nada aqui pode conter dado de empresa: só carimbos, tamanhos,
-- hashes e mensagens de erro. Nunca segredo, nunca conteúdo de backup.

CREATE TABLE IF NOT EXISTS infra_eventos (
  id           TEXT PRIMARY KEY,
  -- backup_interno | backup_externo | restauracao_teste | integridade
  tipo         TEXT NOT NULL,
  -- ok | falha
  resultado    TEXT NOT NULL,
  detalhe      TEXT NOT NULL DEFAULT '',
  bytes        INTEGER,
  -- SHA-256 do conteúdo ANTES de cifrar. É o que permite provar, depois de baixar e decifrar,
  -- que voltou exatamente o que subiu.
  hash         TEXT,
  destino      TEXT NOT NULL DEFAULT '',
  duracao_ms   INTEGER,
  criado_em    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_infra_eventos_tipo ON infra_eventos(tipo, criado_em);
