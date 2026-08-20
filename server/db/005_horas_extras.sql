-- Controle de Horas Extras com justificativa.
--
-- O PROBLEMA QUE ESTA MIGRATION RESOLVE
-- -------------------------------------
-- Até aqui, a análise humana de um dia (setor, causa, justificativa) vivia dentro de
-- `time_records.case_state_json` — o MESMO campo que o motor sobrescreve quando o ponto é
-- reprocessado. Reimportar um mês significava arriscar apagar semanas de justificativa escrita
-- à mão, e ninguém perceberia: o número continuaria lá, só a explicação sumiria.
--
-- A separação é a regra estrutural desta migration:
--
--   `time_records`   = o que o MOTOR calculou. Recalculável, descartável, reprocessável.
--   `he_ocorrencias` = o que uma PESSOA analisou. Nunca é apagado por reprocessamento.
--
-- A ocorrência guarda uma CÓPIA dos números do dia (HE, padrão, jornada) para poder ser
-- consultada e filtrada sozinha, sem reabrir o snapshot. Quando o motor recalcula e o número
-- muda, a cópia é atualizada e a mudança fica REGISTRADA (`recalculada_em`, `he_min_anterior`) —
-- a justificativa continua intacta e a tela avisa que o cálculo mudou depois dela.

-- ---------------------------------------------------------------- ocorrências

CREATE TABLE IF NOT EXISTS he_ocorrencias (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- IDENTIDADE DA OCORRÊNCIA (ver requisito 13).
  -- `colaborador_chave` é o nome normalizado (maiúsculas, sem acento) — é ele que casa a mesma
  -- pessoa entre importações, porque o espelho de ponto nem sempre escreve o nome igual.
  -- `colaborador_id` liga ao cadastro QUANDO existe; a ocorrência não depende disso para existir,
  -- senão um dia importado antes do cadastro do colaborador ficaria sem análise possível.
  colaborador_chave  TEXT NOT NULL,
  colaborador_nome   TEXT NOT NULL,
  colaborador_id     TEXT REFERENCES employees(id) ON DELETE SET NULL,
  data               TEXT NOT NULL,

  -- ---- LADO CALCULADO: espelha o motor, é atualizado a cada reprocessamento
  he_min             INTEGER NOT NULL DEFAULT 0,
  excedente_min      INTEGER NOT NULL DEFAULT 0,
  padrao_min         INTEGER,
  escala_prevista    TEXT NOT NULL DEFAULT '',
  jornada_realizada  TEXT NOT NULL DEFAULT '',
  batidas            TEXT NOT NULL DEFAULT '',
  setor              TEXT NOT NULL DEFAULT '',
  rastreio           TEXT NOT NULL DEFAULT '',
  contexto           TEXT NOT NULL DEFAULT '',

  -- ---- LADO HUMANO: NUNCA é tocado por reprocessamento
  -- pendente | justificada | nao_autorizada | em_analise | abonada
  status             TEXT NOT NULL DEFAULT 'pendente',
  motivo             TEXT,
  justificativa      TEXT,
  origem             TEXT,
  quem_informou      TEXT,
  quem_solicitou     TEXT,
  observacoes        TEXT,
  anexo_nome         TEXT,
  anexo_url          TEXT,
  justificada_em     TEXT,
  responsavel_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  responsavel_nome   TEXT,

  -- ---- RASTRO DO RECÁLCULO (requisito 12)
  criada_em          TEXT NOT NULL,
  atualizada_em      TEXT NOT NULL,
  recalculada_em     TEXT,
  he_min_anterior    INTEGER,

  -- Uma pessoa, um dia, uma empresa: uma ocorrência. É esta restrição que impede a reimportação
  -- de duplicar a mesma HE — o requisito 13 em forma de índice.
  UNIQUE (tenant_id, colaborador_chave, data)
);

CREATE INDEX IF NOT EXISTS idx_he_ocorrencias_tenant       ON he_ocorrencias(tenant_id);
CREATE INDEX IF NOT EXISTS idx_he_ocorrencias_tenant_data  ON he_ocorrencias(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_he_ocorrencias_tenant_stat  ON he_ocorrencias(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_he_ocorrencias_tenant_colab ON he_ocorrencias(tenant_id, colaborador_chave);

-- ---------------------------------------------------------------- histórico da ocorrência

-- Cada mudança relevante vira uma linha. É o que permite responder "qual era a justificativa
-- antes?" e "quem decidiu isso?" — perguntas que a trilha geral de auditoria responde para a
-- empresa inteira, mas que aqui precisam estar ao lado da ocorrência, na tela de detalhe.
CREATE TABLE IF NOT EXISTS he_historico (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ocorrencia_id TEXT NOT NULL REFERENCES he_ocorrencias(id) ON DELETE CASCADE,
  -- identificada | recalculada | justificada | status_alterado | justificativa_alterada
  evento        TEXT NOT NULL,
  usuario       TEXT NOT NULL DEFAULT '',
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  valor_anterior TEXT NOT NULL DEFAULT '',
  valor_novo    TEXT NOT NULL DEFAULT '',
  observacao    TEXT NOT NULL DEFAULT '',
  criado_em     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_he_historico_ocorrencia ON he_historico(ocorrencia_id);
CREATE INDEX IF NOT EXISTS idx_he_historico_tenant     ON he_historico(tenant_id);

-- ---------------------------------------------------------------- listas configuráveis

-- Motivos e origens NÃO ficam fixos no código (requisito 4 e 5): cada empresa ajusta os seus.
-- Guardados como JSON na mesma tabela de regras que já concentra `causa_opts`, para não criar
-- uma segunda tabela de configuração com o mesmo ciclo de vida.
ALTER TABLE workspace_rules ADD COLUMN he_motivos TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspace_rules ADD COLUMN he_origens TEXT NOT NULL DEFAULT '[]';

-- ---------------------------------------------------------------- ligação com a Minha Fila

-- A pendência de "HE sem justificativa" NÃO é uma segunda fonte de verdade (requisito 10): ela
-- aponta para a ocorrência, e é resolvida automaticamente quando a justificativa é registrada.
ALTER TABLE pendings ADD COLUMN he_ocorrencia_id TEXT REFERENCES he_ocorrencias(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_pendings_he_ocorrencia ON pendings(he_ocorrencia_id);
