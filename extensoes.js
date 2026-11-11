// Extensões do VS Code (.vsix) no Red Code, suporte leve: instala, roda cada uma num processo próprio
// (extensoes-host.js, com o "vscode" de mentira do extensoes-vscode.js) e leva os painéis, avisos e caixas de
// digitar dela para a página. Só extensões de painel + comandos + configurações (as de editor não funcionam).
// Segurança: instalar sempre passa pela confirmação da página; o .vsix é lido aqui (zip) e cada nome é conferido
// ANTES de gravar qualquer arquivo; o HTML das webviews é servido em sandbox (origem opaca, sem acesso à API do
// painel); senhas da extensão são cifradas com o DPAPI do usuário do Windows e nunca saem do servidor.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { fork, spawn, execFile, execFileSync } = require('child_process');

let PASTA = null, PASTA_DADOS = null, PORTA = 4317;
const hosts = new Map();        // id -> { proc, status, erro, html: Map(viewId -> {html, versao}), badges: Map, logs: [], pedidos: Map, intencional }
const pendentes = new Map();    // id -> { extId, tipo, dados, responde }
const instalacoes = new Map();  // token -> { buf, info, em }
let proximo = 1;

// ---------- Eventos para a página (long-poll, padrão do /api/midia?versao=) ----------
let versao = 0;
const eventos = [];             // { n, ... } (os últimos 400)
const esperandoEventos = new Set();
function emite(ev) {
    eventos.push({ n: ++versao, ...ev });
    if (eventos.length > 400) eventos.shift();
    for (const fn of esperandoEventos) fn();
    esperandoEventos.clear();
}
function espera(desde, prazo) {
    desde = Number(desde) || 0;
    const pronto = () => {
        // A página ficou para trás demais (ou o servidor reiniciou): ela pede o estado inteiro de novo
        if (desde > versao || (eventos.length && desde < eventos[0].n - 1)) return { versao, recarregar: true, eventos: [] };
        return { versao, eventos: eventos.filter(e => e.n > desde) };
    };
    if (versao !== desde) return Promise.resolve(pronto());
    return new Promise((ok) => {
        const fim = () => { clearTimeout(t); esperandoEventos.delete(fim); ok(pronto()); };
        const t = setTimeout(fim, prazo);
        esperandoEventos.add(fim);
    });
}

// ---------- Registro (extensoes.json) ----------
const pastaExtensoes = () => path.join(PASTA_DADOS, 'extensoes');
const ID_VALIDO = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
// Todo caminho de extensão passa pelo id validado (nada de "..", barra ou outra pasta)
function confereId(id) { if (!ID_VALIDO.test(String(id))) throw new Error('Extensão inválida.'); return String(id); }
const pastaDe = (id) => path.join(pastaExtensoes(), confereId(id));
const pastaDadosDe = (id) => path.join(PASTA_DADOS, 'extensoes-dados', confereId(id));
function leRegistro() { try { return JSON.parse(fs.readFileSync(path.join(pastaExtensoes(), 'extensoes.json'), 'utf8')) || []; } catch (e) { return []; } }
function gravaRegistro(lista) {
    fs.mkdirSync(pastaExtensoes(), { recursive: true });
    const arq = path.join(pastaExtensoes(), 'extensoes.json');
    fs.writeFileSync(arq + '.novo', JSON.stringify(lista, null, 2)); fs.renameSync(arq + '.novo', arq);
}
function pkgDe(id) { if (!ID_VALIDO.test(String(id))) return null; try { return JSON.parse(fs.readFileSync(path.join(pastaDe(id), 'package.json'), 'utf8')); } catch (e) { return null; } }

