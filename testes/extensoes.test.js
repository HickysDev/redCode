// Teste do suporte a extensões (sem abrir o Red Code): instala um .vsix numa pasta de dados temporária e
// exercita o que a página faz. Não envia nada para fora: só abre e cancela caixas, lê painéis e configura.
// Uso: node testes/extensoes.test.js <caminho do .vsix>   (padrão: o Royal Trello Diário)
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const VSIX = process.argv[2] || path.join(os.tmpdir(), 'claude', 'zip-trello', 'conteudo', 'royal-trello-diario', 'royal-trello-diario-0.2.0.vsix');
const DADOS = fs.mkdtempSync(path.join(os.tmpdir(), 'redcode-ext-teste-'));
const ext = require('../extensoes');
const espera = (ms) => new Promise(r => setTimeout(r, ms));
let falhas = 0, oks = 0;
const confere = (ok, texto) => { if (ok) { oks++; console.log('  ok   ' + texto); } else { falhas++; console.log('  FALHA ' + texto); } };
async function ate(fn, ms = 15000) { const fim = Date.now() + ms; while (Date.now() < fim) { const v = await fn(); if (v) return v; await espera(100); } return null; }
// Eventos desde o último lido
let visto = 0;
async function proximosEventos(ms = 3000) { const r = await ext.espera(visto, ms); visto = r.versao; return r.eventos; }
const todos = [];
async function esperaEvento(filtro, ms = 15000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
        const achado = todos.find(filtro);
        if (achado) { todos.splice(todos.indexOf(achado), 1); return achado; }
        todos.push(...await proximosEventos(Math.max(50, fim - Date.now())));
    }
    return null;
}
// Zip simples (sem compressão) para o .vsix malicioso
function zip(entradas) {
    const locais = [], centrais = [];
    let off = 0;
    for (const [nome, texto] of entradas) {
        const n = Buffer.from(nome), d = Buffer.from(texto);
        const crc = zlib.crc32 ? zlib.crc32(d) : 0;
        const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc >>> 0, 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
        const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
        locais.push(l, n, d); centrais.push(c, n);
        off += 30 + n.length + d.length;
    }
    const cd = Buffer.concat(centrais);
    const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(entradas.length, 8); fim.writeUInt16LE(entradas.length, 10); fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(off, 16);
    return Buffer.concat([...locais, cd, fim]);
}

