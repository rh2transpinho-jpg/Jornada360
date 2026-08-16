/* Rotas de dados de uma empresa. TODAS montadas sob /api/tenants/:tenantId, atrás de
 * `autenticar` + `resolverTenant` — nenhum handler aqui precisa (nem deve) confiar em tenant
 * vindo do corpo da requisição: usa sempre `req.tenantId`, que o middleware validou.
 *
 * Os handlers são finos: validam entrada, chamam repositório/service e devolvem. Regra de negócio
 * não mora em rota.
 *
 * CONCORRÊNCIA (Fase 4): as gravações de cadastro comparam o cabeçalho `x-versao` com o carimbo
 * atual do tenant e devolvem 409 quando alguém gravou no meio. Ver `conflitoDeVersao`. */
import { Router } from 'express';
import { conflitoDeVersao, exigirPermissao, rota } from '../middlewares/index.js';
import { PERMISSOES as P, PAPEIS, permissoesDoPapel } from '../lib/permissoes.js';
import * as empresa from '../repositories/empresaRepository.js';
import * as operacao from '../repositories/operacaoRepository.js';
import * as tenants from '../repositories/tenantRepository.js';
import * as usuarios from '../repositories/userRepository.js';
import * as convites from '../repositories/conviteRepository.js';
import { auditar } from '../services/auditService.js';
import { enviarEmail, mensagemConvite } from '../lib/email.js';
import { carregarConfig } from '../config.js';
import * as piloto from '../repositories/pilotoRepository.js';

export const tenantRouter = Router({ mergeParams: true });

/* Toda gravação de cadastro passa por aqui: confere a versão que o cliente leu, executa, e
 * devolve o carimbo novo. Concentrar isso num lugar evita que uma rota nova esqueça a checagem. */
async function gravarCadastro(req, res, executar) {
  const conflito = conflitoDeVersao(req, await tenants.versaoConfig(req.tenantId));
  if (conflito) return res.status(409).json(conflito);

  /* O carimbo novo é gerado e o cabeçalho definido ANTES de executar: cabeçalho não pode ser
   * definido depois que o corpo da resposta já saiu. O custo dessa ordem é que uma gravação que
   * falhe deixa o carimbo avançado sem mudança de dado — o efeito é apenas um conflito falso para
   * quem estiver editando em paralelo, que será convidado a recarregar. Errar para o lado de pedir
   * recarga é preferível a errar para o lado de sobrescrever. */
  const versao = await tenants.tocarConfig(req.tenantId);
  res.set('x-versao', versao);
  return executar();
}

/* ---------------------------------------------------------------- cadastro */

tenantRouter.get('/', exigirPermissao(P.CONFIG_LER), rota(async (req, res) => {
  const t = await tenants.buscarTenant(req.tenantId);
  const regras = await empresa.obterRegras(req.tenantId);
  res.set('x-versao', await tenants.versaoConfig(req.tenantId));
  res.json({
    id: t.id,
    nome: t.nome,
    criadoEm: t.criado_em,
    environment: t.environment,
    papel: req.papel,
    permissoes: permissoesDoPapel(req.papel),
    versao: await tenants.versaoConfig(req.tenantId),
    company: await empresa.obterEmpresa(req.tenantId),
    units: await empresa.listarUnidades(req.tenantId),
    departments: await empresa.listarSetores(req.tenantId),
    schedules: await empresa.listarEscalas(req.tenantId),
    employees: await empresa.listarColaboradores(req.tenantId),
    integrations: await empresa.listarIntegracoes(req.tenantId),
    users: await tenants.listarMembros(req.tenantId),
    rules: regras?.regras,
    causaOpts: regras?.causaOpts ?? [],
  });
}));

tenantRouter.put('/empresa', exigirPermissao(P.CONFIG_ESCREVER), rota(async (req, res) => gravarCadastro(req, res, async () => {
  const antes = await empresa.obterEmpresa(req.tenantId);
  const depois = await empresa.salvarEmpresa(req.tenantId, req.body ?? {});
  /* O nome do tenant acompanha o nome da empresa — é o rótulo que aparece no seletor de empresas
   * e na lista de "onde posso entrar". Sem isso, renomear a empresa mudaria a tela mas não o menu. */
  if (depois?.nome) await tenants.renomearTenant(req.tenantId, depois.nome);
  auditar(req, { entidade: 'Empresa', acao: 'Dados da empresa atualizados', valorAnterior: antes?.nome, valorNovo: depois?.nome });
  res.json(depois);
})));

