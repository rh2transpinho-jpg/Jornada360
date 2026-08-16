# Changelog

Histórico de evolução do Jornada360, por fase. Ver [ROADMAP.md](ROADMAP.md) para o que vem a seguir e [CURRENT_STATE.md](CURRENT_STATE.md) para o snapshot do estado atual.

## Fase 0 — Base funcional (antes da transformação em plataforma)

Sistema React/TS de uma empresa só, com regras fixas no código:

- 11 telas funcionais consumindo `useHEEngineData()`.
- Motor real de HE (`public/motor-he/index.html`) incorporado via iframe, sem alteração.
- Ponte TypeScript (`src/engine/`) portando as funções puras de pós-processamento do motor.
- Constantes fixas no código: tolerância, meta de HE, limite de reincidência, listas de setor/causa, `SETOR_MAP` com ~26 nomes reais de motoristas hardcoded dentro do próprio motor.
- Auditoria só em memória (React state), perdida ao recarregar a página.
- Sem conceito de empresa/workspace — um único conjunto de dados, sem isolamento.

## Fase 1 — Fundação (concluída)

Transformação da base de uma empresa fixa em plataforma configurável e portátil, sem alterar o comportamento das 11 telas já existentes.

**Criado:**
- `src/domain/` — 9 tipos de entidade puros (Company, Unit, Department, Employee, Schedule, Rules, IntegrationConfig, UserAccess, WorkspaceConfig).
- `src/repositories/` — 13 repositórios + `localStorageClient.ts`, contrato estável entre UI e storage.
- `src/services/` — 6 services de domínio (tolerance, overtime, journey, recurrence, score, pendingClassification).
- `src/integrations/` — contrato `IntegrationAdapter` + 4 adapters (1 real, 3 stub).
- `src/workspace/WorkspaceContext.tsx` — provider de workspace ativo + seletor Real/Demo.
- `src/demo/seedDemo.ts` — gerador determinístico de dataset fictício (5 colaboradores, 12 dias).
- `src/pages/settings/` — 8 sub-telas de Configurações (Empresa, Unidades, Setores, Colaboradores, Escalas, Regras, Integrações, Usuários).
- 7 arquivos de documentação na raiz (README, ARCHITECTURE, BUSINESS_RULES, CONFIGURATION, DEMO, ROADMAP, INTEGRATIONS).

**Alterado:**
- `src/engine/heEngineBridge.ts` — passou a aceitar `workspaceId`, namespaceando toda leitura/escrita.
- `src/engine/heEngineCore.ts` — `reclassificar()` passou a receber a tolerância como parâmetro em vez de constante fixa.
- `src/engine/useHEEngineData.ts` — passou a consumir repositórios em vez de chamar `heEngineBridge` diretamente.
- `src/pages/MotorHE.tsx` — passou a montar o `src` do iframe com `?ws={workspaceId}`.
- `src/components/layout/Topbar.tsx` — seletor 🟢 Real / 🟣 Demo adicionado.
- `src/App.tsx` — envolvido com `WorkspaceProvider`.

**Duas alterações deliberadas em `public/motor-he/index.html`** (arquivo de produção de terceiro, tratado como imutável fora do estritamente necessário — cada mudança verificada por `diff` contra o original):
1. `LS_PREFIX` passou a incluir o workspace ativo, lido de `?ws=` na querystring.
2. `SETOR_MAP` (~26 nomes reais de motoristas hardcoded) esvaziado.

**Auditoria pós-Fase 1** encontrou repositórios e services criados sem consumidor real na UI — motivou a Fase 1.1.

## Fase 1.1 — Consolidação da fundação (concluída)

Religou toda a estrutura criada na Fase 1 que ainda não tinha uso real, sem inventar uso artificial onde não fazia sentido.

**Alterado:**
- `EmpresaTab`/`UnidadesTab`/`SetoresTab`/`ColaboradoresTab`/`EscalasTab` — passaram a chamar cada um seu repositório dedicado (`CompanyRepository`/`UnitRepository`/`DepartmentRepository`/`EmployeeRepository`/`ScheduleRepository`) em vez de um `atualizarWorkspace()` genérico.
- `overtimeService.ts` — ganhou `calcularHoraExtraDoDia()`, religado na ficha de pendência via `OvertimeRepository`.
- `useHEEngineData.marcarCampo` — passou a rotear por `PendingRepository`, única porta de entrada pra editar/resolver uma pendência.
- `src/domain/WorkspaceConfig.ts` — campo `setorOpts` **removido**; opções de setor passaram a ser derivadas de `DepartmentRepository.listNomes()` (fonte única, sem duplicação).
- `workspace.causaOpts` — virou campo configurável de verdade (antes só existia dentro do seed demo), editável em Configurações → Regras.
- `public/motor-he/index.html` — **terceira alteração deliberada**: `SETOR_OPTS`/`CAUSA_OPTS` deixaram de ser lista fixa interna e passaram a ler `?setores=`/`?causas=` da querystring (com fallback `['Outro']`).
- `src/pages/MotorHE.tsx` — passou a montar `?setores=`/`?causas=` a partir de `DepartmentRepository`/`workspace.causaOpts`; corrigido bug de dupla codificação (`encodeURIComponent` manual + `URLSearchParams` codificando de novo, quebrava valores com `%`).
- `src/domain/WorkspaceConfig.novoWorkspace()` — defaults deixaram de herdar valores da operação atual: `dailyGoalMin` nasce em `0`, `causaOpts` nasce genérico, escalas nascem sem horário preenchido.
- `src/components/layout/Sidebar.tsx` — rodapé com data fixa (`"11/08/2026 · SEG"`) trocado por `dataRodape()`, calculada a partir de `new Date()`.
- `src/demo/seedDemo.ts` — ganhou `enriquecerConfigDemo()` (aplica setores/causas/meta de exemplo só ao workspace `demo`, só se ele ainda não tiver setor cadastrado); âncora de data trocada de fixa (`2026-08-11`) para `new Date()` real, então o Demo sempre mostra os últimos 12 dias a partir de hoje.

**Analisado e deixado como preparação explícita (não código esquecido):**
- `journeyService.ts` — funções prontas (`interjornadaCritica`, `intervaloIrregular`), zero consumidor. Decisão: não inventar uso artificial. Documentado em BUSINESS_RULES.md.
- `IntegrationRepository`, `ReportRepository`, `ScoreRepository` — mantidos como contratos para Fase 2/3, zero consumidor.

**Avaliado e decidido não migrar:**
- Estratégia de storage `jornada360:workspaces` (uma chave, array de todos os workspaces) vs. `assistente_he_local_{workspaceId}_...` (uma chave por dia por workspace) — avaliada, documentada em ARCHITECTURE.md, decisão consciente de manter como está (sem ganho real, risco de perda de config já configurada sem passo de migração).

**Verificado ao vivo:** `tsc -b`/`build` limpos, isolamento Real/Demo, reclassificação instantânea ao mudar tolerância, persistência de auditoria após reload, `diff` do motor confirmando só as alterações documentadas.

## Fase 2 — Inteligência operacional (em andamento)

### Etapa 1 — Taxonomia de status unificada (concluída)

Introduz um único conceito de status de ocorrência (`Normal`/`Atenção`/`Divergência`/`Pendente`/`Justificado`/`Aprovado`/`Reprovado`), derivado — não recalculado — do que o motor real e o `toleranceService` já produzem.

**Criado:**
- `src/domain/Pendencia.ts` — tipo `StatusPendencia` + `STATUS_PENDENCIA_LABEL`.

