// Editor do Red Code (janela própria). Sem script embutido no HTML: a página roda sob CSP
// que bloqueia scripts inline, então mesmo um texto malicioso num hover não executa nada.
'use strict';
const TOKEN = document.querySelector('meta[name="painel-token"]').content;
const params = new URLSearchParams(location.search);
const CWD = params.get('cwd') || '';
const canal = new BroadcastChannel('painel-claude');
const abas = [];          // { caminho, rel, modelo, codificacao, eol, bom, mtime, salvoVersao, problemas }
let atual = null;
let editor = null;

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let tempoRecado;
function recado(texto) { const el = $('recado'); el.textContent = texto; el.classList.add('visivel'); clearTimeout(tempoRecado); tempoRecado = setTimeout(() => el.classList.remove('visivel'), 2600); }
async function pede(caminho, opcoes = {}) {
    const r = await fetch(caminho, { ...opcoes, headers: { 'X-Painel': '1', 'Content-Type': 'application/json', ...(opcoes.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.erro || 'erro ' + r.status); e.status = r.status; throw e; }
    return d;
}
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ---------- Árvore de arquivos (carrega a pasta quando abre) ----------
async function carregaPasta(dir, alvo) {
    const itens = await pede('/api/editor/arvore?' + q({ cwd: CWD, dir }));
    alvo.innerHTML = itens.map(i => i.tipo === 'pasta'
        ? `<div><button class="no" data-pasta="${esc(dir === '.' ? i.nome : dir + '/' + i.nome)}"><span class="seta">▸</span>${esc(i.nome)}</button><div class="filhos" hidden></div></div>`
        : `<button class="no" data-arquivo="${esc(dir === '.' ? i.nome : dir + '/' + i.nome)}"><span class="seta"></span>${esc(i.nome)}</button>`).join('');
}
$('arvore').addEventListener('click', async (ev) => {
    const p = ev.target.closest('[data-pasta]');
    if (p) {
        const filhos = p.nextElementSibling;
        const abrir = filhos.hidden;
        filhos.hidden = !abrir;
        p.querySelector('.seta').textContent = abrir ? '▾' : '▸';
        if (abrir && !filhos.dataset.carregado) { filhos.dataset.carregado = '1'; try { await carregaPasta(p.dataset.pasta, filhos); } catch (e) { filhos.textContent = e.message; } }
        return;
    }
    const a = ev.target.closest('[data-arquivo]');
    if (a) abreArquivo(a.dataset.arquivo);
});

// ---------- Monaco ----------
const LINGUAGENS = { php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', json: 'json', css: 'css', html: 'html', htm: 'html', md: 'markdown', sql: 'sql', xml: 'xml', yml: 'yaml', yaml: 'yaml', ps1: 'powershell', py: 'python', sh: 'shell', txt: 'plaintext' };
function iniciaMonaco() {
    return new Promise((resolve) => {
        require.config({ paths: { vs: '/vendor/monaco' } });
        require(['vs/editor/editor.main'], () => {
            monaco.editor.defineTheme('painel', {
                base: 'vs-dark', inherit: true, rules: [],
                colors: { 'editor.background': '#141011', 'editor.lineHighlightBackground': '#1d1617', 'editorCursor.foreground': '#e8483d', 'editor.selectionBackground': '#4b3437', 'editorLineNumber.foreground': '#7a6668', 'editorLineNumber.activeForeground': '#e8483d' },
            });
            editor = monaco.editor.create($('editor'), {
                theme: 'painel', automaticLayout: true, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13,
                minimap: { enabled: true }, renderWhitespace: 'selection', scrollBeyondLastLine: false,
                // Links no texto não abrem nada sozinhos (o app só abre http/https e vscode://file)
                links: false,
            });
            editor.onDidChangeCursorPosition((e) => { $('stPosicao').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, salvaAtual);
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, abreBusca);
            editor.addAction({ id: 'perguntar-claude', label: 'Perguntar ao Claude sobre a seleção', contextMenuGroupId: 'navigation', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK], run: perguntarSelecao });
            resolve();
        });
    });
}

// ---------- Abas ----------
function linguagemDe(rel) { return LINGUAGENS[(rel.split('.').pop() || '').toLowerCase()] || 'plaintext'; }
async function abreArquivo(rel, linha) {
    let aba = abas.find(a => a.rel.toLowerCase() === String(rel).replace(/\\/g, '/').toLowerCase() || a.caminho.toLowerCase() === String(rel).toLowerCase());
    if (!aba) {
        let d;
        try { d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: rel })); } catch (e) { return recado(e.message); }
        const modelo = monaco.editor.createModel(d.conteudo, linguagemDe(d.rel), monaco.Uri.file(d.caminho));
        aba = { caminho: d.caminho, rel: d.rel, modelo, codificacao: d.codificacao, soAscii: d.soAscii, eol: d.eol, bom: d.bom, mtime: d.mtime, salvoVersao: modelo.getAlternativeVersionId(), problemas: [] };
        modelo.onDidChangeContent(() => desenhaAbas());
        abas.push(aba);
        diagnostica(aba);
    }
    ativa(aba);
    if (linha) { editor.revealLineInCenter(linha); editor.setPosition({ lineNumber: linha, column: 1 }); }
    editor.focus();
}
function sujo(aba) { return aba.modelo.getAlternativeVersionId() !== aba.salvoVersao; }
function ativa(aba) {
    atual = aba;
    $('vazio').hidden = true; $('editor').hidden = false;
    editor.setModel(aba.modelo);
    $('stCaminho').textContent = aba.rel;
    $('stCodificacao').value = aba.codificacao;
    $('stEol').textContent = aba.eol === 'misto' ? 'CRLF/LF misturados' : aba.eol.toUpperCase();
    document.title = `${aba.rel} · Editor`;
    mostraAviso(aba.eol === 'misto' ? 'Este arquivo mistura fins de linha CRLF e LF. Ao salvar, tudo vira CRLF.' : '');
    desenhaAbas(); desenhaProblemas();
    document.querySelectorAll('.no.atual').forEach(n => n.classList.remove('atual'));
    document.querySelector(`[data-arquivo="${CSS.escape(aba.rel)}"]`)?.classList.add('atual');
}
function desenhaAbas() {
    $('abas').innerHTML = abas.map((a, i) => `<div class="aba ${a === atual ? 'ativa' : ''}" role="tab" data-aba="${i}" title="${esc(a.rel)}">
        ${sujo(a) ? '<span class="sujo" title="Não salvo"></span>' : ''}<span>${esc(a.rel.split('/').pop())}</span><button class="fechar" data-fechar-aba="${i}" aria-label="Fechar">×</button></div>`).join('');
}
$('abas').addEventListener('click', (ev) => {
    const f = ev.target.closest('[data-fechar-aba]');
    if (f) {
        const aba = abas[Number(f.dataset.fecharAba)];
        if (sujo(aba) && !window.confirmarFechar) { mostraAviso(`"${aba.rel}" tem alterações não salvas.`, [['Salvar', () => salvaAba(aba)], ['Descartar e fechar', () => { aba.salvoVersao = aba.modelo.getAlternativeVersionId(); fechaAba(aba); }]]); return; }
        return fechaAba(aba);
    }
    const a = ev.target.closest('[data-aba]');
    if (a) ativa(abas[Number(a.dataset.aba)]);
});
function fechaAba(aba) {
    const i = abas.indexOf(aba);
    abas.splice(i, 1);
    aba.modelo.dispose();
    if (atual === aba) { atual = null; if (abas.length) ativa(abas[Math.max(0, i - 1)]); else { $('editor').hidden = true; $('vazio').hidden = false; $('stCaminho').textContent = ''; } }
    desenhaAbas(); mostraAviso('');
}
function mostraAviso(texto, botoes = []) {
    const el = $('aviso');
    el.hidden = !texto;
    el.innerHTML = esc(texto) + botoes.map((b, i) => `<button data-aviso="${i}">${esc(b[0])}</button>`).join('');
    el.onclick = (ev) => { const b = ev.target.closest('[data-aviso]'); if (b) { mostraAviso(''); botoes[Number(b.dataset.aviso)][1](); } };
}