// ---------- .vsix (zip) lido aqui: nada é gravado antes de conferir todos os nomes ----------
function entradasZip(buf) {
    let i = buf.length - 22;
    const limite = Math.max(0, buf.length - 65557);
    while (i >= limite && buf.readUInt32LE(i) !== 0x06054b50) i--;
    if (i < limite) throw new Error('O arquivo não é um .vsix (zip) válido.');
    const total = buf.readUInt16LE(i + 10), inicio = buf.readUInt32LE(i + 16);
    const lista = [];
    let p = inicio;
    for (let k = 0; k < total; k++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('O .vsix está corrompido.');
        const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
        lista.push({
            nome: buf.toString('utf8', p + 46, p + 46 + nl), metodo: buf.readUInt16LE(p + 10),
            comprimido: buf.readUInt32LE(p + 20), tamanho: buf.readUInt32LE(p + 24), unix: buf.readUInt32LE(p + 38) >>> 16, local: buf.readUInt32LE(p + 42),
        });
        p += 46 + nl + el + cl;
    }
    return lista;
}
function conteudoZip(buf, e) {
    const p = e.local;
    if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('O .vsix está corrompido.');
    const ini = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const bruto = buf.subarray(ini, ini + e.comprimido);
    if (e.metodo === 0) return bruto;
    if (e.metodo === 8) return zlib.inflateRawSync(bruto, { maxOutputLength: e.tamanho + 1 });
    throw new Error('Compressão do .vsix não suportada.');
}
// Só o que está em extension/; recusa nome perigoso (zip-slip), link e tamanho exagerado
function arquivosDaExtensao(buf) {
    const arquivos = [];
    let soma = 0;
    for (const e of entradasZip(buf)) {
        const n = e.nome;
        if (/\\|^\/|:|\0/.test(n) || n.split('/').some(s => s === '..' || s === '.')) throw new Error(`Nome perigoso dentro do .vsix: ${n}`);
        if ((e.unix & 0o170000) === 0o120000) throw new Error(`Link dentro do .vsix: ${n}`);
        if (!n.startsWith('extension/') || n.endsWith('/')) continue;
        soma += e.tamanho;
        if (soma > 200 * 1024 * 1024 || arquivos.length > 8000) throw new Error('O .vsix é grande demais (mais de 200 MB descompactado).');
        arquivos.push({ rel: n.slice('extension/'.length), e });
    }
    if (!arquivos.length) throw new Error('O .vsix não tem a pasta extension/.');
    return arquivos;
}
function analisa(buf) {
    const arquivos = arquivosDaExtensao(buf);
    const pj = arquivos.find(a => a.rel === 'package.json');
    if (!pj) throw new Error('O .vsix não tem extension/package.json.');
    let pkg;
    try { pkg = JSON.parse(conteudoZip(buf, pj.e).toString('utf8')); } catch (e) { throw new Error('O package.json da extensão não é válido.'); }
    const nome = String(pkg.name || '').toLowerCase(), publisher = String(pkg.publisher || '').toLowerCase();
    const id = `${publisher}.${nome}`;
    if (!ID_VALIDO.test(id)) throw new Error('Nome ou publisher da extensão inválido.');
    if (!pkg.engines || !pkg.engines.vscode) throw new Error('Isto não é uma extensão do VS Code (falta engines.vscode).');
    const main = String(pkg.main || '').replace(/^\.\//, '');
    if (!main) throw new Error('A extensão não tem código (main): só temas e linguagens, que o Red Code não usa.');
    if (!arquivos.some(a => a.rel === main || a.rel === main + '.js')) throw new Error(`O arquivo principal ${main} não está no .vsix.`);
    return { arquivos, pkg, info: { id, nome: String(pkg.displayName || pkg.name), versao: String(pkg.version || ''), publisher: String(pkg.publisher || ''), descricao: String(pkg.description || ''), arquivos: arquivos.length } };
}
function preparaInstalacao(buf) {
    const { info } = analisa(buf);
    const token = crypto.randomBytes(16).toString('hex');
    for (const [t, v] of instalacoes) if (Date.now() - v.em > 10 * 60e3) instalacoes.delete(t);
    instalacoes.set(token, { buf, info, em: Date.now() });
    const ja = leRegistro().find(x => x.id === info.id);
    return { token, ...info, instalada: ja ? ja.versao : null };
}
async function confirmaInstalacao(token) {
    const pedido = instalacoes.get(String(token));
    if (!pedido) throw new Error('A instalação expirou: escolha o .vsix de novo.');
    instalacoes.delete(String(token));
    const { arquivos, info } = analisa(pedido.buf);
    const destino = pastaDe(info.id), novo = destino + '.novo-' + Date.now();
    try {
        fs.mkdirSync(novo, { recursive: true });
        const base = path.resolve(novo) + path.sep;
        for (const a of arquivos) {
            const alvo = path.resolve(novo, ...a.rel.split('/'));
            if (!alvo.startsWith(base)) throw new Error('Nome perigoso dentro do .vsix: ' + a.rel);
            fs.mkdirSync(path.dirname(alvo), { recursive: true });
            fs.writeFileSync(alvo, conteudoZip(pedido.buf, a.e));
        }
    } catch (err) { fs.rmSync(novo, { recursive: true, force: true }); throw err; }
    // Atualização: a antiga só para agora, com a nova já extraída
    const anterior = leRegistro().find(x => x.id === info.id);
    await para(info.id);
    hosts.delete(info.id);
    if (fs.existsSync(destino)) fs.rmSync(destino, { recursive: true, force: true });
    fs.renameSync(novo, destino);
    const lista = leRegistro().filter(x => x.id !== info.id);
    lista.push({ id: info.id, versao: info.versao, ligada: anterior ? !!anterior.ligada : true, instaladaEm: new Date().toISOString() });
    gravaRegistro(lista);
    sobe(info.id);
    emite({ tipo: 'lista' });
    return info;
}

// ---------- Senhas da extensão: DPAPI do usuário, o valor vai pelo stdin (nunca na linha de comando) ----------
const SCRIPT_DPAPI = (acao) => Buffer.from(`Add-Type -AssemblyName System.Security
$e = [Console]::In.ReadToEnd().Trim()
$b = [Convert]::FromBase64String($e)
$r = [Security.Cryptography.ProtectedData]::${acao}($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($r))`, 'utf16le').toString('base64');
function dpapi(acao, base64) {
    return new Promise((ok, falha) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', SCRIPT_DPAPI(acao)], { windowsHide: true });
        let saida = '', erro = '';
        p.stdout.on('data', d => { saida += d; });
        p.stderr.on('data', d => { erro += d; });
        p.on('error', falha);
        p.on('close', (c) => c === 0 && saida ? ok(saida.trim()) : falha(new Error('O cofre do Windows não respondeu' + (erro ? ': ' + erro.trim().split('\n')[0] : '.'))));
        p.stdin.end(base64);
    });
}
const cacheSegredos = new Map();   // extId -> { chave: texto }
const filaSegredos = new Map();    // extId -> promessa da última operação (uma de cada vez: dois store juntos não se sobrescrevem)
function arquivoSegredos(id) { return path.join(pastaDadosDe(id), 'segredos.json'); }
function leCifrados(id) { try { return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(arquivoSegredos(id), 'utf8'))); } catch (e) { return Object.create(null); } }
function segredo(id, acao, chave, valor) {
    const antes = filaSegredos.get(id) || Promise.resolve();
    const agora = antes.catch(() => { }).then(() => segredoJa(id, acao, chave, valor));
    filaSegredos.set(id, agora);
    return agora;
}
async function segredoJa(id, acao, chave, valor) {
    if (!cacheSegredos.has(id)) cacheSegredos.set(id, Object.create(null));
    const cache = cacheSegredos.get(id);
    if (acao === 'get') {
        if (chave in cache) return cache[chave];
        const c = leCifrados(id)[chave];
        if (!c) return null;
        return (cache[chave] = Buffer.from(await dpapi('Unprotect', c), 'base64').toString('utf8'));
    }
    const cifrados = leCifrados(id);
    if (acao === 'store') { cifrados[chave] = await dpapi('Protect', Buffer.from(String(valor), 'utf8').toString('base64')); cache[chave] = String(valor); }
    else { delete cifrados[chave]; delete cache[chave]; }
    fs.mkdirSync(pastaDadosDe(id), { recursive: true });
    fs.writeFileSync(arquivoSegredos(id), JSON.stringify(cifrados));
    return null;
}