/* Cada coleção do cadastro segue o mesmo formato: listar / salvar / excluir, todos por tenant.
 * A fábrica evita repetir cinco vezes o mesmo bloco e garante que nenhuma delas esqueça a
 * verificação de permissão, o controle de versão ou a auditoria. */
function rotasDeColecao(caminho, rotulo, api) {
  tenantRouter.get(`/${caminho}`, exigirPermissao(P.CONFIG_LER), rota(async (req, res) => {
    res.json(await api.listar(req.tenantId));
  }));

  tenantRouter.post(`/${caminho}`, exigirPermissao(P.CONFIG_ESCREVER), rota(async (req, res) => gravarCadastro(req, res, async () => {
    if (!req.body?.nome?.trim()) {
      return res.status(400).json({ erro: 'dados_invalidos', mensagem: `Informe o nome ${rotulo}.` });
    }
    const salvo = await api.salvar(req.tenantId, req.body);
    auditar(req, { entidade: `${rotulo} ${salvo.nome}`, acao: `${rotulo} salvo(a)`, valorNovo: salvo.nome });
    res.status(201).json(salvo);
  })));

  tenantRouter.delete(`/${caminho}/:id`, exigirPermissao(P.CONFIG_ESCREVER), rota(async (req, res) => gravarCadastro(req, res, async () => {
    await api.excluir(req.tenantId, req.params.id);
    auditar(req, { entidade: `${rotulo} ${req.params.id}`, acao: `${rotulo} excluído(a)` });
    res.status(204).end();
  })));
}

rotasDeColecao('unidades', 'Unidade', { listar: empresa.listarUnidades, salvar: empresa.salvarUnidade, excluir: empresa.excluirUnidade });
rotasDeColecao('setores', 'Setor', { listar: empresa.listarSetores, salvar: empresa.salvarSetor, excluir: empresa.excluirSetor });
rotasDeColecao('escalas', 'Escala', { listar: empresa.listarEscalas, salvar: empresa.salvarEscala, excluir: empresa.excluirEscala });
rotasDeColecao('colaboradores', 'Colaborador', { listar: empresa.listarColaboradores, salvar: empresa.salvarColaborador, excluir: empresa.excluirColaborador });

/* ---------------------------------------------------------------- regras */

tenantRouter.get('/regras', exigirPermissao(P.CONFIG_LER), rota(async (req, res) => {
  res.json(await empresa.obterRegras(req.tenantId));
}));

tenantRouter.put('/regras', exigirPermissao(P.CONFIG_ESCREVER), rota(async (req, res) => gravarCadastro(req, res, async () => {
  const { regras, causaOpts } = req.body ?? {};
  if (!regras || typeof regras.toleranceMin !== 'number') {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Regras inválidas.' });
  }
  const antes = await empresa.obterRegras(req.tenantId);
  const depois = await empresa.salvarRegras(req.tenantId, { regras, causaOpts });
  auditar(req, {
    entidade: 'Regras da empresa',
    acao: 'Regras atualizadas',
    valorAnterior: `tolerância ${antes?.regras.toleranceMin}min`,
    valorNovo: `tolerância ${depois?.regras.toleranceMin}min`,
  });
  res.json(depois);
})));

/* ---------------------------------------------------------------- integrações */

/* Só o STATUS ("esta empresa usa esta fonte?") é editável. Credencial nenhuma passa por aqui —
 * nem no corpo, nem no banco de configuração: segredo de integração mora em variável de ambiente
 * do servidor (ver INTEGRATIONS.md). */
