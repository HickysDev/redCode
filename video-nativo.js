const { spawn } = require('child_process');
const path = require('path');

let recebe = null, proc = null, abasVistas = new Set(), ultimoUso = 0, timerOcioso = null, falhas = 0, esperaReligar = 0;

const APP_NAVEGADOR = /(^|\.)(chrome|msedge|brave|opera|vivaldi|firefox|arc|yandex|chromium|zen|librewolf|waterfox|floorp)(\.|$)|308046B0AF4A39CB|TheBrowserCompany/i;

function configura(fnRecebe) { recebe = fnRecebe; }
const ehNavegador = (app) => APP_NAVEGADOR.test(String(app || ''));

function entrega(videos) {
    const agora = new Set();
    for (const v of videos) {
        agora.add(Number(v.aba));
        try { recebe(v); } catch (e) { }
    }
    for (const aba of abasVistas) if (!agora.has(aba)) { try { recebe({ aba, fim: true }); } catch (e) { } }
    abasVistas = agora;
}

function liga() {
    if (proc || !recebe || process.platform !== 'win32' || Date.now() < esperaReligar) return;
    const meu = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'video-navegador.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc = meu;
    let resto = '';
    meu.stdout.setEncoding('utf8');
    meu.stdout.on('data', (pedaco) => {
        // PROCESSO ANTIGO SAINDO DEPOIS DO DESLIGA NAO PODE RECOLOCAR ABAS NEM DERRUBAR O NOVO
        if (proc !== meu) return;
        const linhas = (resto + pedaco).split(/\r?\n/);
        resto = linhas.pop();
        for (const linha of linhas) {
            let o;
            try { o = JSON.parse(linha); } catch (e) { continue; }
            falhas = 0;
            if (Array.isArray(o.videos)) entrega(o.videos);
        }
    });
    const morreu = () => {
        if (proc !== meu) return;
        proc = null;
        entrega([]);
        if (Date.now() - ultimoUso < 60000) { falhas++; esperaReligar = Date.now() + Math.min(300000, 5000 * 2 ** (falhas - 1)); }
    };
    meu.on('exit', morreu);
    meu.on('error', morreu);
    meu.stdin.on('error', () => { /* processo já fechou */ });
}

function desliga() {
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.stdin.end(); } catch (e) { /* já fechado */ }
    setTimeout(() => { try { p.kill(); } catch (e) { /* já saiu */ } }, 3000);
    entrega([]);
}

function usado() {
    ultimoUso = Date.now();
    liga();
    clearTimeout(timerOcioso);
    timerOcioso = setTimeout(desliga, 60000);
    timerOcioso.unref();
}

module.exports = { configura, usado, desliga, ehNavegador };
