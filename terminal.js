// Terminal de verdade (PowerShell) para a página, por WebSocket.
// É o que o navegador sozinho não faz: um console na pasta do projeto, com php, git, npm...
// Segurança: só aceita conexão da própria página (Host e Origin locais + token secreto que
// vai no HTML; outro site não consegue ler o HTML por causa do CORS) e só em pastas conhecidas.
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const os = require('os');

const MAXIMO = 8;
const abertos = new Set();

function liga(servidorHttp, { porta, token, pastaPermitida }) {
    const hostsOk = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    servidorHttp.on('upgrade', (req, socket, cabeca) => {
        const recusa = (motivo) => { socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); console.log('terminal recusado:', motivo); };
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return recusa('url'); }
        if (url.pathname !== '/ws/terminal') return recusa('caminho');
        const host = req.headers.host || '';
        if (!hostsOk.has(host)) return recusa('host');                     // contra DNS rebinding
        const origem = req.headers.origin || '';
        if (origem !== `http://${host}`) return recusa('origem');
        if (url.searchParams.get('token') !== token) return recusa('token');
        const cwd = url.searchParams.get('cwd') || os.homedir();
        if (!pastaPermitida(cwd)) return recusa('pasta');
        if (abertos.size >= MAXIMO) return recusa('limite');
        wss.handleUpgrade(req, socket, cabeca, (ws) => conecta(ws, cwd, url));
    });
}

function conecta(ws, cwd, url) {
    const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('cols')) || 100));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 24));
    let p;
    try {
        p = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cwd, cols, rows, env: process.env, useConpty: true });
    } catch (e) {
        ws.send(`\r\nNão consegui abrir o terminal: ${e.message}\r\n`);
        return ws.close();
    }
    p.__cwd = cwd;
    abertos.add(p);
    p.onData((dados) => { if (ws.readyState === 1) ws.send(dados); });
    p.onExit(() => { abertos.delete(p); if (ws.readyState === 1) ws.close(); });
    ws.on('message', (bruto) => {
        let m;
        try { m = JSON.parse(String(bruto)); } catch (e) { return; }
        if (m.tipo === 'entrada' && typeof m.dados === 'string') p.write(m.dados);
        else if (m.tipo === 'tamanho') {
            const c = Math.max(20, Math.min(400, Number(m.cols) || 0)), r = Math.max(5, Math.min(200, Number(m.rows) || 0));
            try { p.resize(c, r); } catch (e) { /* terminal já saiu */ }
        }
    });
    ws.on('close', () => { abertos.delete(p); try { p.kill(); } catch (e) { /* já saiu */ } });
}

// Pastas onde há terminal aberto (um terminal segura a pasta: não dá para remover um worktree com ele)
const pastasAbertas = () => [...abertos].map(p => p.__cwd).filter(Boolean);

module.exports = { liga, quantos: () => abertos.size, pastasAbertas };
