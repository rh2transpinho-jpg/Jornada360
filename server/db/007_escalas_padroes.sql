-- Escalas do dia e Horários Padrão com vigência.
--
-- O PROBLEMA QUE ESTA MIGRATION RESOLVE
-- -------------------------------------
-- Até aqui o "horário padrão" de cada pessoa só existia dentro de uma planilha lida pelo motor,
-- no navegador, sem data de início nem de fim. Duas consequências:
--
--   1. não havia escala POR DIA. Se alguém trabalhava 06:00–17:00 numa terça específica, o
--      sistema continuava comparando o ponto contra o horário habitual (06:00–16:00) e apontava
--      uma hora extra que na verdade estava programada;
--   2. corrigir o horário de alguém reescrevia o passado. A planilha não tem vigência: o valor de
--      hoje passava a valer para julho também, e a análise histórica mudava sozinha.
--
-- A REGRA DE PRECEDÊNCIA QUE ESTAS TABELAS EXISTEM PARA SUSTENTAR
-- ---------------------------------------------------------------
--   1. existe `escalas_dia` para (colaborador, data)  → a referência do dia é a ESCALA;
--   2. senão, o `horarios_padrao` VIGENTE naquela data → a referência é o PADRÃO;
--   3. nenhum dos dois                                 → "referência não encontrada".
--
-- Nunca inventar horário. É por isso que o passo 3 é um estado explícito e não um valor default:
-- comparar ponto contra um horário chutado produz hora extra fictícia.
--
-- SOBRE VIGÊNCIA: `horarios_padrao` guarda LINHAS, não um registro editável no lugar. Corrigir o
-- horário de alguém fecha a vigência anterior e abre uma nova. A análise de julho continua lendo
-- a linha de julho — que é exatamente o que a edição de hoje não pode reescrever.

-- ---------------------------------------------------------------- horário padrão

