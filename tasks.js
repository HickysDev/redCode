// Visão Tasks: constelação das listas de tarefas de todas as conversas, com o Claude no centro.
// Os pulsos nas linhas são o fluxo real lido do transcript (atraso de 1 a 3 s): "in" vai ao Claude, "out" volta dele.
(() => {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const INTERVALO_POLL = 2000;
    const MINUTOS_ABSORVE = 10;
    const PULSO = 18, DURACAO_PULSO = 750, MAX_PULSOS_LINHA = 3, LOTE_MAX_MS = 2000;
    const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sinaisLigados = () => localStorage.getItem('tasksSinais') !== '0';

    const css = `
#janelaTasks { position: fixed; inset: 0; z-index: 65; background: radial-gradient(ellipse 60% 55% at 50% 52%, color-mix(in srgb, var(--voce) 14%, var(--papel)) 0%, var(--papel) 70%); color: var(--tinta); overflow: hidden; font-family: var(--sans); }
#janelaTasks[hidden] { display: none; }
#janelaTasks::after { content: ""; position: absolute; inset: 0; pointer-events: none; background-image: radial-gradient(color-mix(in srgb, var(--tinta) 7%, transparent) 1px, transparent 1px); background-size: 26px 26px; mask-image: radial-gradient(ellipse at 50% 52%, transparent 10%, #000 70%); }
#tasksSvg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; cursor: grab; }
#tasksSvg.arrastando { cursor: grabbing; }
.tk-topo { position: absolute; z-index: 6; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 12px; padding: 14px 20px; }
.tk-topo h2 { font-size: 19px; font-weight: 700; display: flex; align-items: center; gap: 9px; margin: 0; }
.tk-topo h2 i { width: 16px; height: 16px; border-radius: 50%; border: 3px solid var(--voce); box-shadow: 0 0 12px var(--voce); }
.tk-seg { display: flex; background: color-mix(in srgb, var(--tinta) 5%, transparent); border: 1px solid var(--linha); border-radius: 10px; padding: 3px; margin-left: 14px; }
.tk-seg button { font-size: 12.5px; padding: 5px 11px; border-radius: 7px; color: var(--grafite); display: flex; gap: 6px; align-items: center; }
.tk-seg button.sel { background: color-mix(in srgb, var(--tinta) 9%, transparent); color: var(--tinta); }
.tk-seg small { font-size: 10.5px; padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--tinta) 8%, transparent); }
.tk-busca { margin-left: auto; width: 250px; font: inherit; font-size: 12.5px; color: var(--tinta); border: 1px solid var(--linha); background: color-mix(in srgb, var(--tinta) 4%, transparent); border-radius: 10px; padding: 7px 12px; }
.tk-ic { min-width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--linha); background: color-mix(in srgb, var(--tinta) 4%, transparent); display: grid; place-items: center; color: var(--grafite); font-size: 13px; padding: 0 9px; }
.tk-ic:hover, .tk-ic.sel { color: var(--voce); border-color: var(--voce); }
.tk-bh { position: absolute; z-index: 1; left: 0; top: 0; width: 0; height: 0; pointer-events: none; transform-origin: 0 0; }
.tk-bh > div { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; }
.tk-halo { width: 520px; height: 520px; background: radial-gradient(circle, #ff9d4a33 0%, #e8483d22 30%, transparent 62%); filter: blur(18px); }
.tk-bh > .tk-disco { width: 440px; height: 440px; background: conic-gradient(from 200deg, #ffb070, #fff1d6 12%, #ff8a3d 22%, #c2410c 35%, #7f1d1d 52%, #e8483d 64%, #ff8a3d 82%, #ffb070); -webkit-mask: radial-gradient(circle, transparent 31%, #000 33%, #000 46%, transparent 70%); transform: translate(-50%, -50%) rotateX(76deg) rotateZ(0deg); filter: blur(1.5px) saturate(1.2); opacity: .95; animation: tk-gira 24s linear infinite; }
.tk-bh > .tk-disco.frente { clip-path: inset(50% 0 0 0); z-index: 3; animation: none; transform: translate(-50%, -50%) rotateX(76deg); }
.tk-bh > .tk-lente { z-index: 2; width: 150px; height: 150px; background: conic-gradient(from 90deg, #fff1d6, #ff8a3d 25%, #e8483d 50%, #ff8a3d 75%, #fff1d6); -webkit-mask: radial-gradient(circle, transparent 60%, #000 63%, #000 70%, transparent 78%); filter: blur(2.5px); opacity: .9; }
.tk-bh > .tk-horizonte { z-index: 2; width: 104px; height: 104px; background: radial-gradient(circle, #000 62%, #050308 80%, #1a0f05 100%); box-shadow: 0 0 0 1.5px #ffe2b866, 0 0 24px 6px #ff8a3d55, inset 0 0 18px #000; }
.tk-bh > .tk-centro { z-index: 4; border-radius: 0; transform: translate(-50%, 100px); text-align: center; white-space: nowrap; }
.tk-centro b { display: block; font-size: 30px; font-weight: 700; background: linear-gradient(90deg, #ffd29a, #e8483d); -webkit-background-clip: text; background-clip: text; color: transparent; }
.tk-centro span { font-size: 12px; color: var(--grafite); }
@keyframes tk-gira { to { transform: translate(-50%, -50%) rotateX(76deg) rotateZ(360deg); } }
@keyframes tk-roda { to { transform: rotate(360deg); } }
.tk-roda { transform-box: fill-box; transform-origin: center; animation: tk-roda 3.5s linear infinite; }
#tasksSvg text { font-family: var(--sans); fill: var(--tinta); pointer-events: none; }
#tasksSvg .tk-no { cursor: pointer; transition: opacity .2s; }
#tasksSvg .tk-fio { transition: opacity .2s; }
#janelaTasks.focando .tk-esmaece { opacity: .3; }
#janelaTasks.buscando .tk-nao-achado { opacity: .2; }
.tk-gaveta { position: absolute; z-index: 6; top: 64px; right: 20px; width: 340px; max-height: calc(100% - 210px); overflow: auto; background: color-mix(in srgb, var(--folha) 88%, transparent); border: 1px solid var(--linha); border-radius: 16px; padding: 16px; backdrop-filter: blur(18px); box-shadow: 0 20px 60px #0007; }
.tk-gaveta[hidden] { display: none; }
.tk-gaveta .cab { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.tk-gaveta h3 { font-size: 15px; margin: 0; }
.tk-gaveta .sub { font-size: 12px; color: var(--grafite); margin-top: 2px; }
.tk-gaveta .acoes { display: flex; gap: 8px; margin-bottom: 12px; }
.tk-gaveta .acoes button { font-size: 12px; padding: 6px 11px; border-radius: 8px; border: 1px solid var(--linha); color: var(--tinta); }
.tk-gaveta .acoes button.pri { background: var(--voce); border-color: var(--voce); color: #fff; }
.tk-gaveta h4 { font-size: 10.5px; letter-spacing: .8px; color: var(--grafite); margin: 6px 0; font-weight: 600; }
.tk-lin { display: flex; align-items: center; gap: 9px; font-size: 13px; padding: 6px 4px; border-radius: 7px; }
.tk-lin.c { color: var(--grafite); }
.tk-lin.a { background: color-mix(in srgb, var(--tinta) 6%, transparent); font-weight: 600; }
.tk-lin.filho { padding-left: 26px; font-size: 12px; color: var(--agente); }
.tk-lin small { margin-left: auto; font-size: 11.5px; color: var(--grafite); font-variant-numeric: tabular-nums; }
.tk-leg { position: absolute; z-index: 5; left: 20px; bottom: 18px; display: flex; flex-wrap: wrap; gap: 16px; align-items: center; font-size: 12px; color: var(--grafite); background: color-mix(in srgb, var(--folha) 85%, transparent); border: 1px solid var(--linha); border-radius: 12px; padding: 9px 14px; backdrop-filter: blur(12px); }
.tk-leg span { display: flex; align-items: center; gap: 7px; }
.tk-feed { position: absolute; z-index: 5; right: 20px; bottom: 18px; width: 340px; background: color-mix(in srgb, var(--folha) 85%, transparent); border: 1px solid var(--linha); border-radius: 12px; padding: 10px 14px; backdrop-filter: blur(12px); font-size: 12px; color: var(--grafite); }
.tk-feed h4 { font-size: 10.5px; letter-spacing: 1px; margin: 0 0 6px; font-weight: 600; }
.tk-feed div { display: flex; gap: 8px; align-items: center; margin: 4px 0; color: var(--tinta); }
.tk-feed div i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tk-feed div small { margin-left: auto; color: var(--grafite); }
.tk-vazio { position: absolute; z-index: 5; left: 50%; top: 70%; transform: translateX(-50%); color: var(--grafite); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .tk-disco, .tk-roda { animation: none; } }
`;

    const html = `
<div class="tk-bh" id="tkBh"><div class="tk-halo"></div><div class="tk-disco"></div><div class="tk-lente"></div><div class="tk-horizonte"></div><div class="tk-disco frente"></div><div class="tk-centro"><b id="tkPct">0%</b><span id="tkResumo"></span></div></div>
<svg id="tasksSvg" xmlns="${NS}"><g id="tkFios"></g><g id="tkPulsos"></g><g id="tkNos"></g></svg>
<div class="tk-topo">
  <h2><i></i>Tasks</h2>
  <div class="tk-seg" id="tkFiltros">
    <button data-f="todas" class="sel">Todas <small>0</small></button>
    <button data-f="ativas">Ativas <small>0</small></button>
    <button data-f="esperando">Esperando você <small>0</small></button>
    <button data-f="agentes">Com agentes <small>0</small></button>
  </div>
  <input class="tk-busca" id="tkBusca" placeholder="Buscar tarefa ou conversa (Ctrl+K)">
  <button class="tk-ic" id="tkSinais" title="Ligar ou desligar os sinais nas linhas">⚡ sinais</button>
  <button class="tk-ic" id="tkAbsorvidas" title="Mostrar conversas concluídas que caíram no centro">absorvidas</button>
  <button class="tk-ic" id="tkAjusta" title="Ajustar à tela">⤢</button>
  <button class="tk-ic" id="tkFecha" title="Fechar (Esc)">×</button>
</div>
<div class="tk-gaveta" id="tkGaveta" hidden></div>
<div class="tk-feed" id="tkFeed"><h4>AGORA</h4><p style="margin:0">Nada ainda.</p></div>
<div class="tk-leg">
  <span><svg width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-opacity=".6"/></svg>não iniciada</span>
  <span><svg width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="var(--voce)" stroke-width="1.8" stroke-dasharray="17 40" transform="rotate(-90 8 8)"/></svg>parcial</span>
  <span><svg width="16" height="16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="var(--voce)" stroke-width="1.8"/><circle cx="8" cy="8" r="2.3" fill="var(--voce)"/></svg>concluída</span>
  <span><svg width="16" height="16"><rect x="4" y="4" width="8" height="8" rx="2" transform="rotate(45 8 8)" fill="none" stroke="var(--agente)" stroke-width="1.4"/></svg>subagente</span>
  <span><svg width="26" height="10"><line x1="2" y1="5" x2="24" y2="5" stroke="var(--voce)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="7 30"/></svg>entrada (vai ao Claude)</span>
  <span><svg width="26" height="10"><line x1="24" y1="5" x2="2" y2="5" stroke="#ffe2b8" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="7 30"/></svg>saída (volta do Claude)</span>
</div>
<div class="tk-vazio" id="tkVazio" hidden>Nenhuma conversa com lista de tarefas nas últimas 24 h.</div>`;

    const estilo = document.createElement('style');
    estilo.textContent = css;
    document.head.appendChild(estilo);
    const janela = document.createElement('div');
    janela.id = 'janelaTasks';
    janela.hidden = true;
    janela.setAttribute('role', 'dialog');
    janela.setAttribute('aria-label', 'Tasks');
    janela.innerHTML = html;
    document.body.appendChild(janela);

    const $ = (id) => document.getElementById(id);
    const svg = $('tasksSvg'), gFios = $('tkFios'), gPulsos = $('tkPulsos'), gNos = $('tkNos');
    const escapa = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const el = (tag, atributos, pai) => {
        const e = document.createElementNS(NS, tag);
        for (const k in atributos) if (atributos[k] !== undefined && atributos[k] !== null) e.setAttribute(k, atributos[k]);
        if (pai) pai.appendChild(e);
        return e;
    };
    const texto = (pai, x, y, conteudo, atributos) => { const t = el('text', { x, y, ...atributos }, pai); t.textContent = conteudo; return t; };
    const varCss = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
    const rad = (g) => g * Math.PI / 180;

    let dados = null, hash = '', timer = null, filtro = 'todas', busca = '', foco = null, selecionada = null, mostraAbsorvidas = false;
    let viewBox = null, layoutBase = null;
    const tocados = new Map();
    const feed = [];
    let anterior = null;

    // PROGRESSO
    const progressoTarefa = (t) => {
        if (t.status === 'completed') return 1;
        const filhos = (t.subagentes || []).flatMap(s => s.tarefas);
        if (filhos.length) return filhos.reduce((s, f) => s + progressoTarefa(f), 0) / filhos.length;
        if (t.status === 'pending') return 0;
        return 0.5;
    };
    const progressoConversa = (c) => c.tarefas.length ? c.tarefas.reduce((s, t) => s + progressoTarefa(t), 0) / c.tarefas.length : (todosSubs(c).every(s => s.status !== 'rodando') ? 1 : 0.5);
    const todosSubs = (c) => [...c.tarefas.flatMap(t => t.subagentes), ...c.subagentesSoltos];
    const absorvida = (c) => !c.vivo && progressoConversa(c) >= 1 && Date.now() - c.ultimo > MINUTOS_ABSORVE * 60000;
    const passaFiltro = (c) => filtro === 'todas' || (filtro === 'ativas' && c.vivo) || (filtro === 'esperando' && c.esperando) || (filtro === 'agentes' && todosSubs(c).length > 0);

    function corDaConversa(id) {
        const paleta = [varCss('--voce') || '#e8483d', '#38bdf8', '#2dd4bf', varCss('--atencao') || '#f0b264', '#a882ff', '#f472b6', varCss('--ok') || '#9fc5a9', '#fb923c'];
        let h = 0;
        for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return paleta[h % paleta.length];
    }

    function anel(pai, x, y, r, p, cor, o = {}) {
        const g = el('g', {}, pai);
        const sw = o.sw || 2;
        if (o.aura) el('circle', { cx: x, cy: y, r: r + 8, fill: cor, opacity: .14 }, g);
        el('circle', { cx: x, cy: y, r, fill: o.fundo || varCss('--folha'), stroke: varCss('--tinta'), 'stroke-opacity': p === 0 ? .5 : .12, 'stroke-width': p === 0 ? 1.2 : sw, 'stroke-dasharray': o.tracejado ? '2 3' : null }, g);
        if (p > 0 && p < 1) {
            const c = 2 * Math.PI * r;
            const arco = el('circle', { cx: x, cy: y, r, fill: 'none', stroke: cor, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * p} ${c}`, transform: `rotate(-90 ${x} ${y})` }, g);
            if (o.gira) { const gg = el('g', { class: 'tk-roda' }, g); gg.appendChild(arco); }
        }
        if (p >= 1) {
            el('circle', { cx: x, cy: y, r, fill: 'none', stroke: cor, 'stroke-width': sw }, g);
            el('circle', { cx: x, cy: y, r: Math.max(1.6, r * .42), fill: cor }, g);
        }
        return g;
    }

    // LAYOUT DETERMINISTICO: CONVERSAS NUMA ELIPSE, TAREFAS EM ARCO VIRADO PARA FORA
    function monta() {
        const visiveis = dados.conversas.filter(c => passaFiltro(c) && (mostraAbsorvidas || !absorvida(c))).sort((a, b) => a.id.localeCompare(b.id));
        const n = visiveis.length;
        const rx = 300 + Math.min(n, 10) * 28, ry = 210 + Math.min(n, 10) * 20;
        const fios = [], nos = [];
        visiveis.forEach((c, i) => {
            const a = rad(-120 + 360 * i / Math.max(n, 1));
            const x = rx * Math.cos(a), y = ry * Math.sin(a);
            const cor = corDaConversa(c.id);
            const mx = x / 2 + 60 * Math.cos(a + 1.4), my = y / 2 + 60 * Math.sin(a + 1.4);
            fios.push({ chave: c.id, conversa: c.id, d: `M${x},${y} Q${mx},${my} 0,0`, cor, curva: true, vivo: c.vivo });
            nos.push({ tipo: 'conversa', c, x, y, cor, a });
            const m = c.tarefas.length, raio = 92 + Math.max(0, m - 10) * 6, span = rad(m > 1 ? 250 : 0);
            c.tarefas.forEach((t, j) => {
                const b = a - span / 2 + (m > 1 ? span * j / (m - 1) : 0), r = raio + (j % 2) * 22;
                const tx = x + r * Math.cos(b), ty = y + r * Math.sin(b);
                fios.push({ chave: `${c.id}:t${j}`, conversa: c.id, d: `M${x},${y} L${tx},${ty}`, cor, fraco: true });
                nos.push({ tipo: 'tarefa', c, t, j, x: tx, y: ty, cor, b });
                t.subagentes.forEach((s, k) => montaSub(c, s, tx, ty, b + rad((k - (t.subagentes.length - 1) / 2) * 38), fios, nos));
            });
            c.subagentesSoltos.forEach((s, k) => montaSub(c, s, x, y, a + rad(180 + (k - (c.subagentesSoltos.length - 1) / 2) * 24), fios, nos, 120));
        });
        return { visiveis, fios, nos, rx, ry };
    }
    function montaSub(c, s, px, py, ang, fios, nos, dist = 62) {
        const sx = px + dist * Math.cos(ang), sy = py + dist * Math.sin(ang);
        fios.push({ chave: s.id, conversa: c.id, agente: s, d: `M${px},${py} L${sx},${sy}`, cor: varCss('--agente') || '#a3bba9', tracejado: true, sx, sy });
        nos.push({ tipo: 'agente', c, s, x: sx, y: sy, ang });
    }

    function desenha() {
        const { visiveis, fios, nos, rx, ry } = monta();
        layoutBase = { rx, ry };
        if (!viewBox) ajusta();
        gFios.textContent = ''; gNos.textContent = '';
        const corAgente = varCss('--agente') || '#a3bba9', corErro = varCss('--erro') || '#ff8f80', tinta = varCss('--tinta');
        for (const f of fios) {
            const p = el('path', { d: f.d, fill: 'none', stroke: f.fraco ? tinta : f.cor, 'stroke-width': f.curva ? 1.1 : 1, opacity: f.fraco ? .1 : f.tracejado ? .55 : .3, 'stroke-dasharray': f.tracejado ? '2 3' : (f.curva && !f.vivo ? '3 5' : null), class: 'tk-fio', 'data-conversa': f.conversa }, gFios);
            f.el = p;
        }
        fiosAtuais = new Map(fios.map(f => [f.chave, f]));
        for (const no of nos) {
            const g = el('g', { class: 'tk-no', 'data-conversa': no.c.id }, gNos);
            if (no.tipo === 'conversa') {
                const p = progressoConversa(no.c);
                anel(g, no.x, no.y, 21, p, no.cor, { sw: 3, aura: no.c.vivo });
                if (selecionada === no.c.id) el('circle', { cx: no.x, cy: no.y, r: 28, fill: 'none', stroke: varCss('--voce'), 'stroke-width': 1.5 }, g);
                texto(g, no.x, no.y + 4, Math.round(p * 100) + '%', { 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700 });
                texto(g, no.x, no.y + 41, cortaTexto(no.c.titulo, 34), { 'text-anchor': 'middle', 'font-size': 13.5, 'font-weight': 600 });
                const feitas = no.c.tarefas.filter(t => t.status === 'completed').length;
                texto(g, no.x, no.y + 56, `${no.c.esperando ? 'esperando você' : no.c.vivo ? 'trabalhando' : 'parada'} · ${feitas}/${no.c.tarefas.length}`, { 'text-anchor': 'middle', 'font-size': 11, style: `fill:${no.c.vivo ? no.cor : varCss('--grafite')}` });
                g.dataset.busca = (no.c.titulo + ' ' + no.c.nomeProjeto).toLowerCase();
                g.dataset.abre = no.c.id;
            } else if (no.tipo === 'tarefa') {
                const t = no.t, p = progressoTarefa(t), ativa = t.status === 'in_progress';
                anel(g, no.x, no.y, ativa ? 9 : 7, p, no.cor, { sw: ativa ? 2.4 : 1.8, aura: ativa, gira: ativa && !t.subagentes.length });
                const dx = Math.cos(no.b), dy = Math.sin(no.b), off = (ativa ? 9 : 7) + 9;
                const anc = dx > .35 ? 'start' : dx < -.35 ? 'end' : 'middle';
                const mostra = ativa || t.status !== 'completed' || selecionada === no.c.id || foco === no.c.id;
                if (mostra) texto(g, no.x + dx * off, no.y + dy * off + 4 + (anc === 'middle' ? dy * 6 : 0), cortaTexto(t.texto, 38) + (p > 0 && p < 1 ? `  ${Math.round(p * 100)}%` : ''), { 'text-anchor': anc, 'font-size': 11.5, 'font-weight': ativa ? 600 : 400, opacity: t.status === 'completed' ? .55 : 1 });
                g.dataset.busca = t.texto.toLowerCase();
                g.dataset.abre = no.c.id;
            } else {
                const s = no.s, rodando = s.status === 'rodando';
                const cor = s.status === 'erro' || s.status === 'interrompido' ? corErro : corAgente;
                const losango = el('rect', { x: no.x - 5.5, y: no.y - 5.5, width: 11, height: 11, rx: 2.5, transform: `rotate(45 ${no.x} ${no.y})`, fill: varCss('--folha'), stroke: cor, 'stroke-width': rodando ? 1.8 : 1.3 }, g);
                if (s.status === 'concluido') losango.setAttribute('fill', cor);
                const ca = Math.cos(no.ang), sa = Math.sin(no.ang);
                texto(g, no.x + ca * 12, no.y + sa * 12 + (sa > 0 ? 12 : -4), cortaTexto(s.tipo, 22), { 'text-anchor': ca > .3 ? 'start' : ca < -.3 ? 'end' : 'middle', 'font-size': 10.5, style: `fill:${cor}` });
                s.tarefas.forEach((f, k) => {
                    const c = no.ang + rad((k - (s.tarefas.length - 1) / 2) * 34), fx = no.x + 32 * Math.cos(c), fy = no.y + 32 * Math.sin(c);
                    el('line', { x1: no.x, y1: no.y, x2: fx, y2: fy, stroke: cor, opacity: .3 }, g);
                    anel(g, fx, fy, 4.5, progressoTarefa(f), cor, { sw: 1.5 });
                });
                g.dataset.busca = (s.tipo + ' ' + s.descricao).toLowerCase();
                g.dataset.abre = no.c.id;
                fiosAtuais.get(s.id).losango = losango;
            }
        }
        atualizaCentro(visiveis);
        atualizaContadores();
        aplicaFoco();
        aplicaBusca();
        posicionaBuracoNegro();
        $('tkVazio').hidden = visiveis.length > 0;
        if (selecionada) desenhaGaveta();
    }
    let fiosAtuais = new Map();
    const cortaTexto = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    function atualizaCentro(visiveis) {
        const todas = visiveis.flatMap(c => c.tarefas);
        const pct = todas.length ? todas.reduce((s, t) => s + progressoTarefa(t), 0) / todas.length : 0;
        $('tkPct').textContent = Math.round(pct * 100) + '%';
        $('tkResumo').textContent = `${todas.length} tarefas · ${visiveis.length} conversas`;
    }
    function atualizaContadores() {
        const base = dados.conversas.filter(c => mostraAbsorvidas || !absorvida(c));
        const conta = { todas: base.length, ativas: base.filter(c => c.vivo).length, esperando: base.filter(c => c.esperando).length, agentes: base.filter(c => todosSubs(c).length).length };
        for (const b of $('tkFiltros').querySelectorAll('button')) { b.querySelector('small').textContent = conta[b.dataset.f]; b.classList.toggle('sel', b.dataset.f === filtro); }
        $('tkSinais').classList.toggle('sel', sinaisLigados());
        $('tkAbsorvidas').classList.toggle('sel', mostraAbsorvidas);
    }

    // ZOOM E PAN PELO VIEWBOX
    function ajusta() {
        const { rx, ry } = layoutBase || { rx: 400, ry: 300 };
        const w = (rx + 260) * 2, h = (ry + 230) * 2;
        const caixa = svg.getBoundingClientRect(), proporcao = (caixa.width || 1600) / (caixa.height || 1000);
        const largura = Math.max(w, h * proporcao), altura = largura / proporcao;
        viewBox = { x: -largura / 2, y: -altura / 2, w: largura, h: altura };
        aplicaViewBox();
    }
    function aplicaViewBox() {
        svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
        posicionaBuracoNegro();
    }
    function posicionaBuracoNegro() {
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const caixa = janela.getBoundingClientRect();
        const ponto = new DOMPoint(0, 0).matrixTransform(ctm);
        $('tkBh').style.transform = `translate(${ponto.x - caixa.left}px, ${ponto.y - caixa.top}px) scale(${Math.min(ctm.a * 1.1, 1.6)})`;
    }
    svg.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const fator = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(svg.getScreenCTM().inverse());
        viewBox = { x: p.x - (p.x - viewBox.x) * fator, y: p.y - (p.y - viewBox.y) * fator, w: viewBox.w * fator, h: viewBox.h * fator };
        aplicaViewBox();
    }, { passive: false });
    let arrasto = null;
    svg.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest('.tk-no')) return;
        arrasto = { x: ev.clientX, y: ev.clientY, vb: { ...viewBox }, escala: viewBox.w / svg.getBoundingClientRect().width };
        svg.setPointerCapture(ev.pointerId);
        svg.classList.add('arrastando');
    });
    svg.addEventListener('pointermove', (ev) => {
        if (arrasto) {
            viewBox = { ...arrasto.vb, x: arrasto.vb.x - (ev.clientX - arrasto.x) * arrasto.escala, y: arrasto.vb.y - (ev.clientY - arrasto.y) * arrasto.escala };
            aplicaViewBox();
            return;
        }
        const g = ev.target.closest('.tk-no');
        const novo = g ? g.dataset.conversa : null;
        if (novo !== foco) { foco = novo; aplicaFoco(); }
    });
    const soltaArrasto = () => { arrasto = null; svg.classList.remove('arrastando'); };
    svg.addEventListener('pointerup', soltaArrasto);
    svg.addEventListener('pointercancel', soltaArrasto);
    svg.addEventListener('pointerleave', () => { if (foco) { foco = null; aplicaFoco(); } });
    svg.addEventListener('click', (ev) => {
        if (!dados) return;
        const g = ev.target.closest('.tk-no');
        selecionada = g ? g.dataset.abre : null;
        desenha();
        $('tkGaveta').hidden = !selecionada;
    });

    function aplicaFoco() {
        janela.classList.toggle('focando', !!foco);
        for (const e of janela.querySelectorAll('#tasksSvg [data-conversa]')) e.classList.toggle('tk-esmaece', !!foco && e.dataset.conversa !== foco);
    }
    function aplicaBusca() {
        janela.classList.toggle('buscando', !!busca);
        for (const g of gNos.querySelectorAll('.tk-no')) g.classList.toggle('tk-nao-achado', !!busca && !(g.dataset.busca || '').includes(busca));
    }

    // GAVETA
    function desenhaGaveta() {
        const c = dados && dados.conversas.find(x => x.id === selecionada);
        const gaveta = $('tkGaveta');
        if (!c) { gaveta.hidden = true; return; }
        const p = progressoConversa(c), cor = corDaConversa(c.id);
        const linha = (t, filho, prefixo = '') => {
            const pt = progressoTarefa(t);
            const classe = t.status === 'completed' ? 'c' : t.status === 'in_progress' ? 'a' : '';
            return `<div class="tk-lin ${classe}${filho ? ' filho' : ''}">${miniAnel(pt, filho ? varCss('--agente') : cor)}${escapa(prefixo + t.texto)}<small>${Math.round(pt * 100)}%</small></div>`;
        };
        const subs = (lista) => lista.map(s => `<div class="tk-lin filho">◆ ${escapa(s.tipo)}: ${escapa(s.descricao)}<small>${escapa(s.status)}</small></div>` + s.tarefas.map(f => linha(f, true, '   ')).join('')).join('');
        gaveta.innerHTML = `<div class="cab"><svg width="54" height="54" id="tkAnelGaveta"></svg><div><h3>${escapa(c.titulo)}</h3><div class="sub">${escapa(c.nomeProjeto)} · ${escapa(c.modelo || '')} · ${c.esperando ? 'esperando você' : c.vivo ? 'trabalhando' : 'parada'}</div></div></div>
            <div class="acoes"><button class="pri" data-tk-abrir>Abrir conversa</button><button data-tk-fecha-gaveta>Fechar</button></div>
            <h4>TAREFAS · ${c.tarefas.filter(t => t.status === 'completed').length} DE ${c.tarefas.length}</h4>
            ${c.tarefas.map(t => linha(t) + subs(t.subagentes)).join('') || '<p class="sub">Sem lista de tarefas.</p>'}
            ${c.subagentesSoltos.length ? '<h4 style="margin-top:12px">SUBAGENTES DA CONVERSA</h4>' + subs(c.subagentesSoltos) : ''}`;
        const alvo = $('tkAnelGaveta');
        anel(alvo, 27, 27, 21, p, cor, { sw: 3.5, aura: true });
        texto(alvo, 27, 31, Math.round(p * 100) + '%', { 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, style: `fill:${varCss('--tinta')};font-family:var(--sans)` });
        gaveta.hidden = false;
    }
    const miniAnel = (p, cor) => {
        const c = 2 * Math.PI * 6;
        return `<svg width="16" height="16" style="flex:none"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity="${p === 0 ? .5 : .15}" stroke-width="1.6"/>${p > 0 ? `<circle cx="8" cy="8" r="6" fill="none" stroke="${cor}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="${c * Math.min(p, 1)} ${c}" transform="rotate(-90 8 8)"/>` : ''}${p >= 1 ? `<circle cx="8" cy="8" r="2.5" fill="${cor}"/>` : ''}</svg>`;
    };
    $('tkGaveta').addEventListener('click', (ev) => {
        if (ev.target.closest('[data-tk-fecha-gaveta]')) { selecionada = null; $('tkGaveta').hidden = true; desenha(); return; }
        if (ev.target.closest('[data-tk-abrir]')) {
            const c = dados.conversas.find(x => x.id === selecionada);
            if (c && typeof abreSessao === 'function') { fecha(); abreSessao(c.projeto + '/' + c.id); }
        }
    });

    // SINAIS: CADA PULSO E UM TRACO DO TRACEJADO CORRENDO PELA LINHA (SO STROKE-DASHOFFSET, SEM FILTER)
    function pulsa(f, dir) {
        if (!f || !f.el || document.visibilityState !== 'visible') return;
        const vindo = dir === 'in' || dir === 'spawn';
        const cor = dir === 'out' ? '#ffe2b8' : f.cor;
        if (gPulsos.querySelectorAll(`[data-chave="${CSS.escape(f.chave)}"]`).length >= MAX_PULSOS_LINHA * 2) return;
        if (semMovimento()) { f.el.animate([{ opacity: 1 }, { opacity: f.el.getAttribute('opacity') }], 300); return; }
        const len = f.len || (f.len = f.el.getTotalLength());
        // A CURVA DA CONVERSA VAI DO NO PARA O CENTRO: "IN" ANDA NO SENTIDO DO PATH
        const de = vindo ? PULSO : -len, ate = vindo ? -len : PULSO;
        const esmaecido = !!foco && f.conversa !== foco;
        [[8, .28], [2.6, 1]].forEach(([largura, op]) => {
            const p = el('path', { d: f.d, fill: 'none', stroke: cor, 'stroke-width': largura, 'stroke-linecap': 'round', 'stroke-dasharray': `${PULSO} ${len + PULSO}`, opacity: esmaecido ? op * .3 : op, 'data-chave': f.chave }, gPulsos);
            p.animate([{ strokeDashoffset: de }, { strokeDashoffset: ate }], { duration: DURACAO_PULSO * (f.agente ? .6 : 1), easing: 'cubic-bezier(.4,0,.6,1)' }).onfinish = () => p.remove();
        });
    }
    function piscaLosango(f) {
        if (!f || !f.losango || semMovimento() || document.visibilityState !== 'visible') return;
        const r = el('circle', { cx: f.sx, cy: f.sy, r: 6, fill: 'none', stroke: f.cor, 'stroke-width': 1.4 }, gPulsos);
        r.style.transformOrigin = `${f.sx}px ${f.sy}px`;
        r.animate([{ transform: 'scale(1)', opacity: .9 }, { transform: 'scale(2.4)', opacity: 0 }], 550).onfinish = () => r.remove();
    }
    // TOCA SO O QUE CHEGOU DEPOIS DO ULTIMO POLL, NA ORDEM E COM O ESPACAMENTO REAL (COMPRIMIDO EM ATE 2 S)
    function agendaPulsos(primeiraVez) {
        if (!sinaisLigados()) return;
        const agora = Date.parse(dados.agora) || Date.now();
        const fila = [];
        const novos = (chave, lista) => {
            const ultimo = tocados.get(chave) || (primeiraVez ? agora - 3000 : 0);
            const n = lista.filter(p => Date.parse(p.hora) > ultimo);
            if (lista.length) tocados.set(chave, Math.max(ultimo, ...lista.map(p => Date.parse(p.hora))));
            return n;
        };
        for (const c of dados.conversas) {
            novos(c.id, c.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsa(fiosAtuais.get(c.id), p.dir) }));
            for (const s of todosSubs(c)) {
                const marcos = [];
                if (s.inicio) marcos.push({ hora: s.inicio, dir: 'spawn' });
                if (s.fim) marcos.push({ hora: s.fim, dir: 'back' });
                novos(s.id + ':marcos', marcos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsa(fiosAtuais.get(s.id), p.dir) }));
                novos(s.id, s.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => piscaLosango(fiosAtuais.get(s.id)) }));
            }
        }
        if (!fila.length) return;
        fila.sort((a, b) => a.hora - b.hora);
        const inicio = fila[0].hora, total = fila[fila.length - 1].hora - inicio, escala = total > LOTE_MAX_MS ? LOTE_MAX_MS / total : 1;
        fila.forEach(item => setTimeout(item.acao, (item.hora - inicio) * escala));
    }

    // FEED "AGORA": DIFERENCA ENTRE DOIS POLLS
    function registraFeed() {
        const mapa = (lista) => new Map(lista.map(c => [c.id, c]));
        if (anterior) {
            const antes = mapa(anterior.conversas);
            for (const c of dados.conversas) {
                const v = antes.get(c.id);
                if (!v) continue;
                c.tarefas.forEach((t, j) => { if (t.status === 'completed' && v.tarefas[j] && v.tarefas[j].status !== 'completed') feed.unshift({ cor: varCss('--ok'), texto: `${cortaTexto(c.titulo, 22)} concluiu ${cortaTexto(t.texto, 30)}`, hora: Date.now() }); });
                const idsAntes = new Set(todosSubs(v).map(s => s.id));
                todosSubs(c).filter(s => !idsAntes.has(s.id)).forEach(s => feed.unshift({ cor: varCss('--agente'), texto: `${s.tipo} abriu em ${cortaTexto(c.titulo, 28)}`, hora: Date.now() }));
                if (absorvida(c) && !absorvida(v)) feed.unshift({ cor: '#a882ff', texto: `${cortaTexto(c.titulo, 30)} foi absorvida`, hora: Date.now() });
            }
        }
        feed.splice(5);
        anterior = dados;
        const quando = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'min'; };
        $('tkFeed').innerHTML = '<h4>AGORA</h4>' + (feed.length ? feed.map(f => `<div><i style="background:${f.cor}"></i>${escapa(f.texto)}<small>${quando(f.hora)}</small></div>`).join('') : '<p style="margin:0">Nada ainda.</p>');
    }

    // POLLING SO COM A VISAO ABERTA E A JANELA VISIVEL
    async function busca304() {
        if (janela.hidden || document.visibilityState !== 'visible') return;
        try {
            const r = await fetch('/api/tasks?desde=' + encodeURIComponent(hash), { cache: 'no-store' });
            if (r.status === 304 || !r.ok) return;
            const primeiraVez = !dados;
            dados = await r.json();
            hash = dados.hash;
            registraFeed();
            desenha();
            agendaPulsos(primeiraVez);
        } catch (e) { /* SERVIDOR REINICIANDO: TENTA NO PROXIMO CICLO */ }
    }
    function abre() {
        janela.hidden = false;
        viewBox = null;
        busca304();
        clearInterval(timer);
        timer = setInterval(busca304, INTERVALO_POLL);
    }
    function fecha() {
        janela.hidden = true;
        clearInterval(timer);
        timer = null;
        gPulsos.textContent = '';
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') gPulsos.textContent = ''; });
    window.addEventListener('resize', () => { if (!janela.hidden) posicionaBuracoNegro(); });

    $('tkFiltros').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        filtro = b.dataset.f;
        viewBox = null;
        desenha();
    });
    $('tkBusca').addEventListener('input', (ev) => { busca = ev.target.value.trim().toLowerCase(); aplicaBusca(); });
    $('tkBusca').addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !busca) return;
        const g = [...gNos.querySelectorAll('.tk-no')].find(x => (x.dataset.busca || '').includes(busca));
        if (!g) return;
        const b = g.getBBox();
        viewBox = { ...viewBox, x: b.x + b.width / 2 - viewBox.w / 2, y: b.y + b.height / 2 - viewBox.h / 2 };
        aplicaViewBox();
    });
    $('tkSinais').addEventListener('click', () => { localStorage.setItem('tasksSinais', sinaisLigados() ? '0' : '1'); if (!sinaisLigados()) gPulsos.textContent = ''; atualizaContadores(); });
    $('tkAbsorvidas').addEventListener('click', () => { mostraAbsorvidas = !mostraAbsorvidas; viewBox = null; desenha(); });
    $('tkAjusta').addEventListener('click', ajusta);
    $('tkFecha').addEventListener('click', fecha);
    document.addEventListener('keydown', (ev) => {
        if (janela.hidden) return;
        if (ev.key === 'Escape') {
            ev.stopImmediatePropagation();
            if (!$('tkGaveta').hidden) { selecionada = null; $('tkGaveta').hidden = true; desenha(); return; }
            fecha();
        } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
            ev.preventDefault(); ev.stopImmediatePropagation();
            $('tkBusca').focus();
        }
    }, true);

    window.abreTasks = abre;
    const botao = document.getElementById('btnTasks');
    if (botao) botao.addEventListener('click', abre);
})();
