// Red Code, app desktop (Fase 0).
// O Electron é só casca + lançador: o servidor continua no Node do sistema (igual ao de hoje),
// como processo filho. Assim o SDK e os processos do Claude não mudam, e reiniciar o servidor
// não derruba a janela.
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, shell, dialog, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
// Empacotado (Red Code.exe): dados, logs e ícone ficam em %APPDATA%\Red Code, fora da pasta do
// programa (que é trocada inteira a cada versão nova). Rodando pela pasta do projeto, nada muda.
const EMPACOTADO = app.isPackaged;
if (EMPACOTADO && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'Red Code'));
const PASTA_DADOS = EMPACOTADO ? app.getPath('userData') : __dirname;
if (EMPACOTADO) { fs.mkdirSync(PASTA_DADOS, { recursive: true }); process.env.PAINEL_DADOS = PASTA_DADOS; }
const navegador = require('./navegador');
let controleNavegador = null;   // { porta, token } do navegador embutido (passado ao servidor por env)

const PORTA = Number(process.env.PAINEL_PORTA || 4317);
const HOST = '127.0.0.1';                 // o servidor escuta só aqui (server.js)
const ORIGEM = `http://${HOST}:${PORTA}`;
const PASTA = path.join(__dirname, '..');
const ARQ_JANELA = path.join(PASTA_DADOS, 'janela.json');
const ARQ_LOG = path.join(PASTA_DADOS, 'servidor.log');
const CODIGO_REINICIO = 75;
// Identificador do app no Windows (agrupa janelas e avisos). Novo nome = sem ícone velho em cache
const AUMID = 'RedCode.App';
// Empacotado, o exe já sabe qual app abrir: sem o caminho do main.js
const ARGS_APP = EMPACOTADO ? [] : [path.join(__dirname, 'main.js')];
const ARGS_LOGIN = [...ARGS_APP, '--oculto'];
const INICIA_OCULTO = process.argv.includes('--oculto');

let janela = null;
let bandeja = null;
let servidor = null;          // processo filho (só quando o app é o dono do servidor)
let donoDoServidor = false;
let saindo = false;
let falhas = [];              // horários das quedas inesperadas
let vigiaExterno = null;

// Log do próprio app (eventos da janela, erros), ao lado do log do servidor
const ARQ_LOG_APP = path.join(PASTA_DADOS, 'app.log');
function registra(texto) {
    try { fs.appendFileSync(ARQ_LOG_APP, `${new Date().toLocaleString('pt-BR')} ${texto}\n`); } catch (e) { /* sem disco */ }
}
process.on('uncaughtException', (e) => registra('ERRO: ' + (e && e.stack || e)));

// ---------- Instância única ----------
const primeiraInstancia = app.requestSingleInstanceLock();
if (!primeiraInstancia) app.quit();
// Abrir de novo traz a janela; "--sair" pede ao app aberto para sair (com a mesma confirmação da bandeja)
else app.on('second-instance', (_ev, argv) => {
    if (argv.includes('--sair')) sairComConfirmacao();
    else if (argv.includes('--assumir-servidor')) assumeServidor();
    else mostraJanela();
});

