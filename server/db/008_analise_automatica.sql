-- Análise automática da jornada e fila por exceção.
--
-- O PROBLEMA QUE ESTA MIGRATION RESOLVE
-- -------------------------------------
-- Até aqui o sistema guardava o que o motor calculou (`time_records`) e o que uma pessoa analisou
-- (`he_ocorrencias`), mas não guardava a CONCLUSÃO sobre cada jornada: este dia está certo ou
-- precisa de alguém? Sem isso, toda tela precisava reabrir o snapshot inteiro e reclassificar do
-- zero — e a fila operacional listava as 72 pessoas do dia, não as 14 que exigiam ação.
--
-- `jornada_analises` é a conclusão por (colaborador, dia): qual referência foi usada, o que
-- divergiu, e em que classe isso cai. É o que permite a operação por exceção: quem está OK sai da
-- fila, e quem precisa de atenção chega já explicado.
--
-- A ANÁLISE É DERIVADA, E ISSO É PROPOSITAL
-- -----------------------------------------
-- Nada aqui é fonte de verdade: tudo pode ser recalculado a partir de ponto + escala + padrão.
-- Apagar esta tabela inteira não perde dado de negócio — perde só o cache da conclusão. É por
-- isso que reprocessar pode sobrescrever estas linhas sem cerimônia, ao contrário de
-- `he_ocorrencias`, onde mora a análise humana que nunca pode ser reescrita pelo motor.

CREATE TABLE IF NOT EXISTS jornada_analises (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  colaborador_chave  TEXT NOT NULL,
  colaborador_nome   TEXT NOT NULL,
  colaborador_id     TEXT REFERENCES employees(id) ON DELETE SET NULL,
  data               TEXT NOT NULL,

  -- ---- referência utilizada (explicabilidade)
  -- escala | padrao | nao_encontrada. É a resposta a "contra qual horário isso foi comparado?",
  -- gravada junto da conclusão para que a explicação não dependa de reconsultar o cadastro — que
  -- pode ter mudado depois da análise.
  referencia_tipo      TEXT NOT NULL DEFAULT 'nao_encontrada',
  referencia_id        TEXT,
  referencia_situacao  TEXT NOT NULL DEFAULT '',
  referencia_horarios  TEXT NOT NULL DEFAULT '',
  -- O horário padrão vigente vai junto MESMO quando a escala venceu a precedência: a tela precisa
  -- mostrar os dois lado a lado para explicar por que a escala foi escolhida.
  padrao_horarios      TEXT NOT NULL DEFAULT '',
  carga_prevista_min   INTEGER,
  extra_previsto_min   INTEGER,

  -- ---- realizado
  ponto_marcacoes      TEXT NOT NULL DEFAULT '',
  jornada_realizada_min INTEGER,
  he_min               INTEGER NOT NULL DEFAULT 0,
  excedente_min        INTEGER NOT NULL DEFAULT 0,

  -- ---- conclusão
  -- ok | atencao | critico
  classificacao        TEXT NOT NULL DEFAULT 'ok',
  -- JSON: [{tipo, rotulo, previsto, realizado, diferencaMin, detalhe}]
  divergencias_json    TEXT NOT NULL DEFAULT '[]',
  -- Score de priorização (maior = mais urgente). Número, não texto: a fila ordena por ele.
  prioridade           INTEGER NOT NULL DEFAULT 0,

  analisado_em         TEXT NOT NULL,

  UNIQUE (tenant_id, colaborador_chave, data)
);

CREATE INDEX IF NOT EXISTS idx_analise_tenant       ON jornada_analises(tenant_id);
CREATE INDEX IF NOT EXISTS idx_analise_tenant_data  ON jornada_analises(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_analise_tenant_class ON jornada_analises(tenant_id, classificacao);
CREATE INDEX IF NOT EXISTS idx_analise_tenant_col   ON jornada_analises(tenant_id, colaborador_chave);

-- ---------------------------------------------------------------- fila por exceção

-- A pendência continua sendo a `pendings` que já existia: esta migration só lhe dá o que faltava
-- para virar fila automática.
--
-- `chave_dedupe` é o que impede a duplicação exigida no requisito 5. Um mesmo (colaborador, dia,
-- tipo) gera UMA pendência, reprocessando quantas vezes for. Sem ela, cada reimportação empilharia
-- outra cópia do mesmo problema e a fila cresceria sozinha até ninguém confiar nela.
ALTER TABLE pendings ADD COLUMN analise_id TEXT REFERENCES jornada_analises(id) ON DELETE SET NULL;
ALTER TABLE pendings ADD COLUMN chave_dedupe TEXT;
-- Score numérico. `prioridade` (texto) continua existindo e continua sendo o rótulo mostrado;
-- este é o critério de ordenação, que texto não consegue expressar.
ALTER TABLE pendings ADD COLUMN prioridade_score INTEGER NOT NULL DEFAULT 0;
-- Quem resolveu: pessoa ou sistema. Uma pendência fechada automaticamente porque a escala chegou
-- não pode se confundir com uma que alguém analisou e decidiu.
ALTER TABLE pendings ADD COLUMN resolvida_automaticamente INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pendings_dedupe ON pendings(tenant_id, chave_dedupe)
  WHERE chave_dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pendings_prioridade ON pendings(tenant_id, status, prioridade_score);
CREATE INDEX IF NOT EXISTS idx_pendings_analise ON pendings(analise_id);
