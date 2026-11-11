// Editor do Red Code (janela própria). Sem script embutido no HTML: a página roda sob CSP
// que bloqueia scripts inline, então mesmo um texto malicioso num hover não executa nada.
'use strict';
const TOKEN = document.querySelector('meta[name="painel-token"]').content;
const params = new URLSearchParams(location.search);
const CWD = params.get('cwd') || '';
// Dentro da janela principal (iframe do editor ao vivo): quem fala com ele é a página, não o canal
const EMBUTIDO = params.get('embutido') === '1';
const canal = new BroadcastChannel('painel-claude');
const abas = [];          // { caminho, rel, modelo, codificacao, eol, bom, mtime, salvoVersao, problemas, travada }
let atual = null;
let editor = null;
let travados = new Set(); // caminhos (minúsculos) que o Claude está editando agora: só leitura
let liberaPronto;
const monacoPronto = new Promise(r => { liberaPronto = r; });

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
            // Embutido no ao vivo: as mesmas cores e fonte do código ao vivo (tema escuro e claro do Red Code)
            monaco.editor.defineTheme('aovivo-escuro', {
                base: 'vs-dark', inherit: true, rules: [],
                colors: { 'editor.background': '#1f1f1f', 'editor.foreground': '#cccccc', 'editor.lineHighlightBackground': '#2a2d2e', 'editor.lineHighlightBorder': '#2a2d2e', 'editorLineNumber.foreground': '#6e7681', 'editorLineNumber.activeForeground': '#cccccc', 'editorCursor.foreground': '#e8483d', 'editorGutter.background': '#1f1f1f' },
            });
            monaco.editor.defineTheme('aovivo-claro', {
                base: 'vs', inherit: true, rules: [],
                colors: { 'editor.background': '#ffffff', 'editor.foreground': '#1f1f1f', 'editor.lineHighlightBackground': '#f0f0f0', 'editor.lineHighlightBorder': '#f0f0f0', 'editorLineNumber.foreground': '#6e7681', 'editorLineNumber.activeForeground': '#0b216f', 'editorCursor.foreground': '#e8483d', 'editorGutter.background': '#ffffff' },
            });
            editor = monaco.editor.create($('editor'), {
                theme: EMBUTIDO ? 'aovivo-' + temaAtual : 'painel', automaticLayout: true,
                fontFamily: EMBUTIDO ? 'Consolas, "Cascadia Mono", "Courier New", monospace' : 'Cascadia Mono, Consolas, monospace',
                fontSize: EMBUTIDO ? 14 : 13, lineHeight: EMBUTIDO ? 19 : 0, fontLigatures: false,
                minimap: { enabled: !EMBUTIDO }, renderWhitespace: 'selection', scrollBeyondLastLine: false,
                // Links no texto não abrem nada sozinhos (o app só abre http/https e vscode://file)
                links: false,
            });
            editor.onDidChangeCursorPosition((e) => { $('stPosicao').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; avisaPagina(); });
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, salvaAtual);
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, abreBusca);
            editor.addAction({ id: 'perguntar-claude', label: 'Perguntar ao Claude sobre a seleção', contextMenuGroupId: 'navigation', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK], run: perguntarSelecao });
            resolve();
        });
    });
}

