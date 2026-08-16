#!/usr/bin/env node
/* Operação do programa piloto.
 *
 *   npm run piloto                          panorama de todas as empresas
 *   npm run piloto liberar <email> <empresa>  cria a conta e a empresa, devolve a senha inicial
 *   npm run piloto convidar <id> <email> [papel]  gera um convite para uma empresa existente
 *   npm run piloto suspender <id> [motivo]  bloqueia o acesso, PRESERVA os dados
 *   npm run piloto reativar <id>            devolve o acesso
 *   npm run piloto nota <id> <texto>        anotação interna sobre o cliente
 *   npm run piloto feedback [situacao]      feedback de todas as empresas
 *   npm run piloto feedback-marcar <id> <situacao> [nota]
 *
 * POR QUE UMA CLI, E NÃO UM PAINEL DE ADMINISTRAÇÃO
 * -------------------------------------------------
 * Um painel "vê tudo de todos" precisaria de rotas HTTP que atravessam empresas. Essas rotas
 * ficariam expostas para sempre, e bastaria uma falha de autorização nelas para vazar dados entre
 * clientes — um risco permanente criado pela conveniência de uma fase que vai durar poucos meses.
 *
 * Esta CLI roda NO SERVIDOR, com acesso ao banco, e não existe pela rede. Para meia dúzia de
 * empresas, é o suficiente. Quando forem muitas, um painel se justifica — e aí se constrói com o
 * cuidado que ele exige. */
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import * as piloto from '../server/repositories/pilotoRepository.js';
import * as tenants from '../server/repositories/tenantRepository.js';
import * as usuarios from '../server/repositories/userRepository.js';
import * as convites from '../server/repositories/conviteRepository.js';
import { migrar, fecharBanco } from '../server/db/index.js';

await migrar();

const [comando = 'panorama', ...args] = process.argv.slice(2);

const C = { verde: '\x1b[32m', amarelo: '\x1b[33m', vermelho: '\x1b[31m', cinza: '\x1b[90m', reset: '\x1b[0m', negrito: '\x1b[1m' };

function dias(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
}

function descreverAtividade(ultima) {
  const d = dias(ultima);
  if (d === null) return `${C.cinza}nunca usou${C.reset}`;
  if (d === 0) return `${C.verde}hoje${C.reset}`;
  if (d === 1) return `${C.verde}ontem${C.reset}`;
  if (d <= 7) return `${C.verde}há ${d} dias${C.reset}`;
  if (d <= 21) return `${C.amarelo}há ${d} dias${C.reset}`;
  return `${C.vermelho}há ${d} dias${C.reset}`;
}

async function acharEmpresa(idOuNome) {
  const todas = await piloto.panorama();
  const porId = todas.find((t) => t.id === idOuNome);
  if (porId) return porId;

  const alvo = idOuNome.toLowerCase();
  const achadas = todas.filter((t) => t.nome.toLowerCase().includes(alvo));
  if (achadas.length === 1) return achadas[0];
  if (achadas.length > 1) {
    console.error(`\n✗ "${idOuNome}" corresponde a mais de uma empresa:`);
    for (const t of achadas) console.error(`    ${t.id}  ${t.nome}`);
    console.error('  Use o identificador.\n');
    return null;
  }
  console.error(`\n✗ Nenhuma empresa encontrada para "${idOuNome}".\n`);
  return null;
}

/* ---------------------------------------------------------------- panorama */

