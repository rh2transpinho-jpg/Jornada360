/* Middlewares de autenticação, resolução de tenant e autorização.
 *
 * Este é o arquivo mais importante do backend para segurança. Três garantias, nesta ordem:
 *
 * 1. `autenticar`  — só passa quem tem sessão válida.
 * 2. `resolverTenant` — o tenant vem da URL, mas o acesso é validado contra as memberships do
 *    usuário AUTENTICADO. Nunca se confia no id que o cliente mandou.
 * 3. `exigirPermissao` — o papel daquele usuário NAQUELE tenant precisa ter a permissão.
 *
 * O ponto 2 é o que impede IDOR: pedir `/api/tenants/<id-de-outro-cliente>/pendencias` devolve
 * 404, não os dados. 404 e não 403 de propósito — 403 confirmaria que aquele tenant existe. */
import { sessaoValida } from '../repositories/userRepository.js';
import { papelNoTenant } from '../repositories/tenantRepository.js';
import { podeExecutar } from '../lib/permissoes.js';
import { situacaoTenant } from '../repositories/pilotoRepository.js';
import { exigeCabecalhoAntiCsrf, temCabecalhoAntiCsrf, tokenDaRequisicao } from '../lib/sessaoHttp.js';

/* `autenticar` e `resolverTenant` consultam o banco e passaram a ser assíncronos.
 *
 * Os dois são exportados envolvidos em `rota()` — que encaminha uma promessa rejeitada para o
 * tratador de erros. Sem esse envelope, uma falha de banco DENTRO do middleware de autenticação
 * ficaria pendurada sem resposta: o cliente esperaria para sempre, e nada apareceria no log. */
async function autenticarAsync(req, res, next) {
  const { token, origem } = tokenDaRequisicao(req);
  const sessao = await sessaoValida(token);
  if (!sessao) {
    return res.status(401).json({ erro: 'nao_autenticado', mensagem: 'Sessão inválida ou expirada.' });
  }

  /* Sessão por cookie é anexada pelo navegador sozinha — é o que torna CSRF possível. Exigir um
   * cabeçalho que só JavaScript de mesma origem consegue definir fecha o vetor sem precisar de
   * token sincronizado em formulário. Sessão por Bearer não passa por aqui: um token que o cliente
   * anexa à mão nunca viaja sozinho. */
  if (exigeCabecalhoAntiCsrf(req, origem) && !temCabecalhoAntiCsrf(req)) {
    return res.status(403).json({
      erro: 'origem_nao_confiavel',
      mensagem: 'Requisição bloqueada por proteção contra falsificação de origem.',
    });
  }

  req.usuario = sessao.usuario;
  req.origemSessao = origem;
  next();
}

async function resolverTenantAsync(req, res, next) {
  const tenantId = req.params.tenantId;
  const papel = await papelNoTenant(req.usuario.id, tenantId);

  /* Sem membership o recurso "não existe" para este usuário. Devolver 403 revelaria que o tenant
   * existe e que ele apenas não tem acesso — informação que um atacante usaria para enumerar
   * clientes. */
  if (!papel) {
    return res.status(404).json({ erro: 'nao_encontrado', mensagem: 'Empresa não encontrada.' });
  }

  /* Empresa suspensa: acesso recusado, dados intactos.
   *
   * Aqui o código é 403 e NÃO 404, ao contrário do caso acima — e a diferença é deliberada. Um 404
   * existe para não revelar que a empresa de OUTRA pessoa existe. Nesta situação a pessoa tem
   * vínculo legítimo: a empresa é dela, e sumir com ela sem explicação transformaria uma pendência
   * comercial num aparente defeito do sistema. Ela precisa saber que o acesso foi suspenso e com
   * quem falar.
   *
   * A verificação fica AQUI, antes de qualquer rota, e não em cada uma: uma rota nova que
   * esquecesse de checar seria um caminho aberto para uma empresa suspensa continuar operando. */
  const situacao = await situacaoTenant(tenantId);
  if (situacao?.status === 'suspensa') {
    return res.status(403).json({
      erro: 'empresa_suspensa',
      mensagem: 'O acesso desta empresa está suspenso. Seus dados estão preservados — fale com o Jornada360 para reativar.',
      motivo: situacao.motivo ?? null,
      suspensaEm: situacao.suspensaEm ?? null,
    });
  }

  req.tenantId = tenantId;
  req.papel = papel;
  next();
}

export const autenticar = rota(autenticarAsync);
export const resolverTenant = rota(resolverTenantAsync);

export function exigirPermissao(permissao) {
  return (req, res, next) => {
    if (!podeExecutar(req.papel, permissao)) {
      return res.status(403).json({
        erro: 'sem_permissao',
        mensagem: 'Seu perfil de acesso não permite esta ação.',
      });
    }
    next();
  };
}

/* Controle de concorrência otimista.
 *
 * O PROBLEMA QUE RESOLVE: até a Fase 3 cada pessoa trabalhava no próprio navegador, então não
 * existia colisão. Com servidor, duas pessoas podem abrir a mesma tela, e a segunda a salvar
 * apagaria a alteração da primeira sem que ninguém percebesse. Perder trabalho em silêncio é
 * inaceitável num sistema de auditoria.
 *
 * COMO FUNCIONA: quem leu recebeu um carimbo de versão. Ao gravar, devolve esse carimbo no
 * cabeçalho `x-versao`. Se o carimbo atual do servidor for outro, alguém gravou no meio: a resposta
 * é 409 e o cliente pede para a pessoa recarregar em vez de sobrescrever.
 *
 * O cabeçalho é OPCIONAL de propósito: um cliente de API que não participa do controle (script de
 * migração, integração) continua funcionando. A interface web sempre envia. */
export function conflitoDeVersao(req, versaoAtual) {
  const enviada = req.headers['x-versao'];
  if (enviada === undefined || enviada === '') return null;
  if (String(enviada) === String(versaoAtual ?? '')) return null;
  return {
    erro: 'conflito',
    mensagem: 'Alguém alterou este registro enquanto você editava. Recarregue para ver a versão atual.',
    versaoAtual: versaoAtual ?? '',
  };
}

/* Tratamento de erro central. Duas responsabilidades:
 * - nunca devolver stack trace ao cliente (vaza estrutura interna e caminhos do servidor);
 * - registrar o erro completo no log do servidor, onde ele é útil. */
export function tratarErros(err, _req, res, _next) {
  console.error('[jornada360] erro não tratado:', err);
  res.status(500).json({
    erro: 'erro_interno',
    mensagem: 'Não foi possível concluir a operação. Tente novamente.',
  });
}

/* Envolve um handler async para que uma rejeição vá para `tratarErros` em vez de derrubar o
 * processo — sem isso, um `await` que falha em rota async fica pendurado sem resposta. */
export function rota(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