tenantRouter.put('/integracoes/:id', exigirPermissao(P.CONFIG_ESCREVER), rota(async (req, res) => gravarCadastro(req, res, async () => {
  const { status } = req.body ?? {};
  if (status !== 'configurado' && status !== 'nao_configurado') {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Status de integração inválido.' });
  }
  const salva = await empresa.salvarIntegracao(req.tenantId, { id: req.params.id, status });
  if (!salva) return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Integração não encontrada.' });
  auditar(req, { entidade: `Integração ${salva.nome}`, acao: 'Status de integração alterado', valorNovo: status });
  res.json(salva);
})));

/* ---------------------------------------------------------------- usuários e convites */

function papelValido(papel) {
  return PAPEIS.includes(papel);
}

/* Vincula uma conta JÁ EXISTENTE à empresa. Não cria usuário: criar conta em nome de outra pessoa
 * significaria definir a senha dela. Para quem ainda não tem conta existe o convite. */
tenantRouter.post('/membros', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  const { email, papel } = req.body ?? {};
  if (!email || !papelValido(papel)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe o e-mail e um papel válido.' });
  }

  const u = await usuarios.buscarPorEmail(email);
  if (!u) {
    return res.status(404).json({
      erro: 'usuario_inexistente',
      mensagem: 'Nenhuma conta com este e-mail. Gere um convite para que a pessoa crie a dela.',
    });
  }

  await tenants.adicionarMembro(req.tenantId, u.id, papel);
  auditar(req, { entidade: `Usuário ${u.email}`, acao: 'Acesso concedido', valorNovo: papel });
  res.status(201).json(await tenants.listarMembros(req.tenantId));
}));

tenantRouter.put('/membros/:userId', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  const { papel } = req.body ?? {};
  if (!papelValido(papel)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Papel inválido.' });
  }

  /* Rebaixar o último administrador deixaria a empresa sem ninguém capaz de gerir acesso —
   * e desfazer isso exigiria mexer no banco à mão. */
  const atual = await tenants.papelNoTenant(req.params.userId, req.tenantId);
  if (atual === 'administrador' && papel !== 'administrador' && await tenants.contarAdministradores(req.tenantId) <= 1) {
    return res.status(400).json({ erro: 'ultimo_administrador', mensagem: 'A empresa precisa de pelo menos um administrador.' });
  }

  await tenants.adicionarMembro(req.tenantId, req.params.userId, papel);
  auditar(req, { entidade: `Usuário ${req.params.userId}`, acao: 'Papel alterado', valorAnterior: atual, valorNovo: papel });
  res.json(await tenants.listarMembros(req.tenantId));
}));

tenantRouter.delete('/membros/:userId', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  const atual = await tenants.papelNoTenant(req.params.userId, req.tenantId);
  if (!atual) return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Este usuário não tem acesso a esta empresa.' });
  if (atual === 'administrador' && await tenants.contarAdministradores(req.tenantId) <= 1) {
    return res.status(400).json({ erro: 'ultimo_administrador', mensagem: 'A empresa precisa de pelo menos um administrador.' });
  }

  await tenants.removerMembro(req.tenantId, req.params.userId);
  auditar(req, { entidade: `Usuário ${req.params.userId}`, acao: 'Acesso removido', valorAnterior: atual });
  res.json(await tenants.listarMembros(req.tenantId));
}));

tenantRouter.get('/convites', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  res.json(await convites.listarConvites(req.tenantId));
}));

/* Cria o convite, ENVIA por e-mail e devolve o código UMA vez.
 *
 * O código continua voltando na resposta mesmo quando o e-mail é enviado — de propósito. Se o
 * e-mail cair no spam ou o endereço estiver errado, o administrador ainda consegue entregar o
 * acesso pelo canal que já usa com a pessoa. Um sistema que depende exclusivamente do e-mail
 * chegar deixa alguém trancado do lado de fora quando ele não chega.
 *
 * `emailEnviado` diz a verdade sobre o que aconteceu: a interface mostra "enviamos" ou
 * "não conseguimos enviar, entregue o código" conforme o caso, nunca "enviamos" sem ter enviado. */