// ---------- Abas ----------
function linguagemDe(rel) { return LINGUAGENS[(rel.split('.').pop() || '').toLowerCase()] || 'plaintext'; }
async function abreArquivo(rel, linha, focar = true) {
    let aba = abas.find(a => a.rel.toLowerCase() === String(rel).replace(/\\/g, '/').toLowerCase() || a.caminho.toLowerCase() === String(rel).toLowerCase());
    if (!aba) {
        let d;
        try { d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: rel })); } catch (e) { return recado(e.message); }
        aba = abas.find(a => a.caminho.toLowerCase() === d.caminho.toLowerCase()) || criaAba(d);
    }
    ativa(aba);
    if (linha) { editor.revealLineInCenter(linha); editor.setPosition({ lineNumber: linha, column: 1 }); }
    // A página troca de arquivo sozinha (fim da trava, Seguindo): aí não rouba o foco do campo de mensagem
    if (focar) editor.focus();
}
function criaAba(d) {
    const modelo = monaco.editor.createModel(d.conteudo, linguagemDe(d.rel), monaco.Uri.file(d.caminho));
    const aba = { caminho: d.caminho, rel: d.rel, modelo, codificacao: d.codificacao, soAscii: d.soAscii, eol: d.eol, bom: d.bom, mtime: d.mtime, salvoVersao: modelo.getAlternativeVersionId(), problemas: [], travada: travados.has(d.caminho.toLowerCase()) };
    modelo.onDidChangeContent(() => {
        // A pessoa começou a digitar: o verde da última edição do Claude sai
        if (!aba.animando && decoracoesAnim && aba === atual) decoracoesAnim.clear();
        desenhaAbas(); avisaPagina();
    });
    abas.push(aba);
    diagnostica(aba);
    return aba;
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
    aplicaTrava(aba);
    if (!aba.travada) mostraAviso(aba.eol === 'misto' ? 'Este arquivo mistura fins de linha CRLF e LF. Ao salvar, tudo vira CRLF.' : '');
    desenhaAbas(); desenhaProblemas();
    if (window.mdAbaAtivada) window.mdAbaAtivada(aba);
    document.querySelectorAll('.no.atual').forEach(n => n.classList.remove('atual'));
    document.querySelector(`[data-arquivo="${CSS.escape(aba.rel)}"]`)?.classList.add('atual');
    avisaPagina();
}
// Embutido: a página principal desenha abas e barra de status do ao vivo; aqui só conta o estado
function avisaPagina() {
    if (!EMBUTIDO || !editor) return;
    const pos = editor.getPosition();
    try {
        window.parent.editorEmbutidoMudou?.(CWD, {
            caminho: atual ? atual.caminho : '', linha: pos ? pos.lineNumber : 1, coluna: pos ? pos.column : 1,
            codificacao: atual ? atual.codificacao : '', eol: atual ? atual.eol : '', travada: !!(atual && atual.travada),
            sujos: abas.filter(sujo).map(a => a.caminho),
        });
    } catch (e) { /* página principal fechando */ }
}
function desenhaAbas() {
    $('abas').innerHTML = abas.map((a, i) => `<div class="aba ${a === atual ? 'ativa' : ''}" role="tab" data-aba="${i}" title="${esc(a.rel)}">
        ${a.travada ? '<span class="trava" title="O Claude está editando: só leitura">🔒</span>' : ''}${sujo(a) ? '<span class="sujo" title="Não salvo"></span>' : ''}<span>${esc(a.rel.split('/').pop())}</span><button class="fechar" data-fechar-aba="${i}" aria-label="Fechar">×</button></div>`).join('');
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
    if (atual === aba) { atual = null; if (abas.length) ativa(abas[Math.max(0, i - 1)]); else { $('editor').hidden = true; $('previa').hidden = true; $('btnMdLado').hidden = true; $('btnMdSo').hidden = true; $('area').dataset.modo = 'codigo'; $('vazio').hidden = false; $('stCaminho').textContent = ''; } }
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
    if (aba.travada) return recado('O Claude está editando este arquivo. Espere ele terminar para salvar.');
    try {
        const r = await pede('/api/editor/salvar', { method: 'POST', body: JSON.stringify({ cwd: CWD, caminho: aba.caminho, conteudo: aba.modelo.getValue(), codificacao: aba.codificacao, bom: aba.bom, eol: aba.eol === 'misto' ? 'crlf' : aba.eol, mtimeLido: aba.mtime }) });
        aba.mtime = r.mtime;
        aba.salvoVersao = aba.modelo.getAlternativeVersionId();
        if (aba.eol === 'misto') aba.eol = 'crlf';
        aplicaDiagnosticos(aba, r.diagnosticos);
        desenhaAbas(); avisaPagina();
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

// Arquivo mudou no disco (o Claude pode ter editado): sem alteração minha, recarrega; com, pergunta
async function confereDisco(aba, avisar = true) {
    if (aba.conferindo || aba.animando) return;   // uma conferência por vez; a animação já termina igual ao disco
    aba.conferindo = true;
    try {
        const d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: aba.caminho }));
        if (Math.abs(d.mtime - aba.mtime) <= 1) return;
        if (!sujo(aba)) { await recarrega(aba); if (avisar) recado(`${aba.rel} foi atualizado do disco`); }
        else if (aba === atual && !aba.travada) mostraAviso(`"${aba.rel}" mudou no disco enquanto você editava.`, [['Recarregar do disco (perde o meu)', () => recarrega(aba)], ['Manter o meu', () => { aba.mtime = d.mtime; }]]);
    } catch (e) { /* arquivo sumiu */ }
    finally { aba.conferindo = false; }
}
window.addEventListener('focus', () => { for (const aba of abas) confereDisco(aba); });