async function panorama() {
  const lista = (await piloto.panorama()).filter((t) => t.environment !== 'demo');

  if (lista.length === 0) {
    console.log('\nNenhuma empresa no piloto ainda.');
    console.log('Libere a primeira com:  npm run piloto liberar <email> "<nome da empresa>"\n');
    return;
  }

  const ativas = lista.filter((t) => t.status === 'ativa');
  const suspensas = lista.filter((t) => t.status === 'suspensa');

  console.log(`\n${C.negrito}PROGRAMA PILOTO — ${lista.length} empresa(s)${C.reset}   ${ativas.length} ativa(s) · ${suspensas.length} suspensa(s)\n`);

  for (const t of lista) {
    const marca = t.status === 'ativa' ? `${C.verde}●${C.reset}` : `${C.vermelho}○${C.reset}`;
    console.log(`${marca} ${C.negrito}${t.nome}${C.reset}  ${C.cinza}${t.id}${C.reset}`);
    console.log(
      `    ${t.usuarios} usuário(s) · ${t.colaboradores} colaborador(es) · ${t.dias} dia(s) processado(s) · ` +
        `${t.pendencias} pendência(s) (${t.pendenciasResolvidas} tratada(s))`,
    );
    console.log(`    última atividade: ${descreverAtividade(t.ultimaAtividade)}   ${C.cinza}entrou em ${String(t.criadoEm).slice(0, 10)}${C.reset}`);

    if (t.feedbackAberto > 0) console.log(`    ${C.amarelo}${t.feedbackAberto} feedback(s) sem resposta${C.reset}`);
    if (t.status === 'suspensa') {
      console.log(`    ${C.vermelho}SUSPENSA${C.reset} em ${String(t.suspensaEm).slice(0, 10)}${t.motivoSuspensao ? ` — ${t.motivoSuspensao}` : ''}`);
      console.log(`    ${C.cinza}os dados estão preservados; reative com: npm run piloto reativar ${t.id}${C.reset}`);
    }
    if (t.notaPiloto) console.log(`    ${C.cinza}nota: ${t.notaPiloto}${C.reset}`);
    console.log('');
  }

  /* Quem está parado é o que exige ação num piloto: um cliente que não usa não valida nada, e o
   * silêncio dele é a informação mais fácil de deixar passar. */
  const paradas = ativas.filter((t) => {
    const d = dias(t.ultimaAtividade);
    return d === null || d > 7;
  });
  if (paradas.length > 0) {
    console.log(`${C.amarelo}Atenção:${C.reset} ${paradas.length} empresa(s) ativa(s) sem uso há mais de 7 dias — vale um contato.`);
    for (const t of paradas) console.log(`  · ${t.nome} (${descreverAtividade(t.ultimaAtividade)})`);
    console.log('');
  }

  const resumo = await piloto.resumoFeedback();
  if (resumo.length > 0) {
    console.log(`${C.negrito}Feedback recebido${C.reset}`);
    for (const r of resumo) {
      console.log(`  ${(piloto.ROTULO_CATEGORIA[r.categoria] ?? r.categoria).padEnd(26)} ${String(r.total).padStart(3)}  (${r.abertos} em aberto, ${r.empresas} empresa(s))`);
    }
    console.log(`\n  Detalhe: npm run piloto feedback\n`);
  }
}

/* ---------------------------------------------------------------- liberar */

async function liberar() {
  const [email, ...restoNome] = args;
  const nomeEmpresa = restoNome.join(' ').trim();

  if (!email || !nomeEmpresa) {
    console.error('\nUso: npm run piloto liberar <email-do-responsavel> "<nome da empresa>"\n');
    process.exitCode = 1;
    return;
  }

  if (await usuarios.buscarPorEmail(email)) {
    console.error(`\n✗ Já existe uma conta com ${email}.`);
    console.error('  Para dar acesso a outra empresa, use:  npm run piloto convidar <id-da-empresa> ' + email + '\n');
    process.exitCode = 1;
    return;
  }

  /* Senha inicial gerada aqui e mostrada UMA vez. A pessoa troca no primeiro acesso — e como o
   * sistema tem recuperação de senha por e-mail, ela nunca fica presa a esta senha. */
  const senhaInicial = randomBytes(9).toString('base64url');

  const usuario = await usuarios.criarUsuario({ email, nome: email.split('@')[0], senha: senhaInicial });
  const tenant = await tenants.criarTenant({ nome: nomeEmpresa, criadoPorUserId: usuario.id, papel: 'administrador' });

  console.log(`\n${C.verde}✓ Empresa liberada para o piloto${C.reset}\n`);
  console.log(`  Empresa:        ${tenant.nome}`);
  console.log(`  Identificador:  ${tenant.id}`);
  console.log(`  Responsável:    ${email}  (administrador)`);
  console.log(`\n  ${C.negrito}Senha inicial: ${senhaInicial}${C.reset}`);
  console.log(`  ${C.cinza}Esta senha não será mostrada de novo. Entregue ao cliente e peça que troque no primeiro acesso.${C.reset}`);
  console.log(`  ${C.cinza}Se ela se perder, o cliente usa "Esqueci minha senha" na tela de entrada.${C.reset}\n`);
  console.log(`  A empresa nasce VAZIA: sem colaboradores, sem setores, sem dados. Nada é copiado.\n`);
}