tenantRouter.post('/convites', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  const { email, papel } = req.body ?? {};
  if (!email || !papelValido(papel)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe o e-mail e um papel válido.' });
  }

  const convite = await convites.criarConvite(req.tenantId, { email, papel, criadoPor: req.usuario.id });
  const config = carregarConfig();
  const tenant = await tenants.buscarTenant(req.tenantId);

  let emailEnviado = false;
  let erroEmail = null;
  try {
    const msg = mensagemConvite({
      empresa: tenant?.nome ?? 'sua empresa',
      papel,
      url: `${config.urlPublica}/convite?codigo=${encodeURIComponent(convite.codigo)}`,
      quemConvidou: req.usuario.nome,
      validadeDias: convites.DIAS_VALIDADE,
    });
    const r = await enviarEmail(config, { para: convite.email, ...msg });
    emailEnviado = r.enviado;
  } catch (e) {
    console.error('[jornada360] falha ao enviar convite:', e.message);
    erroEmail = 'Não foi possível enviar o e-mail. Entregue o código à pessoa por outro canal.';
  }

  auditar(req, {
    entidade: `Convite para ${convite.email}`,
    acao: 'Convite emitido',
    valorNovo: papel,
    motivo: emailEnviado ? 'E-mail enviado.' : 'E-mail não enviado — código entregue na tela.',
  });

  res.status(201).json({ ...convite, emailEnviado, erroEmail });
}));

tenantRouter.delete('/convites/:id', exigirPermissao(P.USUARIOS_GERIR), rota(async (req, res) => {
  await convites.revogarConvite(req.tenantId, req.params.id);
  auditar(req, { entidade: `Convite ${req.params.id}`, acao: 'Convite revogado' });
  res.status(204).end();
}));

/* ---------------------------------------------------------------- dias processados */

/* `?completo=1` devolve os dias inteiros numa requisição só. A interface precisa de TODOS os dias
 * para calcular indicadores, ranking e score; pedir um por um geraria centenas de idas ao servidor
 * na abertura do Dashboard. O modo padrão (só as datas) continua para quem quer o índice. */
tenantRouter.get('/dias', exigirPermissao(P.DADOS_LER), rota(async (req, res) => {
  if (req.query.completo === '1') return res.json(await operacao.listarDiasCompletos(req.tenantId));
  res.json(await operacao.listarDatas(req.tenantId));
}));

tenantRouter.get('/dias/:dateKey', exigirPermissao(P.DADOS_LER), rota(async (req, res) => {
  const dia = await operacao.obterDia(req.tenantId, req.params.dateKey);
  if (!dia) return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Dia não processado.' });
  res.json(dia);
}));

tenantRouter.put('/dias/:dateKey', exigirPermissao(P.DADOS_ESCREVER), rota(async (req, res) => {
  const { snapshot, caseState } = req.body ?? {};
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Snapshot do dia inválido.' });
  }
  const dia = await operacao.salvarDia(req.tenantId, req.params.dateKey, snapshot, caseState);
  auditar(req, { entidade: `Dia ${req.params.dateKey}`, acao: 'Dia processado gravado', valorNovo: `${snapshot.items.length} registro(s)` });
  res.json(dia);
}));

tenantRouter.patch('/dias/:dateKey/casos/:chave', exigirPermissao(P.PENDENCIA_TRATAR), rota(async (req, res) => {
  const dia = await operacao.atualizarCaso(req.tenantId, req.params.dateKey, req.params.chave, req.body ?? {});
  if (!dia) return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Dia não processado.' });
  auditar(req, { entidade: `Caso ${req.params.dateKey} — ${req.params.chave}`, acao: 'Caso atualizado', valorNovo: JSON.stringify(req.body ?? {}) });
  res.json(dia);
}));

/* "Limpar histórico" — apaga os dias processados E as pendências derivadas deles. Deixar as
 * pendências para trás criaria uma fila apontando para dias que não existem mais. */
tenantRouter.delete('/dias', exigirPermissao(P.DADOS_ESCREVER), rota(async (req, res) => {
  const n = await operacao.limparDias(req.tenantId);
  await operacao.limparPendencias(req.tenantId);
  auditar(req, { entidade: 'Histórico processado', acao: 'Histórico limpo', valorAnterior: `${n} dia(s)` });
  res.json({ removidos: n });
}));

/* ---------------------------------------------------------------- pendências */

