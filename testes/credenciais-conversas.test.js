// Credenciais do Trello achadas nas conversas (credenciais-conversas.js), só com conversas e valores INVENTADOS numa
// pasta temporária. Uso: node testes/credenciais-conversas.test.js
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const cc = require('../credenciais-conversas');
let oks = 0, falhas = 0; const confere = (ok, t) => { ok ? oks++ : falhas++; console.log((ok ? '  ok   ' : '  FALHA ') + t); };
const hex = (n) => crypto.randomBytes(n / 2).toString('hex');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'redcode-cred-teste-'));
const chaveA = hex(32), chaveB = hex(32), tokenA = hex(64), tokenNovo = 'ATTA' + crypto.randomBytes(36).toString('hex'), hashSolto = hex(32), chaveSemTrello = hex(32);
const linha = (texto) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: texto }] } });
const grava = (pasta, id, linhas, quando) => { fs.mkdirSync(path.join(raiz, pasta), { recursive: true }); const a = path.join(raiz, pasta, id + '.jsonl'); fs.writeFileSync(a, linhas.map(linha).join('\n') + '\n'); fs.utimesSync(a, quando, quando); };
const agora = Date.now() / 1000;
grava('c--projeto-a', 'sessao-1', [`curl "https://api.trello.com/1/members/me?key=${chaveA}&token=${tokenA}"`], agora - 3600);
grava('c--projeto-a', 'sessao-2', [`$trello = ["key" => "${chaveB}", "token" => "${tokenNovo}"]; // Trello`, `commit ${hashSolto}`], agora - 60);
grava('c--projeto-b', 'sessao-3', [`TRELLO_KEY=${chaveA}`, 'TRELLO_TOKEN=' + tokenA], agora - 7200);
grava('c--outro', 'sessao-4', [`key=${chaveSemTrello} (outra API, sem falar do serviço)`], agora);
const titulos = { 'sessao-1': 'Integração Trello', 'sessao-2': 'Config do Trello no PHP', 'sessao-3': 'Variáveis', 'sessao-4': 'Outra coisa' };

console.log('1. Qual credencial a caixa está pedindo');
confere(cc.tipoDoPedido('Trello: chave de API (1/2)', 'Chave de API do app Power-Up') === 'trello-chave', 'título da chave → trello-chave');
confere(cc.tipoDoPedido('Trello: token pessoal (2/2)', 'Cole o token gerado') === 'trello-token', 'título do token → trello-token');
confere(cc.tipoDoPedido('Adicionar card pelo link', 'Link do card (https://trello.com/c/...)') === null, 'pedido de link do card → nenhuma');

console.log('2. Chaves achadas');
const chaves = cc.procura('trello-chave', [raiz], (id) => titulos[id]);
const mascaras = chaves.map(c => c.mascara);
confere(chaves.length === 2, `duas chaves distintas (${chaves.length})`);
confere(chaves[0].mascara === chaveB.slice(0, 4) + '…' + chaveB.slice(-4) && chaves[0].conversa === 'Config do Trello no PHP', 'a mais recente primeiro, com o nome da conversa');
confere(chaves.find(c => c.mascara.startsWith(chaveA.slice(0, 4))).conversas === 2, 'a mesma chave em duas conversas aparece uma vez (contando 2)');
confere(!mascaras.some(m => m.startsWith(hashSolto.slice(0, 4)) || m.startsWith(chaveSemTrello.slice(0, 4))), 'hash solto e conversa que não fala de Trello ficam de fora');
confere(!JSON.stringify(chaves).includes(chaveA) && !JSON.stringify(chaves).includes(chaveB), 'a lista não leva o valor inteiro');

console.log('3. Tokens achados');
const tokens = cc.procura('trello-token', [raiz], (id) => titulos[id]);
confere(tokens.length === 2 && tokens.some(t => t.mascara.startsWith('ATTA')), `token antigo (64 hex) e novo (ATTA…): ${tokens.map(t => t.mascara).join(', ')}`);
confere(!JSON.stringify(tokens).includes(tokenA), 'a lista não leva o valor inteiro');

console.log('4. Valor só pelo id (clique)');
confere(cc.valor(chaves[0].id) === chaveB, 'o id devolve a chave certa');
confere(cc.valor(tokens.find(t => t.mascara.startsWith('ATTA')).id) === tokenNovo, 'o id devolve o token novo certo');
confere(cc.valor('naoexiste') === null, 'id desconhecido: nada');

console.log(`\n${oks} ok, ${falhas} falha(s)`);
fs.rmSync(raiz, { recursive: true, force: true });
process.exit(falhas ? 1 : 0);
