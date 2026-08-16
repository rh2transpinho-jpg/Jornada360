-- Esquema do Jornada360.
--
-- REGRA ESTRUTURAL: toda tabela de dado empresarial carrega `tenant_id`, e toda consulta filtra
-- por ele. Isso não é convenção — é o que sustenta o isolamento entre clientes. Uma tabela nova
-- sem `tenant_id` é um vazamento esperando para acontecer.
--
-- As entidades espelham o domínio que já existia em src/domain/. Nenhuma tabela foi inventada:
-- cada uma corresponde a um tipo que o frontend já usava.

-- `PRAGMA foreign_keys = ON` NÃO mora aqui, e é de propósito.
--
-- Ele é uma configuração de CONEXÃO, não de schema: precisa ser ligado a cada conexão nova, e
-- nunca ficou gravado neste arquivo de qualquer forma. Quem o liga é o driver local, em
-- server/db/driverSqlite.js — e o banco remoto (libSQL/Turso) já aplica as chaves estrangeiras
-- do lado do servidor.
--
-- Estava aqui e quebrava a publicação: sendo a primeira instrução do arquivo, o servidor do Turso
-- respondia HTTP 400 e a migration inteira parava antes de criar a primeira tabela. O caminho
-- local nunca acusou porque o SQLite embutido aceita o PRAGMA sem reclamar.

-- ---------------------------------------------------------------- contas e acesso

-- Uma conta de acesso. Pode pertencer a vários tenants (multi-empresa para o mesmo usuário).
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  nome          TEXT NOT NULL,
  -- Formato: scrypt$N$r$p$salt_hex$hash_hex. Nunca senha em texto puro.
  password_hash TEXT NOT NULL,
  criado_em     TEXT NOT NULL,
  ativo         INTEGER NOT NULL DEFAULT 1
);

-- Um tenant = uma empresa-cliente. É a raiz do isolamento.
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  -- 'real' | 'demo' — o mesmo conceito de `Environment` do frontend.
  environment TEXT NOT NULL DEFAULT 'real',
  criado_em   TEXT NOT NULL
);

-- Vínculo usuário ↔ tenant, com o papel que ele exerce ALI. A mesma pessoa pode ser
-- administradora numa empresa e apenas auditora em outra.
CREATE TABLE IF NOT EXISTS memberships (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  papel      TEXT NOT NULL,
  criado_em  TEXT NOT NULL,
  UNIQUE (user_id, tenant_id)
);

-- Sessão ativa. O token é guardado como HASH: vazar o banco não deve entregar sessões válidas.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL
);

-- ---------------------------------------------------------------- cadastro da empresa

CREATE TABLE IF NOT EXISTS companies (
  tenant_id      TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL DEFAULT '',
  cnpj           TEXT NOT NULL DEFAULT '',
  identificacao  TEXT NOT NULL DEFAULT '',
  logo           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'ativa'
);

CREATE TABLE IF NOT EXISTS units (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  codigo      TEXT NOT NULL DEFAULT '',
  localizacao TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_units_tenant ON units(tenant_id);

CREATE TABLE IF NOT EXISTS departments (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  unidade_id  TEXT REFERENCES units(id) ON DELETE SET NULL,
  responsavel TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_departments_tenant ON departments(tenant_id);

CREATE TABLE IF NOT EXISTS schedules (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome               TEXT NOT NULL,
  horario_inicio     TEXT NOT NULL DEFAULT '',
  horario_fim        TEXT NOT NULL DEFAULT '',
  -- JSON: string[] com os dias. Guardado como texto porque SQLite não tem array e a lista é
  -- sempre lida inteira, nunca consultada por elemento.
  dias_trabalhados   TEXT NOT NULL DEFAULT '[]',
  folgas             TEXT NOT NULL DEFAULT '[]',
  he_programada_min  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);

CREATE TABLE IF NOT EXISTS employees (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  matricula  TEXT NOT NULL DEFAULT '',
  cargo      TEXT NOT NULL DEFAULT '',
  setor_id   TEXT REFERENCES departments(id) ON DELETE SET NULL,
  unidade_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'ativo',
  escala_id  TEXT REFERENCES schedules(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_tenant ON employees(tenant_id);

-- Regras de negócio por empresa. Uma linha por tenant — espelha `domain/Rules.ts`.
CREATE TABLE IF NOT EXISTS workspace_rules (
  tenant_id                TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  tolerance_min            INTEGER NOT NULL,
  daily_goal_min           INTEGER NOT NULL,
  recurrence_limit         INTEGER NOT NULL,
  interval_min_min         INTEGER NOT NULL,
  interjourney_min_hours   INTEGER NOT NULL,
  prazo_padrao_dias        INTEGER NOT NULL,
  alerta_antecedencia_dias INTEGER NOT NULL,
  -- JSON: string[] das causas prováveis configuráveis.
  causa_opts               TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS integration_configs (
  id        TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,
  nome      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'nao_configurado'
);
CREATE INDEX IF NOT EXISTS idx_integrations_tenant ON integration_configs(tenant_id);

-- ---------------------------------------------------------------- dados operacionais

-- Um dia processado pelo motor HE. O snapshot é guardado como JSON no formato EXATO que o motor
-- produz: o backend não interpreta nem recalcula nada dele — só armazena e devolve. É isso que
-- permite o motor continuar intocado.
CREATE TABLE IF NOT EXISTS time_records (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date_key      TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  case_state_json TEXT NOT NULL DEFAULT '{}',
  atualizado_em TEXT NOT NULL,
  UNIQUE (tenant_id, date_key)
);
CREATE INDEX IF NOT EXISTS idx_time_records_tenant ON time_records(tenant_id);

CREATE TABLE IF NOT EXISTS pendings (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  colaborador_id     TEXT,
  data               TEXT NOT NULL,
  tipo               TEXT NOT NULL,
  categoria          TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  prioridade         TEXT NOT NULL,
  origem             TEXT NOT NULL,
  descricao          TEXT NOT NULL DEFAULT '',
  evidencias         TEXT NOT NULL DEFAULT '[]',
  recomendacao       TEXT,
  responsavel_id     TEXT,
  prazo              TEXT,
  criada_em          TEXT NOT NULL,
  atualizada_em      TEXT NOT NULL,
  resolvida_em       TEXT,
  resolucao          TEXT,
  revisado_por       TEXT,
  revisado_em        TEXT,
  observacao_revisao TEXT
);
CREATE INDEX IF NOT EXISTS idx_pendings_tenant ON pendings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pendings_tenant_data ON pendings(tenant_id, data);

-- Trilha de auditoria. Gravada pelo SERVIDOR, a partir da sessão autenticada — o cliente não
-- escolhe quem aparece como autor. É o que torna a trilha confiável, diferente da versão local.
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  usuario        TEXT NOT NULL,
  entidade       TEXT NOT NULL,
  acao           TEXT NOT NULL,
  valor_anterior TEXT NOT NULL DEFAULT '',
  valor_novo     TEXT NOT NULL DEFAULT '',
  motivo         TEXT NOT NULL DEFAULT '',
  timestamp      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id);
