// O módulo "vscode" de mentira que as extensões instaladas recebem (extensoes-host.js). Imita só a parte da API
// usada por extensões de painel + comandos + configurações (Royal Trello Diário é a referência). O que não
// existe aqui avisa no log da extensão "Red Code: vscode.x não é suportado" em vez de quebrar em silêncio.
// Tudo que precisa da tela ou do disco do Red Code vai ao servidor pela ponte (IPC): pede() espera resposta,
// avisa() não espera.
const fs = require('fs');
const path = require('path');

class Disposable {
    constructor(fn) { this._fn = fn; }
    dispose() { if (this._fn) { const f = this._fn; this._fn = null; try { f(); } catch (e) { /* já descartado */ } } }
    static from(...itens) { return new Disposable(() => itens.forEach(i => i && typeof i.dispose === 'function' && i.dispose())); }
}
class EventEmitter {
    constructor() {
        this._ouvintes = new Set();
        this.event = (fn, quem, lista) => {
            const f = quem ? fn.bind(quem) : fn;
            this._ouvintes.add(f);
            const d = new Disposable(() => this._ouvintes.delete(f));
            if (Array.isArray(lista)) lista.push(d);
            return d;
        };
    }
    fire(valor) { for (const f of [...this._ouvintes]) { try { f(valor); } catch (e) { console.error(e); } } }
    dispose() { this._ouvintes.clear(); }
}
// Uri: o básico (file e http/https). fsPath no formato do Windows
class Uri {
    constructor(scheme, authority, caminho, query, fragment) { Object.assign(this, { scheme, authority: authority || '', path: caminho || '', query: query || '', fragment: fragment || '' }); }
    get fsPath() { const p = decodeURIComponent(this.path); return process.platform === 'win32' ? p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\') : p; }
    with(m) { return new Uri(m.scheme ?? this.scheme, m.authority ?? this.authority, m.path ?? this.path, m.query ?? this.query, m.fragment ?? this.fragment); }
    toString() {
        if (this.scheme === 'file') return 'file://' + encodeURI(this.path.startsWith('/') ? this.path : '/' + this.path);
        return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`;
    }
    toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath }; }
    static file(p) { const a = path.resolve(String(p)).replace(/\\/g, '/'); return new Uri('file', '', a.startsWith('/') ? a : '/' + a); }
    static parse(s) {
        s = String(s);
        if (/^file:/i.test(s)) return Uri.file(decodeURIComponent(s.replace(/^file:\/*/i, '').replace(/^([A-Za-z]:)/, '$1')));
        const m = s.match(/^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i);
        return m ? new Uri(m[1].toLowerCase(), m[2], m[3], m[4], m[5]) : new Uri('file', '', s);
    }
    static joinPath(base, ...partes) { return base.with({ path: path.posix.join(base.path, ...partes.map(p => String(p).replace(/\\/g, '/'))) }); }
}
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
ThemeIcon.File = new ThemeIcon('file'); ThemeIcon.Folder = new ThemeIcon('folder');
class ThemeColor { constructor(id) { this.id = id; } }
class TreeItem {
    constructor(rotulo, estado) { if (rotulo instanceof Uri) this.resourceUri = rotulo; else this.label = rotulo; this.collapsibleState = estado || 0; }
}
class MarkdownString {
    constructor(valor) { this.value = valor || ''; }
    appendText(t) { this.value += t; return this; } appendMarkdown(t) { this.value += t; return this; }
}
class CancellationTokenSource {
    constructor() { const e = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: e.event }; this._e = e; }
    cancel() { this.token.isCancellationRequested = true; this._e.fire(); } dispose() { this._e.dispose(); }
}
const tokenNunca = new CancellationTokenSource().token;

// Avisa uma vez por nome o que a extensão tentou usar e não existe aqui
function semSuporte(nomeBase, alvo, log) {
    const avisados = new Set();
    return new Proxy(alvo, {
        get(obj, chave) {
            if (chave in obj || typeof chave === 'symbol' || chave === 'then' || chave === 'toJSON') return obj[chave];
            const nome = `${nomeBase}.${String(chave)}`;
            if (!avisados.has(nome)) { avisados.add(nome); log(`Red Code: ${nome} não é suportado.`); }
            return undefined;
        },
    });
}

// ext: { id, pasta, pkg, pastaDados, porta, config }; ponte: { pede(tipo, dados), avisa(tipo, dados), log(texto) }
function criaApi(ext, ponte) {
    const log = (t) => ponte.log(t);
    const comandos = new Map();
    const provedoresWebview = new Map();   // viewId -> provider
    const views = new Map();               // viewId -> WebviewView já resolvida
    const arvores = new Map();             // viewId -> { provider, view, itens: Map(handle -> {el, item}) }
    let proximoHandle = 1;
    const idsDasViews = new Set(Object.values((ext.pkg.contributes || {}).views || {}).flat().map(v => v.id));

    // ---------- Configuração (só o servidor grava; aqui fica a cópia) ----------
    const propriedades = {};
    for (const c of [].concat((ext.pkg.contributes || {}).configuration || [])) Object.assign(propriedades, c.properties || {});
    let valores = { ...(ext.config || {}) };
    const mudouConfig = new EventEmitter();
    function getConfiguration(secao) {
        const cheio = (k) => (secao ? secao + '.' : '') + k;
        const valor = (k) => {
            const n = cheio(k);
            if (n in valores) return valores[n];
            if (propriedades[n] && 'default' in propriedades[n]) return JSON.parse(JSON.stringify(propriedades[n].default));
            return undefined;
        };
        return {
            get(k, padrao) { const v = valor(k); return v === undefined ? padrao : v; },
            has(k) { return valor(k) !== undefined; },
            inspect(k) { const n = cheio(k); return { key: n, defaultValue: propriedades[n] && propriedades[n].default, globalValue: valores[n] }; },
            async update(k, v) { await ponte.pede('config.update', { chave: cheio(k), valor: v === undefined ? null : v }); },
        };
    }

    // ---------- Webviews ----------
    class Webview {
        constructor(viewId) {
            this._viewId = viewId; this._html = ''; this.options = {};
            this._recebe = new EventEmitter(); this.onDidReceiveMessage = this._recebe.event;
            this.cspSource = `http://127.0.0.1:${ext.porta}`;
        }
        get html() { return this._html; }
        set html(v) { this._html = String(v); ponte.avisa('webview.html', { viewId: this._viewId, html: this._html }); }
        postMessage(msg) { ponte.avisa('webview.mensagem', { viewId: this._viewId, msg }); return Promise.resolve(true); }
        asWebviewUri(uri) {
            const rel = path.relative(ext.pasta, uri.fsPath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) return uri;
            return Uri.parse(`http://127.0.0.1:${ext.porta}/api/extensoes/arquivo/${encodeURIComponent(ext.id)}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`);
        }
    }
    class WebviewView {
        constructor(viewId) {
            this.viewType = viewId; this.webview = new Webview(viewId); this.visible = false; this.title = undefined; this.description = undefined;
            this._vis = new EventEmitter(); this.onDidChangeVisibility = this._vis.event;
            this._fim = new EventEmitter(); this.onDidDispose = this._fim.event;
            this._badge = undefined;
        }
        get badge() { return this._badge; }
        set badge(b) { this._badge = b; ponte.avisa('badge', { viewId: this.viewType, badge: b ? { value: Number(b.value) || 0, tooltip: String(b.tooltip || '') } : null }); }
        show() { ponte.avisa('focar', { viewId: this.viewType }); }
    }
    async function visibilidade(viewId, visivel) {
        let v = views.get(viewId);
        if (!v && visivel && provedoresWebview.has(viewId)) {
            v = new WebviewView(viewId);
            views.set(viewId, v);
            v.visible = true;
            await provedoresWebview.get(viewId).resolveWebviewView(v, { state: undefined }, tokenNunca);
            return;
        }
        if (v && v.visible !== visivel) { v.visible = visivel; v._vis.fire(); }
        const a = arvores.get(viewId);
        if (a && a.view.visible !== visivel) { a.view.visible = visivel; a.view._vis.fire({ visible: visivel }); }
    }

