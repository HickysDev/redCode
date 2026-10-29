// Navegador embutido controlado pelo Claude (Fase 3).
// Uma janela isolada (sessão própria, sem preload, sem o token do painel) que o Claude das
// conversas do painel usa para abrir páginas, ler, clicar, digitar e tirar print, enquanto o
// usuário assiste. O controle é um servidor HTTP local com token, que só o servidor do painel
// (processo filho deste app) conhece.
const { BrowserWindow, session } = require('electron');
const http = require('http');
const crypto = require('crypto');

const fs = require('fs');
const path = require('path');

const MUNDO_ISOLADO = 1001;   // a página não enxerga nem altera o script que roda aqui
let janela = null;
let aoMudar = () => {};
let portasProibidas = [];     // porta do painel e do controle: o navegador nunca chega nelas
let dono = null;              // conversa que está usando o navegador agora
let ultimoUso = 0;
const LIBERA_DONO_MS = 2 * 60 * 1000;

// Endereços que o Claude pode abrir (ambientes de teste). Produção fica de fora.
// Configurável em desktop/navegador.json: { "permitidos": ["127.0.0.1", "localhost", "10.150.2.254:8800"] }
const ARQ_CONFIG = path.join(process.env.PAINEL_DADOS || __dirname, 'navegador.json');
function permitidos() {
    try { const c = JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')); if (Array.isArray(c.permitidos)) return c.permitidos.map(String); } catch (e) { /* padrão */ }
    return ['127.0.0.1', 'localhost', '10.150.2.254:8800'];
}
const ehLocal = (host) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host.toLowerCase());
function enderecoPermitido(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const porta = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (ehLocal(u.hostname) && portasProibidas.includes(porta)) return false;
    return permitidos().some(p => p.includes(':') && !p.startsWith('[') ? p.toLowerCase() === `${u.hostname}:${porta}`.toLowerCase() : p.toLowerCase() === u.hostname.toLowerCase());
}
function proibido(url) {
    // Qualquer requisição (página, iframe, fetch, imagem) às portas locais do painel e do controle
    try { const u = new URL(url); const porta = Number(u.port || (u.protocol === 'https:' ? 443 : 80)); return ehLocal(u.hostname) && portasProibidas.includes(porta); } catch (e) { return false; }
}

function sessao() {
    const s = session.fromPartition('persist:navegador');
    if (!s.__painelConfigurada) {
        s.__painelConfigurada = true;
        s.setPermissionRequestHandler((_wc, _p, responde) => responde(false));   // câmera, microfone, notificações...
        s.setPermissionCheckHandler(() => false);
        s.on('will-download', (ev, item) => { item.cancel(); });
        // Rede: painel e controle sempre bloqueados; página/iframe (inclusive redirect) só na lista branca
        s.webRequest.onBeforeRequest((det, responde) => {
            if (proibido(det.url)) return responde({ cancel: true });
            if ((det.resourceType === 'mainFrame' || det.resourceType === 'subFrame') && /^https?:/i.test(det.url) && !enderecoPermitido(det.url)) return responde({ cancel: true });
            responde({});
        });
        s.webRequest.onBeforeRedirect((det) => { if (proibido(det.redirectURL) && janela && !janela.isDestroyed()) janela.webContents.stop(); });
    }
    return s;
}