// Modo anexado: pede ao servidor externo que se encerre quando nada estiver rodando;
// com a porta livre, o vigia do modo anexado sobe o servidor do app (que tem o navegador etc.)
let querAssumir = false, iniciadoVisto = null;
function assumeServidor(silencioso = false) {
    if (donoDoServidor) return;
    querAssumir = !silencioso;
    const corpo = JSON.stringify({ encerrar: true });
    const avisa = (texto) => dialog.showMessageBox({ type: 'info', title: 'Red Code', message: texto });
    const req = http.request(`${ORIGEM}/api/reiniciar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Painel': '1', 'Content-Length': Buffer.byteLength(corpo) }, timeout: 5000 }, (res) => {
        let texto = '';
        res.on('data', d => { texto += d; });
        res.on('end', () => {
            registra(`assumir servidor: ${res.statusCode}`);
            if (res.statusCode === 200) { if (!silencioso) avisa('Pedido feito: o servidor atual se encerra assim que nenhuma conversa ou terminal estiver em uso, e o app assume em seguida.'); }
            else { let erro = texto; try { erro = JSON.parse(texto).erro; } catch (e) { /* texto puro */ } avisa('Não deu para assumir o servidor: ' + erro + ' Feche o painel antigo e abra pelo app.'); }
        });
    });
    req.on('error', (e) => { registra('assumir servidor: ' + e.message); avisa('Não consegui falar com o servidor atual: ' + e.message); });
    req.end(corpo);
}

// ---------- Conversa com o servidor ----------
function pede(caminho, tempo = 3000) {
    return new Promise((resolve) => {
        const req = http.get(`${ORIGEM}${caminho}`, { timeout: tempo }, (res) => {
            let corpo = '';
            res.on('data', d => { corpo += d; });
            res.on('end', () => { try { resolve({ ok: res.statusCode === 200, dados: JSON.parse(corpo) }); } catch (e) { resolve({ ok: res.statusCode === 200, dados: null }); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}
const espera = (ms) => new Promise(r => setTimeout(r, ms));
async function esperaServidor(limiteMs = 20000) {
    const fim = Date.now() + limiteMs;
    while (Date.now() < fim) {
        const r = await pede('/api/versao', 1500);
        if (r && r.ok) return r.dados;
        await espera(400);
    }
    return null;
}
// Porta livre? (ninguém escutando)
function portaLivre() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(PORTA, HOST);
    });
}
// Mesmo critério de "viva" do servidor e do script de reinício
const estaViva = (c) => c.vivo || c.status === 'rodando' || c.status === 'parando';

// ---------- Servidor filho (lançador) ----------
function nodeDoSistema() {
    // Empacotado: o próprio Red Code.exe roda como Node (ELECTRON_RUN_AS_NODE), então o PC não
    // precisa ter Node instalado.
    if (EMPACOTADO) return process.execPath;
    // O Node do sistema, não o do Electron (process.execPath aqui é o electron.exe).
    // Caminho absoluto: no logon do Windows o PATH pode não estar completo.
    const candidatos = [process.env.PAINEL_NODE, 'C:\\Program Files\\nodejs\\node.exe'].filter(Boolean);
    return candidatos.find(c => fs.existsSync(c)) || 'node';
}
function sobeServidor() {
    // Log num descritor de arquivo (não por pipe): se o app morrer, o servidor não morre de EPIPE
    const log = fs.openSync(ARQ_LOG, 'a');
    fs.writeSync(log, `\n--- ${new Date().toLocaleString('pt-BR')} subindo o servidor ---\n`);
    servidor = spawn(nodeDoSistema(), [path.join(PASTA, 'server.js')], {
        cwd: PASTA,
        env: {
            ...process.env, PAINEL_PORTA: String(PORTA), PAINEL_LANCADOR: '1', PAINEL_DESKTOP: '1',
            ...(EMPACOTADO ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            ...(controleNavegador ? { PAINEL_NAVEGADOR_PORTA: String(controleNavegador.porta), PAINEL_NAVEGADOR_TOKEN: controleNavegador.token } : {}),
        },
        stdio: ['ignore', log, log],
        windowsHide: true,
    });
    fs.closeSync(log);
    donoDoServidor = true;
    pararVigia();
    // Node não encontrado ou sem permissão: o 'exit' pode nem disparar
    servidor.on('error', (e) => {
        servidor = null;
        mostraErro(`Não consegui iniciar o servidor (${e.message}). Confira se o Node está em C:\\Program Files\\nodejs ou defina PAINEL_NODE.`);
        atualizaBandeja();
    });
    servidor.on('exit', async (codigo) => {
        servidor = null;
        if (saindo) return;
        if (codigo === CODIGO_REINICIO) {
            // Reinício seguro pedido pela página: sobe de novo (a página recarrega sozinha)
            await espera(500);
            return tentaSubirOuAnexar();
        }
        // Queda inesperada (ou o script de reinício derrubou e subiu outro): até 3 tentativas em 5 s
        falhas = falhas.filter(t => Date.now() - t < 5000).concat(Date.now());
        if (falhas.length > 3) {
            mostraErro(`O servidor do painel parou (código ${codigo}). Veja o log em ${ARQ_LOG}.`);
            atualizaBandeja();
            return;
        }
        await espera(800);
        tentaSubirOuAnexar();
    });
    atualizaBandeja();
}
// Antes de subir: se outro painel já responde na porta, só anexa (não disputa a porta)
async function tentaSubirOuAnexar() {
    const outro = await pede('/api/versao', 1500);
    if (outro && outro.ok) { viraAnexado(); recarrega(); return; }
    if (!(await portaLivre())) { await espera(1000); return tentaSubirOuAnexar(); }
    sobeServidor();
    if (await esperaServidor()) recarrega();
}
// Modo anexar: vigia o servidor externo; se ele cair e a porta ficar livre, o app assume
function viraAnexado() {
    donoDoServidor = false;
    atualizaBandeja();
    pararVigia();
    let semResposta = 0;
    vigiaExterno = setInterval(async () => {
        const r = await pede('/api/versao', 2000);
        if (r && r.ok) {
            semResposta = 0;
            // Pediu para assumir e o servidor de fora só reiniciou (versão antiga, sem "encerrar"): pede de novo
            const iniciado = r.dados && r.dados.iniciado;
            if (querAssumir && iniciadoVisto && iniciado && iniciado !== iniciadoVisto) { registra('assumir: o servidor reiniciou, pedindo de novo'); querAssumir = false; assumeServidor(true); }
            if (iniciado) iniciadoVisto = iniciado;
            return;
        }
        if (++semResposta < 2 || !(await portaLivre())) return;
        pararVigia();
        sobeServidor();
        if (await esperaServidor()) recarrega();
    }, 5000);
}
function pararVigia() { if (vigiaExterno) { clearInterval(vigiaExterno); vigiaExterno = null; } }

// Encerra o servidor e os processos do Claude abaixo dele (no Windows, kill só pega o node.exe)
function encerraServidor() {
    return new Promise((resolve) => {
        if (!servidor) return resolve();
        execFile('taskkill', ['/T', '/F', '/PID', String(servidor.pid)], { windowsHide: true }, () => resolve());
    });
}

// ---------- Janela ----------
function leJanela() {
    try { return JSON.parse(fs.readFileSync(ARQ_JANELA, 'utf8')); } catch (e) { return { width: 1440, height: 900 }; }
}
function guardaJanela() {
    if (!janela) return;
    const salvo = janela.isMaximized() || janela.isMinimized() ? { ...leJanela(), maximizada: janela.isMaximized() } : { ...janela.getBounds(), maximizada: false };
    try { fs.writeFileSync(ARQ_JANELA, JSON.stringify(salvo)); } catch (e) { /* sem disco */ }
}
function criaJanela() {
    const salvo = leJanela();
    janela = new BrowserWindow({
        x: salvo.x, y: salvo.y, width: salvo.width || 1440, height: salvo.height || 900,
        minWidth: 900, minHeight: 600,
        title: 'Red Code',
        icon: icone(256),
        backgroundColor: '#141011',
        show: false,
        autoHideMenuBar: true,
        // backgroundThrottling false: escondida na bandeja, a página continua checando as conversas
        // no ritmo normal (sem isso o Chromium segura os timers e os avisos chegam atrasados)
        webPreferences: PREFERENCIAS_WEB(),
    });
    // maximize() também mostra a janela: só maximiza na hora de mostrar (respeita --oculto)
    maximizarAoMostrar = !!salvo.maximizada;
    janela.once('ready-to-show', () => { if (!INICIA_OCULTO) mostraJanela(); });

    // Só o painel (e o editor) abrem dentro do app; o resto vai para o navegador padrão
    protegeJanela(janela);
    // Só as permissões que a página usa: notificações e área de transferência (botões "Copiar").
    // O Electron pede o writeText como "clipboard-read"; a página é só o painel local (nada de fora carrega aqui).
    const PERMITIDAS = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read']);
    // "clipboard-read" só para a janela principal (o editor não precisa ler a área de transferência)
    const permitida = (wc, permissao) => PERMITIDAS.has(permissao) && (permissao !== 'clipboard-read' || (janela && wc === janela.webContents));
    janela.webContents.session.setPermissionRequestHandler((wc, permissao, responde) => {
        const ok = permitida(wc, permissao);
        if (!ok) registra(`permissão negada (pedido): ${permissao}`);
        responde(ok);
    });
    janela.webContents.session.setPermissionCheckHandler((wc, permissao) => {
        const ok = permitida(wc, permissao);
        if (!ok) registra(`permissão negada (checagem): ${permissao}`);
        return ok;
    });

    janela.on('close', (ev) => {
        registra(`janela: fechar (saindo=${saindo})`);
        if (!saindo) { ev.preventDefault(); janela.hide(); }   // fechar = esconder na bandeja
        try { guardaJanela(); } catch (e) { registra('guardaJanela: ' + e.message); }
    });
    // Destruída por outro caminho (ex.: window.close() da página): recria quando for chamada
    janela.on('closed', () => { registra('janela: destruída'); janela = null; });
    janela.on('resized', guardaJanela);
    janela.on('moved', guardaJanela);
    janela.loadURL(ORIGEM + '/');
}
let maximizarAoMostrar = false;
// Proteções de toda janela do app (principal e editor). Os handlers valem por webContents,
// então cada janela nova recebe os seus.
const PREFERENCIAS_WEB = () => ({
    preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
});
let caminhoIco = null;
// Ícone e nome na barra de tarefas: o Windows usa os dados de app da janela (senão mostra o ícone do electron.exe)
function marcaJanela(win) {
    try {
        win.setIcon(icone(256));
        if (process.platform === "win32" && caminhoIco) win.setAppDetails({ appId: AUMID, appIconPath: caminhoIco, appIconIndex: 0, relaunchCommand: [process.execPath, ...ARGS_APP].map(a => `"${a}"`).join(" "), relaunchDisplayName: "Red Code" });
    } catch (e) { registra("ícone da janela: " + e.message); }
}
function protegeJanela(win) {
    marcaJanela(win);
    // F5 / Ctrl+R recarregam a janela (como no navegador)
    win.webContents.on('before-input-event', (ev, entrada) => {
        if (entrada.type !== 'keyDown') return;
        if (entrada.key === 'F5' || (entrada.control && !entrada.shift && entrada.key.toLowerCase() === 'r')) { ev.preventDefault(); win.webContents.reload(); }
    });
    const dentro = (url) => url === ORIGEM || url.startsWith(ORIGEM + '/');
    // Fora da janela abre só: sites (navegador padrão) e arquivos no VS Code (vscode://file/...);
    // outros comandos do esquema vscode: (clonar repositório, extensões) ficam bloqueados
    const abreFora = (url) => { if (/^https?:\/\//i.test(url) || /^vscode:\/\/file\//i.test(url)) shell.openExternal(url); };
    win.webContents.on('will-navigate', (ev, url) => {
        if (dentro(url)) return;
        ev.preventDefault();
        abreFora(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        // O editor do painel abre numa janela do app; o resto vai para fora ou é negado
        if (url.startsWith(ORIGEM + '/?sessao=')) {
            // Conversa em outra janela (lado a lado)
            return { action: 'allow', overrideBrowserWindowOptions: {
                width: 1100, height: 860, title: 'Red Code', icon: icone(256), backgroundColor: '#141011', autoHideMenuBar: true, webPreferences: PREFERENCIAS_WEB(),
            } };
        }
        if (url.startsWith(ORIGEM + '/editor.html?')) {
            return { action: 'allow', overrideBrowserWindowOptions: {
                width: 1300, height: 860, title: 'Editor · Red Code', icon: icone(256), backgroundColor: '#141011', autoHideMenuBar: true, webPreferences: PREFERENCIAS_WEB(),
            } };
        }
        abreFora(url);
        return { action: 'deny' };
    });
    win.webContents.on('did-create-window', (filha) => protegeJanela(filha));
    // Página pediu para não fechar (alterações não salvas): no Electron isso cancela em silêncio, então pergunta
    win.webContents.on('will-prevent-unload', (ev) => {
        const dono = BrowserWindow.fromWebContents(win.webContents);
        const escolha = dialog.showMessageBoxSync(dono, {
            type: 'question', buttons: ['Sair sem salvar', 'Continuar editando'], defaultId: 1, cancelId: 1,
            title: 'Red Code', message: 'Há alterações não salvas.', detail: 'Se sair agora, elas se perdem.',
        });
        if (escolha === 0) ev.preventDefault();   // preventDefault aqui = ignorar o beforeunload e fechar
        else if (dono) dono.emit('painel-continuar-editando');
    });
}

function mostraJanela() {
    if (!janela || janela.isDestroyed()) { janela = null; criaJanela(); return janela.once('ready-to-show', () => mostraJanela()); }
    if (janela.isMinimized()) janela.restore();
    if (maximizarAoMostrar) { maximizarAoMostrar = false; janela.maximize(); }
    janela.show();
    janela.focus();
}
function alternaJanela() {
    if (janela && janela.isVisible() && janela.isFocused()) janela.hide(); else mostraJanela();
}
function recarrega() {
    if (janela) janela.loadURL(ORIGEM + '/');
}
function mostraErro(texto) {
    if (!janela) return;
    const html = `<body style="background:#141011;color:#f3e9e8;font:15px Segoe UI,sans-serif;padding:40px"><h2 style="color:#e8483d">Red Code</h2><p>${texto.replace(/[<>&]/g, '')}</p></body>`;
    janela.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    mostraJanela();
}
// A página pede para aparecer (clique numa notificação com a janela escondida)
ipcMain.on('painel:mostrar', (ev) => { if (janela && ev.sender === janela.webContents) mostraJanela(); });

// ---------- Ícone do Red Code: estrela de raios vermelha (desenhada em código) ----------
// Raios em cápsula saindo do centro, com comprimentos irregulares; 4x4 amostras por pixel (bordas lisas)
const RAIOS = [1, 0.8, 0.94, 0.74, 0.9, 0.82, 1, 0.77, 0.92, 0.72, 0.88, 0.84].map((comp, i) => ({ ang: (i * 30 + 8 + (i % 3) * 4) * Math.PI / 180, comp: comp * 0.84 }));
const VERMELHO = [220, 48, 38];
function cobreRaio(px, py, raio, espessura) {
    // distância do ponto ao segmento centro→ponta (cápsula)
    const ax = 0, ay = 0, bx = Math.cos(raio.ang) * raio.comp, by = Math.sin(raio.ang) * raio.comp;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
    return Math.hypot(px - (ax + t * bx), py - (ay + t * by)) <= espessura * (1 - 0.35 * t);
}
const cacheIcone = new Map();
function icone(tamanho) {
    if (cacheIcone.has(tamanho)) return cacheIcone.get(tamanho);
    const img = desenhaIcone(tamanho);
    cacheIcone.set(tamanho, img);
    return img;
}
function desenhaIcone(tamanho) {
    const buf = Buffer.alloc(tamanho * tamanho * 4);
    const escala = tamanho / 2 - 0.5, AM = 4;
    const espessura = tamanho <= 20 ? 0.16 : 0.12;   // ícone pequeno (bandeja) com raios mais grossos
    for (let y = 0; y < tamanho; y++) {
        for (let x = 0; x < tamanho; x++) {
            let dentro = 0;
            for (let sy = 0; sy < AM; sy++) for (let sx = 0; sx < AM; sx++) {
                const px = (x + (sx + 0.5) / AM - tamanho / 2) / escala, py = (y + (sy + 0.5) / AM - tamanho / 2) / escala;
                if (Math.hypot(px, py) < espessura * 1.1 || RAIOS.some(r => cobreRaio(px, py, r, espessura))) dentro++;
            }
            if (!dentro) continue;
            const i = (y * tamanho + x) * 4;
            buf[i] = VERMELHO[2]; buf[i + 1] = VERMELHO[1]; buf[i + 2] = VERMELHO[0]; buf[i + 3] = Math.round(255 * dentro / (AM * AM)); // BGRA
        }
    }
    return nativeImage.createFromBuffer(buf, { width: tamanho, height: tamanho });
}
// Arquivo .ico (PNG dentro) para o atalho do Menu Iniciar e a barra de tarefas
function arquivoIcone() {
    const destino = path.join(PASTA_DADOS, 'red-code.ico');
    try {
        const tamanhos = [16, 32, 48, 256];
        const pngs = tamanhos.map(t => icone(t).toPNG());
        const cab = Buffer.alloc(6 + 16 * pngs.length);
        cab.writeUInt16LE(0, 0); cab.writeUInt16LE(1, 2); cab.writeUInt16LE(pngs.length, 4);
        let deslocamento = cab.length;
        pngs.forEach((png, n) => {
            const o = 6 + 16 * n, t = tamanhos[n] >= 256 ? 0 : tamanhos[n];
            cab.writeUInt8(t, o); cab.writeUInt8(t, o + 1); cab.writeUInt8(0, o + 2); cab.writeUInt8(0, o + 3);
            cab.writeUInt16LE(1, o + 4); cab.writeUInt16LE(32, o + 6); cab.writeUInt32LE(png.length, o + 8); cab.writeUInt32LE(deslocamento, o + 12);
            deslocamento += png.length;
        });
        fs.writeFileSync(destino, Buffer.concat([cab, ...pngs]));
        return destino;
    } catch (e) { registra('ícone .ico: ' + e.message); return null; }
}

// ---------- Atalho no Menu Iniciar (necessário para os toasts com o nome do app) ----------
function garanteAtalhoMenuIniciar() {
    if (process.platform !== 'win32') return;
    const pastaProgramas = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const destino = path.join(pastaProgramas, 'Red Code.lnk');
    // O atalho antigo (nome anterior do app) sai do Menu Iniciar
    try { fs.unlinkSync(path.join(pastaProgramas, 'Painel Claude.lnk')); } catch (e) { /* não existia */ }
    const ico = arquivoIcone();
    caminhoIco = ico;
    const dados = {
        target: process.execPath,
        args: ARGS_APP.map(a => `"${a}"`).join(' '),
        cwd: PASTA,
        description: 'Red Code',
        appUserModelId: AUMID,
        ...(ico ? { icon: ico, iconIndex: 0 } : {}),
    };
    try {
        const atual = fs.existsSync(destino) ? shell.readShortcutLink(destino) : null;
        if (!atual || atual.target !== dados.target || atual.args !== dados.args || atual.appUserModelId !== AUMID || atual.icon !== dados.icon) {
            shell.writeShortcutLink(destino, atual ? 'replace' : 'create', dados);
        }
    } catch (e) { /* sem atalho: o toast pode sair sem o nome do app */ }
}

// ---------- Bandeja ----------
function iniciaComWindows() {
    return app.getLoginItemSettings({ path: process.execPath, args: ARGS_LOGIN }).openAtLogin;
}
function atualizaBandeja() {
    if (!bandeja) return;
    bandeja.setToolTip(`Red Code${donoDoServidor ? '' : ' (servidor externo)'}`);
    bandeja.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir o Red Code', click: mostraJanela },
        ...(navegador.aberto() ? [{ label: 'Mostrar o navegador do Claude', click: () => navegador.mostra() }] : []),
        { label: donoDoServidor ? (servidor ? 'Servidor: rodando' : 'Servidor: parado') : `Servidor externo (porta ${PORTA})`, enabled: false },
        // Depois de desistir (3 quedas seguidas), dá para tentar de novo sem fechar o app
        ...(donoDoServidor && !servidor ? [{ label: 'Tentar subir o servidor de novo', click: () => { falhas = []; tentaSubirOuAnexar(); } }] : []),
        // Anexado a um servidor de fora (ex.: aberto pelo lancador.js): o app assume quando estiver livre
        ...(!donoDoServidor ? [{ label: 'Assumir o servidor quando estiver livre', click: assumeServidor }] : []),
        { type: 'separator' },
        { label: 'Iniciar com o Windows', type: 'checkbox', checked: iniciaComWindows(), click: (item) => {
            // Sobe direto na bandeja (--oculto), com o caminho do main.js (sem ele abriria o Electron puro)
            app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: ARGS_LOGIN });
            atualizaBandeja();
        } },
        { type: 'separator' },
        { label: 'Sair', click: sairComConfirmacao },
    ]));
}

// Fecha as janelas do editor; devolve false se alguma recusou (alterações não salvas)
async function fechaJanelasFilhas() {
    navegador.destroi();
    const filhas = BrowserWindow.getAllWindows().filter(w => w !== janela && !w.isDestroyed() && !navegador.ehNavegador(w));
    for (const w of filhas) {
        // Decide pelo que você escolheu no diálogo (não por tempo): fechou, ou pediu para continuar editando
        const resultado = new Promise(r => {
            w.once('closed', () => r(true));
            w.once('painel-continuar-editando', () => r(false));
        });
        w.close();
        if (!(await Promise.race([resultado, espera(30000).then(() => false)]))) {
            if (!w.isDestroyed()) { w.show(); w.focus(); }
            return false;
        }
    }
    return true;
}

async function sairComConfirmacao() {
    if (donoDoServidor) {
        const r = await pede('/api/chat/estado');
        const vivas = r && Array.isArray(r.dados) ? r.dados.filter(estaViva) : [];
        const v = await pede('/api/versao');
        const terminais = (v && v.dados && v.dados.terminais) || 0;
        if (vivas.length || terminais) {
            mostraJanela();
            const partes = [vivas.length ? `${vivas.length} conversa(s) com processo do Claude aberto` : '', terminais ? `${terminais} terminal(is) aberto(s)` : ''].filter(Boolean);
            const { response } = await dialog.showMessageBox(janela, {
                type: 'warning', buttons: ['Sair mesmo assim', 'Cancelar'], defaultId: 1, cancelId: 1,
                title: 'Red Code',
                message: partes.join(' e ') + '.',
                detail: 'Sair encerra o servidor, esses processos e o que estiver rodando nos terminais. Para só esconder a janela, feche-a pelo X.',
            });
            if (response !== 0) return;
        }
    }
    // Primeiro as outras janelas (editor): se alguma tem alteração não salva e você escolher
    // continuar editando, a saída é cancelada ANTES de derrubar o servidor (senão não daria para salvar)
    if (!(await fechaJanelasFilhas())) return;
    saindo = true;
    pararVigia();
    if (donoDoServidor) await encerraServidor();
    app.quit();
}

// ---------- Início ----------
app.whenReady().then(async () => {
    if (!primeiraInstancia) return;
    app.setAppUserModelId(AUMID);
    garanteAtalhoMenuIniciar();
    bandeja = new Tray(icone(16));
    bandeja.on('click', mostraJanela);
    // Controle do navegador embutido: sobe antes do servidor (que recebe porta e token por env)
    controleNavegador = await navegador.iniciaControle({ icone: icone(256), avisa: () => atualizaBandeja(), proibirPortas: [...new Set([PORTA, 4317])] });
    // Porta já ocupada por um painel? Só abre a janela nele (modo anexar)
    const existente = await pede('/api/versao', 1500);
    if (existente && existente.ok) viraAnexado();
    else {
        sobeServidor();
        if (!(await esperaServidor())) { criaJanela(); mostraErro(`O servidor não respondeu na porta ${PORTA}. Veja o log em ${ARQ_LOG}.`); }
    }
    if (!janela) criaJanela();
    atualizaBandeja();
    if (!globalShortcut.register('Control+Shift+Space', alternaJanela)) console.log('Atalho Ctrl+Shift+Espaço já está em uso por outro programa');
});

app.on('before-quit', () => { saindo = true; guardaJanela(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
// Janela escondida não fecha o app (fica na bandeja)
app.on('window-all-closed', () => {});