tenantRouter.get('/pendencias', exigirPermissao(P.PENDENCIA_LER), rota(async (req, res) => {
  res.json(await operacao.listarPendencias(req.tenantId));
}));

tenantRouter.put('/pendencias/:id', exigirPermissao(P.PENDENCIA_TRATAR), rota(async (req, res) => {
  const p = req.body ?? {};
  if (!p.id || p.id !== req.params.id || !p.data || !p.status) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Pendência inválida.' });
  }

  /* Revisão tem rota própria (permissão separada). Aceitar `aprovado`/`reprovado` por aqui deixaria
   * quem só pode TRATAR aprovar o próprio trabalho — exatamente o que a separação impede. */
  if (p.status === 'aprovado' || p.status === 'reprovado') {
    const anterior = await operacao.obterPendencia(req.tenantId, p.id);
    if (anterior?.status !== p.status) {
      return res.status(403).json({
        erro: 'sem_permissao',
        mensagem: 'Aprovar ou reprovar exige a ação de revisão.',
      });
    }
  }

  const atual = await operacao.obterPendencia(req.tenantId, p.id);
  const conflito = conflitoDeVersao(req, atual?.atualizadaEm);
  if (conflito) return res.status(409).json(conflito);

  /* Campos de revisão nunca vêm do cliente nesta rota: são preservados do que está gravado. */
  const salva = await operacao.salvarPendencia(req.tenantId, {
    ...p,
    revisadoPor: atual?.revisadoPor ?? null,
    revisadoEm: atual?.revisadoEm ?? null,
    observacaoRevisao: atual?.observacaoRevisao ?? null,
  });

  if (atual && atual.status !== salva.status) {
    auditar(req, {
      entidade: `Pendência ${salva.id}`,
      acao: 'Status da pendência alterado',
      valorAnterior: atual.status,
      valorNovo: salva.status,
      motivo: salva.resolucao ?? '',
    });
  }

  res.set('x-versao', salva.atualizadaEm);
  res.json(salva);
}));

/* Revisão é permissão SEPARADA de tratamento — quem executa não aprova o próprio trabalho. */
tenantRouter.post('/pendencias/:id/revisao', exigirPermissao(P.PENDENCIA_REVISAR), rota(async (req, res) => {
  const { decisao, observacao } = req.body ?? {};
  if (decisao !== 'aprovado' && decisao !== 'reprovado') {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Decisão de revisão inválida.' });
  }

  const atual = await operacao.obterPendencia(req.tenantId, req.params.id);
  if (!atual) return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Pendência não encontrada.' });

  /* `revisadoPor` vem da SESSÃO, nunca do corpo — é o que impede alguém registrar uma
   * aprovação em nome de outra pessoa. */
  const salva = await operacao.salvarPendencia(req.tenantId, {
    ...atual,
    status: decisao,
    revisadoPor: req.usuario.nome,
    revisadoEm: new Date().toISOString(),
    observacaoRevisao: observacao ?? null,
  });

  auditar(req, {
    entidade: `Pendência ${req.params.id}`,
    acao: decisao === 'aprovado' ? 'Pendência aprovada' : 'Pendência reprovada',
    valorAnterior: atual.status,
    valorNovo: decisao,
    motivo: observacao ?? '',
  });

  res.json(salva);
}));

/* ---------------------------------------------------------------- auditoria */

tenantRouter.get('/auditoria', exigirPermissao(P.AUDITORIA_LER), rota(async (req, res) => {
  res.json(await operacao.listarAuditoria(req.tenantId));
}));

/* Registro de exportação. É a única auditoria que o cliente PEDE para gravar — mas o autor
 * continua vindo da sessão, e a ação é fixa: o corpo só descreve o que foi exportado. */
tenantRouter.post('/exportacoes', exigirPermissao(P.RELATORIO_EXPORTAR), rota(async (req, res) => {
  const { relatorio, escopo } = req.body ?? {};
  if (!relatorio) return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Informe o relatório exportado.' });
  auditar(req, { entidade: `Relatório ${relatorio}`, acao: 'Relatório exportado', valorNovo: escopo ?? '' });
  res.status(201).json({ ok: true });
}));

