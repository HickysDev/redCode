// Processo de uma extensão do VS Code instalada no Red Code (um por extensão, aberto pelo extensoes.js com fork).
// Carrega a extensão com o módulo "vscode" de mentira (extensoes-vscode.js) e conversa com o servidor por IPC.
// No Red Code.exe o fork roda o próprio exe como Node (ELECTRON_RUN_AS_NODE): apaga a variável já, senão
// qualquer app Electron que a extensão abrir (ou os filhos dela) viraria Node também (mesmo motivo do segredos.js)
delete process.env.ELECTRON_RUN_AS_NODE;
const path = require('path');
const Module = require('module');
const { criaApi } = require('./extensoes-vscode');

let proximoPedido = 1;
const esperando = new Map();   // id -> { ok, falha }
let atende = null, extensao = null, contexto = null, saindo = false;

const manda = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* servidor fechou */ } };
const ponte = {
    pede: (tipo, dados) => new Promise((ok, falha) => { const id = proximoPedido++; esperando.set(id, { ok, falha }); manda({ t: 'pede', id, tipo, dados }); }),
    avisa: (tipo, dados) => manda({ t: 'avisa', tipo, dados }),
    log: (texto) => manda({ t: 'avisa', tipo: 'log', dados: { canal: '', nivel: 'warn', texto: String(texto) } }),
};

async function inicia(ext) {
    const { api, context, atende: a } = criaApi(ext, ponte);
    atende = a; contexto = context;
    // require('vscode') de dentro da extensão devolve a API de mentira
    const falso = path.join(__dirname, '__vscode_redcode__.js');
    require.cache[falso] = { id: falso, filename: falso, loaded: true, exports: api, children: [], paths: [] };
    const original = Module._resolveFilename;
    Module._resolveFilename = function (pedido, ...resto) { return pedido === 'vscode' ? falso : original.call(this, pedido, ...resto); };
    extensao = require(path.join(ext.pasta, ext.pkg.main || 'extension.js'));
    if (typeof extensao.activate === 'function') await extensao.activate(context);
    manda({ t: 'avisa', tipo: 'ativou', dados: {} });
}

process.on('message', async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'resposta') {
        const e = esperando.get(m.id);
        if (!e) return;
        esperando.delete(m.id);
        return m.erro ? e.falha(new Error(m.erro)) : e.ok(m.valor);
    }
    if (m.t === 'inicia') {
        try { await inicia(m.ext); }
        catch (e) { manda({ t: 'avisa', tipo: 'falhou', dados: { erro: String(e && e.stack || e) } }); }
        return;
    }
    if (m.t === 'pede') {
        try {
            const fn = atende && atende[m.tipo];
            if (!fn) throw new Error('pedido desconhecido: ' + m.tipo);
            manda({ t: 'resposta', id: m.id, valor: await fn(m.dados || {}) });
        } catch (e) { manda({ t: 'resposta', id: m.id, erro: String(e && e.message || e) }); }
    }
});

// Erro solto da extensão: vai para o log dela e o processo segue (como no VS Code)
process.on('uncaughtException', (e) => ponte.log('Erro na extensão: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => ponte.log('Erro na extensão (promessa): ' + (e && e.stack || e)));

// O servidor saiu (ou desligou a extensão): deactivate e dispose com prazo curto, depois sai
async function encerra() {
    if (saindo) return;
    saindo = true;
    setTimeout(() => process.exit(0), 2000).unref();
    try { if (extensao && typeof extensao.deactivate === 'function') await extensao.deactivate(); } catch (e) { /* saindo */ }
    try { for (const d of (contexto && contexto.subscriptions) || []) { try { d && d.dispose && d.dispose(); } catch (e) { /* segue */ } } } catch (e) { /* saindo */ }
    process.exit(0);
}
process.on('disconnect', encerra);