(async () => {
    console.log('pasta de dados de teste:', DADOS);
    ext.configura({ pasta: path.join(__dirname, '..'), pastaDados: DADOS, porta: 4399 });

    console.log('\n1. .vsix malicioso é recusado antes de gravar');
    const pkgMal = JSON.stringify({ name: 'mal', publisher: 'x', engines: { vscode: '^1.0.0' }, main: 'a.js' });
    for (const [nome, entradas] of [['../ no caminho', [['extension/package.json', pkgMal], ['extension/../../fora.txt', 'x'], ['extension/a.js', '']]], ['caminho absoluto', [['extension/package.json', pkgMal], ['C:/fora.txt', 'x']]], ['barra invertida', [['extension/package.json', pkgMal], ['extension\\..\\fora.txt', 'x']]], ['sem engines.vscode', [['extension/package.json', '{"name":"a","publisher":"b","main":"a.js"}'], ['extension/a.js', '']]]]) {
        let erro = '';
        try { ext.preparaInstalacao(zip(entradas)); } catch (e) { erro = e.message; }
        confere(!!erro, `${nome}: recusado (${erro})`);
    }
    confere(!fs.existsSync(path.join(DADOS, 'extensoes')) || fs.readdirSync(path.join(DADOS, 'extensoes')).length === 0, 'nada foi gravado na pasta de extensões');

    console.log('\n2. Instalar o .vsix de verdade');
    const previa = ext.preparaInstalacao(fs.readFileSync(VSIX));
    confere(previa.id === 'royaltecidos.royal-trello-diario' && !!previa.token, `prévia: ${previa.nome} ${previa.versao} (${previa.id})`);
    await ext.confirmaInstalacao(previa.token);
    const ativa = await ate(() => (ext.estado().extensoes[0] || {}).status === 'ativa');
    const st = ext.estado().extensoes[0];
    confere(!!ativa, `extensão ativou (status ${st.status}${st.erro ? ', erro ' + st.erro : ''})`);
    confere(st.containers.length === 1 && st.containers[0].views.map(v => v.tipo).join(',') === 'webview,arvore', 'container com webview "Diário" e árvore "Textos prontos"');
    confere(st.comandos.length === 6 && !st.comandos.some(c => c.id === 'royalTrello.abrirRascunho'), `6 comandos no menu (o de when:false fica de fora)`);
    const id = st.id;

    console.log('\n3. Árvore e webview');
    confere(!!await esperaEvento(e => e.tipo === 'arvore' && e.viewId === 'royalTrello.textosProntos'), 'árvore avisou que mudou');
    const itens = await ext.arvore(id, 'royalTrello.textosProntos');
    confere(Array.isArray(itens), `árvore respondeu (${itens.length} itens)`);
    await ext.visibilidade(id, 'royalTrello.painel', true);
    confere(!!await esperaEvento(e => e.tipo === 'webview' && e.viewId === 'royalTrello.painel'), 'webview resolvida: HTML chegou');
    const html = ext.htmlWebview(id, 'royalTrello.painel');
    const iPonte = html.indexOf('acquireVsCodeApi'), iCsp = html.indexOf('Content-Security-Policy');
    confere(iPonte > 0 && iCsp > iPonte, 'ponte acquireVsCodeApi injetada antes do CSP da extensão');
    confere(/http:\/\/127\.0\.0\.1:4399\/api\/extensoes\/arquivo\/royaltecidos\.royal-trello-diario\/media\/painel\.js/.test(html), 'asWebviewUri aponta para a rota de arquivos');
    await ext.mensagem(id, 'royalTrello.painel', { tipo: 'pronto' });
    const estadoPainel = await esperaEvento(e => e.tipo === 'mensagem' && e.msg && e.msg.tipo === 'estado');
    confere(!!estadoPainel, 'painel → extensão → painel: o estado voltou' + (estadoPainel ? ` (credenciais: ${JSON.stringify(estadoPainel.msg.estado.credenciais || estadoPainel.msg.estado.conta || '').slice(0, 60)})` : ''));

    console.log('\n4. Arquivos da webview');
    const css = ext.arquivo(id, 'media/painel.css');
    confere(css && css.tipo.startsWith('text/css'), 'media/painel.css servido como text/css');
    for (const rel of ['../extensoes.json', '..%5cextensoes.json', 'media%2F..%2F..%2Fextensoes.json', '..%2F..%2Fextensoes-dados', 'package.json%00.css']) confere(ext.arquivo(id, rel) === null, `recusa ${rel}`);

    console.log('\n5. Configuração');
    const cfg = ext.configDe(id);
    confere(cfg.length >= 10 && cfg.some(c => c.chave === 'royalTrello.agendamento.ativo' && c.valor === false), `${cfg.length} configurações com os padrões`);
    let erroCfg = '';
    try { await ext.mudaConfig(id, 'royalTrello.agendamento.antecedenciaMinutos', -5); } catch (e) { erroCfg = e.message; }
    confere(!!erroCfg, `valor abaixo do mínimo recusado (${erroCfg})`);
    await ext.mudaConfig(id, 'royalTrello.agendamento.antecedenciaMinutos', 20);
    confere(ext.configDe(id).find(c => c.chave === 'royalTrello.agendamento.antecedenciaMinutos').valor === 20, 'valor gravado (20)');
    const depoisConfig = await esperaEvento(e => e.tipo === 'mensagem' && e.msg && e.msg.tipo === 'estado');
    confere(!!depoisConfig && depoisConfig.msg.estado.agendamento && depoisConfig.msg.estado.agendamento.antecedenciaMinutos === 20, 'a extensão recebeu onDidChangeConfiguration e o painel mostra 20');

    console.log('\n6. Cofre (DPAPI)');
    await ext._paraTestes.segredo(id, 'store', 'teste', 'segredo-123');
    const arqSeg = fs.readFileSync(path.join(DADOS, 'extensoes-dados', id, 'segredos.json'), 'utf8');
    confere(!arqSeg.includes('segredo-123') && !arqSeg.includes(Buffer.from('segredo-123').toString('base64')), 'arquivo não tem o texto puro');
    const req = require.resolve('../extensoes'); delete require.cache[req];
    var ext2 = require('../extensoes');   // cache vazio: força decifrar
    ext2.configura({ pasta: path.join(__dirname, '..'), pastaDados: DADOS, porta: 4398 });
    confere(await ext2._paraTestes.segredo(id, 'get', 'teste') === 'segredo-123', 'decifra de novo (outro processo do servidor)');
    await ext._paraTestes.segredo(id, 'delete', 'teste');
    confere(!fs.readFileSync(path.join(DADOS, 'extensoes-dados', id, 'segredos.json'), 'utf8').includes('teste'), 'apagou');

    console.log('\n7. Caixa de digitar pelo comando, pendente e cancelada');
    ext.comando(id, 'royalTrello.configurarCredenciais');
    const pend = await esperaEvento(e => e.tipo === 'pendente' && e.pedido === 'entrada');
    confere(!!pend && /chave de API/i.test(pend.dados.titulo), 'caixa "chave de API (1/2)" ficou pendente' + (pend ? ` (${pend.dados.titulo})` : ''));
    confere(ext.estado().pendentes.length === 1, 'aparece no estado (para re-mostrar depois de recarregar a página)');
    ext.responde(pend.id, null);
    confere(!!await esperaEvento(e => e.tipo === 'pendente-fim' && e.id === pend.id) && ext.estado().pendentes.length === 0, 'cancelada: saiu da lista');
    let erroCmd = '';
    try { ext.comando(id, 'workbench.action.quit'); } catch (e) { erroCmd = e.message; }
    confere(!!erroCmd, `comando que não é da extensão recusado (${erroCmd})`);

    console.log('\n8. Desligar, ligar e encerrar sem sobrar processo');
    await ext.liga(id, false);
    confere(ext.estado().extensoes[0].status === 'parada', 'desligada');
    await ext.liga(id, true);
    confere(!!await ate(() => ext.estado().extensoes[0].status === 'ativa'), 'ligada de novo e ativa');
    const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    const pids = [...ext._paraTestes.pids(), ...ext2._paraTestes.pids()];
    ext.encerraTodas(); ext2.encerraTodas();
    await espera(800);
    confere(pids.length >= 1 && pids.every(p => !vivo(p)), `processos da extensão: ${pids.length} vivos antes, ${pids.filter(vivo).length} depois de encerrar`);

    console.log(`\n${oks} ok, ${falhas} falha(s)`);
    try { fs.rmSync(DADOS, { recursive: true, force: true }); } catch (e) { /* o Windows solta a pasta logo depois */ }
    process.exit(falhas ? 1 : 0);
})().catch(e => { console.log('ERRO', e.stack); process.exit(1); });