// ---------- Salvar e diagnósticos ----------
async function salvaAba(aba) {
    try {
        const r = await pede('/api/editor/salvar', { method: 'POST', body: JSON.stringify({ cwd: CWD, caminho: aba.caminho, conteudo: aba.modelo.getValue(), codificacao: aba.codificacao, bom: aba.bom, eol: aba.eol === 'misto' ? 'crlf' : aba.eol, mtimeLido: aba.mtime }) });
        aba.mtime = r.mtime;
        aba.salvoVersao = aba.modelo.getAlternativeVersionId();
        if (aba.eol === 'misto') aba.eol = 'crlf';
        aplicaDiagnosticos(aba, r.diagnosticos);
        desenhaAbas();
        recado(r.diagnosticos && r.diagnosticos.erros.length ? `Salvo, com ${r.diagnosticos.erros.length} erro(s) de sintaxe` : 'Salvo');
    } catch (e) {
        if (e.status === 409) mostraAviso(e.message, [['Recarregar do disco (perde o meu)', () => recarrega(aba)], ['Salvar por cima', () => { aba.mtime = null; salvaAba(aba); }]]);
        else recado(e.message);
    }
}
function salvaAtual() { if (atual) salvaAba(atual); }
async function recarrega(aba) {
    const d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: aba.caminho }));
    aba.modelo.setValue(d.conteudo);
    Object.assign(aba, { codificacao: d.codificacao, eol: d.eol, bom: d.bom, mtime: d.mtime, salvoVersao: aba.modelo.getAlternativeVersionId() });
    if (aba === atual) ativa(aba);
    diagnostica(aba);
}
async function diagnostica(aba) {
    try { aplicaDiagnosticos(aba, await pede('/api/editor/diagnosticos?' + q({ cwd: CWD, caminho: aba.caminho }))); } catch (e) { /* sem diagnóstico */ }
}
function aplicaDiagnosticos(aba, d) {
    aba.problemas = (d && d.erros) || [];
    monaco.editor.setModelMarkers(aba.modelo, 'painel', aba.problemas.map(p => ({
        severity: monaco.MarkerSeverity.Error, message: p.mensagem, startLineNumber: p.linha, endLineNumber: p.linha, startColumn: 1, endColumn: aba.modelo.getLineMaxColumn(Math.min(p.linha, aba.modelo.getLineCount())),
    })));
    if (aba === atual) desenhaProblemas();
}
function desenhaProblemas() {
    const el = $('problemas');
    const lista = atual ? atual.problemas : [];
    el.hidden = !lista.length;
    el.innerHTML = lista.map(p => `<button data-linha="${p.linha}">⛔ Linha ${p.linha}: ${esc(p.mensagem)}</button>`).join('');
}
$('problemas').addEventListener('click', (ev) => { const b = ev.target.closest('[data-linha]'); if (b) { const l = Number(b.dataset.linha); editor.revealLineInCenter(l); editor.setPosition({ lineNumber: l, column: 1 }); editor.focus(); } });
$('btnSalvar').addEventListener('click', salvaAtual);
$('stCodificacao').addEventListener('change', (ev) => {
    if (!atual) return;
    if (!atual.soAscii) { ev.target.value = atual.codificacao; return recado('A codificação deste arquivo foi detectada pelo conteúdo e não muda aqui.'); }
    atual.codificacao = ev.target.value;
    recado('Vale a partir do próximo salvamento.');
});