    // ---------- Árvores ----------
    function createTreeView(viewId, opcoes) {
        const provider = opcoes.treeDataProvider;
        const vis = new EventEmitter();
        let badge;
        const view = {
            visible: false, _vis: vis, onDidChangeVisibility: vis.event, onDidChangeSelection: new EventEmitter().event,
            onDidExpandElement: new EventEmitter().event, onDidCollapseElement: new EventEmitter().event, selection: [],
            title: undefined, description: undefined, message: undefined,
            get badge() { return badge; },
            set badge(b) { badge = b; ponte.avisa('badge', { viewId, badge: b ? { value: Number(b.value) || 0, tooltip: String(b.tooltip || '') } : null }); },
            reveal() { return Promise.resolve(); },
            dispose() { arvores.delete(viewId); },
        };
        arvores.set(viewId, { provider, view, itens: new Map() });
        if (provider.onDidChangeTreeData) provider.onDidChangeTreeData(() => ponte.avisa('arvore.mudou', { viewId }));
        ponte.avisa('arvore.mudou', { viewId });
        return view;
    }
    // Itens de um nível (raiz ou filhos de um handle), serializados para a página
    async function itensArvore(viewId, handle) {
        const a = arvores.get(viewId);
        if (!a) return [];
        const pai = handle ? (a.itens.get(handle) || {}).el : undefined;
        if (!pai) a.itens.clear();
        const elementos = (await a.provider.getChildren(pai)) || [];
        const saida = [];
        for (const el of elementos) {
            const item = await a.provider.getTreeItem(el);
            const h = 'i' + (proximoHandle++);
            a.itens.set(h, { el, item });
            const rotulo = typeof item.label === 'object' && item.label ? item.label.label : item.label;
            saida.push({
                handle: h, label: String(rotulo || (item.resourceUri ? path.basename(item.resourceUri.fsPath) : '')),
                description: typeof item.description === 'string' ? item.description : '',
                tooltip: typeof item.tooltip === 'string' ? item.tooltip : (item.tooltip && item.tooltip.value) || '',
                icone: item.iconPath instanceof ThemeIcon ? item.iconPath.id : '', temComando: !!item.command, filhos: (item.collapsibleState || 0) > 0,
            });
        }
        return saida;
    }
    // Clique num item: roda o comando DO ITEM guardado aqui (nunca argumentos vindos da página)
    async function clicaItem(viewId, handle) {
        const a = arvores.get(viewId);
        const guardado = a && a.itens.get(handle);
        if (!guardado || !guardado.item.command) return;
        const c = guardado.item.command;
        return executeCommand(c.command, ...(c.arguments || []));
    }

