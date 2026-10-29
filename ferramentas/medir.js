// Abre o painel no Edge invisível (modo de depuração) e roda um trecho de JavaScript na página.
// Uso: node ferramentas/medir.js "<expressão JS>" [arquivo-print.png] [largura] [altura]
// Serve para medir posições de elementos e tirar prints sem o navegador do app.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const expressao = process.argv[2] || 'document.title';
const print = process.argv[3];
const largura = Number(process.argv[4] || 1440), altura = Number(process.argv[5] || 900);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const porta = 9333;
const perfil = path.join(os.tmpdir(), 'painel-edge-medir');

const proc = spawn(edge, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`,
    `--window-size=${largura},${altura}`, process.env.PAINEL_URL || 'http://localhost:4317/'], { stdio: 'ignore' });
const espera = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    let alvo;
    for (let i = 0; i < 40 && !alvo; i++) {
        await espera(250);
        try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json`)).json()).find(t => t.type === 'page'); } catch (e) { /* ainda abrindo */ }
    }
    if (!alvo) throw new Error('Edge não abriu');
    const ws = new WebSocket(alvo.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0;
    const pendentes = new Map();
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (pendentes.has(d.id)) { pendentes.get(d.id)(d); pendentes.delete(d.id); } });
    const chama = (method, params = {}) => new Promise(r => { const n = ++id; pendentes.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    await espera(4000); // deixa a página carregar as sessões
    const r = await chama('Runtime.evaluate', { expression: `(async () => { ${expressao.includes('return') ? expressao : 'return ' + expressao} })()`, awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result, null, 2));
    if (print) {
        const img = await chama('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(print, Buffer.from(img.result.data, 'base64'));
        console.log('print:', print);
    }
    ws.close();
    proc.kill();
    process.exit(0);
})().catch(e => { console.error(e.message); proc.kill(); process.exit(1); });
