// Visão Tasks: placa de circuito. O Claude é o chip no centro; cada conversa é um cartão (o mesmo "Plano" da conversa)
// ligado ao chip por uma trilha. Os pulsos são o fluxo real lido do transcript: "in" corre para o chip, "out" sai dele.
(() => {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const INTERVALO_POLL = 2000;
    const MINUTOS_ABSORVE = 10, HORAS_SELO = 24;
    const PULSO = 22, DURACAO_PULSO = 700, MAX_PULSOS_TRILHA = 3, LOTE_MAX_MS = 2000;
    const LARGURA_CARTAO = 300, CHIP = 164, CANAL = 140, FOLGA_Y = 18, MAX_POR_COLUNA = 4, LINHAS_CARTAO = 4, CHANFRO = 10;
    const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sinaisLigados = () => localStorage.getItem('tasksSinais') !== '0';

    // Identidade visual por família de modelo: matiz próprio misturado com a tinta do tema (funciona no claro e no escuro)
    const IDENTIDADE_MODELO = {
        fable: { nome: 'Fable', matiz: '#a78bfa', glifo: '<path d="M8 2.2l1.5 4.3L13.8 8l-4.3 1.5L8 13.8l-1.5-4.3L2.2 8l4.3-1.5z"/>' },
        opus: { nome: 'Opus', matiz: '#2fb8a6', glifo: '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none"/>' },
        sonnet: { nome: 'Sonnet', matiz: '#ec6fae', glifo: '<path d="M3 10.5c1.6-5 8.4-5 10 0"/><path d="M3 13h10"/>' },
        haiku: { nome: 'Haiku', matiz: '#9ccc3c', glifo: '<path d="M4 11l4-6.5 4 6.5"/><path d="M5.3 13.3h5.4"/>' },
        outro: { nome: 'Claude', matiz: '#9a9a9a', glifo: '<circle cx="8" cy="8" r="4.5"/>' },
    };
    const familiaModelo = (m) => (String(m || '').toLowerCase().match(/fable|opus|sonnet|haiku/) || ['outro'])[0];
    const nomeModelo = (m) => {
        const partes = String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').match(/^([a-z]+)-(\d+)(?:-(\d+))?/);
        return partes ? `${partes[1][0].toUpperCase() + partes[1].slice(1)} ${partes[2]}${partes[3] ? '.' + partes[3] : ''}` : IDENTIDADE_MODELO[familiaModelo(m)].nome;
    };
    const tomModelo = (m) => `var(--tom-${familiaModelo(m)})`;
    const glifoModelo = (m, t = 12) => `<svg width="${t}" height="${t}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IDENTIDADE_MODELO[familiaModelo(m)].glifo}</svg>`;
    const chipModelo = (m, extra = '') => `<span class="tk-chip-modelo${extra}" style="--tom:${tomModelo(m)}" title="${escapa(m || 'modelo não informado')}">${glifoModelo(m)}${escapa(nomeModelo(m))}</span>`;

    const css = `
#janelaTasks { position: fixed; inset: 0; z-index: 65; background: var(--papel); color: var(--tinta); overflow: hidden; font-family: var(--sans); display: flex; flex-direction: column; }
#janelaTasks, .marca, .trilho-lista { ${Object.entries(IDENTIDADE_MODELO).map(([f, i]) => `--tom-${f}: color-mix(in srgb, ${i.matiz} 62%, var(--tinta));`).join(' ')} }
#janelaTasks[hidden] { display: none; }
.tk-topo { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--linha); background: var(--papel); }
.tk-topo .tk-titulo { display: flex; align-items: center; gap: 8px; color: var(--voce); font: 600 18px/1.1 var(--estreita); margin-right: 6px; }
.tk-topo .tk-titulo svg { width: 20px; height: 20px; }
.tk-topo .filtros { flex-wrap: nowrap; }
.tk-topo .tk-modelos { display: flex; gap: 4px; margin-left: 6px; padding-left: 10px; border-left: 1px solid var(--linha); }
.tk-chip-modelo { display: inline-flex; align-items: center; gap: 4px; font: 500 11px var(--sans); line-height: 16px; padding: 0 7px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--tom) 55%, transparent); color: var(--tom); background: color-mix(in srgb, var(--tom) 7%, transparent); white-space: nowrap; }
.tk-chip-modelo.n { opacity: .9; }
.tk-chip-modelo.n .n { font: 11px var(--mono); opacity: .75; }
.tk-chip-modelo[aria-pressed="true"] { background: var(--tom); color: var(--papel); }
.tk-busca { margin-left: auto; width: 240px; height: 30px; padding: 0 11px; border: 1px solid var(--linha); border-radius: 8px; background: var(--folha); color: var(--tinta); font: 13px var(--sans); }
.tk-busca:focus-visible { outline: none; border-color: var(--voce); box-shadow: 0 0 0 2px color-mix(in srgb, var(--voce) 22%, transparent); }
.tk-topo .fechar-mapa { margin-left: 4px; }
.tk-palco { flex: 1; position: relative; overflow: hidden; cursor: grab; background-image: radial-gradient(var(--linha) 1px, transparent 1px); background-size: 28px 28px; background-position: 14px 14px; }
.tk-palco.arrastando { cursor: grabbing; }
.tk-mundo { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.tk-svg { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
.tk-trilha { fill: none; stroke: var(--trilha, var(--linha)); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; transition: opacity .2s, stroke .2s; }
.tk-trilha.acesa { stroke: var(--voce); }
.tk-pino { stroke: var(--linha); stroke-width: 1.5; stroke-linecap: round; }
.tk-pino-ativo { fill: var(--trilha, var(--linha)); }
.tk-pulso { fill: none; stroke-linecap: round; pointer-events: none; }
.tk-direcao { pointer-events: none; }
.tk-chip-centro { position: absolute; left: ${-CHIP / 2}px; top: ${-CHIP / 2}px; width: ${CHIP}px; height: ${CHIP}px; border: 1px solid var(--linha); border-radius: 12px; background: var(--folha); box-shadow: var(--sombra); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center; }
.tk-chip-centro svg { width: 34px; height: 34px; color: var(--voce); margin-bottom: 4px; }
.tk-chip-centro b { font: 600 14px var(--sans); }
.tk-chip-centro .tk-pct { font: 600 20px var(--sans); }
.tk-chip-centro small { font: 11px/1.3 var(--mono); color: var(--grafite); padding: 0 8px; }
.tk-cartao { position: absolute; width: ${LARGURA_CARTAO}px; border: 1px solid var(--linha); border-radius: 10px; background: var(--folha); box-shadow: var(--sombra); padding: 10px 14px 10px 16px; cursor: pointer; transition: opacity .2s, border-color .2s; }
.tk-cartao::before { content: ""; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 3px; border-radius: 0 2px 2px 0; background: var(--tom); }
.tk-cartao:hover, .tk-cartao.sel { border-color: var(--grafite); }
.tk-cartao.viva { border-color: color-mix(in srgb, var(--voce) 55%, var(--linha)); }
.tk-cartao.esperando { border-color: color-mix(in srgb, var(--atencao) 55%, var(--linha)); }
.tk-cartao.sel { outline: 2px solid var(--voce); outline-offset: 1px; }
.tk-cab { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.tk-cab b { font: 600 13.5px/1.3 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tk-cab .tk-pct { font: 600 12px var(--mono); color: var(--grafite); flex: none; }
.tk-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font: 11px var(--mono); color: var(--grafite); margin: 4px 0 7px; }
.tk-meta .tk-sit::before { content: "●"; margin-right: 4px; font-size: 9px; }
.tk-cartao.viva .tk-sit { color: var(--voce); }
.tk-cartao.esperando .tk-sit { color: var(--atencao); }
.tk-cartao .barra { margin-bottom: 7px; }
.tk-cartao .passos li, .tk-gaveta .passos li { grid-template-columns: 22px 1fr; align-items: center; padding: 2px 0; text-decoration: none; font-size: 12.5px; line-height: 1.3; }
.tk-cartao .passos li::before, .tk-gaveta .passos li::before { content: none; }
.tk-cartao .passos li span, .tk-gaveta .passos li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-cartao .passos li.completed span { color: var(--tinta); opacity: .7; }
.tk-cartao .passos li.pending span { color: var(--grafite); }
.tk-cartao .passos li.mais, .tk-gaveta .passos li.mais { font: 11px var(--mono); color: var(--grafite); }
.tk-cartao .passos li.mais::before { content: "+" attr(data-n); color: var(--grafite); font: 11px var(--mono); text-align: center; }
.tk-agentes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.tk-agente { display: inline-flex; align-items: center; gap: 4px; font: 500 11px var(--sans); line-height: 16px; padding: 0 7px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--agente) 55%, transparent); color: var(--agente); background: color-mix(in srgb, var(--agente) 7%, transparent); max-width: 100%; white-space: nowrap; }
.tk-agente i { font-style: normal; color: var(--tom); display: inline-flex; align-items: center; gap: 2px; }
.tk-agente.rodando { border-color: var(--agente); }
.tk-agente.rodando::after { content: "●"; font-size: 8px; animation: pisca-passo 1s ease-in-out infinite; }
.tk-agente.erro, .tk-agente.interrompido { color: var(--erro); border-color: color-mix(in srgb, var(--erro) 55%, transparent); }
.tk-agente.concluido { opacity: .75; }
.tk-agente.pisca { background: color-mix(in srgb, var(--agente) 35%, transparent); }
#janelaTasks.focando .tk-cartao.esmaece, #janelaTasks.focando .tk-trilha.esmaece, #janelaTasks.focando .tk-pulso.esmaece { opacity: .3; }
#janelaTasks.buscando .tk-cartao.nao-achado { opacity: .25; }
.tk-caixa { position: absolute; z-index: 3; background: var(--realce); border: 1px solid var(--linha); border-radius: 12px; box-shadow: var(--sombra); box-sizing: border-box; }
.tk-gaveta { right: 16px; top: 14px; width: 380px; max-height: calc(100% - 180px); overflow: auto; padding: 16px 20px; }
.tk-gaveta[hidden] { display: none; }
.tk-gaveta h2 { font: 600 17px/1.25 var(--estreita); margin: 0; }
.tk-gaveta .nota { margin: 4px 0 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tk-gaveta .acoes { display: flex; gap: 8px; margin-bottom: 12px; }
.tk-gaveta h4 { font: 600 11px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--grafite); margin: 12px 0 6px; }
.tk-gaveta .passos li.in_progress { background: color-mix(in srgb, var(--tinta) 5%, transparent); border-radius: 5px; }
.tk-gaveta .passos li span { white-space: normal; }
.tk-sub { display: flex; align-items: center; gap: 8px; padding: 3px 0 3px 22px; font-size: 12.5px; color: var(--grafite); }
.tk-sub span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-sub .tk-agente { flex: none; }
.tk-sub small { margin-left: auto; font: 11px var(--mono); flex: none; }
.tk-sub.erro small, .tk-sub.interrompido small { color: var(--erro); }
.tk-sub + .passos { margin-left: 22px; }
.tk-feed { right: 16px; bottom: 14px; width: 320px; padding: 10px 14px; font-size: 12.5px; }
.tk-feed h4 { font: 600 11px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--grafite); margin: 0 0 6px; }
.tk-feed p { margin: 0; color: var(--grafite); }
.tk-feed div { display: flex; gap: 8px; align-items: center; margin: 3px 0; min-width: 0; }
.tk-feed div span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-feed div i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.tk-feed div small { margin-left: auto; font: 11px var(--mono); color: var(--grafite); flex: none; }
.tk-legenda { position: absolute; z-index: 3; left: 16px; bottom: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font: 11.5px var(--sans); color: var(--grafite); background: color-mix(in srgb, var(--papel) 85%, transparent); padding: 6px 10px; border-radius: 8px; }
.tk-legenda span { display: inline-flex; align-items: center; gap: 6px; }
.tk-legenda .passos { display: contents; }
.tk-legenda .passos li { display: inline-flex; gap: 6px; padding: 0; align-items: center; font-weight: 400; color: var(--grafite); }
.tk-legenda .passos li::before { content: none; }
.tk-legenda .marcador { width: 13px; height: 13px; }
.tk-legenda .sep { width: 1px; height: 14px; background: var(--linha); }
.tk-vazio { position: absolute; z-index: 3; left: 50%; top: 50%; transform: translate(-50%, -50%); color: var(--grafite); font-size: 13.5px; text-align: center; }
#btnModoTasks { position: relative; }
#btnModoTasks .ponto-tasks { position: absolute; top: 3px; left: 5px; }
.tk-topo .mini .n { font: 11px var(--mono); opacity: .75; margin-left: 4px; }
.selo-tasks { font: 600 10.5px/15px var(--mono); min-width: 15px; padding: 0 5px; border-radius: 8px; background: color-mix(in srgb, var(--tinta) 10%, transparent); color: var(--tinta); text-align: center; }
.trilho-lista .selo-tasks { position: absolute; top: 1px; right: 1px; background: var(--voce); color: #fff; font-size: 9.5px; line-height: 14px; min-width: 14px; padding: 0 4px; }
.trilho-lista [data-trilho="btnModoTasks"] { position: relative; }
.ponto-tasks { width: 6px; height: 6px; border-radius: 50%; background: var(--voce); animation: pisca-passo 1s ease-in-out infinite; }
.trilho-lista .ponto-tasks { position: absolute; left: 5px; top: 5px; }
@media (prefers-reduced-motion: reduce) { .ponto-tasks, .tk-agente.rodando::after { animation: none; } }
`;

    const marcaSvg = (t) => `<svg width="${t}" height="${t}" viewBox="-1.15 -1.15 2.3 2.3" aria-hidden="true"><g stroke="currentColor" stroke-width="0.22" stroke-linecap="round"><line x1="0" y1="0" x2="0.990" y2="0.139"/><line x1="0" y1="0" x2="0.595" y2="0.535"/><line x1="0" y1="0" x2="0.227" y2="0.912"/><line x1="0" y1="0" x2="-0.103" y2="0.733"/><line x1="0" y1="0" x2="-0.602" y2="0.669"/><line x1="0" y1="0" x2="-0.796" y2="0.198"/><line x1="0" y1="0" x2="-0.990" y2="-0.139"/><line x1="0" y1="0" x2="-0.572" y2="-0.515"/><line x1="0" y1="0" x2="-0.223" y2="-0.893"/><line x1="0" y1="0" x2="0.100" y2="-0.713"/><line x1="0" y1="0" x2="0.589" y2="-0.654"/><line x1="0" y1="0" x2="0.815" y2="-0.203"/></g><circle r="0.15" fill="currentColor"/></svg>`;
    const html = `
<div class="tk-topo">
  <span class="tk-titulo">${marcaSvg(20)}Tasks</span>
  <div class="filtros" id="tkFiltros" role="group" aria-label="Quais conversas mostrar">
    <button class="filtro" data-f="todas" aria-pressed="true">Todas<span class="n">0</span></button>
    <button class="filtro" data-f="ativas" aria-pressed="false">Ativas<span class="n">0</span></button>
    <button class="filtro" data-f="esperando" aria-pressed="false">Esperando você<span class="n">0</span></button>
    <button class="filtro" data-f="agentes" aria-pressed="false">Com agentes<span class="n">0</span></button>
  </div>
  <div class="tk-modelos" id="tkModelos" role="group" aria-label="Filtrar por modelo"></div>
  <input class="tk-busca" id="tkBusca" placeholder="Procurar tarefa ou conversa (Ctrl+K)" aria-label="Procurar">
  <button class="mini" id="tkSinais" aria-pressed="true" title="Mostrar ou esconder os sinais correndo nas trilhas">Sinais</button>
  <button class="mini" id="tkAbsorvidas" aria-pressed="false" title="Mostrar as conversas concluídas e paradas há mais de ${MINUTOS_ABSORVE} min">Absorvidas<span class="n" id="tkNAbsorvidas"></span></button>
  <button class="mini" id="tkAjusta" title="Ajustar à tela">Ajustar</button>
  <button class="fechar-mapa" id="tkFecha" title="Fechar (Esc)" aria-label="Fechar">×</button>
</div>
<div class="tk-palco" id="tkPalco">
  <div class="tk-mundo" id="tkMundo">
    <svg class="tk-svg" xmlns="${NS}"><g id="tkPinos"></g><g id="tkTrilhas"></g><g id="tkPulsos"></g></svg>
    <div class="tk-chip-centro" id="tkChip">${marcaSvg(34)}<b>Claude</b><span class="tk-pct" id="tkPct">0%</span><small id="tkResumo"></small></div>
    <div id="tkCartoes"></div>
  </div>
  <div class="tk-caixa tk-gaveta" id="tkGaveta" hidden></div>
  <div class="tk-caixa tk-feed" id="tkFeed"><h4>Agora</h4><p>Nada ainda.</p></div>
  <div class="tk-legenda" id="tkLegenda"></div>
  <div class="tk-vazio" id="tkVazio" hidden>Nenhuma conversa com lista de tarefas nas últimas 24 h.</div>
</div>`;

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
    const palco = $('tkPalco'), mundo = $('tkMundo'), gPinos = $('tkPinos'), gTrilhas = $('tkTrilhas'), gPulsos = $('tkPulsos'), caixaCartoes = $('tkCartoes');
    function escapa(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    const el = (tag, atributos, pai) => {
        const e = document.createElementNS(NS, tag);
        for (const k in atributos) if (atributos[k] !== undefined && atributos[k] !== null) e.setAttribute(k, atributos[k]);
        if (pai) pai.appendChild(e);
        return e;
    };
    const varCss = (nome) => getComputedStyle(janela).getPropertyValue(nome).trim();
    const cortaTexto = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    let dados = null, hash = '', timer = null, filtro = 'todas', filtroModelo = null, busca = '', foco = null, selecionada = null, mostraAbsorvidas = false;
    let vista = null;
    let trilhas = new Map();
    const tocados = new Map();
    const feed = [];
    let anterior = null;

    // PROGRESSO
    const progressoTarefa = (t) => {
        if (t.status === 'completed') return 1;
        const filhos = (t.subagentes || []).flatMap(s => s.tarefas);
        if (filhos.length) return filhos.reduce((s, f) => s + progressoTarefa(f), 0) / filhos.length;
        return t.status === 'pending' ? 0 : 0.5;
    };
    const todosSubs = (c) => [...c.tarefas.flatMap(t => t.subagentes), ...c.subagentesSoltos];
    const progressoConversa = (c) => c.tarefas.length ? c.tarefas.reduce((s, t) => s + progressoTarefa(t), 0) / c.tarefas.length : (todosSubs(c).every(s => s.status !== 'rodando') ? 1 : 0.5);
    const absorvida = (c) => !c.vivo && progressoConversa(c) >= 1 && Date.now() - c.ultimo > MINUTOS_ABSORVE * 60000;
    const passaFiltro = (c) => (filtro === 'todas' || (filtro === 'ativas' && c.vivo) || (filtro === 'esperando' && c.esperando) || (filtro === 'agentes' && todosSubs(c).length > 0))
        && (!filtroModelo || familiaModelo(c.modelo) === filtroModelo || todosSubs(c).some(s => familiaModelo(s.modelo) === filtroModelo));
    const situacao = (c) => c.esperando ? 'esperando você' : c.vivo ? 'trabalhando' : 'parada';
    const classeSituacao = (c) => c.esperando ? 'esperando' : c.vivo ? 'viva' : 'parada';

    // CARTAO DA CONVERSA: MESMO DNA DO CARTAO "PLANO" (BARRA + PASSOS + MARCADORES)
    function janelaTarefas(tarefas) {
        const n = tarefas.length, atual = Math.max(0, tarefas.findIndex(t => t.status === 'in_progress'));
        let inicio = Math.max(0, Math.min(atual - 1, n - LINHAS_CARTAO)), fim = Math.min(n, inicio + LINHAS_CARTAO);
        if (inicio > 0) { inicio += 1; }
        if (fim < n) { fim -= 1; }
        if (inicio > 0 && fim <= inicio) fim = inicio + 1;
        return { inicio, fim: Math.min(n, fim) };
    }
    const itemPasso = (t) => `<li class="${escapa(t.status)}"><i class="marcador"></i><span>${escapa(t.texto)}</span></li>`;
    const chipAgente = (s) => `<span class="tk-agente ${escapa(s.status)}" style="--tom:${tomModelo(s.modelo)}" title="${escapa(s.descricao || s.tipo)} · ${escapa(s.status)}${s.modelo ? ' · ' + escapa(nomeModelo(s.modelo)) : ''}">◆ ${escapa(cortaTexto(s.tipo, 24))}${s.modelo ? `<i>${glifoModelo(s.modelo, 11)}${escapa(IDENTIDADE_MODELO[familiaModelo(s.modelo)].nome)}</i>` : ''}</span>`;
    function htmlCartao(c) {
        const feitas = c.tarefas.filter(t => t.status === 'completed').length, p = progressoConversa(c);
        const { inicio, fim } = janelaTarefas(c.tarefas);
        const passos = c.tarefas.length ? `<ol class="passos">${inicio > 0 ? `<li class="mais" data-n="${inicio}">${inicio === 1 ? 'anterior' : 'anteriores'}</li>` : ''}${c.tarefas.slice(inicio, fim).map(itemPasso).join('')}${fim < c.tarefas.length ? `<li class="mais" data-n="${c.tarefas.length - fim}">${c.tarefas.length - fim === 1 ? 'restante' : 'restantes'}</li>` : ''}</ol>` : '<p class="tk-meta" style="margin:0">Sem lista de tarefas</p>';
        const subs = todosSubs(c);
        return `<div class="tk-cab"><b title="${escapa(c.titulo)}">${escapa(c.titulo)}</b><span class="tk-pct">${Math.round(p * 100)}%</span></div>
            <div class="tk-meta">${chipModelo(c.modelo)}<span class="tk-sit">${situacao(c)}</span><span>· ${feitas} de ${c.tarefas.length}</span></div>
            <div class="barra"><div style="width:${Math.round(p * 100)}%"></div></div>${passos}
            ${subs.length ? `<div class="tk-agentes">${subs.map(chipAgente).join('')}</div>` : ''}`;
    }

    // LAYOUT DETERMINISTICO: COLUNAS A DIREITA E A ESQUERDA DO CHIP, SEM SOBREPOSICAO
    function posiciona(cartoes) {
        const xColuna = (i) => CHIP / 2 + CANAL + i * (LARGURA_CARTAO + CANAL);
        for (const lado of [1, -1]) {
            const lista = cartoes.filter((k, i) => (i % 2 === 0) === (lado === 1));
            const nColunas = Math.ceil(lista.length / MAX_POR_COLUNA), tam = Math.ceil(lista.length / Math.max(nColunas, 1));
            const alturas = [];
            for (let j = 0; j < nColunas; j++) {
                const itens = lista.slice(j * tam, (j + 1) * tam);
                const total = itens.reduce((s, k) => s + k.h, 0) + FOLGA_Y * (itens.length - 1);
                let y = -total / 2;
                for (const k of itens) {
                    Object.assign(k, { lado, coluna: j, y, cy: y + k.h / 2, x: lado > 0 ? xColuna(j) : -xColuna(j) - LARGURA_CARTAO });
                    k.bordaX = lado > 0 ? k.x : k.x + LARGURA_CARTAO;
                    y += k.h + FOLGA_Y;
                }
                alturas.push(total);
            }
            const doLado = lista.slice().sort((a, b) => a.cy - b.cy), n = doLado.length;
            const passo = Math.min(20, (CHIP - 44) / Math.max(n - 1, 1));
            doLado.forEach((k, i) => { k.pinoY = (i - (n - 1) / 2) * passo; k.pinoX = lado * CHIP / 2; });
            // CARTAO MAIS PERTO DO CENTRO SOBE MAIS LONGE NO CANAL: AS TRILHAS FICAM ANINHADAS SEM SE CRUZAR
            const internas = lista.filter(k => k.coluna === 0).sort((a, b) => Math.abs(b.cy) - Math.abs(a.cy));
            const passoX = Math.min(14, (CANAL - 70) / Math.max(internas.length - 1, 1));
            internas.forEach((k, i) => { k.pontos = [[k.pinoX, k.pinoY], [lado * (CHIP / 2 + 44 + i * passoX), k.pinoY], [lado * (CHIP / 2 + 44 + i * passoX), k.cy], [k.bordaX, k.cy]]; });
            const externas = lista.filter(k => k.coluna > 0).sort((a, b) => Math.abs(a.cy) - Math.abs(b.cy));
            externas.forEach((k, i) => {
                const sinal = k.cy < 0 ? -1 : 1, xv = lado * (CHIP / 2 + 12 + i * 8);
                const yl = sinal * (Math.max(...alturas.slice(0, k.coluna)) / 2 + 26 + i * 10), xh = lado * (xColuna(k.coluna) - CANAL + 30 + i * 10);
                k.pontos = [[k.pinoX, k.pinoY], [xv, k.pinoY], [xv, yl], [xh, yl], [xh, k.cy], [k.bordaX, k.cy]];
            });
        }
    }
    // TRILHA DE PLACA: SEGMENTOS ORTOGONAIS COM OS CANTOS CHANFRADOS A 45 GRAUS
    function caminhoChanfrado(pontos) {
        const pts = pontos.filter((p, i) => !i || p[0] !== pontos[i - 1][0] || p[1] !== pontos[i - 1][1]);
        if (pts.length < 2) return '';
        let d = `M${pts[0][0]},${pts[0][1]}`;
        for (let i = 1; i < pts.length - 1; i++) {
            const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
            const lenAB = Math.hypot(b[0] - a[0], b[1] - a[1]), lenBC = Math.hypot(c[0] - b[0], c[1] - b[1]);
            const r = Math.min(CHANFRO, lenAB / 2, lenBC / 2);
            d += ` L${b[0] + (a[0] - b[0]) / lenAB * r},${b[1] + (a[1] - b[1]) / lenAB * r} L${b[0] + (c[0] - b[0]) / lenBC * r},${b[1] + (c[1] - b[1]) / lenBC * r}`;
        }
        const fim = pts[pts.length - 1];
        return d + ` L${fim[0]},${fim[1]}`;
    }

    function desenha() {
        const visiveis = dados.conversas.filter(c => passaFiltro(c) && (mostraAbsorvidas || !absorvida(c))).sort((a, b) => a.id.localeCompare(b.id));
        caixaCartoes.textContent = '';
        const cartoes = visiveis.map(c => {
            const e = document.createElement('article');
            e.className = `tk-cartao ${classeSituacao(c)}${selecionada === c.id ? ' sel' : ''}`;
            e.dataset.conversa = c.id;
            e.style.setProperty('--tom', tomModelo(c.modelo));
            e.dataset.busca = [c.titulo, c.nomeProjeto, nomeModelo(c.modelo), ...c.tarefas.map(t => t.texto), ...todosSubs(c).flatMap(s => [s.tipo, s.descricao, ...s.tarefas.map(t => t.texto)])].join(' ').toLowerCase();
            e.innerHTML = htmlCartao(c);
            caixaCartoes.appendChild(e);
            return { c, el: e, h: e.offsetHeight };
        });
        posiciona(cartoes);
        gPinos.textContent = ''; gTrilhas.textContent = '';
        desenhaPinos();
        trilhas = new Map();
        for (const k of cartoes) {
            k.el.style.left = k.x + 'px';
            k.el.style.top = k.y + 'px';
            const tom = tomModelo(k.c.modelo);
            const p = el('path', { d: caminhoChanfrado(k.pontos), class: 'tk-trilha', 'data-conversa': k.c.id, style: `--trilha: color-mix(in srgb, ${tom} 45%, var(--linha))`, 'stroke-dasharray': k.c.vivo || k.c.esperando ? null : '4 5' }, gTrilhas);
            el('circle', { cx: k.pinoX, cy: k.pinoY, r: 2.6, class: 'tk-pino-ativo', style: `--trilha: color-mix(in srgb, ${tom} 70%, var(--linha))` }, gTrilhas);
            trilhas.set(k.c.id, { el: p, d: p.getAttribute('d'), conversa: k.c.id });
        }
        atualizaCentro(visiveis);
        atualizaContadores();
        desenhaLegenda(visiveis);
        aplicaFoco();
        aplicaBusca();
        $('tkVazio').hidden = visiveis.length > 0;
        if (!vista) ajusta();
        if (selecionada) desenhaGaveta();
    }
    function desenhaPinos() {
        const meio = CHIP / 2, n = 7, passo = (CHIP - 44) / (n - 1), comp = 9;
        for (let i = 0; i < n; i++) {
            const t = (i - (n - 1) / 2) * passo;
            el('line', { x1: -meio, y1: t, x2: -meio - comp, y2: t, class: 'tk-pino' }, gPinos);
            el('line', { x1: meio, y1: t, x2: meio + comp, y2: t, class: 'tk-pino' }, gPinos);
            el('line', { x1: t, y1: -meio, x2: t, y2: -meio - comp, class: 'tk-pino' }, gPinos);
            el('line', { x1: t, y1: meio, x2: t, y2: meio + comp, class: 'tk-pino' }, gPinos);
        }
    }
    function atualizaCentro(visiveis) {
        const todas = visiveis.flatMap(c => c.tarefas);
        const pct = todas.length ? todas.reduce((s, t) => s + progressoTarefa(t), 0) / todas.length : 0;
        $('tkPct').textContent = Math.round(pct * 100) + '%';
        $('tkResumo').textContent = `${todas.length} tarefas · ${visiveis.length} conversas`;
    }
    function atualizaContadores() {
        const base = dados.conversas.filter(c => mostraAbsorvidas || !absorvida(c));
        const conta = { todas: base.length, ativas: base.filter(c => c.vivo).length, esperando: base.filter(c => c.esperando).length, agentes: base.filter(c => todosSubs(c).length).length };
        for (const b of $('tkFiltros').querySelectorAll('button')) { b.querySelector('.n').textContent = conta[b.dataset.f]; b.setAttribute('aria-pressed', String(b.dataset.f === filtro)); }
        const familias = new Map();
        for (const c of base) for (const f of new Set([familiaModelo(c.modelo), ...todosSubs(c).map(s => familiaModelo(s.modelo))])) familias.set(f, (familias.get(f) || 0) + 1);
        if (filtroModelo && !familias.has(filtroModelo)) filtroModelo = null;
        $('tkModelos').innerHTML = [...familias].sort().map(([f, n]) => `<button class="tk-chip-modelo n" data-modelo="${f}" aria-pressed="${filtroModelo === f}" style="--tom:var(--tom-${f})" title="Só conversas e agentes com ${IDENTIDADE_MODELO[f].nome}">${glifoModelo(f)}${IDENTIDADE_MODELO[f].nome}<span class="n">${n}</span></button>`).join('');
        $('tkSinais').setAttribute('aria-pressed', String(sinaisLigados()));
        $('tkAbsorvidas').setAttribute('aria-pressed', String(mostraAbsorvidas));
        const absorvidas = dados.conversas.filter(absorvida).length;
        $('tkNAbsorvidas').textContent = absorvidas || '';
    }
    function desenhaLegenda(visiveis) {
        const familias = [...new Set(visiveis.flatMap(c => [familiaModelo(c.modelo), ...todosSubs(c).map(s => familiaModelo(s.modelo))]))].sort();
        const traco = (cor) => `<svg width="26" height="8" aria-hidden="true"><line x1="2" y1="4" x2="24" y2="4" stroke="var(--linha)" stroke-width="1.5"/><line x1="6" y1="4" x2="16" y2="4" stroke="${cor}" stroke-width="2.5" stroke-linecap="round"/></svg>`;
        $('tkLegenda').innerHTML = `<ol class="passos"><li class="completed"><i class="marcador"></i>feita</li><li class="in_progress"><i class="marcador"></i>em andamento</li><li class="pending"><i class="marcador"></i>a fazer</li></ol>
            <i class="sep"></i><span>${traco('var(--voce)')}entrada</span><span>${traco('var(--tinta)')}saída</span><span>${traco('var(--agente)')}agente</span>
            ${familias.length ? '<i class="sep"></i>' + familias.map(f => `<span style="--tom:var(--tom-${f});color:var(--tom)">${glifoModelo(f, 13)}${IDENTIDADE_MODELO[f].nome}</span>`).join('') : ''}`;
    }

    // ZOOM E ARRASTE: UMA TRANSFORMACAO SO PARA AS TRILHAS (SVG) E OS CARTOES (HTML)
    function aplicaVista() { mundo.style.transform = `translate(${vista.x}px, ${vista.y}px) scale(${vista.k})`; }
    function ajusta() {
        const cartoes = [...caixaCartoes.children];
        let minX = -CHIP / 2 - 12, maxX = CHIP / 2 + 12, minY = -CHIP / 2 - 12, maxY = CHIP / 2 + 12;
        for (const e of cartoes) {
            minX = Math.min(minX, e.offsetLeft); maxX = Math.max(maxX, e.offsetLeft + e.offsetWidth);
            minY = Math.min(minY, e.offsetTop); maxY = Math.max(maxY, e.offsetTop + e.offsetHeight);
        }
        const caixa = palco.getBoundingClientRect(), w = caixa.width || 1600, h = caixa.height || 900, margem = 40;
        const k = Math.min(1.15, (w - margem * 2) / (maxX - minX), (h - margem * 2 - 60) / (maxY - minY));
        vista = { k, x: w / 2 - (minX + maxX) / 2 * k, y: (h - 50) / 2 - (minY + maxY) / 2 * k };
        aplicaVista();
    }
    palco.addEventListener('wheel', (ev) => {
        if (ev.target.closest('.tk-caixa')) return;
        ev.preventDefault();
        const fator = ev.deltaY > 0 ? 1 / 1.12 : 1.12, caixa = palco.getBoundingClientRect();
        const px = ev.clientX - caixa.left, py = ev.clientY - caixa.top;
        vista = { k: vista.k * fator, x: px - (px - vista.x) * fator, y: py - (py - vista.y) * fator };
        aplicaVista();
    }, { passive: false });
    let arrasto = null;
    palco.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || ev.target.closest('.tk-cartao, .tk-caixa, .tk-legenda, .tk-chip-centro')) return;
        arrasto = { x: ev.clientX, y: ev.clientY, vx: vista.x, vy: vista.y, moveu: false };
        palco.setPointerCapture(ev.pointerId);
    });
    palco.addEventListener('pointermove', (ev) => {
        if (arrasto) {
            const dx = ev.clientX - arrasto.x, dy = ev.clientY - arrasto.y;
            if (Math.hypot(dx, dy) > 3) { arrasto.moveu = true; palco.classList.add('arrastando'); }
            vista = { ...vista, x: arrasto.vx + dx, y: arrasto.vy + dy };
            aplicaVista();
            return;
        }
        const cartao = ev.target.closest('.tk-cartao'), novo = cartao ? cartao.dataset.conversa : null;
        if (novo !== foco) { foco = novo; aplicaFoco(); }
    });
    const soltaArrasto = (ev) => {
        if (arrasto && !arrasto.moveu && ev.type === 'pointerup' && !ev.target.closest('.tk-cartao')) { selecionada = null; $('tkGaveta').hidden = true; desenha(); }
        arrasto = null; palco.classList.remove('arrastando');
    };
    palco.addEventListener('pointerup', soltaArrasto);
    palco.addEventListener('pointercancel', soltaArrasto);
    palco.addEventListener('pointerleave', () => { if (foco) { foco = null; aplicaFoco(); } });
    caixaCartoes.addEventListener('click', (ev) => {
        const cartao = ev.target.closest('.tk-cartao');
        if (!cartao || !dados) return;
        selecionada = selecionada === cartao.dataset.conversa ? null : cartao.dataset.conversa;
        desenha();
        $('tkGaveta').hidden = !selecionada;
    });

    function aplicaFoco() {
        janela.classList.toggle('focando', !!foco);
        for (const e of palco.querySelectorAll('[data-conversa]')) e.classList.toggle('esmaece', !!foco && e.dataset.conversa !== foco);
    }
    function aplicaBusca() {
        janela.classList.toggle('buscando', !!busca);
        for (const e of caixaCartoes.children) e.classList.toggle('nao-achado', !!busca && !(e.dataset.busca || '').includes(busca));
    }

    // GAVETA: A CONVERSA ESCOLHIDA POR INTEIRO (TAREFAS, SUBAGENTES E AS TAREFAS DELES)
    function desenhaGaveta() {
        const c = dados && dados.conversas.find(x => x.id === selecionada);
        const gaveta = $('tkGaveta');
        if (!c) { gaveta.hidden = true; return; }
        const p = progressoConversa(c), feitas = c.tarefas.filter(t => t.status === 'completed').length;
        const subs = (lista) => lista.map(s => `<div class="tk-sub ${escapa(s.status)}">${chipAgente(s)}<span title="${escapa(s.descricao)}">${escapa(s.descricao)}</span><small>${escapa(s.status)}</small></div>${s.tarefas.length ? `<ol class="passos">${s.tarefas.map(itemPasso).join('')}</ol>` : ''}`).join('');
        gaveta.innerHTML = `<div class="cabeca-mapa"><h2>${escapa(c.titulo)}</h2><button class="fechar-mapa" data-tk-fecha-gaveta aria-label="Fechar">×</button></div>
            <div class="nota">${chipModelo(c.modelo)}<span>${escapa(c.nomeProjeto)}</span><span>·</span><span class="tk-sit-gaveta" style="color:${c.esperando ? 'var(--atencao)' : c.vivo ? 'var(--voce)' : 'var(--grafite)'}">${situacao(c)}</span></div>
            <div class="acoes"><button class="botao principal" data-tk-abrir>Abrir conversa</button></div>
            <div class="cabeca-plano"><span>Tarefas</span><span>${feitas} de ${c.tarefas.length} · ${Math.round(p * 100)}%</span></div>
            <div class="barra"><div style="width:${Math.round(p * 100)}%"></div></div>
            ${c.tarefas.map(t => `<ol class="passos">${itemPasso(t)}</ol>${subs(t.subagentes)}`).join('') || '<p class="nota">Sem lista de tarefas.</p>'}
            ${c.subagentesSoltos.length ? '<h4>Subagentes da conversa</h4>' + subs(c.subagentesSoltos) : ''}`;
        gaveta.hidden = false;
    }
    $('tkGaveta').addEventListener('click', (ev) => {
        if (ev.target.closest('[data-tk-fecha-gaveta]')) { selecionada = null; $('tkGaveta').hidden = true; desenha(); return; }
        if (ev.target.closest('[data-tk-abrir]')) {
            const c = dados.conversas.find(x => x.id === selecionada);
            if (c && typeof abreSessao === 'function') { fecha(); abreSessao(c.projeto + '/' + c.id); }
        }
    });

    // SINAIS: UM TRACO CURTO CORRENDO PELA TRILHA (SO STROKE-DASHOFFSET, SEM FILTER)
    // A TRILHA VAI DO PINO AO CARTAO: "IN" E "BACK" CORREM CONTRA O PATH, "OUT" E "SPAWN" A FAVOR
    function pulsa(f, dir) {
        if (!f || !f.el || document.visibilityState !== 'visible') return;
        const paraChip = dir === 'in' || dir === 'back';
        const cor = dir === 'in' ? 'var(--voce)' : dir === 'out' ? 'var(--tinta)' : 'var(--agente)';
        if (semMovimento()) { f.el.classList.add('acesa'); setTimeout(() => f.el.classList.remove('acesa'), 300); etiquetaDirecao(f, dir, cor); return; }
        if (gPulsos.querySelectorAll(`.tk-cauda[data-chave="${CSS.escape(f.conversa)}"]`).length >= MAX_PULSOS_TRILHA) return;
        const len = f.len || (f.len = f.el.getTotalLength());
        const esmaece = foco && f.conversa !== foco ? ' esmaece' : '';
        const cauda = el('path', { d: f.d, class: 'tk-pulso tk-cauda' + esmaece, stroke: cor, 'stroke-width': 2, opacity: .35, 'stroke-dasharray': `${PULSO * 2.4} ${len * 2}`, 'data-chave': f.conversa, 'data-conversa': f.conversa }, gPulsos);
        const corpo = el('path', { d: f.d, class: 'tk-pulso' + esmaece, stroke: cor, 'stroke-width': 3.2, 'stroke-dasharray': `${PULSO} ${len * 2}`, 'data-conversa': f.conversa }, gPulsos);
        const seta = el('path', { d: 'M-4,-4.5 L3,0 L-4,4.5', class: 'tk-pulso tk-seta' + esmaece, stroke: cor, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'data-conversa': f.conversa }, gPulsos);
        etiquetaDirecao(f, dir, cor);
        const inicio = performance.now(), duracao = DURACAO_PULSO * (dir === 'spawn' || dir === 'back' ? .8 : 1.15);
        const suave = (x) => x < .5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
        const quadro = (agora) => {
            const k = Math.min(1, (agora - inicio) / duracao), s = suave(k);
            // A TRILHA VAI DO PINO AO CARTAO: "IN" E "BACK" CORREM CONTRA O PATH, "OUT" E "SPAWN" A FAVOR
            const ponta = paraChip ? len * (1 - s) : len * s;
            const atras = paraChip ? Math.min(len, ponta + 2) : Math.max(0, ponta - 2);
            corpo.style.strokeDashoffset = paraChip ? -ponta : PULSO - ponta;
            cauda.style.strokeDashoffset = paraChip ? -ponta : PULSO * 2.4 - ponta;
            const a = f.el.getPointAtLength(ponta), b = f.el.getPointAtLength(atras);
            const ang = Math.atan2(a.y - b.y, a.x - b.x) * 180 / Math.PI;
            seta.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ang})`);
            seta.style.opacity = k < .08 ? k / .08 : k > .92 ? (1 - k) / .08 : 1;
            if (k < 1) requestAnimationFrame(quadro); else { corpo.remove(); cauda.remove(); seta.remove(); }
        };
        requestAnimationFrame(quadro);
    }
    // ROTULO NA PONTA DO CARTAO: DIZ SE O ULTIMO SINAL FOI ENTRADA OU SAIDA, E SOME SOZINHO
    function etiquetaDirecao(f, dir, cor) {
        const len = f.len || (f.len = f.el.getTotalLength());
        const texto = { in: 'entrada', out: 'saída', spawn: 'agente abriu', back: 'agente voltou' }[dir];
        const largura = Math.max(46, texto.length * 6.4 + 12);
        const p = f.el.getPointAtLength(Math.max(0, len - largura / 2 - 10));
        const antigo = gPulsos.querySelector(`.tk-direcao[data-chave="${CSS.escape(f.chave || f.conversa)}"]`);
        if (antigo) antigo.remove();
        const g = el('g', { class: 'tk-direcao', 'data-chave': f.chave || f.conversa, 'data-conversa': f.conversa, transform: `translate(${p.x} ${p.y - 12})` }, gPulsos);
        const r = el('rect', { x: -30, y: -9, width: 60, height: 16, rx: 8, fill: 'var(--folha)', stroke: cor, 'stroke-width': 1 }, g);
        const tx = el('text', { x: 0, y: 3, 'text-anchor': 'middle', 'font-size': 9.5, fill: cor, style: 'font-family: var(--mono)' }, g);
        tx.textContent = texto;
        r.setAttribute('width', largura);
        r.setAttribute('x', -largura / 2);
        g.animate([{ opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .75 }, { opacity: 0 }], { duration: 2200 }).onfinish = () => g.remove();
    }
    function piscaAgente(c, s) {
        const cartao = caixaCartoes.querySelector(`[data-conversa="${CSS.escape(c.id)}"]`);
        const chip = cartao && [...cartao.querySelectorAll('.tk-agente')].find(e => e.title.startsWith(s.descricao || s.tipo));
        if (!chip) return;
        chip.classList.add('pisca');
        setTimeout(() => chip.classList.remove('pisca'), 350);
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
            novos(c.id, c.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsa(trilhas.get(c.id), p.dir) }));
            for (const s of todosSubs(c)) {
                const marcos = [];
                if (s.inicio) marcos.push({ hora: s.inicio, dir: 'spawn' });
                if (s.fim) marcos.push({ hora: s.fim, dir: 'back' });
                novos(s.id + ':marcos', marcos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsa(trilhas.get(c.id), p.dir) }));
                novos(s.id, s.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => piscaAgente(c, s) }));
            }
        }
        if (!fila.length) return;
        fila.sort((a, b) => a.hora - b.hora);
        const inicio = fila[0].hora, total = fila[fila.length - 1].hora - inicio, escala = total > LOTE_MAX_MS ? LOTE_MAX_MS / total : 1;
        fila.forEach(item => setTimeout(item.acao, (item.hora - inicio) * escala));
    }

    // FEED "AGORA": DIFERENCA ENTRE DOIS POLLS
    function registraFeed() {
        if (anterior) {
            const antes = new Map(anterior.conversas.map(c => [c.id, c]));
            for (const c of dados.conversas) {
                const v = antes.get(c.id);
                if (!v) continue;
                c.tarefas.forEach((t, j) => { if (t.status === 'completed' && v.tarefas[j] && v.tarefas[j].status !== 'completed') feed.unshift({ cor: 'var(--ok)', texto: `${cortaTexto(c.titulo, 22)} concluiu: ${t.texto}`, hora: Date.now() }); });
                const idsAntes = new Set(todosSubs(v).map(s => s.id));
                todosSubs(c).filter(s => !idsAntes.has(s.id)).forEach(s => feed.unshift({ cor: 'var(--agente)', texto: `${s.tipo} abriu em ${cortaTexto(c.titulo, 28)}`, hora: Date.now() }));
                if (c.esperando && !v.esperando) feed.unshift({ cor: 'var(--atencao)', texto: `${cortaTexto(c.titulo, 30)} espera você`, hora: Date.now() });
                if (absorvida(c) && !absorvida(v)) feed.unshift({ cor: 'var(--grafite)', texto: `${cortaTexto(c.titulo, 30)} foi absorvida`, hora: Date.now() });
            }
        }
        feed.splice(5);
        anterior = dados;
        const quando = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; };
        $('tkFeed').innerHTML = '<h4>Agora</h4>' + (feed.length ? feed.map(f => `<div><i style="background:${f.cor}"></i><span>${escapa(f.texto)}</span><small>${quando(f.hora)}</small></div>`).join('') : '<p>Nada ainda.</p>');
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
    const botoesTasks = () => [document.getElementById('btnModoTasks'), document.querySelector('.trilho-lista [data-trilho="btnModoTasks"]')].filter(Boolean);
    function abre() {
        janela.hidden = false;
        vista = null;
        botoesTasks().forEach(b => b.setAttribute('aria-pressed', 'true'));
        busca304();
        clearInterval(timer);
        timer = setInterval(busca304, INTERVALO_POLL);
    }
    function fecha() {
        janela.hidden = true;
        clearInterval(timer);
        timer = null;
        gPulsos.textContent = '';
        botoesTasks().forEach(b => b.setAttribute('aria-pressed', 'false'));
    }
    const alterna = () => janela.hidden ? abre() : fecha();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') gPulsos.textContent = ''; });

    $('tkFiltros').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        filtro = b.dataset.f;
        vista = null;
        desenha();
    });
    $('tkModelos').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        filtroModelo = filtroModelo === b.dataset.modelo ? null : b.dataset.modelo;
        vista = null;
        desenha();
    });
    $('tkBusca').addEventListener('input', (ev) => { busca = ev.target.value.trim().toLowerCase(); aplicaBusca(); });
    $('tkBusca').addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !busca) return;
        const e = [...caixaCartoes.children].find(x => (x.dataset.busca || '').includes(busca));
        if (!e) return;
        const caixa = palco.getBoundingClientRect();
        vista = { ...vista, x: caixa.width / 2 - (e.offsetLeft + e.offsetWidth / 2) * vista.k, y: caixa.height / 2 - (e.offsetTop + e.offsetHeight / 2) * vista.k };
        aplicaVista();
    });
    $('tkSinais').addEventListener('click', () => { localStorage.setItem('tasksSinais', sinaisLigados() ? '0' : '1'); if (!sinaisLigados()) gPulsos.textContent = ''; atualizaContadores(); });
    $('tkAbsorvidas').addEventListener('click', () => { mostraAbsorvidas = !mostraAbsorvidas; vista = null; desenha(); });
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

    // SELO DO BOTAO TASKS NA LISTA: VEM DO /api/sessoes (A CADA 5 S), SEM CHAMAR /api/tasks COM A VISAO FECHADA
    function atualizaSelo(sessoes) {
        const limite = Date.now() - HORAS_SELO * 3600 * 1000, recentes = (sessoes || []).filter(s => s.atualizado >= limite);
        const andamento = recentes.reduce((n, s) => n + (s.tarefasAndamento || 0), 0), trabalhando = recentes.some(s => s.ativa);
        for (const b of botoesTasks()) {
            const selo = b.querySelector('.selo-tasks'), ponto = b.querySelector('.ponto-tasks');
            if (selo) { selo.textContent = andamento; selo.hidden = !andamento; }
            if (ponto) ponto.hidden = !trabalhando;
            b.title = `Tasks: o chip e as tarefas de todas as conversas (Ctrl + Shift + T)${andamento ? ` · ${andamento} em andamento` : ''}${trabalhando ? ' · alguma conversa trabalhando' : ''}`;
        }
    }

    window.abreTasks = abre;
    window.fechaTasks = fecha;
    window.tasksAlterna = alterna;
    window.tasksAtualizaSelo = atualizaSelo;
    botoesTasks().forEach(b => { if (b.id === 'btnModoTasks') b.addEventListener('click', alterna); });
})();