    // ---------- Comandos ----------
    async function executeCommand(id, ...args) {
        if (comandos.has(id)) return comandos.get(id)(...args);
        const foco = String(id).match(/^(.+)\.focus$/);
        if (foco && idsDasViews.has(foco[1])) { ponte.avisa('focar', { viewId: foco[1] }); return; }
        if (id === 'setContext') return;
        throw new Error(`Red Code: o comando "${id}" não existe aqui.`);
    }

    // ---------- Avisos e caixa de digitar ----------
    function mensagem(nivel) {
        return async (texto, ...resto) => {
            let opcoes = {};
            if (resto.length && resto[0] && typeof resto[0] === 'object' && !('title' in resto[0])) opcoes = resto.shift();
            const itens = resto.filter(i => i !== undefined && i !== null);
            const titulos = itens.map(i => typeof i === 'string' ? i : String(i.title));
            const escolha = await ponte.pede('aviso', { nivel, texto: String(texto), botoes: titulos, modal: !!opcoes.modal, detalhe: opcoes.detail ? String(opcoes.detail) : '' });
            const i = titulos.indexOf(escolha);
            return i >= 0 ? itens[i] : undefined;
        };
    }
    async function showInputBox(o = {}) {
        for (;;) {
            const v = await ponte.pede('entrada', { titulo: String(o.title || ''), prompt: String(o.prompt || ''), valor: String(o.value || ''), placeholder: String(o.placeHolder || ''), senha: !!o.password });
            if (v === undefined || v === null) return undefined;
            // validateInput: devolvendo texto, pergunta de novo mostrando o erro
            const erro = typeof o.validateInput === 'function' ? await o.validateInput(v) : null;
            if (!erro) return v;
            o = { ...o, value: v, prompt: `${typeof erro === 'string' ? erro : erro.message} — ${o.prompt || ''}` };
        }
    }