/* ---------------------------------------------------------------- convidar */

async function convidar() {
  const [idOuNome, email, papel = 'administrador'] = args;
  if (!idOuNome || !email) {
    console.error('\nUso: npm run piloto convidar <id-ou-nome-da-empresa> <email> [papel]\n');
    process.exitCode = 1;
    return;
  }

  const empresa = await acharEmpresa(idOuNome);
  if (!empresa) {
    process.exitCode = 1;
    return;
  }

  const convite = await convites.criarConvite(empresa.id, { email, papel, criadoPor: null });
  console.log(`\n${C.verde}✓ Convite gerado para ${empresa.nome}${C.reset}\n`);
  console.log(`  Para:    ${convite.email}  (${papel})`);
  console.log(`  Válido até: ${String(convite.expiraEm).slice(0, 10)}`);
  console.log(`\n  ${C.negrito}Código: ${convite.codigo}${C.reset}`);
  console.log(`  ${C.cinza}Mostrado uma única vez. O convite é nominal e de uso único.${C.reset}`);
  console.log(`  ${C.cinza}A pessoa abre /convite, cola o código e cria a conta ali — não precisa de conta antes.${C.reset}`);
  console.log(`  ${C.cinza}Quem já tem conta usa o mesmo endereço, ou "Entrar em outra empresa".${C.reset}\n`);
}

/* ---------------------------------------------------------------- suspender / reativar */

async function suspender() {
  const [idOuNome, ...motivo] = args;
  if (!idOuNome) {
    console.error('\nUso: npm run piloto suspender <id-ou-nome> [motivo]\n');
    process.exitCode = 1;
    return;
  }

  const empresa = await acharEmpresa(idOuNome);
  if (!empresa) {
    process.exitCode = 1;
    return;
  }
  if (empresa.status === 'suspensa') {
    console.log(`\n${empresa.nome} já está suspensa.\n`);
    return;
  }

  console.log(`\nSuspender o acesso de ${C.negrito}${empresa.nome}${C.reset}?`);
  console.log(`  ${empresa.usuarios} usuário(s) perderão o acesso imediatamente (as sessões abertas são encerradas).`);
  console.log(`  ${C.verde}TODOS OS DADOS SÃO PRESERVADOS${C.reset} — ${empresa.dias} dia(s), ${empresa.pendencias} pendência(s), auditoria.`);
  console.log(`  Reversível a qualquer momento com: npm run piloto reativar ${empresa.id}\n`);

  const leitor = createInterface({ input: process.stdin, output: process.stdout });
  const resposta = await leitor.question('Digite SUSPENDER para confirmar: ');
  leitor.close();
  if (resposta.trim() !== 'SUSPENDER') {
    console.log('\nCancelado. Nada foi alterado.\n');
    return;
  }

  await piloto.suspender(empresa.id, motivo.join(' ') || null);
  console.log(`\n${C.verde}✓ Acesso suspenso.${C.reset} Os dados continuam no banco e entram nos backups normalmente.\n`);
}