CREATE TABLE IF NOT EXISTS horarios_padrao (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Mesma identidade da ocorrência de HE: a chave normalizada é o que casa a mesma pessoa entre
  -- importações, e o vínculo com o cadastro é opcional para que um horário importado antes do
  -- cadastro do colaborador não fique órfão.
  colaborador_chave  TEXT NOT NULL,
  colaborador_nome   TEXT NOT NULL,
  colaborador_id     TEXT REFERENCES employees(id) ON DELETE SET NULL,

  -- JSON: string[] de marcações no formato "HH:MM", em ordem. 4 ou 6 posições — o motor já lê até
  -- três pares entrada/saída, e achatar tudo para um par quebraria jornada com dois intervalos.
  marcacoes_json     TEXT NOT NULL DEFAULT '[]',

  -- Carga contratual do dia, em minutos. É o divisor da conta de extra e vem do cadastro, não de
  -- inferência: duas empresas com o mesmo horário podem ter carga diferente.
  carga_prevista_min INTEGER,

  -- Extra habitual derivado: soma dos turnos − carga. MESMA fórmula que o motor já aplicava sobre
  -- a planilha (public/motor-he/index.html), gravada aqui para não recalcular a cada consulta.
  extra_min          INTEGER,

  -- Vigência. `fim` NULL = vigente por prazo indeterminado.
  vigencia_inicio    TEXT NOT NULL,
  vigencia_fim       TEXT,

  status             TEXT NOT NULL DEFAULT 'ativo',   -- ativo | inativo
  observacoes        TEXT NOT NULL DEFAULT '',

  criado_em          TEXT NOT NULL,
  criado_por_nome    TEXT NOT NULL DEFAULT '',
  atualizado_em      TEXT NOT NULL,
  atualizado_por_nome TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_padrao_tenant       ON horarios_padrao(tenant_id);
CREATE INDEX IF NOT EXISTS idx_padrao_tenant_colab ON horarios_padrao(tenant_id, colaborador_chave);
-- A consulta quente é "qual padrão valia para esta pessoa nesta data".
CREATE INDEX IF NOT EXISTS idx_padrao_vigencia     ON horarios_padrao(tenant_id, colaborador_chave, vigencia_inicio);

CREATE TABLE IF NOT EXISTS horarios_padrao_historico (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  padrao_id      TEXT NOT NULL REFERENCES horarios_padrao(id) ON DELETE CASCADE,
  -- criado | alterado | inativado | reativado | vigencia_alterada | substituido
  evento         TEXT NOT NULL,
  usuario        TEXT NOT NULL DEFAULT '',
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  valor_anterior TEXT NOT NULL DEFAULT '',
  valor_novo     TEXT NOT NULL DEFAULT '',
  observacao     TEXT NOT NULL DEFAULT '',
  criado_em      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_padrao_hist_padrao ON horarios_padrao_historico(padrao_id);
CREATE INDEX IF NOT EXISTS idx_padrao_hist_tenant ON horarios_padrao_historico(tenant_id);

-- ---------------------------------------------------------------- importações de escala

-- Criada ANTES de `escalas_dia` porque a escala referencia a importação que a trouxe. A ordem das
-- tabelas neste arquivo é a ordem de dependência — o mesmo cuidado que a restauração exige.
CREATE TABLE IF NOT EXISTS escala_importacoes (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  arquivo         TEXT NOT NULL DEFAULT '',
  formato         TEXT NOT NULL DEFAULT '',   -- xlsx | csv
  total_linhas    INTEGER NOT NULL DEFAULT 0,
  criadas         INTEGER NOT NULL DEFAULT 0,
  atualizadas     INTEGER NOT NULL DEFAULT 0,
  ignoradas       INTEGER NOT NULL DEFAULT 0,
  -- JSON: [{linha, tipo, mensagem}] — os problemas ficam guardados para que a importação possa
  -- ser explicada depois, não só no momento em que a tela estava aberta.
  problemas_json  TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'concluida',
  criado_em       TEXT NOT NULL,
  criado_por_nome TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_escala_import_tenant ON escala_importacoes(tenant_id, criado_em);

-- ---------------------------------------------------------------- escala do dia

CREATE TABLE IF NOT EXISTS escalas_dia (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  colaborador_chave  TEXT NOT NULL,
  colaborador_nome   TEXT NOT NULL,
  colaborador_id     TEXT REFERENCES employees(id) ON DELETE SET NULL,
  data               TEXT NOT NULL,

  -- trabalha | folga | extra | alteracao_horario | ausencia_programada | sem_definicao
  situacao           TEXT NOT NULL DEFAULT 'trabalha',

  marcacoes_json     TEXT NOT NULL DEFAULT '[]',
  carga_prevista_min INTEGER,
  extra_min          INTEGER,

  turno              TEXT NOT NULL DEFAULT '',
  setor              TEXT NOT NULL DEFAULT '',
  unidade            TEXT NOT NULL DEFAULT '',
  observacao         TEXT NOT NULL DEFAULT '',

  origem             TEXT NOT NULL DEFAULT 'manual',  -- importacao | manual
  importacao_id      TEXT REFERENCES escala_importacoes(id) ON DELETE SET NULL,

  criado_em          TEXT NOT NULL,
  criado_por_nome    TEXT NOT NULL DEFAULT '',
  atualizado_em      TEXT NOT NULL,
  atualizado_por_nome TEXT NOT NULL DEFAULT '',

  -- Uma pessoa, um dia, uma empresa: uma escala. Reimportar a mesma data NÃO duplica — e um
  -- segundo horário para a mesma pessoa/data vira conflito visível em vez de linha silenciosa.
  UNIQUE (tenant_id, colaborador_chave, data)
);

CREATE INDEX IF NOT EXISTS idx_escala_tenant      ON escalas_dia(tenant_id);
CREATE INDEX IF NOT EXISTS idx_escala_tenant_data ON escalas_dia(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_escala_tenant_col  ON escalas_dia(tenant_id, colaborador_chave);

CREATE TABLE IF NOT EXISTS escalas_historico (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  escala_id      TEXT NOT NULL REFERENCES escalas_dia(id) ON DELETE CASCADE,
  -- criada | alterada | importada | substituida | removida
  evento         TEXT NOT NULL,
  usuario        TEXT NOT NULL DEFAULT '',
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  valor_anterior TEXT NOT NULL DEFAULT '',
  valor_novo     TEXT NOT NULL DEFAULT '',
  observacao     TEXT NOT NULL DEFAULT '',
  criado_em      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_escala_hist_escala ON escalas_historico(escala_id);
CREATE INDEX IF NOT EXISTS idx_escala_hist_tenant ON escalas_historico(tenant_id);

-- ---------------------------------------------------------------- referência na ocorrência de HE

-- EXPLICABILIDADE: a ocorrência passa a dizer contra QUAL horário o ponto foi comparado. Sem isto,
-- quem abre uma HE de 18 minutos não tem como saber se o sistema usou a escala daquele dia ou o
-- horário habitual — e são justamente essas duas leituras que dão números diferentes.
--
-- Aditivo e com default: ocorrências gravadas antes desta versão continuam válidas, apenas sem
-- referência registrada, e a tela mostra isso como "não registrada" em vez de inventar uma.
ALTER TABLE he_ocorrencias ADD COLUMN referencia_tipo TEXT NOT NULL DEFAULT '';
ALTER TABLE he_ocorrencias ADD COLUMN referencia_id TEXT;
ALTER TABLE he_ocorrencias ADD COLUMN referencia_horarios TEXT NOT NULL DEFAULT '';
ALTER TABLE he_ocorrencias ADD COLUMN referencia_extra_min INTEGER;