    // ---------- Log (Output) ----------
    function createOutputChannel(nome, opcoes) {
        const comNivel = opcoes && typeof opcoes === 'object' && opcoes.log;
        const linha = (nivel) => (...partes) => {
            const t = partes.map(p => p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
            ponte.avisa('log', { canal: nome, nivel, texto: comNivel ? `${new Date().toISOString().replace('T', ' ').slice(0, 23)} [${nivel}] ${t}` : t });
        };
        return {
            name: nome, logLevel: 2, onDidChangeLogLevel: new EventEmitter().event,
            append: linha('info'), appendLine: linha('info'), replace: linha('info'), clear() { ponte.avisa('log.limpa', { canal: nome }); },
            trace: linha('trace'), debug: linha('debug'), info: linha('info'), warn: linha('warn'), error: linha('error'),
            show() { ponte.avisa('log.mostrar', { canal: nome }); }, hide() { }, dispose() { },
        };
    }

    const window = semSuporte('vscode.window', {
        registerWebviewViewProvider(viewId, provider) { provedoresWebview.set(viewId, provider); return new Disposable(() => provedoresWebview.delete(viewId)); },
        createTreeView,
        registerTreeDataProvider(viewId, provider) { const v = createTreeView(viewId, { treeDataProvider: provider }); return new Disposable(() => v.dispose()); },
        showInformationMessage: mensagem('info'), showWarningMessage: mensagem('aviso'), showErrorMessage: mensagem('erro'),
        showInputBox, createOutputChannel,
        setStatusBarMessage(texto, ms) { ponte.avisa('status', { texto: String(texto), ms: typeof ms === 'number' ? ms : 5000 }); return new Disposable(() => { }); },
        createStatusBarItem() { return { text: '', tooltip: '', command: undefined, show() { }, hide() { }, dispose() { } }; },
        withProgress: async (o, tarefa) => tarefa({ report() { } }, tokenNunca),
        activeTextEditor: undefined, visibleTextEditors: [], state: { focused: true },
        onDidChangeWindowState: new EventEmitter().event, onDidChangeActiveTextEditor: new EventEmitter().event,
    }, log);
    const workspace = semSuporte('vscode.workspace', {
        getConfiguration, onDidChangeConfiguration: mudouConfig.event, workspaceFolders: [], name: undefined,
        onDidChangeWorkspaceFolders: new EventEmitter().event, rootPath: undefined,
    }, log);
    const env = semSuporte('vscode.env', {
        appName: 'Red Code', appRoot: ext.pasta, language: 'pt-br', uriScheme: 'vscode', machineId: 'redcode', sessionId: String(process.pid),
        clipboard: { writeText: async (t) => { ponte.avisa('copiar', { texto: String(t) }); }, readText: async () => '' },
        openExternal: async (uri) => { const u = String(uri); if (!/^https?:\/\//i.test(u)) return false; ponte.avisa('abrir', { url: u }); return true; },
    }, log);
    const commands = semSuporte('vscode.commands', {
        registerCommand(id, fn, quem) { comandos.set(id, quem ? fn.bind(quem) : fn); return new Disposable(() => comandos.delete(id)); },
        executeCommand, getCommands: async () => [...comandos.keys()],
    }, log);
    const extensions = semSuporte('vscode.extensions', { getExtension: () => undefined, all: [], onDidChange: new EventEmitter().event }, log);

    const api = semSuporte('vscode', {
        version: '1.85.0', Disposable, EventEmitter, Uri, ThemeIcon, ThemeColor, TreeItem, MarkdownString, CancellationTokenSource,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 }, ExtensionMode: { Production: 1, Development: 2, Test: 3 },
        window, workspace, env, commands, extensions,
    }, log);

    // ---------- Contexto do activate ----------
    fs.mkdirSync(ext.pastaDados, { recursive: true });
    // Gravação pendente (debounce) vai para o disco na saída do processo, para não perder a última
    const gravacoesPendentes = new Set();
    process.on('exit', () => { for (const f of gravacoesPendentes) { try { f(); } catch (e) { /* saindo */ } } });
    function memento(arquivo) {
        let dados = {};
        try { dados = JSON.parse(fs.readFileSync(arquivo, 'utf8')) || {}; } catch (e) { dados = {}; }
        let timer = null, esperando = [];
        const gravaJa = () => {
            clearTimeout(timer); gravacoesPendentes.delete(gravaJa);
            try { fs.writeFileSync(arquivo + '.novo', JSON.stringify(dados)); fs.renameSync(arquivo + '.novo', arquivo); } catch (e) { log('Red Code: não deu para gravar o estado: ' + e.message); }
            const lista = esperando; esperando = []; lista.forEach(f => f());
        };
        const grava = () => new Promise((ok) => {
            esperando.push(ok);
            clearTimeout(timer);
            gravacoesPendentes.add(gravaJa);
            timer = setTimeout(gravaJa, 200);
        });
        return {
            get(k, padrao) { return k in dados ? JSON.parse(JSON.stringify(dados[k])) : padrao; },
            update(k, v) { if (v === undefined) delete dados[k]; else dados[k] = JSON.parse(JSON.stringify(v)); return grava(); },
            keys() { return Object.keys(dados); }, setKeysForSync() { },
        };
    }
    const mudouSegredo = new EventEmitter();
    const context = {
        subscriptions: [],
        extensionPath: ext.pasta, extensionUri: Uri.file(ext.pasta), asAbsolutePath: (rel) => path.join(ext.pasta, rel),
        globalStorageUri: Uri.file(ext.pastaDados), globalStoragePath: ext.pastaDados,
        storageUri: Uri.file(path.join(ext.pastaDados, 'workspace')), storagePath: path.join(ext.pastaDados, 'workspace'),
        logUri: Uri.file(path.join(ext.pastaDados, 'logs')), logPath: path.join(ext.pastaDados, 'logs'),
        extensionMode: 1, extension: { id: ext.id, extensionPath: ext.pasta, packageJSON: ext.pkg, isActive: true },
        globalState: memento(path.join(ext.pastaDados, 'estado.json')),
        workspaceState: memento(path.join(ext.pastaDados, 'estado-workspace.json')),
        secrets: {
            get: (k) => ponte.pede('segredo.get', { chave: String(k) }).then(v => v == null ? undefined : v),
            store: async (k, v) => { await ponte.pede('segredo.store', { chave: String(k), valor: String(v) }); mudouSegredo.fire({ key: String(k) }); },
            delete: async (k) => { await ponte.pede('segredo.delete', { chave: String(k) }); mudouSegredo.fire({ key: String(k) }); },
            onDidChange: mudouSegredo.event,
        },
        environmentVariableCollection: { replace() { }, append() { }, prepend() { }, clear() { }, delete() { }, get() { }, forEach() { } },
    };

    // O que o servidor pede ao host
    const atende = {
        visibilidade: ({ viewId, visivel }) => visibilidade(viewId, !!visivel),
        'webview.recebe': ({ viewId, msg }) => { const v = views.get(viewId); if (v) v.webview._recebe.fire(msg); },
        arvore: ({ viewId, handle }) => itensArvore(viewId, handle),
        clique: ({ viewId, handle }) => clicaItem(viewId, handle),
        comando: ({ comando }) => executeCommand(comando),
        'config.mudou': ({ config, chaves }) => {
            valores = { ...(config || {}) };
            mudouConfig.fire({ affectsConfiguration: (s) => (chaves || []).some(c => c === s || c.startsWith(s + '.') || s.startsWith(c + '.')) });
        },
    };
    return { api, context, atende };
}

module.exports = { criaApi };