async function reativar() {
  const [idOuNome] = args;
  if (!idOuNome) {
    console.error('\nUso: npm run piloto reativar <id-ou-nome>\n');
    process.exitCode = 1;
    return;
  }

  const empresa = await acharEmpresa(idOuNome);
  if (!empresa) {
    process.exitCode = 1;
    return;
  }

  await piloto.reativar(empresa.id);
  console.log(`\n${C.verde}✓ ${empresa.nome} reativada.${C.reset}`);
  console.log(`  Os usuários precisam entrar de novo (as sessões foram encerradas na suspensão).\n`);
}

async function anotar() {
  const [idOuNome, ...texto] = args;
  if (!idOuNome || texto.length === 0) {
    console.error('\nUso: npm run piloto nota <id-ou-nome> <texto>\n');
    process.exitCode = 1;
    return;
  }
  const empresa = await acharEmpresa(idOuNome);
  if (!empresa) {
    process.exitCode = 1;
    return;
  }
  await piloto.anotar(empresa.id, texto.join(' '));
  console.log(`\n✓ Nota registrada para ${empresa.nome}.\n`);
}

/* ---------------------------------------------------------------- feedback */

async function verFeedback() {
  const [situacao] = args;
  if (situacao && !piloto.SITUACOES_FEEDBACK.includes(situacao)) {
    console.error(`\nSituação inválida. Use: ${piloto.SITUACOES_FEEDBACK.join(' | ')}\n`);
    process.exitCode = 1;
    return;
  }

  const lista = await piloto.listarTodoFeedback({ situacao });
  if (lista.length === 0) {
    console.log(`\nNenhum feedback${situacao ? ` com situação "${situacao}"` : ''}.\n`);
    return;
  }

  console.log(`\n${C.negrito}${lista.length} feedback(s)${situacao ? ` — ${situacao}` : ''}${C.reset}\n`);
  for (const f of lista) {
    const cor = f.situacao === 'aberto' ? C.amarelo : f.situacao === 'resolvido' ? C.verde : C.cinza;
    console.log(`${cor}[${f.situacao}]${C.reset} ${C.negrito}${piloto.ROTULO_CATEGORIA[f.categoria] ?? f.categoria}${C.reset}  ${C.cinza}${f.id}${C.reset}`);
    console.log(`  ${f.empresa} · ${f.usuario} · ${String(f.criadoEm).slice(0, 16).replace('T', ' ')}${f.tela ? ` · tela: ${f.tela}` : ''}`);
    console.log(`  ${f.mensagem.split('\n').join('\n  ')}`);
    if (f.notaInterna) console.log(`  ${C.cinza}nota: ${f.notaInterna}${C.reset}`);
    console.log('');
  }
  console.log(`${C.cinza}Marcar: npm run piloto feedback-marcar <id> <${piloto.SITUACOES_FEEDBACK.join('|')}> [nota]${C.reset}\n`);
}

async function marcarFeedback() {
  const [id, situacao, ...nota] = args;
  if (!id || !piloto.SITUACOES_FEEDBACK.includes(situacao)) {
    console.error(`\nUso: npm run piloto feedback-marcar <id> <${piloto.SITUACOES_FEEDBACK.join('|')}> [nota]\n`);
    process.exitCode = 1;
    return;
  }
  await piloto.atualizarSituacaoFeedback(id, situacao, nota.join(' ') || null);
  console.log(`\n✓ Feedback ${id} marcado como "${situacao}".\n`);
}

/* ---------------------------------------------------------------- despacho */

const comandos = {
  panorama,
  liberar,
  convidar,
  suspender,
  reativar,
  nota: anotar,
  feedback: verFeedback,
  'feedback-marcar': marcarFeedback,
};

const executar = comandos[comando];

if (!executar) {
  console.error(`\nComando desconhecido: "${comando}"`);
  console.error(`Disponíveis: ${Object.keys(comandos).join(', ')}\n`);
  process.exitCode = 1;
} else {
  await executar();
}

await fecharBanco();
