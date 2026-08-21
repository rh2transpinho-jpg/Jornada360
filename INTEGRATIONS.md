# Integrações

## Por que uma camada própria

O Jornada360 não deve depender de um único fornecedor de rastreamento ou de ponto. Cada empresa-cliente pode usar sistemas diferentes — a camada de integração existe pra isolar essa variação atrás de um contrato único.

## Contrato

`src/integrations/IntegrationService.ts` define `IntegrationAdapter`:

```ts
interface IntegrationAdapter {
  tipo: 'cobli' | 'ponto' | 'excel_csv' | 'api';
  nome: string;
  disponivel: boolean;       // true = funciona hoje, sem credencial pendente
  importar(input: unknown): Promise<ImportResultado>;
}
```

`ImportResultado` traz `registrosEncontrados`, `registrosValidos`, `registrosComErro` e a lista de `erros` — o mesmo formato que a tela de Importar Dados exibe.

## Adapters desta fase

| Adapter | Status | O que faz hoje |
|---|---|---|
| `FileImportIntegration` | **IMPLEMENTADO** | Importação universal de planilha (CSV) — parsing e validação de linhas. Único com corpo funcional. |
| `CobliIntegration` | **PENDENTE DE CREDENCIAL** | `disponivel: false`. O contrato está pronto; falta a chave de API da conta Cobli da empresa-cliente. Nenhuma credencial foi pedida nem simulada só para "fechar visualmente". |
| `TimeClockIntegration` | **PENDENTE DE CREDENCIAL** | `disponivel: false`. Varia por fornecedor. Hoje o cruzamento usa o espelho de ponto exportado em planilha (via Assistente HE Diário), o que já cobre o caso sem depender de API. |
| `ApiIntegration` | **PREPARADO** | `disponivel: false`. Ponto de extensão genérico. |

### Onde a credencial vai morar

Desde a Fase 3 existe backend, e é lá que credencial de integração deve ficar — **nunca no navegador**. O banco tem a tabela `integration_configs` com `tenant_id`, e o servidor lê segredos de variável de ambiente (`.env`, ignorado pelo git; ver `.env.example`). O frontend nunca recebe nem exibe uma credencial.

## Adicionar uma integração nova

1. Criar um novo arquivo em `src/integrations/adapters/`, implementando `IntegrationAdapter`.
2. Registrar em `src/integrations/index.ts`.
3. Adicionar o tipo em `src/domain/IntegrationConfig.ts` (`IntegrationType`) se for uma fonte nova.
4. A tela Configurações → Integrações já lista qualquer entrada de `workspace.integrations` automaticamente — não precisa mexer na UI pra um novo tipo aparecer.

## Segurança

Nenhuma credencial, token, senha ou chave de API é digitada ou armazenada em nenhuma tela do Jornada360, nem em código. Quando uma integração real for implementada, ela deve:

- Usar o método oficial de autenticação da API do fornecedor (nunca capturar login/senha do usuário final).
- Ler a credencial no **servidor**, de variável de ambiente (`.env`, nunca commitado) ou de um cofre de configuração administrativa — nunca hardcoded, nunca no bundle do frontend.
- Nunca logar a credencial em console, auditoria ou qualquer relatório.

---

## Rastreamento como quarta fonte (arquitetura preparada, não implementada)

> **Estado: NÃO IMPLEMENTADO, por decisão.** Nada aqui está ligado. Não existe credencial da Cobli
> no projeto, não foi feita nenhuma chamada à API deles, e não há scraping em lugar nenhum. Esta
> seção descreve o encaixe para quando a integração for autorizada — e existe para que a decisão
> de hoje não feche a porta de amanhã.

### O modelo atual tem três fontes

Desde a fase de escalas e horários padrão, a análise de jornada cruza:

```
PONTO            o que realmente aconteceu       (espelho, via motor)
ESCALA           o que estava programado no dia  (escalas_dia)
HORÁRIO PADRÃO   a jornada habitual vigente      (horarios_padrao)
```

A precedência é resolvida em `server/services/referenciaJornada.js`: escala do dia vence; sem ela,
o padrão vigente naquela data; sem nenhum dos dois, "referência não encontrada" — nunca um horário
inventado.

### Onde a quarta fonte entra

```
RASTREAMENTO     onde o veículo esteve, e quando  (futuro)
```

Rastreamento **não é uma quarta referência de jornada**, e essa distinção é a coisa mais importante
desta seção. Escala e padrão respondem "o que estava previsto". Rastreamento responde outra
pergunta: "o que o registro de ponto afirma bate com o que o veículo fez?".

Concretamente: o ponto diz que a jornada terminou 17:18. O rastreamento diz que o veículo chegou à
garagem 17:05 e não se moveu mais. Isso não muda a referência nem recalcula a hora extra — vira
**evidência** dentro da ocorrência, ao lado do previsto e do realizado, para quem vai decidir.

Tratar rastreamento como referência de jornada seria um erro caro: posição de GPS não é registro de
ponto, não tem valor trabalhista, e um sinal perdido viraria "divergência" para uma pessoa que
trabalhou normalmente.

### Encaixe técnico

O ponto de extensão já existe e não precisa ser inventado:

| Peça | Onde | O que muda |
|---|---|---|
| Adapter | `src/integrations/adapters/CobliIntegration.ts` | Já existe com `disponivel: false`. Ganha corpo. |
| Credencial | `integration_configs` + variável de ambiente no servidor | Nada muda: o padrão já está definido acima. |
| Persistência | tabela nova `rastreio_eventos` (aditiva) | `tenant_id`, `colaborador_chave`, `data`, `evento`, `ocorrido_em`, `latitude`, `longitude`, `fonte`. |
| Cruzamento | `services/referenciaJornada.js` → `compararComReferencia` | Recebe os eventos como parâmetro opcional e acrescenta divergências do tipo `ponto_sem_movimento`, `movimento_sem_ponto`. |
| Explicação | `analises/:id/explicacao` | Ganha um quarto bloco em `referencia-comparacao`, ao lado de padrão / escala / ponto. |
| Fila | `analiseRepository.GERA_PENDENCIA` | Os tipos novos entram na lista, ou não — é uma decisão de produto, não técnica. |

Nada disso exige alterar o motor de jornada, o cálculo de hora extra, a precedência escala > padrão,
nem a garantia de que reprocessar preserva a análise humana. É por isso que a arquitetura está
"preparada": a quarta fonte é aditiva em todas as camadas.

### Condições para implementar

1. A empresa-cliente fornece e **autoriza** o uso da credencial da própria conta.
2. A credencial é lida pelo servidor, de variável de ambiente — nunca digitada numa tela, nunca no
   bundle do frontend, nunca em log ou auditoria.
3. Autenticação pelo método oficial da API do fornecedor. **Nada de scraping, nada de armazenar
   login e senha do usuário final.**
4. Os dados de rastreamento respeitam `tenant_id` como todo o resto: uma empresa nunca vê a posição
   de veículo de outra.

Enquanto essas quatro condições não estiverem satisfeitas, `CobliIntegration.disponivel` continua
`false` e o sistema opera normalmente com as três fontes — que é o estado de hoje.
