// Ponte com o VS Code aberto: o Claude das conversas do painel enxerga o que a extensão do
// Claude Code no VS Code oferece (erros do editor, seleção, abas). O VS Code publica um canal
// local (~/.claude/ide/<porta>.lock, WebSocket com token); o painel repassa só ferramentas
// de leitura e "abrir arquivo". Nada que salve, feche abas ou execute código.
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASTA_TRAVAS = path.join(os.homedir(), '.claude', 'ide');
const PERMITIDAS = new Set(['getDiagnostics', 'getCurrentSelection', 'getLatestSelection', 'getOpenEditors', 'openFile', 'getWorkspaceFolders']);
const conexoes = new Map();   // porta -> Promise<conexão>

// Trava mais recente de um VS Code aberto na pasta (ou numa pasta que contém a do projeto)
function travaDaPasta(cwd) {
    const alvo = path.resolve(cwd).toLowerCase();
    let lista = [];
    try { lista = fs.readdirSync(PASTA_TRAVAS).filter(f => f.endsWith('.lock')); } catch (e) { return null; }
    const travas = lista.map(f => {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(PASTA_TRAVAS, f), 'utf8'));
            return { porta: Number(f.replace('.lock', '')), token: j.authToken, pastas: (j.workspaceFolders || []).map(w => path.resolve(w).toLowerCase()), m: fs.statSync(path.join(PASTA_TRAVAS, f)).mtimeMs };
        } catch (e) { return null; }
    }).filter(t => t && t.token && t.porta && t.pastas.some(p => alvo === p || alvo.startsWith(p + path.sep)));
    return travas.sort((a, b) => b.m - a.m);
}

function conecta(trava) {
    if (conexoes.has(trava.porta)) return conexoes.get(trava.porta);
    const promessa = new Promise((resolve, rejeita) => {
        const ws = new WebSocket(`ws://127.0.0.1:${trava.porta}`, { headers: { 'x-claude-code-ide-authorization': trava.token } });
        let id = 0;
        const pend = new Map();
        const chama = (method, params) => new Promise((ok, falha) => {
            const n = ++id;
            pend.set(n, { ok, falha });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
            setTimeout(() => { if (pend.delete(n)) falha(new Error('O VS Code não respondeu.')); }, 15000);
        });
        ws.on('message', (m) => { let d; try { d = JSON.parse(String(m)); } catch (e) { return; } const p = pend.get(d.id); if (p) { pend.delete(d.id); d.error ? p.falha(new Error(d.error.message || 'erro')) : p.ok(d.result); } });
        const morreu = () => { conexoes.delete(trava.porta); for (const p of pend.values()) p.falha(new Error('Conexão com o VS Code caiu.')); pend.clear(); };
        ws.on('close', morreu);
        ws.on('error', (e) => { morreu(); rejeita(e); });
        ws.on('open', async () => {
            try {
                await chama('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'painel-claude', version: '1.0.0' } });
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
                resolve({ chama, fecha: () => ws.close() });
            } catch (e) { rejeita(e); }
        });
    });
    promessa.catch(() => conexoes.delete(trava.porta));
    conexoes.set(trava.porta, promessa);
    return promessa;
}

// Chama uma ferramenta do VS Code aberto na pasta; tenta as travas da mais nova para a mais velha
async function chamaVscode(cwd, ferramenta, argumentos = {}) {
    if (!PERMITIDAS.has(ferramenta)) throw new Error('Ferramenta do VS Code não permitida pelo painel.');
    const travas = travaDaPasta(cwd) || [];
    if (!travas.length) return null;
    let ultimoErro;
    for (const t of travas.slice(0, 4)) {
        try {
            const c = await conecta(t);
            const r = await c.chama('tools/call', { name: ferramenta, arguments: argumentos });
            return (r && r.content || []).map(x => x.text || '').join('\n');
        } catch (e) { ultimoErro = e; }
    }
    if (ultimoErro && /ECONNREFUSED/.test(ultimoErro.message)) return null;
    throw ultimoErro || new Error('VS Code indisponível.');
}

function disponivel(cwd) { return !!(travaDaPasta(cwd) || []).length; }

module.exports = { chamaVscode, disponivel };