// ---------- Configuração (só o servidor grava o config.json) ----------
function propriedadesDe(pkg) {
    const p = {};
    for (const c of [].concat(((pkg || {}).contributes || {}).configuration || [])) Object.assign(p, c.properties || {});
    return p;
}
const arquivoConfig = (id) => path.join(pastaDadosDe(id), 'config.json');
function leConfig(id) { try { return JSON.parse(fs.readFileSync(arquivoConfig(id), 'utf8')) || {}; } catch (e) { return {}; } }
function validaValor(prop, valor) {
    if (valor === null) return null;   // null = volta ao padrão
    const tipo = [].concat(prop.type || [])[0];
    if (tipo === 'boolean' && typeof valor !== 'boolean') throw new Error('Esperava sim ou não.');
    if ((tipo === 'number' || tipo === 'integer') && (typeof valor !== 'number' || !Number.isFinite(valor))) throw new Error('Esperava um número.');
    if (tipo === 'integer' && !Number.isInteger(valor)) throw new Error('Esperava um número inteiro.');
    if (typeof valor === 'number' && prop.minimum !== undefined && valor < prop.minimum) throw new Error(`O mínimo é ${prop.minimum}.`);
    if (typeof valor === 'number' && prop.maximum !== undefined && valor > prop.maximum) throw new Error(`O máximo é ${prop.maximum}.`);
    if (tipo === 'string' && typeof valor !== 'string') throw new Error('Esperava um texto.');
    if (typeof valor === 'string' && prop.pattern && !new RegExp(prop.pattern).test(valor)) throw new Error(prop.patternErrorMessage || 'Formato inválido.');
    if (prop.enum && !prop.enum.includes(valor)) throw new Error('Valor fora da lista.');
    if (tipo === 'array' && !Array.isArray(valor)) throw new Error('Esperava uma lista.');
    return valor;
}
async function mudaConfig(id, chave, valor, daExtensao) {
    const pkg = pkgDe(id);
    if (!pkg) throw new Error('Extensão não instalada.');
    const props = propriedadesDe(pkg);
    // A extensão pode gravar chaves fora do schema (como no VS Code); a página só as do schema
    if (!daExtensao && !props[chave]) throw new Error('Configuração desconhecida.');
    if (props[chave]) valor = validaValor(props[chave], valor);
    const config = leConfig(id);
    if (valor === null || valor === undefined) delete config[chave]; else config[chave] = valor;
    fs.mkdirSync(pastaDadosDe(id), { recursive: true });
    fs.writeFileSync(arquivoConfig(id), JSON.stringify(config, null, 2));
    const h = hosts.get(id);
    if (h && h.proc) pedeHost(id, 'config.mudou', { config, chaves: [chave] }).catch(() => { });
    emite({ tipo: 'config', extId: id });
}

