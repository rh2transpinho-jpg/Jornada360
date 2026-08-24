-- Escala operacional: os SERVIÇOS atribuídos a um motorista numa data.
--
-- O ERRO QUE ESTA MIGRATION CORRIGE
-- --------------------------------
-- A migration 007 criou `escalas_dia` com `UNIQUE (tenant_id, colaborador_chave, data)` e eu
-- documentei essa restrição como se fosse uma garantia de qualidade: "uma pessoa, um dia, uma
-- escala". Era o oposto. A escala real da operação tem, em média, 4,3 serviços por motorista por
-- dia — e até 14. A restrição não protegia nada: recusaria 13 das 14 linhas.
--
-- Pior: `escalas_dia.marcacoes_json` era lido como jornada (primeira marcação = entrada, última =
-- saída). Aplicado à escala real, o primeiro serviço às 05:40 e o último às 22:00 virariam uma
-- jornada prevista de 16h20 — e a hora extra verdadeira da pessoa desapareceria dentro dela.
--
-- O QUE MUDA CONCEITUALMENTE
-- -------------------------
--   HORÁRIO PADRÃO   → referência TRABALHISTA (entrada, intervalo, saída, carga, HE)
--   ESCALA OPERACIONAL → o que a pessoa vai OPERAR no dia (contexto, nunca jornada)
--   PONTO            → o que foi efetivamente registrado
--
-- Os horários daqui são OPERACIONAIS. "ENTRADA 07:10" é a viagem que leva os funcionários do
-- cliente para dentro às 07:10 — não é a entrada do motorista, que precisa começar antes para
-- estar posicionado. Comparar esse horário com a batida de ponto compara coisas diferentes.
--
-- POR QUE UMA TABELA NOVA E NÃO UM ALTER
-- -------------------------------------
-- `escalas_dia` continua existindo e não perde uma linha. Ela guarda o que uma PESSOA declarou
-- sobre o dia (folga, ausência programada) — informação explícita, que a planilha operacional não
-- carrega. O que ela deixa de fazer é servir de referência de jornada.

CREATE TABLE IF NOT EXISTS escala_servicos (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  data               TEXT NOT NULL,

  -- ---- identidade do SERVIÇO
  -- EMPRESA + HORÁRIO NÃO IDENTIFICA UM SERVIÇO: a mesma empresa tem várias linhas saindo no
  -- mesmo horário, com motoristas diferentes. A linha/rota precisa participar da chave — é o que
  -- `chave_servico` carrega, normalizada, para que reimportar não duplique nem confunda.
  chave_servico      TEXT NOT NULL,
  seq                TEXT NOT NULL DEFAULT '',
  empresa            TEXT NOT NULL DEFAULT '',
  filial             TEXT NOT NULL DEFAULT '',
  linha              TEXT NOT NULL DEFAULT '',
  descricao          TEXT NOT NULL DEFAULT '',

  -- Horário da coluna HORÁRIO da planilha (saída da garagem / posicionamento).
  horario            TEXT NOT NULL DEFAULT '',
  -- Horário citado DENTRO da descrição, quando existe e difere do anterior. São coisas diferentes
  -- na planilha real (HORÁRIO 17:18 com descrição "(SAÍDA 17:33)") e nenhuma das duas é jornada.
  horario_descricao  TEXT NOT NULL DEFAULT '',
  -- Texto bruto de horário condicional por dia da semana, quando a descrição traz um
  -- ("SAÍDA 18:00/ Sexta 17:00"). Guardado como TEXTO: interpretar isso automaticamente exigiria
  -- uma regra que a planilha não define.
  horario_condicional TEXT NOT NULL DEFAULT '',

  -- entrada | saida | destino | translado | extra | outro — o que a DESCRIÇÃO diz que o serviço é.
  -- É rótulo operacional, não marcação de ponto.
  rotulo             TEXT NOT NULL DEFAULT 'outro',

  projecao_carro     TEXT NOT NULL DEFAULT '',
  -- Terceirizado não bate ponto na empresa; a análise de jornada não se aplica a ele.
  terceirizado       INTEGER NOT NULL DEFAULT 0,

  -- ---- quem opera
  colaborador_chave  TEXT NOT NULL DEFAULT '',
  colaborador_nome   TEXT NOT NULL DEFAULT '',
  colaborador_id     TEXT REFERENCES employees(id) ON DELETE SET NULL,

  origem             TEXT NOT NULL DEFAULT 'importacao',
  importacao_id      TEXT REFERENCES escala_importacoes(id) ON DELETE SET NULL,

  criado_em          TEXT NOT NULL,
  atualizado_em      TEXT NOT NULL,
  atualizado_por_nome TEXT NOT NULL DEFAULT '',

  -- A chave é o SERVIÇO NA DATA, não a pessoa. Reimportar o mesmo arquivo não duplica; reimportar
  -- com outro motorista TROCA o responsável do mesmo serviço, que é o comportamento pedido.
  UNIQUE (tenant_id, data, chave_servico)
);

CREATE INDEX IF NOT EXISTS idx_esvc_tenant_data  ON escala_servicos(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_esvc_tenant_col   ON escala_servicos(tenant_id, colaborador_chave, data);
CREATE INDEX IF NOT EXISTS idx_esvc_tenant_emp   ON escala_servicos(tenant_id, empresa);
CREATE INDEX IF NOT EXISTS idx_esvc_tenant_linha ON escala_servicos(tenant_id, linha);

-- ---------------------------------------------------------------- histórico do serviço

-- Troca de motorista precisa deixar rastro: quem estava, quem passou a estar, e qual importação
-- fez a mudança. Sem isso, "o João sumiu da linha 103" vira investigação em vez de consulta.
CREATE TABLE IF NOT EXISTS escala_servicos_historico (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  servico_id     TEXT NOT NULL REFERENCES escala_servicos(id) ON DELETE CASCADE,
  -- criado | motorista_alterado | dados_alterados | removido
  evento         TEXT NOT NULL,
  usuario        TEXT NOT NULL DEFAULT '',
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  valor_anterior TEXT NOT NULL DEFAULT '',
  valor_novo     TEXT NOT NULL DEFAULT '',
  observacao     TEXT NOT NULL DEFAULT '',
  importacao_id  TEXT REFERENCES escala_importacoes(id) ON DELETE SET NULL,
  criado_em      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_esvc_hist_servico ON escala_servicos_historico(servico_id);
CREATE INDEX IF NOT EXISTS idx_esvc_hist_tenant  ON escala_servicos_historico(tenant_id, criado_em);

-- ---------------------------------------------------------------- referência na análise

-- A análise passa a registrar quantos serviços operacionais a pessoa tinha no dia. É CONTEXTO:
-- entra na explicação da ocorrência, e não no cálculo de jornada nenhum.
ALTER TABLE jornada_analises ADD COLUMN servicos_no_dia INTEGER NOT NULL DEFAULT 0;