/* ---------------------------------------------------------------- feedback do piloto */

/* Qualquer pessoa com acesso à empresa pode relatar — inclusive quem só lê.
 *
 * Isso é deliberado: num piloto, a pessoa que mais tropeça costuma ser justamente a que tem menos
 * permissão, e exigir papel para relatar silenciaria exatamente quem mais tem o que dizer. */
tenantRouter.post('/feedback', rota(async (req, res) => {
  const { categoria, mensagem, tela } = req.body ?? {};

  if (!piloto.CATEGORIAS_FEEDBACK.includes(categoria)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Escolha uma categoria válida.' });
  }
  if (!mensagem || mensagem.trim().length < 5) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Descreva um pouco mais para que possamos entender.' });
  }

  /* Quem relatou vem da SESSÃO, nunca do corpo — mesma regra da auditoria. */
  const entrada = await piloto.registrarFeedback(req.tenantId, {
    userId: req.usuario.id,
    usuario: req.usuario.nome,
    categoria,
    mensagem: String(mensagem).slice(0, 4000),
    tela: String(tela ?? '').slice(0, 120),
  });

  res.status(201).json(entrada);
}));

/* O que a própria empresa já enviou. Cada uma vê só o seu — é dado dela, sujeito às mesmas regras
 * de isolamento de todo o resto. Não existe rota que mostre o feedback de várias empresas juntas:
 * essa visão é do operador do piloto e sai pela CLI, que roda no servidor. */
tenantRouter.get('/feedback', rota(async (req, res) => {
  res.json(await piloto.listarFeedbackDaEmpresa(req.tenantId));
}));

/* ---------------------------------------------------------------- importação em lote */

/* Recebe o conteúdo que estava no navegador de alguém e o grava NESTE tenant. É o destino da
 * ferramenta "Migrar dados deste navegador" (ver MIGRACAO_LOCALSTORAGE.md).
 *
 * Devolve a CONTAGEM do que ficou gravado — é o que permite ao cliente conferir antes de oferecer
 * a limpeza local. Nada é apagado do navegador por esta rota. */
tenantRouter.post('/importar', exigirPermissao(P.DADOS_ESCREVER), rota(async (req, res) => {
  const { dias = [], pendencias = [] } = req.body ?? {};
  if (!Array.isArray(dias) || !Array.isArray(pendencias)) {
    return res.status(400).json({ erro: 'dados_invalidos', mensagem: 'Formato de importação inválido.' });
  }

  let diasGravados = 0;
  for (const d of dias) {
    if (!d?.dateKey || !d?.snapshot?.items) continue;
    await operacao.salvarDia(req.tenantId, d.dateKey, d.snapshot, d.caseState ?? {});
    diasGravados += 1;
  }

  let pendenciasGravadas = 0;
  for (const p of pendencias) {
    if (!p?.id || !p?.data || !p?.status) continue;
    await operacao.salvarPendencia(req.tenantId, p);
    pendenciasGravadas += 1;
  }

  auditar(req, {
    entidade: 'Importação de dados locais',
    acao: 'Dados do navegador importados',
    valorNovo: `${diasGravados} dia(s), ${pendenciasGravadas} pendência(s)`,
  });

  res.status(201).json({
    diasGravados,
    pendenciasGravadas,
    /* Contagem lida DO BANCO depois de gravar — conferir contra o que o cliente mandou é o que
     * transforma "enviei" em "está lá". */
    diasNoServidor: (await operacao.listarDatas(req.tenantId)).length,
    pendenciasNoServidor: (await operacao.listarPendencias(req.tenantId)).length,
  });
}));

/* ---------------------------------------------------------------- exclusão da empresa */

tenantRouter.delete('/', exigirPermissao(P.TENANT_EXCLUIR), rota(async (req, res) => {
  const t = await tenants.buscarTenant(req.tenantId);
  if (t?.environment === 'demo') {
    return res.status(400).json({ erro: 'protegido', mensagem: 'O ambiente de demonstração não pode ser excluído.' });
  }
  await tenants.excluirTenant(req.tenantId);
  res.status(204).end();
}));