// ---------- Processo de cada extensão ----------
function pedeHost(id, tipo, dados, prazo = 20000) {
    const h = hosts.get(id);
    if (!h || !h.proc || !h.proc.connected) return Promise.reject(new Error('A extensão não está rodando.'));
    return new Promise((ok, falha) => {
        const n = proximo++;
        const t = setTimeout(() => { h.pedidos.delete(n); falha(new Error('A extensão não respondeu.')); }, prazo);
        h.pedidos.set(n, { ok: (v) => { clearTimeout(t); ok(v); }, falha: (e) => { clearTimeout(t); falha(e); } });
        h.proc.send({ t: 'pede', id: n, tipo, dados });
    });
}
function registraLog(id, canal, nivel, texto) {
    const h = hosts.get(id);
    if (!h) return;
    const linha = { hora: Date.now(), canal: canal || '', nivel: nivel || 'info', texto: String(texto).slice(0, 4000) };
    h.logs.push(linha);
    if (h.logs.length > 500) h.logs.shift();
    try {
        fs.mkdirSync(pastaDadosDe(id), { recursive: true });
        const arq = path.join(pastaDadosDe(id), 'log.txt');
        if (fs.existsSync(arq) && fs.statSync(arq).size > 5 * 1024 * 1024) fs.renameSync(arq, path.join(pastaDadosDe(id), 'log.anterior.txt'));
        fs.appendFileSync(arq, `[${new Date().toLocaleString('pt-BR')}] ${linha.canal ? linha.canal + ' ' : ''}${linha.texto}\n`);
    } catch (e) { /* sem disco */ }
    emite({ tipo: 'log', extId: id, linha });
}
function tiraPendentes(id) {
    for (const [pid, p] of pendentes) if (p.extId === id) { pendentes.delete(pid); emite({ tipo: 'pendente-fim', id: pid }); }
}
function sobe(id) {
    const reg = leRegistro().find(x => x.id === id);
    const pkg = pkgDe(id);
    if (!reg || !reg.ligada || !pkg) return;
    const atual = hosts.get(id);
    if (atual && atual.proc) return;
    const h = { proc: null, status: 'iniciando', erro: '', html: new Map(), badges: new Map(), logs: atual ? atual.logs : [], pedidos: new Map(), intencional: false };
    hosts.set(id, h);
    // No Red Code.exe o servidor é o próprio exe rodando como Node: o fork precisa da variável de volta (o
    // segredos.js apagou), senão abriria outra janela do app. O host apaga de novo na primeira linha
    const env = { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    const proc = fork(path.join(__dirname, 'extensoes-host.js'), [id], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, cwd: pastaDe(id) });
    h.proc = proc;
    const textoSolto = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(l => registraLog(id, '', 'info', l));
    proc.stdout.on('data', textoSolto);
    proc.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(l => registraLog(id, '', 'error', l)));
    proc.on('message', (m) => trataHost(id, h, m));
    proc.on('error', (err) => { h.status = 'falhou'; h.erro = 'Não deu para abrir o processo da extensão: ' + err.message; registraLog(id, '', 'error', h.erro); emite({ tipo: 'lista' }); });
    proc.on('exit', (codigo) => {
        if (hosts.get(id) !== h) return;
        h.proc = null;
        for (const p of h.pedidos.values()) p.falha(new Error('A extensão parou.'));
        h.pedidos.clear();
        tiraPendentes(id);
        if (!h.intencional) { h.status = 'falhou'; h.erro = h.erro || `O processo da extensão saiu (código ${codigo}).`; registraLog(id, '', 'error', h.erro); }
        else h.status = 'parada';
        emite({ tipo: 'lista' });
    });
    proc.send({ t: 'inicia', ext: { id, pasta: pastaDe(id), pkg, pastaDados: pastaDadosDe(id), porta: PORTA, config: leConfig(id) } });
    emite({ tipo: 'lista' });
}
function trataHost(id, h, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'resposta') { const p = h.pedidos.get(m.id); if (p) { h.pedidos.delete(m.id); m.erro ? p.falha(new Error(m.erro)) : p.ok(m.valor); } return; }
    const d = m.dados || {};
    if (m.t === 'avisa') {
        switch (m.tipo) {
            case 'ativou': h.status = 'ativa'; h.erro = ''; emite({ tipo: 'lista' }); break;
            case 'falhou': h.status = 'falhou'; h.erro = String(d.erro || '').split('\n')[0]; registraLog(id, '', 'error', d.erro); emite({ tipo: 'lista' }); break;
            case 'webview.html': { const v = (h.html.get(d.viewId) || { versao: 0 }).versao + 1; h.html.set(String(d.viewId), { html: String(d.html || ''), versao: v }); emite({ tipo: 'webview', extId: id, viewId: d.viewId, versao: v }); break; }
            case 'webview.mensagem': emite({ tipo: 'mensagem', extId: id, viewId: d.viewId, msg: d.msg }); break;
            case 'arvore.mudou': emite({ tipo: 'arvore', extId: id, viewId: d.viewId }); break;
            case 'badge': if (d.badge) h.badges.set(d.viewId, d.badge); else h.badges.delete(d.viewId); emite({ tipo: 'badge', extId: id, viewId: d.viewId, badge: d.badge }); break;
            case 'log': registraLog(id, d.canal, d.nivel, d.texto); break;
            case 'log.limpa': h.logs = h.logs.filter(l => l.canal !== d.canal); emite({ tipo: 'log-limpo', extId: id }); break;
            case 'log.mostrar': emite({ tipo: 'log-mostrar', extId: id, canal: d.canal }); break;
            case 'status': emite({ tipo: 'status', extId: id, texto: String(d.texto || '').slice(0, 300) }); break;
            case 'abrir': if (/^https?:\/\//i.test(String(d.url))) emite({ tipo: 'abrir', extId: id, url: String(d.url) }); break;
            case 'copiar': emite({ tipo: 'copiar', extId: id, texto: String(d.texto || '') }); break;
            case 'focar': emite({ tipo: 'focar', extId: id, viewId: d.viewId }); break;
        }
        return;
    }
    if (m.t === 'pede') {
        const responde = (valor, erro) => { try { if (h.proc && h.proc.connected) h.proc.send({ t: 'resposta', id: m.id, valor, erro }); } catch (e) { /* saiu */ } };
        const tenta = (p) => p.then(v => responde(v), e => responde(undefined, e.message));
        switch (m.tipo) {
            case 'config.update': return tenta(mudaConfig(id, String(d.chave), d.valor, true));
            case 'segredo.get': return tenta(segredo(id, 'get', String(d.chave)));
            case 'segredo.store': return tenta(segredo(id, 'store', String(d.chave), d.valor));
            case 'segredo.delete': return tenta(segredo(id, 'delete', String(d.chave)));
            case 'aviso': case 'entrada': {
                // Fica guardado até a página responder (recarregar a página mostra de novo)
                const pid = 'p' + (proximo++);
                const dados = m.tipo === 'aviso'
                    ? { nivel: d.nivel, texto: String(d.texto).slice(0, 2000), detalhe: String(d.detalhe || '').slice(0, 2000), botoes: (d.botoes || []).slice(0, 6).map(String), modal: !!d.modal }
                    : { titulo: String(d.titulo || ''), prompt: String(d.prompt || ''), valor: String(d.valor || ''), placeholder: String(d.placeholder || ''), senha: !!d.senha };
                pendentes.set(pid, { extId: id, tipo: m.tipo, dados, responde });
                emite({ tipo: 'pendente', id: pid, extId: id, pedido: m.tipo, dados });
                return;
            }
            default: return responde(undefined, 'pedido desconhecido: ' + m.tipo);
        }
    }
}
// Para o processo e os filhos dele (ex.: o claude -p que a extensão abriu): taskkill /T, como o main.js faz
function para(id) {
    const h = hosts.get(id);
    if (!h || !h.proc) return Promise.resolve();
    h.intencional = true;
    const proc = h.proc, pid = proc.pid;
    return new Promise((ok) => {
        let feito = false;
        const fim = () => { if (feito) return; feito = true; if (h.proc === proc) h.proc = null; ok(); };
        proc.once('exit', fim);
        try { proc.disconnect(); } catch (e) { /* já desconectado */ }
        // Filhos dela (ex.: claude -p) e a própria, se não saiu sozinha
        setTimeout(() => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => setTimeout(fim, 1500)), 2000);
    });
}
// Servidor saindo (inclusive o reinício seguro com process.exit(75)): mata tudo de forma síncrona
function encerraTodas() {
    const pids = [...hosts.values()].filter(h => h.proc).map(h => { h.intencional = true; return h.proc.pid; });
    if (!pids.length) return;
    try { execFileSync('taskkill', ['/T', '/F', ...pids.flatMap(p => ['/PID', String(p)])], { windowsHide: true, timeout: 3000, stdio: 'ignore' }); } catch (e) { /* já saíram */ }
}