// Arquivo mudou no disco (o Claude pode ter editado): ao voltar para a janela, confere
window.addEventListener('focus', async () => {
    for (const aba of abas) {
        try {
            const d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: aba.caminho }));
            if (Math.abs(d.mtime - aba.mtime) <= 1) continue;
            if (!sujo(aba)) { await recarrega(aba); recado(`${aba.rel} foi atualizado do disco`); }
            else if (aba === atual) mostraAviso(`"${aba.rel}" mudou no disco enquanto você editava.`, [['Recarregar do disco (perde o meu)', () => recarrega(aba)], ['Manter o meu', () => { aba.mtime = d.mtime; }]]);
        } catch (e) { /* arquivo sumiu */ }
    }
});
window.addEventListener('beforeunload', (ev) => { if (abas.some(sujo)) { ev.preventDefault(); ev.returnValue = ''; } });

// ---------- Perguntar ao Claude sobre a seleção ----------
function perguntarSelecao() {
    if (!atual) return;
    const sel = editor.getSelection();
    const texto = sel && !sel.isEmpty() ? atual.modelo.getValueInRange(sel) : atual.modelo.getLineContent(editor.getPosition().lineNumber);
    const ini = sel && !sel.isEmpty() ? sel.startLineNumber : editor.getPosition().lineNumber;
    const fim = sel && !sel.isEmpty() ? sel.endLineNumber : ini;
    const ext = (atual.rel.split('.').pop() || '').toLowerCase();
    canal.postMessage({ tipo: 'inserir', cwd: CWD, texto: `@${atual.rel}#L${ini}${fim !== ini ? '-' + fim : ''}\n\`\`\`${ext}\n${texto}\n\`\`\`\n` });
    recado('Trecho enviado para a conversa');
}
$('btnPerguntar').addEventListener('click', perguntarSelecao);
$('btnVscode').addEventListener('click', () => { if (atual) window.open('vscode://file/' + encodeURI(atual.caminho.replace(/\\/g, '/')) + ':' + editor.getPosition().lineNumber); });