// ---------- Trava: arquivo que o Claude está editando fica só leitura (evita uma edição atropelar a outra) ----------
function aplicaTrava(aba) {
    if (aba !== atual || !editor) return;
    editor.updateOptions({ readOnly: !!aba.travada, readOnlyMessage: { value: 'O Claude está editando este arquivo. Ele volta a ser editável quando o Claude terminar.' } });
    // Embutido: o aviso fica na trilha do ao vivo (uma faixa aqui empurraria o código a cada trava)
    if (aba.travada && !EMBUTIDO) mostraAviso('🔒 O Claude está editando este arquivo: só leitura até ele terminar. As mudanças dele aparecem aqui.');
}
// A página principal chama a cada atualização da conversa, com os caminhos completos
window.travaArquivos = (lista) => {
    travados = new Set((lista || []).map(c => String(c).toLowerCase()));
    let mudou = false;
    for (const aba of abas) {
        // Travado: o que o Claude grava chega pela animação (window.animaEdicao), não por recarga
        const travada = travados.has(aba.caminho.toLowerCase());
        if (travada === !!aba.travada) continue;
        aba.travada = travada; mudou = true;
        if (aba === atual) { aplicaTrava(aba); if (!travada) mostraAviso(''); }
        // Liberado: pega a versão final do disco (ou pergunta, se eu tinha mexido antes da trava)
        if (!travada) confereDisco(aba);
    }
    if (mudou) { desenhaAbas(); avisaPagina(); }
};
// Fecha o arquivo sem trocar sozinho de aba (no ao vivo, quem escolhe a próxima é a página). Não salvo: só com forcar
window.fechaArquivoEditor = (caminho, forcar) => {
    const aba = abas.find(a => a.caminho.toLowerCase() === String(caminho).toLowerCase());
    if (!aba) return true;
    if (sujo(aba) && !forcar) return false;
    abas.splice(abas.indexOf(aba), 1);
    if (atual === aba) { atual = null; editor.setModel(null); }
    aba.modelo.dispose();
    desenhaAbas(); avisaPagina();
    return true;
};
// ---------- Animação da edição do Claude (o ao vivo dentro do editor) ----------
// A página manda cada edição: o arquivo volta ao "antes", as linhas que saem ficam vermelhas e somem,
// e o texto novo é digitado com fundo verde. No fim o modelo é sempre igual ao disco (nada fica pela metade).
let geracaoAnim = 0;
let decoracoesAnim = null;
const esperaAnim = (ms, g) => new Promise((ok, falha) => setTimeout(() => g === geracaoAnim ? ok() : falha('cancelado'), ms));
const normaliza = (t) => String(t || '').replace(/\r\n/g, '\n');
const faixa = (m, ini, fim) => { const a = m.getPositionAt(ini), b = m.getPositionAt(fim); return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column); };
const linhasInteiras = (m, ini, fim, classe) => {
    const a = m.getPositionAt(ini), b = m.getPositionAt(Math.max(ini, fim - 1));
    return { range: new monaco.Range(a.lineNumber, 1, b.lineNumber, 1), options: { isWholeLine: true, className: classe, linesDecorationsClassName: classe + '-margem' } };
};
// Onde está o texto novo no arquivo final: a ocorrência mais perto da linha em que o Claude mexeu por último
function achaDepois(final, depois, linhaRef) {
    if (!depois) return -1;
    const achados = [];
    for (let i = final.indexOf(depois); i >= 0 && achados.length < 50; i = final.indexOf(depois, i + 1)) achados.push(i);
    if (!achados.length) return -1;
    const linhaDe = (p) => final.slice(0, p).split('\n').length;
    return linhaRef ? achados.sort((a, b) => Math.abs(linhaDe(a) - linhaRef) - Math.abs(linhaDe(b) - linhaRef))[0] : achados[0];
}
// Trecho longo vem cortado (só as primeiras linhas): o fim é contado pelo total de linhas
function fimDoDepois(final, ini, t, depois) {
    if (!t.depoisCortado) return ini + depois.length;
    let p = ini;
    for (let n = 1; n < t.depoisTotal; n++) { const q = final.indexOf('\n', p); if (q < 0) return final.length; p = q + 1; }
    const q = final.indexOf('\n', p);
    return q < 0 ? final.length : q;
}
window.animaEdicao = async (ed, { animar = true, linha } = {}) => {
    await monacoPronto;
    const g = ++geracaoAnim;
    let d;
    try { d = await pede('/api/editor/arquivo?' + q({ cwd: CWD, caminho: ed.caminho })); } catch (e) { return { ok: false }; }
    if (g !== geracaoAnim) return { ok: false };
    const aba = abas.find(a => a.caminho.toLowerCase() === d.caminho.toLowerCase()) || criaAba(d);
    if (!decoracoesAnim) decoracoesAnim = editor.createDecorationsCollection();
    decoracoesAnim.clear();
    // Alteração minha não salva por cima: não atropela (ao liberar, o editor pergunta o que fazer)
    if (sujo(aba)) { ativa(aba); return { ok: false }; }
    const final = d.conteudo, m = aba.modelo;
    // Cada trecho novo volta a ser o que era: esse é o "antes" que a animação parte
    const trechos = [];
    if (ed.tipo === 'diff') {
        for (const t of ed.trocas || []) {
            const depois = normaliza(t.depois), ini = achaDepois(final, depois, linha);
            if (ini < 0) continue;   // só apagou, ou o texto não está mais no arquivo: aparece pronto
            const fim = fimDoDepois(final, ini, t, depois);
            if (!trechos.some(x => ini < x.fim && fim > x.ini)) trechos.push({ ini, fim, antes: normaliza(t.antes), depois: final.slice(ini, fim) });
        }
    } else if (final !== m.getValue() || animar) trechos.push({ ini: 0, fim: final.length, antes: '', depois: final });
    trechos.sort((a, b) => a.ini - b.ini);
    let inicio = final;
    for (const t of [...trechos].reverse()) inicio = inicio.slice(0, t.ini) + t.antes + inicio.slice(t.fim);
    aba.animando = true; aba.animG = g;
    ativa(aba);
    const termina = () => {
        if (aba.animG !== g) return;   // outra animação no mesmo arquivo já assumiu
        aba.animando = false;
        if (m.getValue() !== final) m.setValue(final);
        aba.mtime = d.mtime; aba.salvoVersao = m.getAlternativeVersionId();
        // Fica o verde do que entrou (como no ao vivo) até a pessoa digitar ou a próxima edição
        if (atual === aba) decoracoesAnim.set(trechos.filter(t => t.fim > t.ini).map(t => linhasInteiras(m, t.ini, t.fim, 'dec-entra')));
        desenhaAbas(); avisaPagina();
    };
    const linhaDe = (t) => m.getPositionAt(t.ini).lineNumber;
    if (!animar || !trechos.length) {
        termina();
        if (trechos.length) { editor.revealLineInCenter(linhaDe(trechos[0])); editor.setPosition({ lineNumber: linhaDe(trechos[0]), column: 1 }); }
        return { ok: true, linha: trechos.length ? linhaDe(trechos[0]) : 1 };
    }
    if (m.getValue() !== inicio) m.setValue(inicio);
    try {
        // Já trocados os trechos de cima, cada um começa no mesmo ponto em que fica no arquivo final
        for (const t of trechos) {
            // 1) as linhas que saem ficam vermelhas e somem
            if (t.antes) {
                const r = faixa(m, t.ini, t.ini + t.antes.length);
                decoracoesAnim.set([linhasInteiras(m, t.ini, t.ini + t.antes.length, 'dec-sai')]);
                editor.revealRangeInCenterIfOutsideViewport(r);
                await esperaAnim(350 + Math.min(12, r.endLineNumber - r.startLineNumber + 1) * 90, g);
                m.applyEdits([{ range: r, text: '' }]);
                decoracoesAnim.clear();
                await esperaAnim(250, g);
            } else {
                editor.revealLineInCenterIfOutsideViewport(linhaDe(t));
                await esperaAnim(350, g);
            }
            // 2) digita o que entra (até ~6 s por trecho: a velocidade acompanha o tamanho)
            const texto = t.depois, passo = Math.max(1, Math.ceil((Math.min(4000, texto.length) || 1) / 380));
            for (let feito = 0; feito < texto.length;) {
                const n = feito >= 4000 ? texto.length - feito : Math.min(passo, texto.length - feito);
                const p = m.getPositionAt(t.ini + feito);
                m.applyEdits([{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: texto.slice(feito, feito + n) }]);
                feito += n;
                const cursor = m.getPositionAt(t.ini + feito);
                decoracoesAnim.set([linhasInteiras(m, t.ini, t.ini + feito, 'dec-entra')]);
                editor.setPosition(cursor); editor.revealPositionInCenterIfOutsideViewport(cursor);
                await esperaAnim(16, g);
            }
            await esperaAnim(500, g);
        }
    } catch (x) { if (x !== 'cancelado') console.error(x); }
    termina();
    return { ok: true, linha: linhaDe(trechos[trechos.length - 1]) };
};
let temaAtual = params.get('tema') === 'claro' ? 'claro' : 'escuro';
window.temaEditor = (tema) => {
    temaAtual = tema === 'claro' ? 'claro' : 'escuro';
    document.body.dataset.tema = temaAtual;
    if (editor && EMBUTIDO) monaco.editor.setTheme('aovivo-' + temaAtual);
};
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
// Embutido: as abas são as do ao vivo, então arquivo novo entra pelo Explorar da janela principal
function abreBusca() { if (EMBUTIDO) return; $('busca').hidden = false; $('buscaCampo').value = ''; $('buscaLista').innerHTML = ''; $('buscaCampo').focus(); }
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
    if (EMBUTIDO) return;   // a janela do editor continua sendo a que responde "está aí?"
    if (m.tipo === 'ping-editor' && m.cwd === CWD) canal.postMessage({ tipo: 'pong-editor', cwd: CWD });
    if (m.tipo === 'abrir' && m.cwd === CWD) { window.painelDesktop?.mostrar?.(); window.focus(); if (m.arquivo) abreArquivo(m.arquivo, m.linha); }
});

// Para a visualização de Markdown (editor-md.js)
window.abaAtualEditor = () => atual;
window.editorMonaco = () => editor;
// A página principal pode chamar antes do Monaco carregar: espera
window.abreArquivoEditor = async (rel, linha, focar = true) => { await monacoPronto; return abreArquivo(rel, linha, focar); };

// ---------- Início ----------
(async () => {
    // Embutido: a árvore fica na coluna da lista da janela principal (botão Explorar)
    if (EMBUTIDO) { document.body.classList.add('embutido'); document.body.dataset.tema = temaAtual; }
    else {
        $('arvore').innerHTML = `<div class="raiz">${esc(CWD)}</div><div id="raizArvore"></div>`;
        try { await carregaPasta('.', $('raizArvore')); } catch (e) { $('raizArvore').textContent = e.message; }
    }
    await iniciaMonaco();
    liberaPronto();
    if (params.get('arquivo')) abreArquivo(params.get('arquivo'), Number(params.get('linha')) || undefined);
})();