// ---------- O que a página vê ----------
function resumo(id) {
    const reg = leRegistro().find(x => x.id === id) || {};
    const pkg = pkgDe(id) || {};
    const c = pkg.contributes || {};
    const h = hosts.get(id);
    const escondidos = new Set(((c.menus || {}).commandPalette || []).filter(x => x.when === 'false').map(x => x.command));
    const containers = [].concat(((c.viewsContainers || {}).activitybar) || []).map(ct => ({
        id: ct.id, titulo: ct.title, icone: ct.icon && typeof ct.icon === 'string' ? `/api/extensoes/arquivo/${encodeURIComponent(id)}/${ct.icon.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/')}` : '',
        views: ((c.views || {})[ct.id] || []).map(v => ({ id: v.id, nome: v.name, tipo: v.type === 'webview' ? 'webview' : 'arvore', boasVindas: ((c.viewsWelcome || []).find(w => w.view === v.id) || {}).contents || '' })),
    }));
    return {
        id, nome: pkg.displayName || pkg.name || id, versao: pkg.version || reg.versao || '', publisher: pkg.publisher || '', descricao: pkg.description || '',
        ligada: !!reg.ligada, status: h ? h.status : (reg.ligada ? 'parada' : 'desligada'), erro: h ? h.erro : '',
        containers, comandos: [].concat(c.commands || []).filter(x => !escondidos.has(x.command)).map(x => ({ id: x.command, titulo: x.title, categoria: x.category || '' })),
        badges: h ? Object.fromEntries(h.badges) : {}, html: h ? Object.fromEntries([...h.html].map(([v, x]) => [v, x.versao])) : {},
        temConfig: Object.keys(propriedadesDe(pkg)).length > 0,
    };
}
function estado() {
    return {
        versao, extensoes: leRegistro().map(r => resumo(r.id)),
        pendentes: [...pendentes].map(([id, p]) => ({ id, extId: p.extId, pedido: p.tipo, dados: p.dados })),
    };
}
function responde(pid, valor) {
    const p = pendentes.get(String(pid));
    if (!p) return false;
    pendentes.delete(String(pid));
    p.responde(valor === undefined ? null : valor);
    emite({ tipo: 'pendente-fim', id: String(pid) });
    return true;
}
function configDe(id) {
    const pkg = pkgDe(id);
    if (!pkg) throw new Error('Extensão não instalada.');
    const props = propriedadesDe(pkg), valores = leConfig(id);
    return Object.entries(props).map(([chave, p]) => ({
        chave, tipo: [].concat(p.type || [])[0] || 'string', descricao: p.markdownDescription || p.description || '', padrao: p.default,
        valor: chave in valores ? valores[chave] : p.default, enum: p.enum || null, enumDescricoes: p.enumDescriptions || null,
        minimo: p.minimum, maximo: p.maximum, padraoTexto: p.pattern || null, itens: p.items && p.items.type || null,
    }));
}
function logsDe(id) { const h = hosts.get(id); return h ? h.logs : []; }
async function liga(id, ligada) {
    const lista = leRegistro();
    const r = lista.find(x => x.id === id);
    if (!r) throw new Error('Extensão não instalada.');
    r.ligada = !!ligada;
    gravaRegistro(lista);
    if (ligada) sobe(id); else { await para(id); tiraPendentes(id); }
    emite({ tipo: 'lista' });
}
async function reinicia(id) { await para(id); hosts.delete(id); sobe(id); emite({ tipo: 'lista' }); }
async function remove(id) {
    await para(id);
    tiraPendentes(id);
    hosts.delete(id);
    gravaRegistro(leRegistro().filter(x => x.id !== id));
    if (ID_VALIDO.test(id)) fs.rmSync(pastaDe(id), { recursive: true, force: true });
    emite({ tipo: 'lista' });
}
function apagaDados(id) {
    if (!ID_VALIDO.test(id)) throw new Error('Extensão inválida.');
    if (hosts.get(id) && hosts.get(id).proc) throw new Error('Desligue a extensão antes de apagar os dados dela.');
    fs.rmSync(pastaDadosDe(id), { recursive: true, force: true });
    cacheSegredos.delete(id);
}