function garanteJanela(icone) {
    if (janela && !janela.isDestroyed()) return janela;
    janela = new BrowserWindow({
        width: 1280, height: 860, title: 'Navegador · Red Code', icon: icone, backgroundColor: '#ffffff', autoHideMenuBar: true,
        webPreferences: { session: sessao(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const soWeb = (url) => /^https?:\/\//i.test(url);
    janela.webContents.on('will-navigate', (ev, url) => { if (!soWeb(url)) ev.preventDefault(); });
    // Popups abrem na própria janela (uma só aba para o Claude acompanhar)
    janela.webContents.setWindowOpenHandler(({ url }) => { if (soWeb(url)) janela.loadURL(url); return { action: 'deny' }; });
    janela.on('closed', () => { janela = null; aoMudar(false); });
    aoMudar(true);
    return janela;
}

const espera = (ms) => new Promise(r => setTimeout(r, ms));
async function noIsolado(codigo) {
    return janela.webContents.executeJavaScriptInIsolatedWorld(MUNDO_ISOLADO, [{ code: codigo }], true);
}

// Documentos da página, incluindo iframes da mesma origem (as telas do Royal usam muitos),
// e a busca de um elemento marcado em qualquer um deles
const PRELUDIO = `
    const docs = [];
    const varre = (doc, rotulo, prof) => {
        docs.push({ doc, rotulo });
        if (prof > 4) return;
        for (const f of doc.querySelectorAll('iframe, frame')) {
            let d; try { d = f.contentDocument; } catch (e) { continue; }
            if (!d || !d.documentElement) continue;
            varre(d, (rotulo ? rotulo + ' > ' : '') + 'iframe ' + (f.id || f.name || f.getAttribute('src') || '').slice(0, 40), prof + 1);
        }
    };
    varre(document, '', 0);
    const acha = (ref) => { for (const x of docs) { const el = x.doc.querySelector('[data-painel-ref="' + ref + '"]'); if (el) return el; } return null; };
    // Posição na janela: soma o deslocamento de cada iframe até o topo
    const centro = (el) => {
        let w = el.ownerDocument.defaultView;
        const cadeia = [];
        while (w && w.frameElement) { cadeia.unshift(w.frameElement); w = w.parent; }
        cadeia.forEach(f => f.scrollIntoView({ block: 'center', inline: 'center' }));
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        let x = r.left + r.width / 2, y = r.top + r.height / 2;
        w = el.ownerDocument.defaultView;
        while (w && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left + w.frameElement.clientLeft; y += fr.top + w.frameElement.clientTop; w = w.parent; }
        return { x: Math.round(x), y: Math.round(y) };
    };
`;

// Marca os elementos interativos com data-painel-ref e devolve o texto + a lista numerada
const SCRIPT_LER = `(() => {${PRELUDIO}
    const visivel = (el) => { const r = el.getBoundingClientRect(); const s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const itens = [];
    const textos = [];
    let n = 0;
    for (const { doc, rotulo } of docs) {
        doc.querySelectorAll('[data-painel-ref]').forEach(e => e.removeAttribute('data-painel-ref'));
        const alvos = [...doc.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [contenteditable="true"]')].filter(visivel);
        for (const el of alvos) {
            if (n >= 200) break;
            n++;
            el.setAttribute('data-painel-ref', String(n));
            const tipo = el.tagName.toLowerCase() + (el.type ? ':' + el.type : '');
            const nome = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.name || el.id || el.title || el.getAttribute('href') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
            const valor = (el.tagName === 'INPUT' && el.type !== 'password') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? ' = "' + String(el.value || '').slice(0, 60) + '"' : '';
            itens.push('[' + n + '] ' + (rotulo ? '(' + rotulo + ') ' : '') + tipo + ' "' + nome + '"' + valor);
        }
        const t = doc.body ? doc.body.innerText.trim() : '';
        if (t) textos.push((rotulo ? '--- dentro de ' + rotulo + ' ---\\n' : '') + t);
    }
    return { titulo: document.title, url: location.href, texto: textos.join('\\n\\n').slice(0, 20000), elementos: itens };
})()`;

async function executa(m) {
    // Uma conversa por vez: quem usou por último é o dono até liberar ou ficar 2 min parado
    const conversa = String(m.conversa || 'sem-id');
    if (dono && dono !== conversa && Date.now() - ultimoUso < LIBERA_DONO_MS) {
        throw new Error(`O navegador está em uso por outra conversa do painel (${dono.slice(0, 8)}). Tente de novo em alguns minutos.`);
    }
    if (m.acao === 'liberar') { if (dono === conversa) dono = null; aoMudar(aberto()); return { ok: true }; }
    dono = conversa;
    ultimoUso = Date.now();
    aoMudar(true);
    if (m.acao === 'abrir') {
        if (!enderecoPermitido(String(m.url || ''))) throw new Error(`Endereço fora da lista permitida (${permitidos().join(', ')}). O navegador do painel só abre ambientes de teste; produção e outros sites ficam bloqueados. Para liberar outro, o usuário edita desktop/navegador.json.`);
        garanteJanela(m.icone);
        janela.show();
        try { await janela.loadURL(m.url); } catch (e) { if (!/ERR_ABORTED/.test(e.message)) throw new Error('Não abriu: ' + e.message); }
        return { titulo: janela.webContents.getTitle(), url: janela.webContents.getURL() };
    }
    if (!janela || janela.isDestroyed()) throw new Error('O navegador não está aberto. Use navegador_abrir primeiro.');
    if (m.acao === 'ler') return noIsolado(SCRIPT_LER);
    if (m.acao === 'clicar' || m.acao === 'digitar') {
        const ref = Number(m.ref);
        const info = await noIsolado(`(() => {${PRELUDIO}
            const el = acha(${ref});
            if (!el) return { erro: 'Elemento ${ref} não existe mais (a página mudou). Use navegador_ler de novo.' };
            const pos = centro(el);
            if (${m.acao === 'digitar'}) { if (el.type === 'password') return { erro: 'Campo de senha: o Claude não digita senhas. Peça ao usuário para entrar (logar) na janela do navegador do painel; a sessão fica guardada e depois você continua.' }; el.focus(); if ('value' in el && ${!!m.limpar}) el.value = ''; }
            return pos;
        })()`);
        if (info.erro) throw new Error(info.erro);
        if (m.acao === 'clicar') {
            await espera(120);
            for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) janela.webContents.sendInputEvent({ type, x: info.x, y: info.y, button: 'left', clickCount: 1 });
            await espera(600);
        } else {
            await janela.webContents.insertText(String(m.texto || ''));
            if (m.enviar) { janela.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); janela.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); janela.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await espera(800); }
        }
        return { titulo: janela.webContents.getTitle(), url: janela.webContents.getURL() };
    }
    if (m.acao === 'selecionar') {
        // <select> nativo: o popup não é página, então define o valor e dispara input/change
        const ref = Number(m.ref);
        const r = await noIsolado(`(() => {${PRELUDIO}
            const el = acha(${ref});
            if (!el || el.tagName !== 'SELECT') return { erro: 'O elemento ${ref} não é uma lista de seleção. Use navegador_ler de novo.' };
            const alvo = ${JSON.stringify(String(m.opcao || ''))}.trim().toLowerCase();
            const op = [...el.options].find(o => o.value.toLowerCase() === alvo) || [...el.options].find(o => o.text.trim().toLowerCase() === alvo) || [...el.options].find(o => o.text.trim().toLowerCase().includes(alvo));
            if (!op) return { erro: 'Opção não encontrada. Opções: ' + [...el.options].map(o => o.text.trim()).slice(0, 40).join(' | ') };
            el.value = op.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { escolhida: op.text.trim() };
        })()`);
        if (r.erro) throw new Error(r.erro);
        await espera(500);
        return { titulo: janela.webContents.getTitle(), url: janela.webContents.getURL(), escolhida: r.escolhida };
    }
    if (m.acao === 'avaliar') {
        // Checagem rápida no DOM (mundo isolado: vê a página, não as variáveis do JS dela).
        // Não serve para preencher senha (contornaria a regra do digitar)
        const expr = String(m.expressao || '');
        if (/password|passwordd|senha/i.test(expr) && /=(?!=)|setAttribute|value\s*\(/.test(expr.replace(/[=!]==?|=>/g, ''))) throw new Error('navegador_avaliar não escreve em campos de senha. Peça ao usuário para entrar na janela do navegador.');
        const r = await noIsolado(`(() => { try { const v = (function () { return (${String(m.expressao || 'null')}); })(); return { valor: JSON.stringify(v === undefined ? null : v).slice(0, 8000) }; } catch (e) { return { erro: String(e.message || e) }; } })()`);
        if (r.erro) throw new Error(r.erro);
        return { valor: r.valor };
    }
    if (m.acao === 'print') {
        const img = await janela.webContents.capturePage();
        return { imagem: img.resize({ width: Math.min(1280, img.getSize().width) }).toJPEG(70).toString('base64') };
    }
    if (m.acao === 'esperar') { await espera(Math.min(10000, Math.max(0, Number(m.ms) || 1000))); return { ok: true }; }
    throw new Error('Ação desconhecida.');
}

// Servidor de controle: 127.0.0.1, porta aleatória, token obrigatório, só POST JSON
function iniciaControle({ icone, avisa, proibirPortas = [] }) {
    if (avisa) aoMudar = avisa;
    portasProibidas = proibirPortas.map(Number);
    const token = crypto.randomBytes(32).toString('hex');
    const servidor = http.createServer((req, res) => {
        const fim = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const porta = servidor.address().port;
        if (req.headers.host !== `127.0.0.1:${porta}` || req.method !== 'POST' || req.headers['x-navegador-token'] !== token || !/application\/json/.test(req.headers['content-type'] || '')) return fim(403, { erro: 'recusado' });
        let corpo = '';
        req.on('data', d => { corpo += d; if (corpo.length > 1e6) req.destroy(); });
        req.on('end', async () => {
            let m;
            try { m = JSON.parse(corpo); } catch (e) { return fim(400, { erro: 'json' }); }
            try { fim(200, await executa({ ...m, icone })); } catch (e) { fim(400, { erro: e.message }); }
        });
    });
    return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => {
        portasProibidas.push(servidor.address().port);   // o navegador também não alcança o próprio controle
        resolve({ porta: servidor.address().port, token });
    }));
}

function mostra() { if (janela && !janela.isDestroyed()) { janela.show(); janela.focus(); } }
function aberto() { return !!(janela && !janela.isDestroyed()); }
// Na saída do app: fecha sem dar chance de um site segurar com "deseja sair desta página?"
function destroi() { if (janela && !janela.isDestroyed()) janela.destroy(); }
function ehNavegador(win) { return !!(janela && win === janela); }
function donoAtual() { return dono && Date.now() - ultimoUso < LIBERA_DONO_MS ? dono : null; }

module.exports = { iniciaControle, mostra, aberto, destroi, ehNavegador, donoAtual };