**Alterado:**
- `src/domain/index.ts` — export do novo módulo.
- `src/services/pendingClassificationService.ts` — nova função `statusDoCaso(item)`, regra de derivação documentada inline e em [BUSINESS_RULES.md](BUSINESS_RULES.md#taxonomia-de-status-unificada-fase-2-etapa-1).
- `src/components/ui/Badges.tsx` — novo `StatusPendenciaBadge`.
- `src/components/he/RealPendenciasSection.tsx` — coluna "Status" na tabela e linha "Status" no modal de detalhe, ambos consumindo `statusDoCaso()` (a tela não interpreta os campos brutos por conta própria).

**Não alterado (deliberado):** `public/motor-he/index.html`, `heEngineCore.ts`, `heEngineBridge.ts`, `PendingRepository`, `TimeRecordRepository` — nenhuma lógica de cálculo foi duplicada ou movida; `Aprovado`/`Reprovado` existem no tipo mas não têm produtor (documentado como limitação, não implementado por falta de campo de decisão de revisão em `HECaseState`).

**Verificado:** `tsc -b` e `npm run build` limpos; testado ao vivo no Demo (Divergência para casos não resolvidos, Justificado para casos resolvidos com `done:true`); Real permanece vazio e não afetado pela navegação no Demo.

### Etapa 2 — Pendência como entidade real (concluída)

Transforma "pendência" de um conceito derivado em tempo real numa entidade persistida e rastreável, independente da estrutura temporária do motor.

**Criado:**
- `src/services/pendenciaService.ts` — `sincronizarPendencias` (materializa a entidade a partir dos casos do motor, idempotente por id determinístico), `listarPendenciasPersistidas`, `buscarPendencia`, `atualizarPrioridade`, `idDaPendencia`.

**Alterado:**
- `src/domain/Pendencia.ts` — `Pendencia` (entidade completa: id/workspaceId/colaboradorId/data/tipo/categoria/status/prioridade/origem/descricao/evidencias/recomendacao/responsavelId/prazo/criadaEm/atualizadaEm/resolvidaEm/resolucao), `Prioridade` (baixa/média/alta/crítica, neutra='media'), `OrigemPendencia` (união de 1 valor: `'motor_he'`).
- `src/repositories/PendingRepository.ts` — `criarPendencia`/`buscarPendencia`/`listarPorWorkspace`/`atualizarPendencia`/`resolverPendencia`, storage próprio (`jornada360:{workspaceId}:pendencias`, via `localStorageClient`). Métodos legados (`updateCampo`/`resolve`, sobre `HECaseState`) mantidos sem alteração — documentado no cabeçalho do arquivo a distinção entre os dois.
- `src/components/he/RealPendenciasSection.tsx` — `useEffect` sincroniza a Pendencia sempre que `dias` muda; coluna "Prioridade" na tabela e seletor de prioridade no modal, lendo/escrevendo via `pendenciaService` (não via `marcarCampo`/HECaseState); mudança de prioridade registra auditoria própria.

**Não alterado (deliberado):** `public/motor-he/index.html`, `heEngineCore.ts`, `heEngineBridge.ts`, `pendingClassificationService.statusDoCaso` (reaproveitado, não duplicado), fluxo existente de setor/causa/justificativa (`marcarCampo`, inalterado).

**Migração:** nenhuma migração retroativa em massa foi feita — a materialização é incremental, disparada pela própria tela ao carregar os dias já processados. Decisão explícita (ver BUSINESS_RULES.md): evita criar um volume grande de entidades de uma vez sem uma ação do usuário por trás.

**Verificado:** `tsc -b` e `npm run build` limpos; testado ao vivo no Demo — sincronização automática criou 5 entidades (2 abertas + 3 já resolvidas), prioridade alterada e confirmada persistente após reload, "Marcar resolvido" transicionou a entidade pra `status: 'justificado'` com `resolvidaEm` setado, auditoria registrou a resolução do caso e a troca de prioridade. Real confirmado sem nenhuma entidade (`jornada360:real:pendencias` permanece `null`) mesmo após uso extensivo do Demo.

### Etapa 3 — Centro de Ações / Fila operacional (concluída)

Primeira versão de uma fila operacional de triagem sobre a entidade Pendencia — não um segundo sistema de pendências.

**Criado:**
- `src/pages/CentroAcoes.tsx` (rota `/centro-de-acoes`) — resumo (4 cards), filtros (status/prioridade/data/colaborador), fila aberta + seção de resolvidas separada, prioridade editável inline.

**Alterado:**
- `src/services/pendenciaService.ts` — `estadoResolvido` exportado (reaproveitado, não duplicado), `ordenarPendencias` (crítica→alta→média→baixa, empate por data mais antiga), `resumoPendencias` (contagens sobre a lista completa do workspace).
- `src/components/ui/Badges.tsx` — `PrioridadeBadge` (cores por urgência).
- `src/components/he/RealPendenciasSection.tsx` — passou a ler `?abrir=<id>` da URL e auto-abrir o caso correspondente (deep-link do Centro de Ações); coluna de Prioridade passou a usar `PrioridadeBadge` em vez de texto simples.
- `src/App.tsx`, `src/components/layout/Sidebar.tsx` — nova rota e item de navegação.

**Não alterado (deliberado):** motor HE, `heEngineCore.ts`, `heEngineBridge.ts`; nenhum mecanismo novo de resolução (continua só em `/pendencias`); nenhuma infraestrutura nova de auditoria (reaproveita `AuditRepository`/`registrarAuditoria`).

**Decisões de escopo:** filtro por colaborador implementado via cruzamento com dado ao vivo do motor (não via `colaboradorId`, best-effort demais); filtro por tipo/origem e colunas de prazo/responsável **não** implementados — sem dado real que os sustente ainda (documentado em BUSINESS_RULES.md, não inventado).

**Verificado:** `tsc -b` e `npm run build` limpos; testado ao vivo no Demo — resumo/filtros corretos, deep-link abriu o caso certo em `/pendencias`, prioridade alterada inline refletiu nos cards e na fila, "Marcar resolvido" moveu o caso pra seção "Resolvidas" automaticamente, tudo persistente após reload. Real confirmado com zero pendências mesmo após uso extensivo do Demo (troca Demo→Real→Demo repetida). Auditoria registrou a alteração de prioridade feita a partir do Centro de Ações, com rótulo distinto da mesma ação feita em `/pendencias`.

### Etapa 4 — Explicabilidade da Pendência / "Por que isso apareceu?" (concluída)

Bloco de explicação transparente e auditável no detalhe da Pendência — sem IA, sem recalcular divergência, sem inventar dado ausente.

**Criado:**
- `src/services/pendingExplanationService.ts` — `explicarPendencia(workspaceId, dateKey, pendencia, item, toleranceMin)`, reaproveita `overtimeService.calcularHoraExtraDoDia` e `pendingClassificationService.statusDoCaso` (nenhum recálculo próprio); retorna `{motivo, dadosConsiderados, regraAplicada, resultado, evidencias, origem}`, com `valor: null` explícito pra todo dado ausente.

**Alterado:**
- `src/components/he/RealPendenciasSection.tsx` — bloco expansível "Por que isso apareceu?" no modal de detalhe, renderizando a explicação; campos ausentes mostram "Não disponível" na interface (nunca um valor calculado no lugar).

**Não alterado (deliberado):** motor HE, `heEngineCore.ts`, `heEngineBridge.ts`; nenhuma nova infraestrutura de auditoria (o bloco só exibe); Centro de Ações não ganhou uma segunda tela de explicação — reaproveita o mesmo modal via deep-link já existente (Etapa 3).

**Cuidado específico:** `overtimeService.calcularHoraExtra` retorna `heProgramadaMin: item.padraoMin ?? 0` — zera silenciosamente quando não há padrão. O service de explicação **não usa esse valor diretamente** pra decidir "há padrão" — checa `item.padraoMin === null` primeiro, senão mostraria `00:00` (valor inventado) em vez de "Não disponível" quando o padrão realmente não existe.

**Verificado:** `tsc -b` e `npm run build` limpos. Testado ao vivo no Demo com os 5 casos exigidos — incluindo 2 casos sintéticos injetados temporariamente via `localStorage` (um sem padrão cadastrado, outro com padrão mas sem dado de rastreio) pra cobrir cenários que não ocorrem naturalmente no dataset gerado por `seedDemo.ts`; removidos após o teste. Real confirmado sem nenhuma explicação/dado vazado do Demo.

### Etapa 5 — Priorização Operacional (concluída)

Evolui a prioridade de escolha puramente manual para uma recomendação determinística, explicável e nunca-silenciosa, baseada só em sinais reais já existentes no sistema.

**Criado:**
- `src/services/priorizacaoService.ts` — `recomendarPrioridade(pendencia, item, dias, recurrenceLimit)`: reaproveita `heAggregations.agregarPorMotorista` (reincidência) e `pendenciaService.estadoResolvido`; nunca recalcula status/HE/tolerância; retorna `null` para pendências resolvidas.

**Alterado:**
- `src/components/he/RealPendenciasSection.tsx` — bloco "Recomendação do sistema" no modal (badge + motivo + botão "Aplicar" quando difere da prioridade efetiva); `mudarPrioridade` ganhou um parâmetro de origem pra distinguir auditoria manual de auditoria "aplicar recomendação".
- `src/pages/CentroAcoes.tsx` — nota inline "Sistema sugere: X" sob o seletor de prioridade de cada linha, só quando a recomendação difere da efetiva (motivo disponível via `title`/tooltip).

**Não alterado (deliberado):** motor HE; `Pendencia` (nenhum campo novo — decisão explícita de computar a recomendação sob demanda em vez de persistir, ver BUSINESS_RULES.md); nenhuma infraestrutura nova de auditoria (reaproveita `registrarAuditoria`, só na ação "Aplicar", nunca ao só exibir a recomendação); `Prioridade`/`workspace.rules.recurrenceLimit` (parâmetro já existia, já configurável por workspace desde a Fase 1 — nenhum campo de configuração novo foi criado).

**Sinais avaliados e descartados (documentados, não inventados):** magnitude do excedente em minutos e idade da pendência — o dado existe, mas não há limiar configurado nas regras de negócio; "quantidade de ocorrências" foi absorvida pela métrica de reincidência já existente, em vez de duplicada.

**Verificado:** `tsc -b` e `npm run build` limpos. Testado ao vivo no Demo: recomendação "Alta" correta para uma divergência simples de Juliana Costa (caso reaberto temporariamente para o teste); boost de reincidência confirmado reduzindo `recurrenceLimit` de 5 para 2 (Juliana tinha 3 dias acima do padrão) — recomendação subiu para "Crítica" com o motivo citando o número exato de dias e o limite configurado; prioridade manual definida como "Baixa" nunca foi sobrescrita pela recomendação "Alta"/"Crítica" (botão "Aplicar" precisou ser clicado explicitamente); auditoria registrou só a ação de aplicar, com rótulo distinto do ajuste manual livre e o motivo da recomendação como motivo do evento. `recurrenceLimit` e o caso de teste foram restaurados ao estado original após o teste. Real confirmado com `recurrenceLimit` (5) e pendências totalmente independentes do Demo durante todo o teste.

## Bloco 1 — Operação (Etapas 6, 7 e 8) — concluído

Primeiro bloco executado sem parada entre etapas (nova estratégia de trabalho: cada etapa interna manteve análise/tsc/build/teste/isolamento/documentação próprios, mas a aprovação passou a ser por bloco). Fecha o ciclo operacional completo da Pendência.

### Etapa 6 — Responsável + prazo

**Alterado:**
- `src/domain/Rules.ts` — novos campos configuráveis `prazoPadraoDias` (default 3) e `alertaAntecedenciaDias` (default 1), ambos neutros.
- `src/domain/Pendencia.ts` — `responsavelId`/`prazo` deixaram de ser "sempre null"; novos `revisadoPor`/`revisadoEm`/`observacaoRevisao` (usados na Etapa 8).
- `src/repositories/WorkspaceRepository.ts` — `listAll()` espalha `regrasPadrao()` antes de `w.rules`: workspaces salvos antes dos campos novos existirem ganham o default na leitura, sem sobrescrever o que já estava configurado.
- `src/services/pendenciaService.ts` — `atualizarResponsavel`, `atualizarPrazo`, `sugerirPrazo` (sugestão apenas, nunca aplicada sozinha).
- `src/components/he/RealPendenciasSection.tsx` — seletor de responsável (lista de `workspace.users`) e campo de prazo na ficha, com auditoria em cada alteração.
- `src/pages/settings/RegrasTab.tsx` — os dois parâmetros novos, editáveis por workspace.
- `src/pages/CentroAcoes.tsx` — coluna "Responsável" e filtro por responsável.

### Etapa 7 — SLA / acompanhamento

**Criado:**
- `src/services/slaService.ts` — `calcularEstadoSla` (6 estados) e `diasDeAtraso`, puros, sem recalcular nada do motor.

**Alterado:**
- `src/components/ui/Badges.tsx` — `EstadoSlaBadge`.
- `src/services/pendingExplanationService.ts` — campo `notaPrazo` (só quando o prazo é relevante; `null` caso contrário), mais responsável/prazo/estado do SLA/revisão nos "dados considerados". Mesma função de explicação, sem criar uma segunda.
- `src/pages/CentroAcoes.tsx` — coluna "SLA" e card de resumo "Vencidas".
- `src/components/he/RealPendenciasSection.tsx` — badge de SLA ao lado do prazo, nota de prazo dentro do bloco "Por que isso apareceu?".

### Etapa 8 — Aprovação / reprovação

**Alterado:**
- `src/repositories/PendingRepository.ts` — `revisarPendencia` (grava decisão + quem + quando + observação, sem tocar em `resolvidaEm`/`resolucao`).
- `src/services/pendenciaService.ts` — `aprovarPendencia`, `reprovarPendencia`, `reabrirRevisao`, e a proteção `statusAlvoSincronizacao`: sem ela, toda sincronização reclassificaria um caso revisado de volta pra `justificado` (porque `item._done` continua `true`), apagando a decisão humana.
- `src/components/he/RealPendenciasSection.tsx` — bloco de revisão (só aparece com status `justificado`), bloco de revisão registrada, botão "Reabrir para novo tratamento" (só para `reprovado`); a tabela e a ficha passaram a exibir o status **persistido** da entidade, não o calculado ao vivo (só o persistido reflete aprovado/reprovado).

**Correção encontrada durante o teste manual:** ao reabrir uma pendência, `resolvidaEm`/`resolucao` continuavam preenchidos — a ficha dizia "resolvido em X" num caso aberto, e o SLA o classificava como já resolvido. `pendenciaService.materializarCaso` agora limpa os dois quando o status volta de resolvido para aberto; `prazo` e `responsavelId` são preservados (o trabalho continua atribuído).

**Não alterado em todo o bloco (deliberado):** `public/motor-he/index.html`, `heEngineCore.ts`, `heEngineBridge.ts`; nenhuma infraestrutura nova de auditoria (tudo via `registrarAuditoria` existente); nenhuma entidade nova de usuário (`UserAccess` da Fase 1 reaproveitado); nenhum segundo Centro de Ações nem segunda explicação.

**Verificado (regressão do bloco):** `tsc -b` e `npm run build` limpos. Testado ao vivo no Demo o fluxo completo — atribuir responsável, sugerir prazo padrão (13/08 + 3 = 16/08, correto), alterar prazo para testar os três estados de SLA (dentro → próximo → vencido, todos corretos com `alertaAntecedenciaDias=1`), resolver (SLA virou "Resolvida fora do prazo"), reprovar com observação, confirmar após reload que a decisão **não** foi sobrescrita pela sincronização, reabrir (status recalculado, revisão limpa, prazo/responsável preservados), aprovar outro caso. Auditoria registrou as 6 ações novas, nenhuma por renderização. Centro de Ações exibiu SLA/responsável/status revisado, filtro por responsável funcionando, cards estáveis sob filtro. Isolamento: no Real tudo zerado e nem a lista de usuários do Demo aparece; Demo→Real→Demo sem vazamento. Regressão nas 8 demais telas (Dashboard, Ponto, HE1, Reincidência, Score, Setores, Relatórios, Importar) sem erro de console. Estado do Demo restaurado ao original após os testes.

## Conclusão da Fase 2 — Plataforma completa

Bloco final, executado sem parada intermediária. Fecha o ciclo operacional e o analítico, e remove os últimos acoplamentos a uma empresa específica.

### Regras de jornada parametrizadas

**Alterado — `public/motor-he/index.html`:** novo helper `numeroDaQuerystring`, irmão do `listaDaQuerystring` que já existia. `TOLERANCIA_PADRAO_MIN` (`?tol=`), `META_MIN` (`?meta=`), `LIMITE_REINCIDENCIA` (`?reinc=`), `INTERJORNADA_MIN_H` (`?interj=`) e `INTERVALO_MIN_MIN` (`?intervalo=`) deixaram de ser constantes fixas.

`META_MIN` valia `36*60+50` — 36:50, a meta diária de uma operação real. Agora nasce em 0 = "não configurada", e os painéis que comparavam com a meta mostram "—" em vez de comparar com um alvo inventado (`metaConfigurada()`). O placeholder `34:00` no HTML também foi neutralizado.

**Criado — cálculo de intervalo intrajornada no motor:** com 4+ batidas, o maior intervalo entre batidas consecutivas é comparado com o mínimo configurado. Com menos de 4 batidas nada é concluído. Exibido na ficha do motor ao lado do alerta de interjornada, que já existia (agora também com limiar configurável).

**Alterado — `src/pages/MotorHE.tsx`:** monta a querystring com as 5 regras; a `key` do iframe passou a ser a querystring inteira, para o motor remontar quando qualquer regra mudar (antes seguiria rodando com a tolerância antiga até um F5).

**Alterado — `src/services/journeyService.ts`:** deixou de ser preparação. Virou a porta de leitura dos alertas do motor (`alertasDeJornada`, `temAlertaDeJornada`), com consumidor real em `ControlePonto`, `analyticsService`, `scoreService` e `reportService`.

### Bloco Analítico

**Criado — `src/services/analyticsService.ts`:** visão geral com 6 indicadores explicados, evolução diária/mensal, por colaborador, por setor, por unidade, principais causas, indicadores de pendência/SLA/revisão, pontos de atenção e 3 rankings. Todo indicador que não pode ser calculado devolve `null` com o motivo — nunca um número estimado.

**Reescrito — `src/services/scoreService.ts`:** score multidimensional com 5 dimensões reais. Peso igual por decisão explícita; dimensão sem base de cálculo sai da média em vez de contar zero. Pontualidade e magnitude da HE ficaram de fora, com o motivo escrito na própria tela.

**Reescrito — `src/pages/Dashboard.tsx`:** Dashboard Executivo. **Reescrito — `src/pages/ScoreColaborador.tsx`:** composição do score por colaborador. **Criado — `src/components/ui/Indicadores.tsx`:** `CardIndicador`, `ExplicacaoIndicador` (botão "?"), `EstadoVazio`, `AvisoConfiguracao`.

### Bloco de Consistência

`Dashboard`, `ControlePonto` e `AnaliseSetor` deixaram de importar `heAggregations` direto. Taxonomia unificada aplicada em Controle de Ponto e Análise por Setor. Terminologia "Motorista" → "Colaborador" em toda a interface — era vocabulário de transportadora.

### Portabilidade multiempresa

**Criado — `src/services/workspaceService.ts`** e **`src/pages/settings/EmpresasTab.tsx`:** criar/excluir empresa pela interface, com defaults neutros e sem herdar nada da anterior; `real`/`demo` protegidos; exclusão limpa todos os namespaces; diagnóstico de "o que falta configurar" por empresa. `WorkspaceContext` ganhou `criarEmpresa`/`excluirEmpresa`.

### Relatórios

**Criado — `src/services/reportService.ts`** e **`src/pages/Relatorios.tsx`** (substitui `RelatorioMensal.tsx`): 7 relatórios montados a partir dos mesmos services das telas, período por mês/ciclo/tudo, exportação CSV (separador `;`, escape RFC 4180, BOM UTF-8, cabeçalho com empresa e escopo). `ReportRepository` deixou de ser preparação.

### Centro de Ações e experiência

Colunas "Motivo" e "Ação necessária" (via `pendenciaService.acaoNecessaria`), situação da revisão inline (`situacaoRevisao`), prazo sob o badge de SLA, card "Aguardando revisão". Estados vazios padronizados com orientação de próximo passo em todas as telas. Responsividade abaixo de 900px (barra lateral vira faixa, tabelas rolam no próprio contêiner).

### Correções encontradas durante os testes

1. **Dashboard mostrava zero pendências** para quem entrava direto nele — faltava `sincronizarPendencias`, que as outras duas telas já chamavam. O badge da barra lateral mostrava dezenas ao mesmo tempo.
2. **"Dentro do padrão" liderava o ranking de setores com mais divergência** — o agrupamento sintético recebe a parcela *dentro do padrão* de casos acima do padrão, e essas divergências eram contadas nele. Agora é marcado (`SETOR_DENTRO_DO_PADRAO`, campo `sintetico`) e excluído do ranking; na Análise por Setor aparece como "(rotina normal)".
3. **Deep-link não reabria o mesmo caso duas vezes** — a URL não mudava, então o efeito não voltava a rodar. O parâmetro passou a ser consumido após abrir.
4. **Cadastro aceitava setores/unidades homônimos** — o que fica gravado num caso é o nome, não o id. Bloqueado na origem, com `listNomes()` deduplicando como defesa para dados antigos.
5. **Chaves órfãs após excluir empresa** — `pendencias` e `auditLog` viravam listas vazias em vez de serem removidas.

### Verificação

`tsc -b` e `npm run build` limpos. Empresa nova criada e configurada ponta a ponta pela interface (unidade → setor → escala → colaborador → regras), com tolerância alterada só nela; excluída em seguida sem deixar chave órfã. Ciclo completo no Demo: deep-link → responsável → prazo sugerido → resolver → reabrir ficha resolvida → aprovar. Parâmetros do motor conferidos por inspeção interna do iframe. Os 7 relatórios gerados e um CSV inspecionado. 12 rotas sem erro de console em sessão limpa. Responsividade validada em 375px. Demo restaurado ao estado do seed.

## Consolidação Produto + Portfólio

Transformação do sistema funcional em produto apresentável e vitrine profissional. **Nenhuma regra de negócio foi alterada** — o motor HE, os cálculos e as 13 telas operacionais continuam idênticos.

### Primeiro acesso — a mudança mais importante

**Alterado — `WorkspaceRepository.ensureBootstrap()`:** parou de criar o workspace `real` ("Minha Empresa") e de forçar uma empresa ativa. Agora garante apenas o ambiente de demonstração e devolve `activeId: null`.

O problema que isso resolve: quem abria o Jornada360 entrava automaticamente numa empresa que não criou, com um nome que não é dele, sem saber se aquilo era demonstração ou produção. Um Dashboard zerado ali parecia uma operação impecável — a pior leitura possível para um cliente novo.

**Compatibilidade preservada:** `real` nunca é apagado e quem já tinha um `activeWorkspaceId` salvo entra direto onde estava, sem ver o portão. Só instalações novas mudam de comportamento.

**Criado — `src/pages/BemVindo.tsx`:** portão com três caminhos explícitos — criar minha empresa / ver demonstração / já tenho acesso. A opção de login explica que a autenticação ainda não existe e por quê; **nenhum login falso foi criado**.

**Alterado — `WorkspaceContext`:** dividido em dois níveis. `useSessao()` (empresa pode ser null) para App/AppState/portão; `useWorkspace()` (empresa garantida) para as 13 telas operacionais, que não precisaram de nenhuma alteração. `App.tsx` decide antes: sem empresa ativa renderiza rotas públicas, com empresa renderiza o shell.

**Alterado — `Topbar`:** botão "Sair desta empresa", que volta ao portão sem apagar nada. **Alterado — `excluirEmpresa`:** excluir a empresa ativa passa a voltar ao portão em vez de cair silenciosamente em outra (o que poderia jogar alguém dentro da demonstração sem perceber).

### Blindagem do ambiente de demonstração

**Alterado — `seedDemoWorkspaceIfEmpty()`:** passou a verificar `workspace.environment === 'demo'` e recusar qualquer outro ambiente. Antes bastava o id ser `demo`; agora nem uma chamada equivocada consegue semear 5 colaboradores fictícios dentro de uma empresa real. Somada às duas garantias que já existiam (empresas criadas pela interface nascem como `real`; o seed nunca copia de outro workspace), são três camadas independentes.

### Onboarding

**Criado — `src/services/onboardingService.ts`:** 9 passos (empresa, unidades, setores, escalas, colaboradores, regras, integrações, usuários, primeiros dados), com marcação de quais são essenciais e o motivo de cada um existir.

O progresso é **derivado do cadastro real** a cada leitura, não um flag salvo. Duas razões: um flag mentiria assim que alguém apagasse a última escala (diria "pronto" com a empresa quebrada), e quem configurou por fora aparece corretamente como concluído sem refazer nada.

**Criado — `src/components/onboarding/PainelOnboarding.tsx`:** barra de progresso, percentual, próximo passo destacado com o porquê, e lista completa. Aparece no Dashboard enquanto faltar passo essencial e some sozinho depois.

**Alterado — `Configuracoes.tsx`:** passou a aceitar `?aba=` para o onboarding levar direto ao passo certo, em vez de largar a pessoa na aba Empresa.

### Estados vazios diferenciados

**Criado — `AmbienteSemDados`** em `Indicadores.tsx`. A distinção que ele existe para fazer: "0 pendências" pode significar "operação impecável" ou "nada analisado ainda". Mostrar o mesmo zero nos dois casos faz uma empresa vazia parecer perfeita.

Três estados distintos, aplicados em Dashboard, Controle de Ponto, Horas Extras, Ranking, Score, Análise por Setor, Relatórios, Pendências e Centro de Ações:

- Nenhum dia processado → "Seu ambiente ainda não possui dados", com os caminhos processar / configurar / importar
- Dias processados, sem ocorrência → "Operação sem pendências no período — N dia(s) analisado(s)"
- Existe caso, filtro escondeu → "Nada em aberto com estes filtros"

### Portfólio e apresentação

**Criado — `src/portfolio/projetos.ts`:** catálogo como arquivo de **dados**, não CMS. Adicionar um projeto é acrescentar um objeto ao array; nenhuma tela muda.

**Criado — `src/pages/Portfolio.tsx`** e **`src/pages/Apresentacao.tsx`:** telas públicas, fora do shell. **Não importam nenhum repositório** — não há caminho pelo qual dado de cliente chegue lá. A apresentação inclui uma seção "O que ainda não é", declarando abertamente a ausência de login, servidor e sincronização.

**Criado — `src/publico.css`:** folha separada para o lado de fora do produto, usando os mesmos tokens de cor e tipografia do sistema.

### Documentação

**Criados:** `PRODUCT.md`, `SAAS_ARCHITECTURE.md`, `ONBOARDING.md`, `PORTFOLIO.md`.
**Atualizados:** `README.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, `CURRENT_STATE.md`, `ROADMAP.md`, `DEMO.md`, `JORNADA360_HANDOFF.md`.

`SAAS_ARCHITECTURE.md` declara explicitamente: *arquitetura preparada para evolução para SaaS; backend, banco, autenticação e isolamento server-side ainda são necessários para produção multi-tenant.*

### Correções

- Texto da aba Empresas afirmava que "Real e Demonstração não podem ser excluídos" — ficou incorreto para instalações novas, que não têm mais `real`.
- `AppStateProvider` usava `useWorkspace()` e passou a usar `useSessao()`: envolve toda a árvore, inclusive o portão, onde não há empresa ativa.

### Verificação

`tsc -b`, `npm run build` e `npm run lint` limpos. Testado com armazenamento zerado: portão aparece, só o workspace `demo` é criado, nenhuma empresa ativa. Empresa nova criada pelo portão nasceu vazia com defaults neutros e sem nenhum dado da demonstração. Cadastro completo (unidade → setor → escala → colaborador) elevou o progresso de 33% para 78%. Isolamento demonstração → empresa → demonstração sem vazamento nos dois sentidos. Motor HE, pendências, Centro de Ações e auditoria intactos. Responsividade em 375px sem rolagem horizontal em nenhuma tela nova.

## Fase 3 — Fundação de produção (concluída)

Backend real, banco, autenticação, multi-tenancy server-side, RBAC, testes automatizados e performance. **A interface não foi convertida para consumir a API** — essa decisão está documentada em [MIGRACAO.md](MIGRACAO.md), não escondida.

### Bloco A — Testes automatizados

**Criado:** Vitest com duas configurações — frontend (`jsdom`, `vitest.config.ts`) e backend (`node`, `vitest.server.config.ts`, sem paralelismo de arquivo por causa do banco compartilhado).

12 arquivos de teste no frontend, **152 testes** cobrindo tolerância, HE, jornada, classificação de status, ciclo da pendência, priorização, SLA, score, indicadores do dashboard, onboarding, ciclo de vida de empresa e blindagem do seed de demonstração.

Scripts: `npm test`, `npm run test:watch`, `npm run test:coverage`, `npm run test:server`.

### Bloco B — Backend e banco

**Criado — `server/`:** Node + Express, em camadas `routes → services/repositories → db`.

Banco **SQLite pelo módulo embutido do Node** (`node:sqlite`, disponível no Node 24) — sem compilação nativa, sem dependência externa de driver. `schema.sql` com **13 tabelas**; toda tabela de negócio tem `tenant_id`, e todas caem em cascata a partir de `tenants`. Migrations idempotentes rodam na subida do servidor.

`server/seed.js` cria um tenant de demonstração — **separado** do código de produção, e sem nenhum dado real.

### Bloco C — Autenticação e multi-tenancy

**Criado — `server/lib/seguranca.js`:** senha com **scrypt** (`node:crypto`, N=16384) e comparação em tempo constante. Nenhuma senha em texto puro, em lugar nenhum. Sessão por **token opaco**, com apenas o hash SHA-256 guardado no banco e expiração verificada a cada requisição.

**Criado — `server/middlewares/index.js`:** a peça central da segurança. `resolverTenant` só aceita o `tenantId` da URL depois de confirmar que o usuário da sessão tem vínculo com ele. **Sem vínculo, a resposta é 404 — não 403** (403 confirmaria que o tenant existe). O cliente nunca informa em quem ele quer operar; a sessão informa.

**Criado — `src/api/`:** `client.ts` (único lugar do frontend que chama `fetch`, com erros tipados e mensagem pronta — o usuário nunca recebe stack trace), `authService.ts` e `remoteEmpresaRepository.ts`.

### Bloco D — RBAC e auditoria

**Criado — `server/lib/permissoes.js`:** matriz de **11 permissões × 5 papéis**, aplicada em `exigirPermissao` nas rotas. `auditor` lê e exporta mas nunca escreve; `gestor` trata mas não revisa; só `administrador` pode excluir a empresa. Esconder botão no frontend não é considerado autorização.

**Criado — `server/services/auditService.js`:** o autor do registro vem da **sessão**, não do corpo da requisição.

**54 testes de backend**, entre eles **25 de isolamento** que criam dois tenants e verificam, por HTTP, que cada um só enxerga o próprio dado e que acesso cruzado devolve 404 — mais 15 de integração provando que `RemoteEmpresaRepository` fala o mesmo contrato dos repositórios locais, com os nomes de campo do domínio sobrevivendo à ida e volta.

### Bloco E — Performance

**Alterado — `App.tsx`:** code splitting por rota com `React.lazy` + `Suspense`. O portão permanece no bundle principal (é a primeira tela). Bundle inicial caiu de **798 KB num único chunk para 255 KB** (82 KB gzip) + chunks sob demanda — Recharts saiu do caminho crítico.

### Documentação

**Criados:** `BACKEND.md` (API, banco, decisões técnicas, matriz de RBAC, segurança implementada **e as limitações que permanecem**), `MIGRACAO.md` (classificação dos 13 repositórios e o custo honesto do que falta), `.env.example`.

**Atualizados:** `README.md`, `CURRENT_STATE.md`, `JORNADA360_HANDOFF.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `INTEGRATIONS.md`, `PRODUCT.md`, `CONFIGURATION.md`, `SAAS_ARCHITECTURE.md`.

### O que deliberadamente NÃO foi feito

- **Motor HE intocado.** Nenhuma regra de cruzamento foi alterada para acomodar o backend.
- **Telas não migradas.** Converter 13 telas para assíncrono é amplo e mecânico; merece a rede de testes de interface que ainda não existe.
- **Nenhuma credencial pedida** para Cobli ou sistema de ponto só para "fechar visualmente". Os contratos ficaram prontos e o estado real está declarado.
- **Nenhuma URL fictícia** apresentada como produção.
- **Nenhum dado fictício migrado** para empresa real.

### Verificação

`npm test` (152), `npm run test:server` (54), `npx tsc -b`, `npm run build` e `npm run lint` — todos limpos. Isolamento entre tenants verificado também por HTTP real, fora da suíte: A→A 200, A→B 404, B→B 200, B→A 404, sem token 401.

## Fase 4 — Integração real frontend + backend (concluída)

O objetivo era um só, e foi alcançado: **a interface deixou de ser um aplicativo local com backend paralelo e passou a ser uma aplicação conectada.** Nenhuma das treze telas foi reescrita.

### A decisão que tornou isso possível sem reescrever nada

`localStorage` é síncrono; a rede não é. Converter treze telas para lidar com carregamento, erro e recarga seria mudar centenas de linhas de código estável — a maneira mais fácil de introduzir regressão.

Em vez disso: **o carregamento virou assíncrono e acontece uma vez** (`WorkspaceProvider`), e **a leitura continua síncrona** para quem está dentro do sistema. O roteador só monta o shell depois que o dado chegou. Ver [FRONTEND_BACKEND.md](FRONTEND_BACKEND.md).

### Bloco A — Autenticação no frontend

**Criado — `src/auth/AuthContext.tsx`:** três estados, não dois. Além de "logado" e "não logado" existe **"ainda não sei"** — tratar a checagem inicial como "não logado" faria o portão piscar a cada recarga para quem tem sessão válida.

**Criadas — `Entrar.tsx`, `CriarConta.tsx`, `NovaEmpresa.tsx`.** Criar conta e empresa acontece numa transação só no servidor: meia conta sem empresa seria um estado que ninguém conserta pela interface.

**Alterado — `BemVindo.tsx`:** "Já tenho acesso" deixou de ser uma explicação e virou login. O que não mudou é a honestidade: quando o servidor não responde, a tela **diz isso** em vez de deixar botões mortos sem explicação — e a demonstração continua disponível justamente nessa hora.

### Bloco B — Sessão em cookie HttpOnly

**Criado — `server/lib/sessaoHttp.js`.** O token saiu do `localStorage`, onde qualquer script capaz de executar na página conseguiria lê-lo e **levar a sessão embora**. Agora vive num cookie `HttpOnly`, invisível ao JavaScript.

**Alterado — `vite.config.ts`:** proxy de `/api`. É o que torna o cookie first-party em desenvolvimento — sem isso ele exigiria `SameSite=None; Secure`, que exige HTTPS, e o login "não funcionaria" localmente. Em produção a mesma topologia se repete.

**Proteção contra CSRF:** escrita autenticada por cookie exige o cabeçalho `x-jornada-cliente: web`, que outro site não consegue definir sem preflight de CORS.

O token ainda existe, mas **só volta no corpo para quem se declara cliente de API** — um navegador recebe apenas o cookie.

### Bloco C — Padrão assíncrono e fábrica de repositórios

**Criado — `src/data/useRecurso.ts`:** `useRecurso` e `useGravacao`. Duas garantias que parecem detalhe: resposta atrasada de um pedido antigo nunca sobrescreve um pedido mais novo (trocar de empresa rápido mostraria dados da empresa errada), e nada é escrito depois que o componente saiu da tela.

**Criado — `src/data/tipos.ts`:** o contrato único de persistência, com duas implementações (`conjuntoLocal` e `conjuntoRemoto`). A escolha acontece **uma vez**; nenhuma tela pergunta "estou no demo?" — é esse `if` espalhado que a fábrica existe para impedir.

**Criado — `src/components/ui/EstadosAsync.tsx`:** "carregando", "servidor fora do ar", "sessão expirada", "sem permissão" e "conflito" são situações **diferentes** e precisam ser ditas de forma diferente. Um erro genérico faria a pessoa tentar de novo quando deveria entrar de novo.

**Alterado — `pendenciaService`: deixou de fazer I/O.** Ele calcula o estado desejado e devolve; quem grava é a camada de dados. Uma regra que escreve sozinha só funciona onde conhece o armazenamento — sem I/O, as mesmas regras valem nos dois caminhos e seguem testáveis como funções puras.

`sincronizarPendencias` passou a devolver **só o que mudou**: sem isso, abrir a tela reenviaria centenas de pendências idênticas às que já estão no servidor.

### Bloco D — Cadastro, empresa e onboarding

As 8 abas de Configurações passaram a gravar pelo conjunto ativo, com feedback de "Salvando… / Salvo / Erro". O rascunho **só é limpo quando a gravação foi confirmada** — limpar antes faria a pessoa perder o que digitou justamente quando algo deu errado.

`EmpresasTab` passou a listar as empresas **da conta**, vindas do servidor. O diagnóstico de prontidão só é calculado para a empresa ativa — buscar o cadastro de todas para preencher uma coluna informativa seria pedir ao servidor o conteúdo inteiro de cada empresa.

### Bloco E — Operação, motor HE e RBAC na interface

Pendências, revisão, auditoria e relatórios passaram pelo servidor. A **revisão tem rota própria**: o autor vem da sessão, e enviar `revisadoPor` no corpo é ignorado — verificado por teste.

**Criado — painel de envio em `MotorHE.tsx`.** O motor **não foi alterado**: continua gravando no `localStorage`. O envio é um adaptador ao redor dele, **explícito** — enviar sozinho esconderia o momento em que o dado sai do navegador.

**RBAC na interface:** a partir da matriz que o servidor devolve. Auditor não recebe botão de gravar habilitado. Continua sendo conveniência — quem autoriza é o backend.

**Criado — controle de concorrência otimista.** Antes, cada pessoa trabalhava no próprio navegador e colisão não existia. Com servidor, a segunda a salvar apagaria a alteração da primeira sem ninguém perceber. Agora a resposta é 409 e a interface pede recarga — perder trabalho em silêncio é inaceitável num sistema de auditoria.

### Bloco F — Migração dos dados locais

**Criado — `MigracaoTab.tsx` + `POST /importar`.** Regra que governa a tela inteira: **nada acontece em silêncio.** Detectar → mostrar o que existe → confirmar → enviar em lotes → **conferir a contagem lida do banco** → e só então oferecer a limpeza, como passo separado e opcional.

A contagem que aparece na tela não é o que foi enviado: é o que **ficou lá**. Ver [MIGRACAO_LOCALSTORAGE.md](MIGRACAO_LOCALSTORAGE.md).

### Bloco G — Gestão de acesso

**Criado — `conviteRepository.js` + rotas de membros e convites.** Duas situações diferentes, tratadas como tais: quem já tem conta é vinculado pelo e-mail; quem não tem recebe um convite — criar a conta por ela significaria definir a senha dela.

O convite é **nominal**, de uso único, e o código aparece **uma vez** (o banco guarda só o hash). **O envio por e-mail não existe** e não finge existir.

Remover ou rebaixar o último administrador é recusado: a empresa ficaria sem ninguém capaz de gerir acesso.

### Bloco H — Segurança e testes

**Criado — `server/lib/limiteDeTaxa.js`:** 10 tentativas de login em 15 min, 5 contas em 60 min. A senha correta também é barrada enquanto o bloqueio vale — senão o limite não atrapalharia quem estivesse adivinhando.

**Cabeçalhos:** `nosniff`, `DENY`, `no-referrer`. **CORS** com `credentials: true` e lista de origens.

**Criados — 68 testes novos:**
- `src/App.test.tsx` — **19 de interface**: portão, login, guarda de rota, empresa ativa, carregamento, servidor fora do ar, sessão expirada, RBAC, demonstração.
- `server/fluxoCompleto.test.js` — **35 ponta a ponta**: cadastro → estrutura → dia processado → pendência → revisão → auditoria → relatório → logout → **login de outra sessão e tudo continua lá**. Mais isolamento, concorrência, importação e convites.
- `server/seguranca.test.js` — **14**: cookie, CSRF, limite de tentativas, cabeçalhos, ausência de stack trace e de senha nas respostas.

### Documentação

**Criados:** `AUTH.md`, `FRONTEND_BACKEND.md`, `DEPLOY.md`, `MIGRACAO_LOCALSTORAGE.md`, `SECURITY.md`, `scripts/dev-all.js`.
**Atualizados:** `README.md`, `CURRENT_STATE.md`, `JORNADA360_HANDOFF.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `PRODUCT.md`, `SAAS_ARCHITECTURE.md`, `CONFIGURATION.md`, `ONBOARDING.md`, `BACKEND.md`, `MIGRACAO.md`.

### O que deliberadamente NÃO foi feito

- **Motor HE intocado.** Nenhuma regra de cruzamento alterada.
- **Nenhuma tela reescrita.** As treze continuam lendo dado de forma síncrona.
- **Sem interface otimista.** A tela só mostra o valor novo depois que o servidor confirmou — antecipar exigiria saber desfazer.
- **Sem offline-first.** Melhor dizer "sem conexão" do que salvar local e fingir que sincronizou.
- **Sem recuperação de senha falsa**, sem verificação de e-mail falsa, sem envio de convite falso.
- **Sem `/api/v1/`** — existe um único cliente, versionado e implantado junto. Decisão registrada em [DEPLOY.md](DEPLOY.md).
- **Sem Postgres.** SQLite atende; migrar só para dizer que usa Postgres seria acrescentar operação sem ganho.
- **Sem cobrança.**

### Verificação

`npm test` (172), `npm run test:server` (103), `npx tsc -b`, `npm run build` e `npm run lint` — todos limpos. Fluxo completo exercitado no navegador: criar conta → empresa vazia → cadastrar → sair → entrar → dado no lugar. Cookie confirmado como invisível ao JavaScript; `localStorage` sem token.


## Fase 5 — Publicação e operação (concluída)

Transformar a aplicação que funcionava localmente num produto que se publica com um comando, opera sozinho e se prova funcionando. **Nenhum módulo novo, nenhuma alteração no motor de jornada.**

### A guarda de configuração

**Criado — `server/config.js`:** em produção, uma configuração insegura **impede o servidor de subir**. Não avisa no log e continua — recusa, listando o que está errado.

A razão: a forma mais comum de um sistema ir para produção inseguro não é alguém decidir isso, é um valor de desenvolvimento sobrando numa variável que ninguém conferiu. CORS apontando para localhost, cookie sem `Secure`, banco dentro da pasta do código que o próximo deploy apaga. Nada disso quebra nada — o sistema sobe, funciona, e está errado. Um servidor que se recusa a subir é impossível de ignorar; um aviso no log é fácil demais.

12 casos cobertos por teste.

### Frontend servido pela API

**Alterado — `server/app.js`:** em produção o mesmo processo serve a aplicação e a API. Não é conveniência: é o que mantém página e cookie na **mesma origem**, e é a mesma origem que faz o cookie `HttpOnly` funcionar sem `SameSite=None`.

Junto vieram: cache eterno para os arquivos com hash no nome e `no-cache` para o `index.html` (um `index.html` em cache manteria a pessoa numa versão antiga depois do deploy), fallback de rota para o React Router (sem ele, recarregar em `/pendencias` daria 404), e 404 em JSON para `/api/*` — nunca a página inteira onde se esperava um objeto.

### HTTPS automático

**Criados — `Dockerfile`, `docker-compose.yml`, `Caddyfile`.** O Caddy pede o certificado ao Let's Encrypt na primeira subida, renova sozinho e redireciona http → https. **Não há passo manual nem data de validade para alguém esquecer.**

A porta da aplicação não é publicada: só o proxy a alcança. Publicá-la deixaria a aplicação acessível por HTTP direto, contornando o HTTPS.

### Recuperação de senha — real

**Criados — `server/lib/email.js`, `recuperacaoRepository.js`, telas `EsqueciSenha` e `RedefinirSenha`.**

Regras que fazem o fluxo ser seguro e não apenas conveniente: validade de 30 minutos, uso único, um pedido invalida os anteriores, só o hash no banco, e **trocar a senha encerra todas as sessões** — se a pessoa está recuperando porque alguém entrou na conta dela, manter as sessões abertas anularia o esforço.

A resposta é **idêntica** para conta existente e inexistente: senão a rota vira um verificador de quem tem conta no sistema, anulando o cuidado que o login tem de nunca distinguir os dois casos.

O link é validado **ao abrir a tela**. Deixar a pessoa escolher e confirmar uma senha para só então dizer "expirou" é gastar o tempo dela num caminho já inválido.

**Dois modos de e-mail, e nenhum finge:** `smtp` envia de verdade; `log` escreve no console para desenvolvimento. O servidor **recusa subir em produção no modo `log`**.

### Envio real de convites

**Alterado — a rota de convite envia por e-mail** e continua devolvendo o código na tela. De propósito: se o e-mail cair no spam ou o endereço estiver errado, o administrador ainda entrega o acesso por outro canal. Um sistema que depende exclusivamente do e-mail chegar deixa alguém trancado do lado de fora quando ele não chega. A resposta traz `emailEnviado`, e a interface diz a verdade sobre o que aconteceu.

### Backup que é backup

**Criado — `server/lib/backup.js` + `scripts/backup.js` + `scripts/restaurar.js`.**

Usa `VACUUM INTO` do SQLite, não cópia de arquivo: o SQLite grava em WAL, e copiar o `.db` com o servidor rodando produz, na melhor das hipóteses, uma cópia desatualizada — na pior, um arquivo inconsistente que só se descobre inválido no dia da restauração.

**Todo backup é verificado antes de contar como backup.** Logo após gerar, o arquivo é aberto, o `integrity_check` roda e as tabelas essenciais são consultadas. Se falhar, o arquivo é **descartado** e a falha vai para o log — um backup que não abre é pior do que nenhum, porque cria a impressão de que existe uma cópia.

Automático a cada 6 horas, com o primeiro 15 segundos após a subida (um deploy que quebrasse antes do primeiro intervalo deixaria o dia sem cópia). A limpeza por retenção **nunca remove o mais recente**: uma retenção mal configurada não pode ser o que deixa o sistema sem nenhuma cópia.

**Restauração:** verifica o backup **antes** de tocar em qualquer coisa — restaurar um arquivo corrompido destruiria o banco bom para colocar um ruim no lugar. Guarda o banco atual como `.pre-restauracao`. Confere o resultado depois de gravar. O modo `--testar` restaura numa cópia isolada e responde a única pergunta que importa sobre um backup: **ele funciona?**

### Monitoramento

**Criado — `server/lib/log.js`:** JSON em produção, legível em desenvolvimento. Rotas normalizadas (`/api/tenants/:id/setores`) — id de cliente no log é identificador espalhado por um arquivo que muita gente lê, e agrupar por rota é o que torna a métrica útil. Nunca entram: senha, token, código, corpo de requisição, ou a URL de SMTP.

**Dois endereços, de propósito separados:** `/api/saude` responde rápido sem tocar o banco (é o que o orquestrador consulta; se consultasse o banco, uma lentidão de disco reiniciaria um processo saudável) e `/api/prontidao` faz o diagnóstico completo — banco, SMTP e **idade do último backup**. Backup parado é uma falha silenciosa, do tipo que só aparece no dia em que faz falta.

### Execução permanente

`restart: unless-stopped` no Docker e `Restart=always` no systemd. **Encerramento gracioso:** para de aceitar conexões, termina o que está fazendo e fecha o banco antes de sair — sem isso, `docker stop` mata no meio de uma escrita. `tini` como PID 1 para o SIGTERM chegar ao Node.

Uma exceção não capturada encerra o processo para o supervisor reiniciar limpo: continuar rodando "torto" é o que produz corrupção difícil de rastrear.

**Criadas — unidades systemd** para quem prefere não usar Docker, incluindo um timer semanal de ensaio de restauração.

### Verificação pós-deploy

**Criado — `scripts/smoke.js`:** 31 verificações contra a URL publicada. Os 275 testes provam que o **código** funciona; este prova que o **deploy** funciona — HTTPS de verdade, redirecionamento de http, cookie chegando com os atributos certos, frontend servido, dado persistindo entre sessões, isolamento valendo em produção, permissões, recuperação de senha e prontidão.

### Testes

**Criado — `server/producao.test.js`, 30 testes:** os 12 casos da guarda de configuração, o backup verificável, a restauração (incluindo a recusa de restaurar arquivo inválido **sem tocar no destino**) e o ciclo completo de recuperação de senha.

**Total: 305 testes** (172 frontend + 133 backend), mais as 31 verificações do smoke.

### O que foi verificado de verdade nesta fase

Não só escrito — executado:

- servidor recusando subir com config insegura, listando os 5 problemas;
- servidor de produção no ar servindo o frontend construído numa porta só;
- smoke test completo: **31 passou, 0 falhou**;
- e-mail de recuperação **efetivamente entregue** por SMTP, com o link montado;
- ciclo completo de recuperação: link válido → troca → link recusado na segunda vez → senha nova funciona → senha antiga recusada;
- backup com dado real, verificado lendo o arquivo gerado;
- ensaio de restauração;
- **reinício do servidor com os dados sobrevivendo**;
- **restauração real a um ponto anterior**: a conta criada depois do backup sumiu, as do backup voltaram, o servidor subiu saudável.

### Documentação

**Criados:** `OPERACAO.md` (plantão), `.env.producao.example`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `deploy/` (5 unidades systemd).
**Reescrito:** `DEPLOY.md` — do servidor vazio à URL do cliente, com custos reais.
**Atualizados:** `README.md`, `CURRENT_STATE.md`, `JORNADA360_HANDOFF.md`, `AUTH.md`, `SECURITY.md`, `PRODUCT.md`.

### O que deliberadamente NÃO foi feito

- **Nenhum módulo novo, motor de jornada intocado** — era a instrução.
- **Sem Postgres.** SQLite atende; o sinal para migrar é concorrência de escrita, não volume.
- **Sem `/api/v1/`.** Um cliente só, implantado junto.
- **Sem verificação de e-mail.** Ficou como pendência declarada, não simulada.
- **Sem cobrança.**

### Verificação

`npm test` (172), `npm run test:server` (133), `npx tsc -b`, `npm run build` e `npm run lint` — todos limpos. 6 avisos cosméticos de fast-refresh.


## MVP Comercial / Programa Piloto (concluído)

Ajuste de **objetivo**, não de arquitetura. A primeira versão comercial passou a ser uma **venda piloto**: poucas empresas, cobrança manual, suporte direto. Nada do que já existia foi reconstruído — backend, banco, autenticação, multiempresa, RBAC, auditoria, motor de jornada, backup, Docker e HTTPS ficaram exatamente como estavam.

### Controle de acesso comercial

- **Cadastro fechado por padrão em produção** (`JORNADA_CADASTRO_ABERTO`). `POST /api/auth/registrar` responde 403 `cadastro_fechado`.
- **O mesmo portão em `POST /api/auth/tenants`** — sem isto, fechar o registro não fecharia nada: bastaria entrar por convite e abrir quantas empresas quisesse.
- **`GET /api/auth/modo`** — a interface pergunta ao servidor o que oferecer, em vez de supor. Com o cadastro fechado, o portão não mostra "criar minha empresa" e explica o programa piloto.
- **`POST /api/auth/convites/aceitar`** (novo) — cria a conta **a partir do convite**, para quem ainda não tem nenhuma, com a tela `/convite`. Era um buraco real: com o cadastro fechado, um colega convidado por um cliente liberado não conseguia sequer existir no sistema. O convite continua nominal, de uso único e com validade de 7 dias; o e-mail da conta vem dele, não do que a pessoa digita.
- **Migração `004_piloto.sql`** — `tenants` ganhou `status`, `suspensa_em`, `motivo_suspensao`, `nota_piloto`; tabela `feedback` criada.

### Suspender preservando os dados

- `piloto.suspender(tenantId, motivo)` marca a empresa e **encerra as sessões abertas** — sem isso a suspensão só valeria quando o token expirasse.
- O middleware passa a recusar leitura e escrita daquela empresa com **403 `empresa_suspensa`** (não 404: a pessoa tem vínculo legítimo, e fazer a empresa sumir seria lido como perda de dados).
- **Nada é apagado.** A empresa continua listada em `/api/auth/eu` marcada como suspensa, aparece no portão em laranja com "seus dados estão preservados", e continua nos backups.
- Reativar devolve o acesso imediatamente.

### Feedback dos clientes piloto

- Botão **Relatar** fixo em qualquer tela (some na demonstração), com as cinco categorias pedidas — Erro / Dificuldade de uso / Sugestão / Funcionalidade solicitada / Dúvida — cada uma com a própria explicação, e a tela atual enviada junto.
- `POST` e `GET /api/tenants/:id/feedback`, isolados por empresa como todo o resto. **Não existe rota HTTP que devolva o feedback de várias empresas** — a visão cruzada existe só na CLI.
- O texto de confirmação diz a verdade: nem toda sugestão vira funcionalidade, mas todas são lidas.

### CLI do operador (`npm run piloto`)

`panorama` (uso e última atividade por empresa), `liberar`, `convidar`, `suspender`, `reativar`, `nota`, `feedback`, `feedback-marcar`. Roda no servidor, com acesso ao banco, e **não existe pela rede** — um painel comercial exigiria rotas HTTP que atravessam empresas, expostas para sempre por conveniência de uma fase de poucos meses.

### Dois defeitos encontrados pela validação

- **Empresa suspensa devolvia a pessoa ao portão sem dizer nada.** `workspaceIdAtivo` só é exposto depois que o dado chega; quando o carregamento falhava, o roteador tratava como "ninguém escolheu empresa". O erro passou a ser verificado **antes** desse desvio, e `useRecurso` passou a limpar o erro ao ser desabilitado — senão o botão "voltar" ficava preso na tela de erro.
- **Empresa reativada continuava marcada como suspensa** no portão, porque a lista vinha do login. Voltar da tela de erro agora relê a sessão.

### Documentação

**Criado:** `PILOTO.md` — o manual de quem opera o piloto.
**Atualizados:** `README.md` (classificação no topo), `CURRENT_STATE.md`, `CHANGELOG.md`, `PRODUCT.md`, `ROADMAP.md`, `SECURITY.md`, `JORNADA360_HANDOFF.md`, `.env.producao.example`.

### O que deliberadamente NÃO foi feito

Cobrança automática, checkout, planos, Central 360, CRM, painel de super administrador, aplicativo móvel, central de tickets, infraestrutura para centenas de empresas. Nada disso é necessário para colocar os primeiros clientes usando.

### Verificação

`npm run test:all` — **318 testes** (175 frontend + 143 backend, incluindo 10 novos do piloto e 3 de interface). `npx tsc -b`, `npm run build`, `npm run lint` limpos. Validado ao vivo no navegador: cadastro fechado, login do cliente, feedback saindo do botão e chegando na CLI, suspensão bloqueando com os dados intactos, reativação devolvendo tudo, e um convite virando conta nova com o cadastro fechado.


## Publicação gratuita — Opção A (Render + Turso)

Mudança de **estratégia de hospedagem**, não de produto. O objetivo passou a ser publicar o piloto numa URL pública sem contratar VPS. Nenhuma regra de negócio, tela, cálculo ou garantia de segurança foi alterada para caber na hospedagem gratuita.

### Por que Render + Turso, e não Cloudflare Workers + D1

O Workers foi avaliado primeiro, e é gratuito e sem cartão. Duas coisas o derrubaram para este produto:

- **Teto de 10 ms de CPU por requisição no plano gratuito.** O hash de senha é scrypt; o Workers não tem scrypt, e o PBKDF2 disponível lá é limitado a 100.000 iterações — que já custam ~100 ms. Publicar ali exigiria **enfraquecer o hash de senha**, que é exatamente o que não se troca por conveniência de deploy.
- **Express não roda no Workers**: seriam ~4.000 linhas de backend reescritas — reconstrução, não adaptação.

Render roda Node de verdade (Express, cookie `HttpOnly` e scrypt intactos) e Turso fala o dialeto do SQLite, então as 84 consultas da Fase 3 valem letra por letra.

### Banco com dois drivers, um contrato

- `server/db/{index,driverSqlite,driverLibsql}.js` — `consultar` / `consultarUm` / `executar` / `emTransacao`, iguais nos dois. A escolha é por `JORNADA_DB_URL` e acontece uma vez, na abertura; nenhum repositório sabe em qual dos dois está.
- **Tudo virou assíncrono**, inclusive o driver local (que por dentro continua síncrono). Duas assinaturas para a mesma operação seriam a porta de entrada para uma consulta que funciona num ambiente e quebra no outro.
- 7 repositórios, rotas, middlewares, serviços e a CLI do piloto convertidos.
- `autenticar` e `resolverTenant` passaram a ser envolvidos por `rota()`: sem isso, uma falha de banco **dentro do middleware de sessão** ficaria pendurada sem resposta e sem log.
- `criarApp` ganhou uma trava que segura a primeira requisição até a migração terminar — em hospedagem que hiberna, o serviço acorda já com gente batendo.

### Migração conferida, não confiada

`npm run exportar` e `npm run importar` (novos). O importador recusa destino povoado, carrega numa transação, **confere as contagens de cada tabela** contra o cabeçalho do dump e **confere o isolamento** (nenhuma linha de negócio pode ficar sem empresa dona). Uma migração que termina sem erro mas perde linhas é o pior desfecho, porque parece sucesso.

### Configuração e e-mail

- `validarConfig` passou a aceitar **duas** formas de persistência — banco remoto ou arquivo em volume — e a recusar as duas ausentes. Banco remoto sem token também reprova.
- Backup em disco deixou de ser exigido quando o banco é remoto: lá não há arquivo para copiar, e cobrar um diretório reprovaria uma configuração correta.
- Novo modo `JORNADA_EMAIL_MODO=desativado`: publica sem envio, e **diz isso**. Recuperação de senha e convite passam a exigir entrega manual do código. Continua não existindo modo que finja ter enviado.
- `PORT` (usado pelas plataformas gerenciadas) agora é aceito além de `JORNADA_PORT`.

### Verificação

- **318 testes** no driver SQLite; **135 dos 143 de backend também no driver libSQL** (`JORNADA_DB_DRIVER=libsql`), incluindo isolamento entre empresas, RBAC, segurança, fluxo completo e piloto. Os 8 que não rodam lá são os de backup **por arquivo**, que dependem de `VACUUM INTO`.
- Migração real executada: 36 linhas exportadas do banco de desenvolvimento e importadas num destino libSQL limpo, com contagens batendo e zero linhas órfãs.
- Aplicação rodada contra o banco migrado: login, leitura do cadastro, feedback e **acesso cruzado devolvendo 404**.
- Configuração de produção do Render validada: sobe com as variáveis do `render.yaml`, reprova sem token do banco e sem banco nenhum.

### Preservado

`Dockerfile`, `docker-compose.yml`, `Caddyfile`, `deploy/`, scripts de backup e `DEPLOY.md` continuam inteiros — a Opção B é a saída quando o piloto crescer. A volta está documentada em `DEPLOY_GRATUITO.md` §8 e não exige mudança de código.

### Documentação

**Criados:** `DEPLOY_GRATUITO.md` (limites com números, custos, passo a passo, backup, volta ao Docker), `.env.gratuito.example`, `render.yaml`.
**Atualizados:** `README.md`, `PILOTO.md`, `DEPLOY.md`, `CHANGELOG.md`.


## Não lançado / não iniciado

Ver [DEPLOY.md](DEPLOY.md) — contratar servidor e domínio e publicar; verificação de e-mail; cópia externa dos backups; integrações reais (Cobli, sistema de ponto); atualização em tempo real; cobrança e planos.