// ---------- Webview: o HTML da extensão, em sandbox, com a ponte acquireVsCodeApi ----------
// Fixo (nada vindo de fora é interpolado aqui). Fica antes do <meta> CSP da extensão, que só vale do meta em diante.
// O tema chega por postMessage da página e só aceita nomes --vscode-* e valores sem < > { } ;
const FONTES_RED_CODE = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap';
const PONTE_WEBVIEW = `<meta charset="utf-8"><link rel="stylesheet" href="${FONTES_RED_CODE}"><script>(() => {
    const pai = window.parent;
    let estado, pego = false;
    window.acquireVsCodeApi = () => {
        if (pego) throw new Error('acquireVsCodeApi só pode ser chamado uma vez');
        pego = true;
        return Object.freeze({
            postMessage: (m) => pai.postMessage({ __redcodeExt: 'mensagem', m }, '*'),
            getState: () => estado,
            setState: (s) => { estado = s; return s; },
        });
    };
    window.addEventListener('message', (ev) => {
        if (ev.source !== pai || !ev.data || !ev.data.__redcodeTema) return;
        ev.stopImmediatePropagation();
        const t = ev.data.__redcodeTema;
        for (const [k, v] of Object.entries(t.vars || {})) if (/^--vscode-[a-zA-Z0-9-]+$/.test(k) && typeof v === 'string' && !/[<>{};]/.test(v)) document.documentElement.style.setProperty(k, v);
        // Esquema no <html>: com ele diferente do body, o navegador pinta um fundo opaco branco por trás do painel
        document.documentElement.style.colorScheme = t.claro ? 'light' : 'dark';
        const corpo = () => { document.body.classList.remove('vscode-dark', 'vscode-light'); document.body.classList.add(t.claro ? 'vscode-light' : 'vscode-dark'); };
        if (document.body) corpo(); else document.addEventListener('DOMContentLoaded', corpo);
    }, true);
    pai.postMessage({ __redcodeExt: 'pronta' }, '*');
})();</script><style>
html { background: var(--vscode-sideBar-background, transparent); }
html { accent-color: var(--vscode-button-background); }
:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
body { margin: 0; padding: 0 14px 14px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
a { color: var(--vscode-textLink-foreground); }
code { font-family: var(--vscode-editor-font-family); }
input, select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; font: inherit; }
button { font: inherit; }
::-webkit-scrollbar { width: 9px; height: 9px; } ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 6px; }
</style>`;
function liberaFontes(html) {
    // content="..." pode ter aspas simples dentro ('none', 'nonce-...'): vai até a aspa igual à que abriu
    return html.replace(/(<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=)(["'])((?:(?!\2)[^])*)\2/i, (todo, ini, aspa, regra) => {
        const novo = /(^|;)\s*font-src\b/i.test(regra)
            ? regra.replace(/(^|;)(\s*font-src\b)/i, '$1$2 https://fonts.gstatic.com')
            : regra.replace(/;?\s*$/, '') + '; font-src https://fonts.gstatic.com';
        return ini + aspa + novo + aspa;
    });
}
function htmlWebview(id, viewId) {
    const h = hosts.get(id);
    const v = h && h.html.get(String(viewId));
    let html = liberaFontes(v ? v.html : '<!DOCTYPE html><html><head></head><body><p style="opacity:.7">Carregando…</p></body></html>');
    // Depois do <head> (ou no começo, se não houver): antes do <meta> de CSP da extensão
    const m = html.match(/<head[^>]*>/i);
    html = m ? html.slice(0, m.index + m[0].length) + PONTE_WEBVIEW + html.slice(m.index + m[0].length) : PONTE_WEBVIEW + html;
    return html;
}
const TIPOS = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8' };
// Arquivo da extensão para a webview: decodificado, realpath e sempre dentro da pasta dela
function arquivo(id, rel) {
    if (!ID_VALIDO.test(id) || !leRegistro().some(x => x.id === id)) return null;
    let caminho;
    try { caminho = decodeURIComponent(String(rel)); } catch (e) { return null; }
    if (/\0/.test(caminho)) return null;
    const base = pastaDe(id);
    let real, realBase;
    try { realBase = fs.realpathSync(base); real = fs.realpathSync(path.resolve(base, caminho)); } catch (e) { return null; }
    if (!(real.toLowerCase() + '').startsWith(realBase.toLowerCase() + path.sep)) return null;
    const tipo = TIPOS[path.extname(real).toLowerCase()];
    if (!tipo || !fs.statSync(real).isFile()) return null;
    return { caminho: real, tipo };
}

function dispara(id, promessa) {
    promessa.catch((e) => { registraLog(id, '', 'error', e.message); emite({ tipo: 'status', extId: id, texto: e.message, erro: true }); });
}
function configura(opcoes) {
    PASTA = opcoes.pasta; PASTA_DADOS = opcoes.pastaDados; PORTA = opcoes.porta;
    // As ligadas sobem um pouco depois do servidor (onStartupFinished)
    setTimeout(() => { for (const r of leRegistro()) if (r.ligada) sobe(r.id); }, 3000).unref();
}

module.exports = {
    configura, espera, estado, preparaInstalacao, confirmaInstalacao, liga, reinicia, remove, apagaDados, configDe, mudaConfig, logsDe, responde,
    visibilidade: (id, viewId, visivel) => pedeHost(id, 'visibilidade', { viewId: String(viewId), visivel: !!visivel }),
    mensagem: (id, viewId, msg) => pedeHost(id, 'webview.recebe', { viewId: String(viewId), msg }),
    arvore: (id, viewId, handle) => pedeHost(id, 'arvore', { viewId: String(viewId), handle: handle ? String(handle) : null }),
    // Clique e comando: disparam e respondem na hora (podem demorar minutos, ex.: gerar com o Claude); erro vai para o log e a tela
    clique: (id, viewId, handle) => { dispara(id, pedeHost(id, 'clique', { viewId: String(viewId), handle: String(handle) }, 600000)); },
    comando: (id, comando) => {
        const pkg = pkgDe(id) || {};
        if (!([].concat(((pkg.contributes || {}).commands) || [])).some(c => c.command === comando)) throw new Error('Comando desconhecido.');
        dispara(id, pedeHost(id, 'comando', { comando: String(comando) }, 600000));
    },
    htmlWebview, arquivo, encerraTodas,
    _paraTestes: { analisa, entradasZip, segredo, dpapi, liberaFontes, pids: () => [...hosts.values()].filter(h => h.proc).map(h => h.proc.pid) },
};