// ---------- Ctrl+P: abrir arquivo pelo nome ----------
let resultados = [], marcado = 0;
function abreBusca() { $('busca').hidden = false; $('buscaCampo').value = ''; $('buscaLista').innerHTML = ''; $('buscaCampo').focus(); }
$('btnBusca').addEventListener('click', abreBusca);
let esperaBusca;
$('buscaCampo').addEventListener('input', () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(async () => {
        const r = await fetch('/api/arquivos?' + q({ cwd: CWD, q: $('buscaCampo').value }));
        resultados = r.ok ? await r.json() : [];
        marcado = 0;
        $('buscaLista').innerHTML = resultados.map((p, i) => `<button class="resultado" data-res="${i}" aria-selected="${i === 0}">${esc(p)}</button>`).join('');
    }, 120);
});
$('buscaCampo').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { $('busca').hidden = true; editor && editor.focus(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); marcado = (marcado + (ev.key === 'ArrowDown' ? 1 : -1) + resultados.length) % Math.max(1, resultados.length); document.querySelectorAll('.resultado').forEach((b, i) => b.setAttribute('aria-selected', String(i === marcado))); }
    else if (ev.key === 'Enter' && resultados[marcado]) { $('busca').hidden = true; abreArquivo(resultados[marcado]); }
});
$('buscaLista').addEventListener('click', (ev) => { const b = ev.target.closest('[data-res]'); if (b) { $('busca').hidden = true; abreArquivo(resultados[Number(b.dataset.res)]); } });
document.addEventListener('keydown', (ev) => { if (ev.ctrlKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); abreBusca(); } if (ev.ctrlKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); salvaAtual(); } });

// ---------- Mensagens da janela principal: abrir arquivo, "está aí?" ----------
canal.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.tipo === 'ping-editor' && m.cwd === CWD) canal.postMessage({ tipo: 'pong-editor', cwd: CWD });
    if (m.tipo === 'abrir' && m.cwd === CWD) { window.painelDesktop?.mostrar?.(); window.focus(); if (m.arquivo) abreArquivo(m.arquivo, m.linha); }
});

// ---------- Início ----------
(async () => {
    $('arvore').innerHTML = `<div class="raiz">${esc(CWD)}</div><div id="raizArvore"></div>`;
    try { await carregaPasta('.', $('raizArvore')); } catch (e) { $('raizArvore').textContent = e.message; }
    await iniciaMonaco();
    if (params.get('arquivo')) abreArquivo(params.get('arquivo'), Number(params.get('linha')) || undefined);
})();
