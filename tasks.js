// Visão Tasks: placa de circuito. O Claude é o chip no centro; cada conversa é um cartão (o mesmo "Plano" da conversa)
// ligado ao chip por uma trilha. Os pulsos são o fluxo real lido do transcript: "in" corre para o chip, "out" sai dele.
(() => {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const INTERVALO_POLL = 2000;
    const MINUTOS_ABSORVE = 10, HORAS_SELO = 24;
    const DURACAO_PULSO = 480, MAX_PULSOS_TRILHA = 3, LOTE_MAX_MS = 2000, JANELA_PRIMEIRO_POLL_MS = 3000;
    const LARGURA_CARTAO = 300, CHIP = 164, CANAL = 140, FOLGA_Y = 18, MAX_POR_COLUNA = 4, LINHAS_CARTAO = 4, CHANFRO = 10;
    const DUPLO_CLIQUE_MS = 320;
    const LARGURA_SUB = 210, CANAL_SUB = 56, FOLGA_SUB = 10, LINHAS_SUB = 3, FADE_SUB_MS = 420;
    const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    const tomPulso = (m) => `var(--tom-${familiaModelo(m)}-pulso)`;
    const glifoModelo = (m, t = 12) => `<svg width="${t}" height="${t}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IDENTIDADE_MODELO[familiaModelo(m)].glifo}</svg>`;
    const chipModelo = (m, extra = '') => `<span class="tk-chip-modelo${extra}" style="--tom:${tomModelo(m)}" title="${escapa(m || 'modelo não informado')}">${glifoModelo(m)}${escapa(nomeModelo(m))}</span>`;

    const css = `
#janelaTasks { position: fixed; top: 0; right: 0; bottom: 0; left: var(--larg-sessoes, 0px); z-index: 65; background: var(--papel); color: var(--tinta); overflow: hidden; font-family: var(--sans); display: flex; flex-direction: column; --tk-nucleo: #fff; }
html[data-tema-efetivo="claro"] #janelaTasks { --tk-nucleo: var(--tinta); }
#janelaTasks, .marca, .trilho-lista { ${Object.entries(IDENTIDADE_MODELO).map(([f, i]) => `--tom-${f}: color-mix(in srgb, ${i.matiz} 62%, var(--tinta)); --tom-${f}-pulso: color-mix(in srgb, ${i.matiz} 88%, var(--tinta));`).join(' ')} }
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
.tk-topo .mini .n { font: 11px var(--mono); opacity: .75; margin-left: 4px; }
.tk-palco { flex: 1; position: relative; overflow: hidden; cursor: grab; background-image: radial-gradient(var(--linha) 1px, transparent 1px); background-size: 28px 28px; background-position: 14px 14px; }
.tk-palco.arrastando { cursor: grabbing; }
.tk-mundo { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.tk-svg { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
.tk-trilha { fill: none; stroke: var(--trilha, var(--linha)); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; transition: opacity .2s, stroke .2s; }
.tk-trilha.acesa { stroke: var(--voce); }
.tk-pino { stroke: var(--linha); stroke-width: 1.5; stroke-linecap: round; }
.tk-pino-ativo { fill: var(--trilha, var(--linha)); }
.tk-pulso { fill: none; stroke-linecap: round; pointer-events: none; }
.tk-chip-centro { position: absolute; width: ${CHIP}px; height: ${CHIP}px; border: 1px solid var(--linha); border-radius: 12px; background: var(--folha); box-shadow: var(--sombra); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center; cursor: grab; user-select: none; }
.tk-chip-centro svg { width: 34px; height: 34px; color: var(--voce); margin-bottom: 4px; }
.tk-chip-centro b { font: 600 14px var(--sans); }
.tk-chip-centro .tk-pct { font: 600 20px var(--sans); }
.tk-chip-centro small { font: 11px/1.3 var(--mono); color: var(--grafite); padding: 0 8px; }
.tk-cartao { position: absolute; user-select: none; width: ${LARGURA_CARTAO}px; border: 1px solid var(--linha); border-radius: 10px; background: var(--folha); box-shadow: var(--sombra); padding: 10px 14px 10px 16px; cursor: pointer; transition: opacity .2s, border-color .2s; }
.tk-cartao::before { content: ""; position: absolute; left: -1px; top: 10px; bottom: 10px; width: 3px; border-radius: 0 2px 2px 0; background: var(--tom); }
.tk-cartao:hover, .tk-cartao.sel { border-color: var(--grafite); }
.tk-cartao.viva { border-color: color-mix(in srgb, var(--voce) 55%, var(--linha)); }
.tk-cartao.esperando { border-color: color-mix(in srgb, var(--atencao) 55%, var(--linha)); }
.tk-cartao.sel { outline: 2px solid var(--voce); outline-offset: 1px; }
.tk-cartao.arrastando, .tk-chip-centro.arrastando { cursor: grabbing; box-shadow: var(--sombra), 0 0 0 2px color-mix(in srgb, var(--voce) 35%, transparent); transition: none; z-index: 2; }
.tk-palco.arrastando-cartao .tk-trilha { transition: none; }
.tk-cab { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.tk-cab b { font: 600 13.5px/1.3 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.tk-cab .tk-pct { font: 600 12px var(--mono); color: var(--grafite); flex: none; }
.tk-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font: 11px var(--mono); color: var(--grafite); margin: 4px 0 7px; }
.tk-meta .tk-sit::before { content: "●"; margin-right: 4px; font-size: 9px; }
.tk-cartao.viva .tk-sit { color: var(--voce); }
.tk-cartao.esperando .tk-sit { color: var(--atencao); }
.tk-agora { display: flex; align-items: center; gap: 6px; margin: -3px 0 7px; font: 11px var(--mono); color: var(--grafite); white-space: nowrap; overflow: hidden; }
.tk-agora span { overflow: hidden; text-overflow: ellipsis; }
.tk-agora.pergunta { font: 12px var(--sans); color: var(--atencao); }
.tk-agora.pergunta b { font: 700 12px var(--sans); flex: none; }
.tk-agora.acao b { font-weight: 600; color: var(--tinta); flex: none; }
.tk-cartao .barra { margin-bottom: 7px; }
.tk-cartao .passos li, .tk-gaveta .passos li { grid-template-columns: 22px 1fr; align-items: center; padding: 2px 0; text-decoration: none; font-size: 12.5px; line-height: 1.3; }
.tk-cartao .passos li::before, .tk-gaveta .passos li::before { content: none; }
.tk-cartao .passos li span, .tk-gaveta .passos li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-cartao .passos li.completed span { color: var(--tinta); opacity: .7; }
.tk-cartao .passos li.pending span { color: var(--grafite); }
.tk-cartao .passos li.mais, .tk-gaveta .passos li.mais { font: 11px var(--mono); color: var(--grafite); }
.tk-cartao .passos li.mais::before { content: "+" attr(data-n); color: var(--grafite); font: 11px var(--mono); text-align: center; }
.tk-agentes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.tk-agente { display: inline-flex; align-items: center; gap: 4px; font: 500 11px var(--sans); line-height: 16px; padding: 0 7px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--tom) 55%, transparent); color: var(--tom); background: color-mix(in srgb, var(--tom) 7%, transparent); max-width: 100%; white-space: nowrap; overflow: visible; }
.tk-agente i { font-style: normal; color: var(--tom); display: inline-flex; align-items: center; gap: 2px; opacity: .85; }
.tk-agente { box-sizing: border-box; height: 20px; padding: 0 8px 0 3px; }
.tk-pet { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: flex-end; justify-content: center; }
.tk-pet .pet-mini { zoom: .4; width: 40px; height: 40px; margin: 0; }
.tk-agente.rodando { border-color: var(--tom); margin-left: 0; font-size: 11px; color: var(--tom); }
.tk-agente.rodando::after { content: "●"; font-size: 8px; line-height: 1; animation: pisca-passo 1s ease-in-out infinite; }
.tk-agente.erro, .tk-agente.interrompido { color: var(--erro); border-color: color-mix(in srgb, var(--erro) 55%, transparent); }
.tk-agente.concluido { opacity: .75; }
.tk-agente.pisca { background: color-mix(in srgb, var(--tom) 35%, transparent); }
@media (prefers-reduced-motion: reduce) { .tk-agente .pet-corpo, .tk-agente .pet-item, .tk-agente .pet-corpo::before, .tk-agente .pet-corpo::after, .tk-agente.rodando::after, .ponto-tasks { animation: none !important; } }
#janelaTasks.focando .tk-cartao.esmaece, #janelaTasks.focando .tk-subcartao.esmaece, #janelaTasks.focando .tk-trilha.esmaece, #janelaTasks.focando .tk-pulso.esmaece { opacity: .3; }
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
.tk-gaveta .tk-agora { margin: 0 0 10px; white-space: normal; }
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
.tk-legenda { position: absolute; z-index: 3; left: 16px; bottom: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font: 11.5px var(--sans); color: var(--grafite); background: color-mix(in srgb, var(--papel) 85%, transparent); padding: 6px 10px; border-radius: 8px; max-width: calc(100% - 370px); }
.tk-legenda span { display: inline-flex; align-items: center; gap: 6px; }
.tk-legenda .passos { display: contents; }
.tk-legenda .passos li { display: inline-flex; gap: 6px; padding: 0; align-items: center; font-weight: 400; color: var(--grafite); }
.tk-legenda .passos li::before { content: none; }
.tk-legenda .marcador { width: 13px; height: 13px; }
.tk-legenda .sep { width: 1px; height: 14px; background: var(--linha); }
#janelaTasks.vazio .tk-chip-centro { opacity: .55; }
.tk-subcartao { position: absolute; user-select: none; width: ${LARGURA_SUB}px; border: 1px solid color-mix(in srgb, var(--tom) 45%, var(--linha)); border-radius: 8px; background: var(--folha); box-shadow: var(--sombra); padding: 7px 10px 7px 12px; cursor: pointer; transition: opacity .2s, border-color .2s; }
.tk-subcartao::before { content: ""; position: absolute; left: -1px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 2px 2px 0; background: var(--tom); }
.tk-subcartao.arrastando { cursor: grabbing; box-shadow: var(--sombra), 0 0 0 2px color-mix(in srgb, var(--voce) 35%, transparent); transition: none; z-index: 2; }
.tk-subcartao.saindo { opacity: 0; transition: opacity ${FADE_SUB_MS}ms; pointer-events: none; }
.tk-subcartao .tk-sub-cab { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tk-subcartao .tk-sub-cab b { font: 600 12px/1.3 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.tk-subcartao .tk-sub-cab .tk-chip-modelo { flex: none; font-size: 10px; line-height: 14px; padding: 0 5px; }
.tk-subcartao .tk-sub-desc { font: 11px/1.3 var(--sans); color: var(--grafite); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.tk-subcartao .tk-agora { margin: 4px 0 0; }
.tk-subcartao .tk-agora::before { content: "●"; color: var(--tom); font-size: 8px; animation: pisca-passo 1s ease-in-out infinite; flex: none; }
.tk-subcartao .passos { margin-top: 4px; }
.tk-subcartao .passos li { grid-template-columns: 18px 1fr; align-items: center; padding: 1px 0; text-decoration: none; font-size: 11.5px; line-height: 1.3; color: var(--grafite); }
.tk-subcartao .passos li::before { content: none; }
.tk-subcartao .passos li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-subcartao .passos li.in_progress { color: var(--tinta); }
.tk-subcartao .passos li .marcador { width: 12px; height: 12px; font-size: 8px; }
.tk-subcartao .passos li.mais::before { content: "+" attr(data-n); color: var(--grafite); font: 10.5px var(--mono); text-align: center; }
.tk-subcartao .tk-pet { width: 18px; height: 18px; }
.tk-subcartao .tk-pet .pet-mini { zoom: .45; }
@media (prefers-reduced-motion: reduce) { .tk-subcartao .tk-agora::before, .tk-subcartao .pet-corpo, .tk-subcartao .pet-item, .tk-subcartao .pet-corpo::before, .tk-subcartao .pet-corpo::after { animation: none !important; } }
#btnModoTasks { position: relative; }
#btnModoTasks .ponto-tasks { position: absolute; top: 3px; left: 5px; }
.selo-tasks { font: 600 10.5px/15px var(--mono); min-width: 15px; padding: 0 5px; border-radius: 8px; background: color-mix(in srgb, var(--tinta) 10%, transparent); color: var(--tinta); text-align: center; }
.trilho-lista .selo-tasks { position: absolute; top: 1px; right: 1px; background: var(--voce); color: #fff; font-size: 9.5px; line-height: 14px; min-width: 14px; padding: 0 4px; }
.trilho-lista [data-trilho="btnModoTasks"] { position: relative; }
.ponto-tasks { width: 6px; height: 6px; border-radius: 50%; background: var(--voce); animation: pisca-passo 1s ease-in-out infinite; }
.trilho-lista .ponto-tasks { position: absolute; left: 5px; top: 5px; }
`;

    const marcaSvg = (t) => `<svg width="${t}" height="${t}" viewBox="-1.15 -1.15 2.3 2.3" aria-hidden="true"><g stroke="currentColor" stroke-width="0.22" stroke-linecap="round"><line x1="0" y1="0" x2="0.990" y2="0.139"/><line x1="0" y1="0" x2="0.595" y2="0.535"/><line x1="0" y1="0" x2="0.227" y2="0.912"/><line x1="0" y1="0" x2="-0.103" y2="0.733"/><line x1="0" y1="0" x2="-0.602" y2="0.669"/><line x1="0" y1="0" x2="-0.796" y2="0.198"/><line x1="0" y1="0" x2="-0.990" y2="-0.139"/><line x1="0" y1="0" x2="-0.572" y2="-0.515"/><line x1="0" y1="0" x2="-0.223" y2="-0.893"/><line x1="0" y1="0" x2="0.100" y2="-0.713"/><line x1="0" y1="0" x2="0.589" y2="-0.654"/><line x1="0" y1="0" x2="0.815" y2="-0.203"/></g><circle r="0.15" fill="currentColor"/></svg>`;
    const html = `
<div class="tk-topo">
  <span class="tk-titulo">${marcaSvg(20)}Tasks</span>
  <div class="filtros" id="tkFiltros" role="group" aria-label="Quais conversas mostrar">
    <button class="filtro" data-f="todas" aria-pressed="true">Todas<span class="n">0</span></button>
    <button class="filtro" data-f="ativas" aria-pressed="false">Trabalhando<span class="n">0</span></button>
    <button class="filtro" data-f="esperando" aria-pressed="false">Pergunta pra você<span class="n">0</span></button>
    <button class="filtro" data-f="agentes" aria-pressed="false">Com agentes<span class="n">0</span></button>
  </div>
  <div class="tk-modelos" id="tkModelos" role="group" aria-label="Filtrar por modelo"></div>
  <input class="tk-busca" id="tkBusca" placeholder="Procurar tarefa ou conversa (Ctrl+K)" aria-label="Procurar">
  <button class="mini" id="tkSinais" aria-pressed="true" title="Mostrar ou esconder os sinais correndo nas trilhas">Sinais</button>
  <button class="mini" id="tkAbsorvidas" hidden aria-pressed="false" title="Mostrar as conversas concluídas e paradas há mais de ${MINUTOS_ABSORVE} min">Absorvidas<span class="n" id="tkNAbsorvidas"></span></button>
  <button class="mini" id="tkOrganiza" title="Voltar ao arranjo automático (esquece as posições arrastadas)">Organizar</button>
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
    const cortaTexto = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    // PREFERENCIAS LEMBRADAS ENTRE ABERTURAS: VISTA (ZOOM/PAN), FILTROS, ABSORVIDAS E SINAIS
    const CHAVE_PREFS = 'tasksPrefs', CHAVE_POSICOES = 'tasksPosicoes';
    const lePref = (chave, padrao) => { try { const v = JSON.parse(localStorage.getItem(chave) || 'null'); return v == null ? padrao : v; } catch (e) { return padrao; } };
    const gravaPref = (chave, valor) => { try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* sem armazenamento */ } };
    const prefs = { vista: null, filtro: 'todas', filtroModelo: null, absorvidas: false, sinais: localStorage.getItem('tasksSinais') !== '0', ...lePref(CHAVE_PREFS, {}) };
    const gravaPrefs = () => gravaPref(CHAVE_PREFS, prefs);
    const sinaisLigados = () => prefs.sinais !== false;

    let dados = null, hash = '', ultimoSeq = 0, timer = null, busca = '', foco = null, selecionada = null;
    let vista = null, buscando = false;
    const cartoesPorId = new Map();
    let cartoesAtuais = [], chaveVisiveis = '';
    const tocados = new Map();
    const emVoo = new Map();
    const feed = [];
    let anterior = null;
    let temporizadores = new Set(), quadros = new Set();

    // PROGRESSO
    const progressoTarefa = (t) => {
        if (t.status === 'completed') return 1;
        const filhos = (t.subagentes || []).flatMap(s => s.tarefas);
        if (filhos.length) return filhos.reduce((s, f) => s + progressoTarefa(f), 0) / filhos.length;
        return t.status === 'pending' ? 0 : 0.5;
    };
    const todosSubs = (c) => [...c.tarefas.flatMap(t => t.subagentes), ...c.subagentesSoltos];
    const ativo = (s) => s.status === 'rodando';
    const agentesAtivos = (c) => todosSubs(c).filter(ativo);
    const progressoConversa = (c) => c.tarefas.length ? c.tarefas.reduce((s, t) => s + progressoTarefa(t), 0) / c.tarefas.length : (todosSubs(c).every(s => s.status !== 'rodando') ? 1 : 0.5);
    const absorvida = () => false;
    const passaFiltro = (c) => (prefs.filtro === 'todas' || (prefs.filtro === 'ativas' && c.vivo) || (prefs.filtro === 'esperando' && c.esperando) || (prefs.filtro === 'agentes' && agentesAtivos(c).length > 0))
        && (!prefs.filtroModelo || familiaModelo(c.modelo) === prefs.filtroModelo || todosSubs(c).some(s => familiaModelo(s.modelo) === prefs.filtroModelo));
    const visiveisAgora = () => dados.conversas.filter(c => passaFiltro(c) && (prefs.absorvidas || !absorvida(c))).sort((a, b) => a.id.localeCompare(b.id));
    const situacao = (c) => c.esperando ? 'pergunta pra você' : c.vivo ? 'trabalhando' : 'parada';
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
    // MASCOTE DO AGENTE: O MESMO petMini DO APP (COM A PERSONALIZACAO DO USUARIO); SEM ELE, VOLTA AO LOSANGO
    const petDoAgente = (s) => `<span class="tk-pet">${typeof petMini === 'function' ? petMini(s.tipo, s.status === 'rodando') : '◆'}</span>`;
    const chipAgente = (s) => `<span class="tk-agente ${escapa(s.status)}" data-agente="${escapa(s.id)}" style="--tom:${tomModelo(s.modelo)}" title="${escapa(s.descricao || s.tipo)} · ${escapa(s.status)}${s.modelo ? ' · ' + escapa(nomeModelo(s.modelo)) : ''}">${petDoAgente(s)}${escapa(cortaTexto(s.tipo, 24))}${s.modelo ? `<i>${glifoModelo(s.modelo, 11)}${escapa(IDENTIDADE_MODELO[familiaModelo(s.modelo)].nome)}</i>` : ''}</span>`;
    // "AGORA" DO CARTAO: A PERGUNTA PENDENTE (ESPERANDO VOCE) OU A ACAO EM CURSO (TRABALHANDO)
    const VERBO_ACAO = { comando: 'Rodando:', edicao: 'Editando', leitura: 'Lendo', busca: 'Procurando', agente: 'Agente:', web: 'Acessando', skill: 'Skill:', ferramenta: 'Usando' };
    function htmlAgora(c) {
        if (c.esperando && c.pergunta) return `<div class="tk-agora pergunta" title="${escapa(c.pergunta)}"><b>?</b><span>${escapa(c.pergunta)}</span></div>`;
        if (c.vivo && c.acaoAtual && c.acaoAtual.texto) return `<div class="tk-agora acao" title="${escapa(c.acaoAtual.texto)}"><b>${escapa(VERBO_ACAO[c.acaoAtual.tipo] || c.acaoAtual.tipo)}</b><span>${escapa(c.acaoAtual.texto)}</span></div>`;
        return '';
    }
    function htmlCartao(c) {
        const feitas = c.tarefas.filter(t => t.status === 'completed').length, p = progressoConversa(c);
        const { inicio, fim } = janelaTarefas(c.tarefas);
        const passos = c.tarefas.length ? `<ol class="passos">${inicio > 0 ? `<li class="mais" data-n="${inicio}">${inicio === 1 ? 'anterior' : 'anteriores'}</li>` : ''}${c.tarefas.slice(inicio, fim).map(itemPasso).join('')}${fim < c.tarefas.length ? `<li class="mais" data-n="${c.tarefas.length - fim}">${c.tarefas.length - fim === 1 ? 'restante' : 'restantes'}</li>` : ''}</ol>` : '<p class="tk-meta" style="margin:0">Sem lista de tarefas</p>';
        return `<div class="tk-cab"><b title="${escapa(c.titulo)}">${escapa(c.titulo)}</b><span class="tk-pct">${Math.round(p * 100)}%</span></div>
            <div class="tk-meta">${chipModelo(c.modelo)}<span class="tk-sit">${situacao(c)}</span><span>· ${feitas} de ${c.tarefas.length}</span></div>
            ${htmlAgora(c)}<div class="barra"><div style="width:${Math.round(p * 100)}%"></div></div>${passos}`;
    }
    // SUB-CARTAO DO AGENTE RODANDO: MASCOTE, TIPO, MODELO, DESCRICAO, O QUE FAZ AGORA E A MINI-LISTA DELE
    function htmlAgoraAgente(s) {
        const a = s.acaoAtual;
        const rotulo = !a ? 'Pensando' : a.texto ? (VERBO_ACAO[a.tipo] || a.tipo) : ({ pensou: 'Pensando', fala: 'Escrevendo', pedido: 'Lendo o pedido' }[a.tipo] || VERBO_ACAO[a.tipo] || a.tipo);
        return `<div class="tk-agora acao" title="${escapa(a && a.texto ? a.texto : rotulo)}"><b>${escapa(rotulo)}</b>${a && a.texto ? `<span>${escapa(a.texto)}</span>` : ''}</div>`;
    }
    function htmlSubCartao(s) {
        const n = s.tarefas.length, atual = Math.max(0, s.tarefas.findIndex(t => t.status === 'in_progress'));
        const inicio = Math.max(0, Math.min(atual - 1, n - LINHAS_SUB)), fim = Math.min(n, inicio + LINHAS_SUB - (n > LINHAS_SUB ? 1 : 0));
        const passos = n ? `<ol class="passos">${s.tarefas.slice(inicio, fim).map(itemPasso).join('')}${fim < n ? `<li class="mais" data-n="${n - fim}">${n - fim === 1 ? 'restante' : 'restantes'}</li>` : ''}</ol>` : '';
        return `<div class="tk-sub-cab">${petDoAgente(s)}<b title="${escapa(s.tipo)}">${escapa(s.tipo)}</b>${s.modelo ? chipModelo(s.modelo) : ''}</div>
            ${s.descricao ? `<div class="tk-sub-desc" title="${escapa(s.descricao)}">${escapa(s.descricao)}</div>` : ''}
            ${htmlAgoraAgente(s)}${passos}`;
    }

    // POSICOES FIXADAS PELO USUARIO (NO ESPACO DO MUNDO) E O CENTRO DO CHIP
    let fixas = { cartoes: {}, agentes: {}, chip: null, ...lePref(CHAVE_POSICOES, {}) };
    const centro = () => fixas.chip || { x: 0, y: 0 };
    const gravaPosicoes = () => gravaPref(CHAVE_POSICOES, fixas);

    // FOOTPRINT DO CARTAO COM OS SUB-CARTOES PENDURADOS DO LADO DE FORA (LONGE DO CHIP)
    const extraSubs = (k) => k.subs.length ? CANAL_SUB + LARGURA_SUB : 0;
    const alturaSubs = (k) => k.subs.reduce((s, u) => s + u.h, 0) + FOLGA_SUB * Math.max(0, k.subs.length - 1);
    const alturaTotal = (k) => Math.max(k.h, alturaSubs(k));
    // LAYOUT DETERMINISTICO: COLUNAS A DIREITA E A ESQUERDA DO CHIP, SEM SOBREPOSICAO; CARTAO FIXADO FICA ONDE O USUARIO DEIXOU
    function posiciona(cartoes) {
        const o = centro();
        const automaticos = cartoes.filter(k => !k.fixo);
        for (const lado of [1, -1]) {
            const lista = automaticos.filter((k, i) => (i % 2 === 0) === (lado === 1));
            const nColunas = Math.ceil(lista.length / MAX_POR_COLUNA), tam = Math.ceil(lista.length / Math.max(nColunas, 1));
            const alturas = [], bordas = [];
            let borda = CHIP / 2 + CANAL;
            for (let j = 0; j < nColunas; j++) {
                const itens = lista.slice(j * tam, (j + 1) * tam);
                const total = itens.reduce((s, k) => s + alturaTotal(k), 0) + FOLGA_Y * (itens.length - 1);
                let y = -total / 2;
                for (const k of itens) {
                    Object.assign(k, { lado, coluna: j, y: o.y + y, x: o.x + (lado > 0 ? borda : -borda - LARGURA_CARTAO), contorno: null });
                    y += alturaTotal(k) + FOLGA_Y;
                }
                alturas.push(total);
                bordas.push(borda);
                borda += LARGURA_CARTAO + Math.max(0, ...itens.map(extraSubs)) + CANAL;
            }
            // COLUNA EXTERNA CONTORNA A INTERNA: LANE ACIMA OU ABAIXO DO BLOCO E DEPOIS DESCE ATE O CARTAO
            lista.filter(k => k.coluna > 0).sort((a, b) => Math.abs(a.y + a.h / 2 - o.y) - Math.abs(b.y + b.h / 2 - o.y)).forEach((k, i) => {
                const sinal = k.y + k.h / 2 < o.y ? -1 : 1;
                k.contorno = { xv: o.x + lado * (CHIP / 2 + 12 + i * 8), yl: o.y + sinal * (Math.max(...alturas.slice(0, k.coluna)) / 2 + 26 + i * 10), xh: o.x + lado * (bordas[k.coluna] - CANAL + 30 + i * 10) };
            });
        }
        empurraColisoes(cartoes);
        cartoes.forEach(posicionaSubs);
    }
    // RETANGULO OCUPADO PELO CARTAO E SEUS SUB-CARTOES
    function pegada(k) {
        const extra = extraSubs(k), esquerda = k.lado < 0 || (k.fixo && k.x + LARGURA_CARTAO / 2 < centro().x);
        return { x: esquerda ? k.x - extra : k.x, y: k.y, w: LARGURA_CARTAO + extra, h: alturaTotal(k) };
    }
    // CARTAO AUTOMATICO QUE CAIU EM CIMA DE UM FIXADO (OU DO CHIP) DESCE ATE ACHAR LUGAR
    function empurraColisoes(cartoes) {
        const o = centro();
        const colide = (a, b) => a.x < b.x + b.w + FOLGA_Y && b.x < a.x + a.w + FOLGA_Y && a.y < b.y + b.h + FOLGA_Y && b.y < a.y + a.h + FOLGA_Y;
        const postos = [{ x: o.x - CHIP / 2, y: o.y - CHIP / 2, w: CHIP, h: CHIP }, ...cartoes.filter(k => k.fixo).map(pegada)];
        for (const k of cartoes.filter(k => !k.fixo).sort((a, b) => a.lado - b.lado || a.coluna - b.coluna || a.y - b.y)) {
            const r = pegada(k);
            for (let volta = 0; volta < 50; volta++) {
                const batida = postos.find(p => colide(r, p));
                if (!batida) break;
                r.y = batida.y + batida.h + FOLGA_Y;
                k.contorno = null;
            }
            k.y = r.y;
            postos.push(r);
        }
    }
    // SUB-CARTOES DO LADO DE FORA DO CARTAO (LONGE DO CHIP), EMPILHADOS; OFFSET PROPRIO QUANDO O USUARIO ARRASTOU
    function posicionaSubs(k) {
        const o = centro(), aEsquerda = k.x + LARGURA_CARTAO / 2 < o.x;
        let y = 0;
        for (const u of k.subs) {
            const fixa = fixas.agentes[u.s.id];
            if (fixa) { u.dx = fixa.dx; u.dy = fixa.dy; }
            else { u.dx = aEsquerda ? -CANAL_SUB - LARGURA_SUB : LARGURA_CARTAO + CANAL_SUB; u.dy = y; y += u.h + FOLGA_SUB; }
            u.x = k.x + u.dx; u.y = k.y + u.dy;
            u.el.style.left = u.x + 'px'; u.el.style.top = u.y + 'px';
        }
    }
    // TRILHA CURTA ENTRE DOIS RETANGULOS (CARTAO -> SUB-CARTAO), SAINDO PELO LADO QUE OLHA PARA O OUTRO
    function rotaEntre(a, b) {
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        if (b.x >= a.x + a.w - 4 || b.x + b.w <= a.x + 4) {
            const dir = b.x >= a.x + a.w - 4 ? 1 : -1;
            const x0 = dir > 0 ? a.x + a.w : a.x, x1 = dir > 0 ? b.x : b.x + b.w;
            const y0 = clamp(bcy, a.y + 12, a.y + a.h - 12), y1 = clamp(y0, b.y + 10, b.y + b.h - 10), xm = (x0 + x1) / 2;
            return [[x0, y0], [xm, y0], [xm, y1], [x1, y1]];
        }
        const dir = bcy >= acy ? 1 : -1;
        const y0 = dir > 0 ? a.y + a.h : a.y, y1 = dir > 0 ? b.y : b.y + b.h;
        const x0 = clamp(bcx, a.x + 12, a.x + a.w - 12), x1 = clamp(x0, b.x + 10, b.x + b.w - 10), ym = (y0 + y1) / 2;
        return [[x0, y0], [x0, ym], [x1, ym], [x1, y1]];
    }
    // LADO DO CHIP POR ONDE A TRILHA SAI, CONFORME ONDE O CARTAO ESTA
    function ladoDoCartao(k) {
        const o = centro();
        if (k.x > o.x + CHIP / 2 + 20) return 'dir';
        if (k.x + LARGURA_CARTAO < o.x - CHIP / 2 - 20) return 'esq';
        return k.y + k.h / 2 < o.y ? 'cima' : 'baixo';
    }
    // ROTEIA TODAS AS TRILHAS: PINOS DISTRIBUIDOS POR LADO; CARTAO MAIS PERTO DO CENTRO SOBE MAIS LONGE NO CANAL (TRILHAS ANINHADAS)
    function roteia(cartoes) {
        const o = centro();
        const grupos = { dir: [], esq: [], cima: [], baixo: [] };
        for (const k of cartoes) { k.cx = k.x + LARGURA_CARTAO / 2; k.cy = k.y + k.h / 2; grupos[ladoDoCartao(k)].push(k); }
        for (const [lado, lista] of Object.entries(grupos)) {
            const horizontal = lado === 'dir' || lado === 'esq', sinal = lado === 'dir' || lado === 'baixo' ? 1 : -1;
            const ordenada = lista.slice().sort((a, b) => horizontal ? a.cy - b.cy : a.cx - b.cx), n = ordenada.length;
            const passo = Math.min(20, (CHIP - 44) / Math.max(n - 1, 1));
            ordenada.forEach((k, i) => {
                const t = (i - (n - 1) / 2) * passo;
                k.pinoX = horizontal ? o.x + sinal * CHIP / 2 : o.x + t;
                k.pinoY = horizontal ? o.y + t : o.y + sinal * CHIP / 2;
            });
            const distancia = (k) => Math.abs(horizontal ? k.cy - o.y : k.cx - o.x);
            const diretas = lista.filter(k => !k.contorno).sort((a, b) => distancia(b) - distancia(a));
            const passoX = Math.min(14, (CANAL - 70) / Math.max(diretas.length - 1, 1));
            diretas.forEach((k, i) => {
                if (horizontal) {
                    const borda = sinal > 0 ? k.x : k.x + LARGURA_CARTAO;
                    const xm = sinal > 0 ? Math.min(o.x + CHIP / 2 + 44 + i * passoX, borda - 12) : Math.max(o.x - CHIP / 2 - 44 - i * passoX, borda + 12);
                    k.pontos = [[k.pinoX, k.pinoY], [xm, k.pinoY], [xm, k.cy], [borda, k.cy]];
                } else {
                    const borda = sinal > 0 ? k.y : k.y + k.h;
                    const ym = sinal > 0 ? Math.min(o.y + CHIP / 2 + 44 + i * passoX, borda - 12) : Math.max(o.y - CHIP / 2 - 44 - i * passoX, borda + 12);
                    k.pontos = [[k.pinoX, k.pinoY], [k.pinoX, ym], [k.cx, ym], [k.cx, borda]];
                }
            });
            lista.filter(k => k.contorno).forEach(k => {
                const { xv, yl, xh } = k.contorno, borda = k.lado > 0 ? k.x : k.x + LARGURA_CARTAO;
                k.pontos = [[k.pinoX, k.pinoY], [xv, k.pinoY], [xv, yl], [xh, yl], [xh, k.cy], [borda, k.cy]];
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

    // DESENHA POR DIFERENCA: CARTAO, TRILHA E PINO PERSISTEM POR ID; SO O HTML QUE MUDOU E RETROCADO,
    // E AS ALTURAS SAO MEDIDAS EM LOTE DEPOIS DE TODAS AS ESCRITAS NO DOM
    const subsPorId = new Map();
    function desenha() {
        if (!dados) return;
        const visiveis = visiveisAgora();
        chaveVisiveis = visiveis.map(c => c.id).join(',');
        const vivos = new Set(visiveis.map(c => c.id));
        for (const [id, k] of cartoesPorId) if (!vivos.has(id)) { k.el.remove(); k.trilha.remove(); k.pino.remove(); k.subs.forEach(u => { u.el.remove(); u.trilha.remove(); }); cartoesPorId.delete(id); }
        const cartoes = visiveis.map(c => {
            let k = cartoesPorId.get(c.id);
            const corpo = htmlCartao(c), classe = `tk-cartao ${classeSituacao(c)}${selecionada === c.id ? ' sel' : ''}`;
            if (!k) {
                const e = document.createElement('article');
                e.dataset.conversa = c.id;
                caixaCartoes.appendChild(e);
                k = { el: e, corpo: null, subs: [], trilha: el('path', { class: 'tk-trilha', 'data-conversa': c.id }, gTrilhas), pino: el('circle', { r: 2.6, class: 'tk-pino-ativo' }, gTrilhas) };
                cartoesPorId.set(c.id, k);
            }
            k.c = c;
            if (k.el.className !== classe) k.el.className = classe;
            if (k.corpo !== corpo) {
                k.corpo = corpo;
                k.el.innerHTML = corpo;
                k.el.style.setProperty('--tom', tomModelo(c.modelo));
                k.el.dataset.busca = [c.titulo, c.nomeProjeto, nomeModelo(c.modelo), ...c.tarefas.map(t => t.texto), ...todosSubs(c).flatMap(s => [s.tipo, s.descricao, ...s.tarefas.map(t => t.texto)])].join(' ').toLowerCase();
                k.mediu = false;
                const tom = tomModelo(c.modelo);
                k.trilha.setAttribute('style', `--trilha: color-mix(in srgb, ${tom} 45%, var(--linha))`);
                if (c.vivo || c.esperando) k.trilha.removeAttribute('stroke-dasharray'); else k.trilha.setAttribute('stroke-dasharray', '4 5');
                k.pino.setAttribute('style', `--trilha: color-mix(in srgb, ${tom} 70%, var(--linha))`);
            }
            const fixa = fixas.cartoes[c.id];
            Object.assign(k, { fixo: !!fixa, x: fixa ? fixa.x : 0, y: fixa ? fixa.y : 0 });
            k.subs = agentesAtivos(c).map(s => montaSub(k, s));
            return k;
        });
        // AGENTE QUE TERMINOU: O SUB-CARTAO SOME COM UM FADE CURTO (A TRILHA FICA ATE O FIM DO FADE PARA O PULSO "BACK")
        for (const [id, u] of subsPorId) if (!u.k.subs.includes(u) && !u.saindo) {
            u.saindo = true;
            u.el.classList.add('saindo');
            u.trilha.style.transition = `opacity ${FADE_SUB_MS}ms`; u.trilha.style.opacity = '0';
            agenda(() => { u.el.remove(); u.trilha.remove(); if (subsPorId.get(id) === u) subsPorId.delete(id); }, FADE_SUB_MS + 60);
        }
        for (const k of cartoes) {
            if (!k.mediu) { k.h = k.el.offsetHeight; k.mediu = true; }
            for (const u of k.subs) if (!u.mediu) { u.h = u.el.offsetHeight; u.mediu = true; }
        }
        posiciona(cartoes);
        cartoesAtuais = cartoes;
        posicionaChip();
        if (!gPinos.childElementCount) desenhaPinos();
        for (const k of cartoes) { k.el.style.left = k.x + 'px'; k.el.style.top = k.y + 'px'; }
        atualizaTrilhas();
        atualizaCentro(visiveis);
        atualizaContadores();
        desenhaLegenda(visiveis);
        aplicaFoco();
        aplicaBusca();
        janela.classList.toggle('vazio', !visiveis.length);
        if (!vista) ajusta();
        if (selecionada) desenhaGaveta();
    }
    function montaSub(k, s) {
        let u = subsPorId.get(s.id);
        const corpo = htmlSubCartao(s);
        if (!u || u.saindo) {
            const e = document.createElement('article');
            e.className = 'tk-subcartao';
            e.dataset.conversa = k.c.id;
            e.dataset.agente = s.id;
            caixaCartoes.appendChild(e);
            u = { el: e, corpo: null, trilha: el('path', { class: 'tk-trilha', 'data-conversa': k.c.id }, gTrilhas) };
            subsPorId.set(s.id, u);
        }
        u.k = k; u.s = s;
        if (u.corpo !== corpo) {
            u.corpo = corpo;
            u.el.innerHTML = corpo;
            u.el.style.setProperty('--tom', tomModelo(s.modelo));
            u.trilha.setAttribute('style', `--trilha: color-mix(in srgb, ${tomModelo(s.modelo)} 55%, var(--linha))`);
            u.mediu = false;
        }
        return u;
    }
    // ABSORVIDA DEPENDE DO RELOGIO E NAO ENTRA NO HASH: REAVALIA A CADA POLL, MESMO COM 304
    function desenhaSeMudou() {
        if (!dados) return;
        if (visiveisAgora().map(c => c.id).join(',') !== chaveVisiveis) desenha();
    }
    function posicionaChip() {
        const o = centro();
        $('tkChip').style.left = (o.x - CHIP / 2) + 'px';
        $('tkChip').style.top = (o.y - CHIP / 2) + 'px';
        gPinos.setAttribute('transform', `translate(${o.x} ${o.y})`);
    }
    // RECALCULA TODAS AS TRILHAS (TAMBEM A CADA QUADRO DO ARRASTE DE UM CARTAO OU DO CHIP)
    function atualizaTrilhas() {
        roteia(cartoesAtuais);
        for (const k of cartoesAtuais) {
            const d = caminhoChanfrado(k.pontos);
            if (k.d !== d) { k.d = d; k.len = 0; k.trilha.setAttribute('d', d); }
            k.pino.setAttribute('cx', k.pinoX);
            k.pino.setAttribute('cy', k.pinoY);
            for (const u of k.subs) {
                const du = caminhoChanfrado(rotaEntre({ x: k.x, y: k.y, w: LARGURA_CARTAO, h: k.h }, { x: u.x, y: u.y, w: LARGURA_SUB, h: u.h }));
                if (u.d !== du) { u.d = du; u.len = 0; u.trilha.setAttribute('d', du); }
            }
        }
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
        const base = dados.conversas.filter(c => prefs.absorvidas || !absorvida(c));
        const conta = { todas: base.length, ativas: base.filter(c => c.vivo).length, esperando: base.filter(c => c.esperando).length, agentes: base.filter(c => agentesAtivos(c).length).length };
        for (const b of $('tkFiltros').querySelectorAll('button')) { b.querySelector('.n').textContent = conta[b.dataset.f]; b.setAttribute('aria-pressed', String(b.dataset.f === prefs.filtro)); }
        const familias = new Map();
        for (const c of base) for (const f of new Set([familiaModelo(c.modelo), ...todosSubs(c).map(s => familiaModelo(s.modelo))])) familias.set(f, (familias.get(f) || 0) + 1);
        if (prefs.filtroModelo && !familias.has(prefs.filtroModelo)) prefs.filtroModelo = null;
        const htmlModelos = [...familias].sort().map(([f, n]) => `<button class="tk-chip-modelo n" data-modelo="${f}" aria-pressed="${prefs.filtroModelo === f}" style="--tom:var(--tom-${f})" title="Só conversas e agentes com ${IDENTIDADE_MODELO[f].nome}">${glifoModelo(f)}${IDENTIDADE_MODELO[f].nome}<span class="n">${n}</span></button>`).join('');
        if ($('tkModelos').innerHTML !== htmlModelos) $('tkModelos').innerHTML = htmlModelos;
        $('tkSinais').setAttribute('aria-pressed', String(sinaisLigados()));
        $('tkAbsorvidas').setAttribute('aria-pressed', String(!!prefs.absorvidas));
        const absorvidas = dados.conversas.filter(absorvida).length;
        $('tkNAbsorvidas').textContent = absorvidas || '';
    }
    function desenhaLegenda(visiveis) {
        const familias = [...new Set(visiveis.flatMap(c => [familiaModelo(c.modelo), ...todosSubs(c).map(s => familiaModelo(s.modelo))]))].sort();
        const traco = (cor, tracejado) => `<svg width="26" height="8" aria-hidden="true"><line x1="2" y1="4" x2="24" y2="4" stroke="var(--linha)" stroke-width="1.5"${tracejado ? ' stroke-dasharray="4 3"' : ''}/>${cor ? `<line x1="6" y1="4" x2="16" y2="4" stroke="${cor}" stroke-width="2.5" stroke-linecap="round"/>` : ''}</svg>`;
        const htmlLegenda = `<ol class="passos"><li class="completed"><i class="marcador"></i>feita</li><li class="in_progress"><i class="marcador"></i>em andamento</li><li class="pending"><i class="marcador"></i>a fazer</li></ol>
            <i class="sep"></i><span>${traco('var(--voce)')}entrada</span><span>${traco('var(--tinta)')}saída</span><span>${traco('var(--tom-haiku-pulso)')}agente (trilha do sub-cartão, cor do modelo)</span><span>${traco(null, true)}conversa parada</span>
            ${familias.length ? '<i class="sep"></i>' + familias.map(f => `<span style="--tom:var(--tom-${f});color:var(--tom)">${glifoModelo(f, 13)}${IDENTIDADE_MODELO[f].nome}</span>`).join('') : ''}`;
        if ($('tkLegenda').innerHTML !== htmlLegenda) $('tkLegenda').innerHTML = htmlLegenda;
    }

    // ZOOM E ARRASTE: UMA TRANSFORMACAO SO PARA AS TRILHAS (SVG) E OS CARTOES (HTML); A VISTA E LEMBRADA
    function aplicaVista() {
        mundo.style.transform = `translate(${vista.x}px, ${vista.y}px) scale(${vista.k})`;
        prefs.vista = vista;
        gravaPrefs();
    }
    function ajusta() {
        const o = centro();
        let minX = o.x - CHIP / 2 - 12, maxX = o.x + CHIP / 2 + 12, minY = o.y - CHIP / 2 - 12, maxY = o.y + CHIP / 2 + 12;
        for (const k of cartoesAtuais) {
            minX = Math.min(minX, k.x); maxX = Math.max(maxX, k.x + LARGURA_CARTAO);
            minY = Math.min(minY, k.y); maxY = Math.max(maxY, k.y + k.h);
            for (const u of k.subs) { minX = Math.min(minX, u.x); maxX = Math.max(maxX, u.x + LARGURA_SUB); minY = Math.min(minY, u.y); maxY = Math.max(maxY, u.y + u.h); }
        }
        const caixa = palco.getBoundingClientRect(), w = caixa.width || 1600, h = caixa.height || 900, margem = 40;
        const k = Math.min(1.15, (w - margem * 2) / (maxX - minX), (h - margem * 2 - 60) / (maxY - minY));
        vista = { k, x: w / 2 - (minX + maxX) / 2 * k, y: (h - 50) / 2 - (minY + maxY) / 2 * k };
        aplicaVista();
    }
    const vistaValida = (v) => !!v && Number.isFinite(v.k) && v.k > 0 && Number.isFinite(v.x) && Number.isFinite(v.y);
    palco.addEventListener('wheel', (ev) => {
        if (ev.target.closest('.tk-caixa') || !vistaValida(vista)) return;
        ev.preventDefault();
        const fator = ev.deltaY > 0 ? 1 / 1.12 : 1.12, caixa = palco.getBoundingClientRect();
        const px = ev.clientX - caixa.left, py = ev.clientY - caixa.top;
        vista = { k: vista.k * fator, x: px - (px - vista.x) * fator, y: py - (py - vista.y) * fator };
        aplicaVista();
    }, { passive: false });
    let arrasto = null, arrastoCartao = null, ultimoClique = { id: null, hora: 0 }, cliqueTimer = null;
    palco.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || ev.target.closest('.tk-caixa, .tk-legenda') || !vistaValida(vista)) return;
        const cartao = ev.target.closest('.tk-cartao'), chip = ev.target.closest('.tk-chip-centro'), subEl = ev.target.closest('.tk-subcartao');
        if (subEl) {
            const u = subsPorId.get(subEl.dataset.agente);
            if (!u || u.saindo) return;
            arrastoCartao = { u, k: u.k, x: ev.clientX, y: ev.clientY, x0: u.dx, y0: u.dy, moveu: false };
        } else if (cartao || chip) {
            const k = cartao ? cartoesAtuais.find(x => x.el === cartao) : null;
            if (cartao && !k) return;
            arrastoCartao = { k, x: ev.clientX, y: ev.clientY, x0: k ? k.x : centro().x, y0: k ? k.y : centro().y, moveu: false };
        } else {
            arrasto = { x: ev.clientX, y: ev.clientY, vx: vista.x, vy: vista.y, moveu: false };
        }
        palco.setPointerCapture(ev.pointerId);
    });
    palco.addEventListener('pointermove', (ev) => {
        if (arrastoCartao) {
            const a = arrastoCartao;
            // LIMIAR DE 4 PX: ABAIXO DISSO E CLIQUE (ABRE A GAVETA), NAO ARRASTE
            if (!a.moveu && Math.hypot(ev.clientX - a.x, ev.clientY - a.y) < 4) return;
            if (!a.moveu) { a.moveu = true; palco.classList.add('arrastando-cartao'); limpaPulsos(); (a.u ? a.u.el : a.k ? a.k.el : $('tkChip')).classList.add('arrastando'); }
            const nx = Math.round(a.x0 + (ev.clientX - a.x) / vista.k), ny = Math.round(a.y0 + (ev.clientY - a.y) / vista.k);
            if (a.u) { fixas.agentes[a.u.s.id] = { dx: nx, dy: ny }; posicionaSubs(a.k); }
            else if (a.k) { a.k.x = nx; a.k.y = ny; a.k.fixo = true; a.k.contorno = null; a.k.el.style.left = nx + 'px'; a.k.el.style.top = ny + 'px'; posicionaSubs(a.k); }
            else { fixas.chip = { x: nx, y: ny }; posicionaChip(); }
            atualizaTrilhas();
            return;
        }
        if (arrasto) {
            const dx = ev.clientX - arrasto.x, dy = ev.clientY - arrasto.y;
            if (Math.hypot(dx, dy) > 3) { arrasto.moveu = true; palco.classList.add('arrastando'); }
            vista = { ...vista, x: arrasto.vx + dx, y: arrasto.vy + dy };
            aplicaVista();
            return;
        }
        const cartao = ev.target.closest('.tk-cartao, .tk-subcartao'), novo = cartao ? cartao.dataset.conversa : null;
        if (novo !== foco) { foco = novo; aplicaFoco(); }
    });
    function abreConversa(c) {
        if (!c || typeof abreSessao !== 'function') return;
        fecha();
        abreSessao(c.projeto + '/' + c.id);
    }
    // CLIQUE SIMPLES ABRE A GAVETA (DEPOIS DE UMA PAUSA CURTA); DUPLO CLIQUE ABRE A CONVERSA SEM A GAVETA PISCAR
    function cliqueNoCartao(k) {
        const agora = performance.now(), duplo = ultimoClique.id === k.c.id && agora - ultimoClique.hora < DUPLO_CLIQUE_MS;
        ultimoClique = { id: k.c.id, hora: agora };
        clearTimeout(cliqueTimer);
        if (duplo) { ultimoClique = { id: null, hora: 0 }; abreConversa(k.c); return; }
        const id = k.c.id;
        cliqueTimer = setTimeout(() => { selecionada = selecionada === id ? null : id; desenha(); $('tkGaveta').hidden = !selecionada; }, DUPLO_CLIQUE_MS);
    }
    const soltaArrasto = (ev) => {
        if (arrastoCartao) {
            const a = arrastoCartao;
            arrastoCartao = null;
            palco.classList.remove('arrastando-cartao');
            (a.u ? a.u.el : a.k ? a.k.el : $('tkChip')).classList.remove('arrastando');
            if (a.moveu) {
                if (a.k && !a.u) fixas.cartoes[a.k.c.id] = { x: a.k.x, y: a.k.y };
                gravaPosicoes();
                desenha();
            } else if (a.k && ev.type === 'pointerup') {
                cliqueNoCartao(a.k);
            }
            return;
        }
        if (arrasto && !arrasto.moveu && ev.type === 'pointerup') { selecionada = null; $('tkGaveta').hidden = true; desenha(); }
        arrasto = null; palco.classList.remove('arrastando');
    };
    palco.addEventListener('pointerup', soltaArrasto);
    palco.addEventListener('pointercancel', soltaArrasto);
    palco.addEventListener('pointerleave', () => { if (foco) { foco = null; aplicaFoco(); } });
    // A AREA DA VISAO MUDA COM A LISTA (CTRL+B) E COM A JANELA: REENCAIXA (SO ENTRE DOIS TAMANHOS REAIS, NAO AO ABRIR)
    let tamanhoPalco = null;
    new ResizeObserver(([entrada]) => {
        const { width, height } = entrada.contentRect;
        const antes = tamanhoPalco;
        tamanhoPalco = width && height ? { width, height } : null;
        if (antes && tamanhoPalco && (antes.width !== width || antes.height !== height) && !janela.hidden && dados) ajusta();
    }).observe(palco);

    function aplicaFoco() {
        janela.classList.toggle('focando', !!foco);
        for (const e of palco.querySelectorAll('[data-conversa]')) e.classList.toggle('esmaece', !!foco && e.dataset.conversa !== foco);
    }
    function aplicaBusca() {
        janela.classList.toggle('buscando', !!busca);
        for (const e of caixaCartoes.children) e.classList.toggle('nao-achado', !!busca && !(e.dataset.busca || '').includes(busca));
    }

    // GAVETA: A CONVERSA ESCOLHIDA POR INTEIRO; SO REESCREVE SE O CONTEUDO MUDOU, PRESERVANDO ROLAGEM E FOCO
    let htmlGaveta = '';
    function desenhaGaveta() {
        const c = dados && dados.conversas.find(x => x.id === selecionada);
        const gaveta = $('tkGaveta');
        if (!c) { gaveta.hidden = true; htmlGaveta = ''; return; }
        const p = progressoConversa(c), feitas = c.tarefas.filter(t => t.status === 'completed').length;
        const subs = (lista) => lista.map(s => `<div class="tk-sub ${escapa(s.status)}">${chipAgente(s)}<span title="${escapa(s.descricao)}">${escapa(s.descricao)}</span><small>${escapa(s.status)}</small></div>${s.tarefas.length ? `<ol class="passos">${s.tarefas.map(itemPasso).join('')}</ol>` : ''}`).join('');
        const novo = `<div class="cabeca-mapa"><h2>${escapa(c.titulo)}</h2><button class="fechar-mapa" data-tk-fecha-gaveta aria-label="Fechar">×</button></div>
            <div class="nota">${chipModelo(c.modelo)}<span>${escapa(c.nomeProjeto)}</span><span>·</span><span class="tk-sit-gaveta" style="color:${c.esperando ? 'var(--atencao)' : c.vivo ? 'var(--voce)' : 'var(--grafite)'}">${situacao(c)}</span></div>
            ${htmlAgora(c)}
            <div class="acoes"><button class="botao principal" data-tk-abrir>Abrir conversa</button></div>
            <div class="cabeca-plano"><span>Tarefas</span><span>${feitas} de ${c.tarefas.length} · ${Math.round(p * 100)}%</span></div>
            <div class="barra"><div style="width:${Math.round(p * 100)}%"></div></div>
            ${c.tarefas.map(t => `<ol class="passos">${itemPasso(t)}</ol>${subs(t.subagentes.filter(ativo))}`).join('') || '<p class="nota">Sem lista de tarefas.</p>'}
            ${c.subagentesSoltos.some(ativo) ? '<h4>Subagentes da conversa</h4>' + subs(c.subagentesSoltos.filter(ativo)) : ''}`;
        if (novo !== htmlGaveta) {
            const rolagem = gaveta.scrollTop, focado = document.activeElement && gaveta.contains(document.activeElement) ? [...gaveta.querySelectorAll('button')].indexOf(document.activeElement) : -1;
            gaveta.innerHTML = novo;
            htmlGaveta = novo;
            gaveta.scrollTop = rolagem;
            if (focado >= 0) { const b = gaveta.querySelectorAll('button')[focado]; if (b) b.focus(); }
        }
        gaveta.hidden = false;
    }
    $('tkGaveta').addEventListener('click', (ev) => {
        if (ev.target.closest('[data-tk-fecha-gaveta]')) { selecionada = null; $('tkGaveta').hidden = true; desenha(); return; }
        if (ev.target.closest('[data-tk-abrir]')) abreConversa(dados.conversas.find(x => x.id === selecionada));
    });

    // SINAIS: PULSO DE LUZ EM CAMADAS DO MESMO TRACEJADO COM A CABECA ALINHADA (HALO, CAUDA, NUCLEO), SEM FILTER
    // A TRILHA VAI DO PINO AO CARTAO: "IN" E "BACK" CORREM CONTRA O PATH, "OUT" E "SPAWN" A FAVOR
    const CAMADAS_PULSO = [
        { largura: 9, comprimento: 26, opacidade: .14 },
        { largura: 2.2, comprimento: 78, opacidade: .22 },
        { largura: 2.6, comprimento: 30, opacidade: .6 },
        { largura: 2, comprimento: 9, opacidade: 1, nucleo: true },
    ];
    const agenda = (fn, ms) => { const id = setTimeout(() => { temporizadores.delete(id); fn(); }, ms); temporizadores.add(id); return id; };
    const quadro = (fn) => { const id = requestAnimationFrame((t) => { quadros.delete(id); fn(t); }); quadros.add(id); return id; };
    function limpaPulsos() {
        temporizadores.forEach(clearTimeout); temporizadores = new Set();
        quadros.forEach(cancelAnimationFrame); quadros = new Set();
        gPulsos.textContent = '';
        emVoo.clear();
    }
    // PULSO NUMA TRILHA: A DA CONVERSA (PINO -> CARTAO) OU A DO AGENTE (CARTAO -> SUB-CARTAO).
    // "IN" E "BACK" CORREM CONTRA O PATH (RUMO A QUEM RECEBE), "OUT" E "SPAWN" A FAVOR
    function pulsa(elo, dir, cor, fonte) {
        if (!elo || !elo.d || !elo.trilha.isConnected || janela.hidden || document.visibilityState !== 'visible') return;
        const paraOrigem = dir === 'in' || dir === 'back';
        const conversa = elo.trilha.dataset.conversa;
        if (semMovimento()) { elo.trilha.classList.add('acesa'); agenda(() => elo.trilha.classList.remove('acesa'), 300); return; }
        if ((emVoo.get(fonte) || 0) >= MAX_PULSOS_TRILHA) return;
        emVoo.set(fonte, (emVoo.get(fonte) || 0) + 1);
        const len = elo.len || (elo.len = elo.trilha.getTotalLength()), trilha = elo.trilha, d = elo.d;
        const esmaece = foco && conversa !== foco ? ' esmaece' : '';
        const camadas = CAMADAS_PULSO.map(c => ({ ...c, el: el('path', {
            d, class: 'tk-pulso' + esmaece, 'data-conversa': conversa,
            stroke: c.nucleo ? `color-mix(in srgb, ${cor} 35%, var(--tk-nucleo))` : cor, 'stroke-width': c.largura, 'stroke-dasharray': `${c.comprimento} ${len * 2}`, opacity: 0,
        }, gPulsos) }));
        const inicio = performance.now();
        const suave = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
        const passo = (agora) => {
            const t = Math.min(1, (agora - inicio) / DURACAO_PULSO);
            const cabeca = paraOrigem ? len * (1 - suave(t)) : len * suave(t);
            const brilho = Math.min(1, t / .12, (1 - t) / .18);
            for (const c of camadas) {
                c.el.style.strokeDashoffset = paraOrigem ? -cabeca : c.comprimento - cabeca;
                c.el.style.opacity = c.opacidade * brilho;
            }
            if (t < 1) return quadro(passo);
            camadas.forEach(c => c.el.remove());
            emVoo.set(fonte, Math.max(0, (emVoo.get(fonte) || 1) - 1));
            if (trilha.isConnected) clarao(trilha.getPointAtLength(paraOrigem ? 0 : len), cor, esmaece);
        };
        quadro(passo);
    }
    const pulsaConversa = (c, dir) => pulsa(cartoesPorId.get(c.id), dir, dir === 'in' ? 'var(--voce)' : 'var(--tinta)', c.id + ':conversa');
    // SEM SUB-CARTAO (AGENTE JA SAIU DA TELA), O PULSO DO AGENTE CORRE NA TRILHA DA CONVERSA
    const pulsaAgente = (c, s, dir) => pulsa(subsPorId.get(s.id) || cartoesPorId.get(c.id), dir, tomPulso(s.modelo), c.id + ':' + s.id);
    // CLARAO CURTO ONDE O PULSO CHEGA (PINO DO CHIP OU BORDA DO CARTAO)
    function clarao(p, cor, esmaece) {
        const c = el('circle', { cx: p.x, cy: p.y, r: 4, fill: cor, class: 'tk-pulso' + esmaece }, gPulsos);
        c.style.transformOrigin = `${p.x}px ${p.y}px`;
        c.animate([{ transform: 'scale(.6)', opacity: .9 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 280, easing: 'ease-out' }).onfinish = () => c.remove();
    }
    function piscaAgente(s) {
        const u = subsPorId.get(s.id);
        if (!u) return;
        u.el.style.borderColor = tomPulso(s.modelo);
        agenda(() => { u.el.style.borderColor = ''; }, 350);
    }
    // TOCA SO O QUE CHEGOU DEPOIS DO ULTIMO POLL (POR seq), NA ORDEM E COM O ESPACAMENTO REAL (COMPRIMIDO EM ATE 2 S).
    // CHAVE NOVA (CONVERSA OU AGENTE QUE APARECEU AGORA) ANCORA EM agora-3s, COMO NO PRIMEIRO POLL
    function agendaPulsos() {
        if (!sinaisLigados() || janela.hidden) return;
        const agora = Date.parse(dados.agora) || Date.now();
        const fila = [], vistos = new Set();
        const novos = (chave, lista) => {
            vistos.add(chave);
            const ultimo = tocados.has(chave) ? tocados.get(chave) : agora - JANELA_PRIMEIRO_POLL_MS;
            const n = lista.filter(p => Date.parse(p.hora) > ultimo && (!p.seq || p.seq > ultimoSeq));
            tocados.set(chave, Math.max(ultimo, ...lista.map(p => Date.parse(p.hora))));
            return n;
        };
        for (const c of dados.conversas) {
            novos(c.id, c.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsaConversa(c, p.dir) }));
            for (const s of todosSubs(c)) {
                const marcos = [];
                if (s.inicio) marcos.push({ hora: s.inicio, dir: 'spawn' });
                if (s.fim) marcos.push({ hora: s.fim, dir: 'back' });
                novos(s.id + ':marcos', marcos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => pulsaAgente(c, s, p.dir) }));
                novos(s.id, s.pulsos).forEach(p => fila.push({ hora: Date.parse(p.hora), acao: () => { pulsaAgente(c, s, p.dir); piscaAgente(s); } }));
            }
        }
        for (const chave of [...tocados.keys()]) if (!vistos.has(chave)) tocados.delete(chave);
        ultimoSeq = Math.max(ultimoSeq, dados.seq || 0, ...dados.conversas.flatMap(c => [...c.pulsos, ...todosSubs(c).flatMap(s => s.pulsos)]).map(p => p.seq || 0));
        if (!fila.length) return;
        fila.sort((a, b) => a.hora - b.hora);
        const inicio = fila[0].hora, total = fila[fila.length - 1].hora - inicio, escala = total > LOTE_MAX_MS ? LOTE_MAX_MS / total : 1;
        fila.forEach(item => agenda(item.acao, (item.hora - inicio) * escala));
    }

    // FEED "AGORA": DIFERENCA ENTRE DOIS POLLS (TAREFAS COMPARADAS PELO TEXTO, NAO PELA POSICAO)
    function registraFeed() {
        if (anterior) {
            const antes = new Map(anterior.conversas.map(c => [c.id, c]));
            for (const c of dados.conversas) {
                const v = antes.get(c.id);
                if (!v) continue;
                const statusAntes = new Map(v.tarefas.map(t => [t.texto, t.status]));
                c.tarefas.forEach(t => { if (t.status === 'completed' && statusAntes.has(t.texto) && statusAntes.get(t.texto) !== 'completed') feed.unshift({ cor: 'var(--ok)', texto: `${cortaTexto(c.titulo, 22)} concluiu: ${t.texto}`, hora: Date.now() }); });
                const idsAntes = new Set(todosSubs(v).map(s => s.id));
                todosSubs(c).filter(s => !idsAntes.has(s.id)).forEach(s => feed.unshift({ cor: tomModelo(s.modelo), texto: `${s.tipo} abriu em ${cortaTexto(c.titulo, 28)}`, hora: Date.now() }));
                const ativosAgora = new Set(agentesAtivos(c).map(s => s.id));
                agentesAtivos(v).filter(s => !ativosAgora.has(s.id)).forEach(s => feed.unshift({ cor: tomModelo(s.modelo), texto: `${s.tipo} terminou em ${cortaTexto(c.titulo, 26)}`, hora: Date.now() }));
                if (c.esperando && !v.esperando) feed.unshift({ cor: 'var(--atencao)', texto: `${cortaTexto(c.titulo, 30)} fez uma pergunta`, hora: Date.now() });
                if (absorvida(c) && !absorvida(v)) feed.unshift({ cor: 'var(--grafite)', texto: `${cortaTexto(c.titulo, 30)} foi absorvida`, hora: Date.now() });
            }
            const idsAgora = new Set(dados.conversas.map(c => c.id));
            for (const v of anterior.conversas) {
                if (!idsAgora.has(v.id)) feed.unshift({ cor: 'var(--ok)', texto: `${cortaTexto(v.titulo, 34)} terminou`, hora: Date.now() });
            }
        }
        feed.splice(5);
        anterior = dados;
        const quando = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; };
        $('tkFeed').innerHTML = '<h4>Agora</h4>' + (feed.length ? feed.map(f => `<div><i style="background:${f.cor}"></i><span>${escapa(f.texto)}</span><small>${quando(f.hora)}</small></div>`).join('') : '<p>Nada ainda.</p>');
    }

    // POLLING SO COM A VISAO ABERTA E A JANELA VISIVEL; UMA REQUISICAO POR VEZ E RESPOSTA DESCARTADA SE A VISAO FECHOU
    async function busca304() {
        if (janela.hidden || document.visibilityState !== 'visible' || buscando) return;
        buscando = true;
        try {
            const r = await fetch('/api/tasks?desde=' + encodeURIComponent(hash) + '&seq=' + ultimoSeq, { cache: 'no-store' });
            if (janela.hidden) return;
            if (r.status === 304 || !r.ok) { if (!vista) ajusta(); desenhaSeMudou(); return; }
            const novo = await r.json();
            if (janela.hidden) return;
            dados = novo;
            hash = dados.hash;
            registraFeed();
            // POLL NO MEIO DE UM ARRASTE: O CARTAO NAO PODE VOLTAR; REDESENHA AO SOLTAR
            if (arrastoCartao) return;
            desenha();
            agendaPulsos();
        } catch (e) { /* SERVIDOR REINICIANDO: TENTA NO PROXIMO CICLO */ }
        finally { buscando = false; }
    }
    const botoesTasks = () => [document.getElementById('btnModoTasks'), document.querySelector('.trilho-lista [data-trilho="btnModoTasks"]')].filter(Boolean);
    function abre() {
        if (!janela.hidden) return;
        janela.hidden = false;
        botoesTasks().forEach(b => b.setAttribute('aria-pressed', 'true'));
        if (!vistaValida(vista)) vista = vistaValida(prefs.vista) ? prefs.vista : null;
        // DADOS JA EM MEMORIA (REABERTURA): DESENHA NA HORA, O POLL SO CONFIRMA (304) OU ATUALIZA
        if (dados) { desenha(); if (vista) aplicaVista(); }
        busca304();
        clearInterval(timer);
        timer = setInterval(busca304, INTERVALO_POLL);
    }
    function fecha() {
        janela.hidden = true;
        clearInterval(timer);
        timer = null;
        clearTimeout(cliqueTimer);
        limpaPulsos();
        botoesTasks().forEach(b => b.setAttribute('aria-pressed', 'false'));
    }
    const alterna = () => janela.hidden ? abre() : fecha();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') limpaPulsos(); });

    $('tkFiltros').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        prefs.filtro = b.dataset.f;
        gravaPrefs();
        vista = null;
        desenha();
    });
    $('tkModelos').addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        prefs.filtroModelo = prefs.filtroModelo === b.dataset.modelo ? null : b.dataset.modelo;
        gravaPrefs();
        vista = null;
        desenha();
    });
    $('tkBusca').addEventListener('input', (ev) => { busca = ev.target.value.trim().toLowerCase(); aplicaBusca(); });
    $('tkBusca').addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !busca || !vistaValida(vista)) return;
        const k = cartoesAtuais.find(x => (x.el.dataset.busca || '').includes(busca));
        if (!k) return;
        const caixa = palco.getBoundingClientRect();
        vista = { ...vista, x: caixa.width / 2 - (k.x + LARGURA_CARTAO / 2) * vista.k, y: caixa.height / 2 - (k.y + k.h / 2) * vista.k };
        aplicaVista();
    });
    $('tkSinais').addEventListener('click', () => { prefs.sinais = !sinaisLigados(); gravaPrefs(); localStorage.setItem('tasksSinais', prefs.sinais ? '1' : '0'); if (!prefs.sinais) limpaPulsos(); atualizaContadores(); });
    $('tkAbsorvidas').addEventListener('click', () => { prefs.absorvidas = !prefs.absorvidas; gravaPrefs(); vista = null; desenha(); });
    $('tkAjusta').addEventListener('click', ajusta);
    $('tkOrganiza').addEventListener('click', () => { fixas = { cartoes: {}, agentes: {}, chip: null }; gravaPosicoes(); vista = null; desenha(); });
    $('tkFecha').addEventListener('click', fecha);
    // ESC SO QUANDO A TASKS E A JANELA DE CIMA (UMA CONFIRMACAO DO APP, Z-INDEX MAIOR, FICA POR CIMA DELA)
    const temJanelaPorCima = () => [...document.querySelectorAll('.ajuda:not([hidden])')].some(e => (parseInt(getComputedStyle(e).zIndex, 10) || 0) >= 65);
    document.addEventListener('keydown', (ev) => {
        if (janela.hidden || temJanelaPorCima()) return;
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
        const limite = Date.now() - HORAS_SELO * 3600 * 1000, arquivadas = new Set((typeof dadosPainel !== 'undefined' && dadosPainel.arquivadas) || []);
        const recentes = (sessoes || []).filter(s => s.atualizado >= limite && !arquivadas.has(s.projeto + '/' + s.id) && (s.ativa || s.pergunta));
        const andamento = recentes.reduce((n, s) => n + (s.tarefasAndamento || 0), 0), trabalhando = recentes.some(s => s.ativa);
        for (const b of botoesTasks()) {
            const selo = b.querySelector('.selo-tasks'), ponto = b.querySelector('.ponto-tasks');
            if (selo) { selo.textContent = andamento; selo.hidden = !andamento; }
            if (ponto) ponto.hidden = !trabalhando;
            b.title = `Tasks: o chip e as tarefas de todas as conversas (Ctrl + Shift + T)${andamento ? ` · ${andamento} em andamento` : ''}${trabalhando ? ' · alguma conversa trabalhando' : ''}`;
        }
    }

    // ABRIR UMA CONVERSA PELA LISTA LATERAL FECHA A TASKS (COMPORTAMENTO DE ABA); ABERTURAS AUTOMATICAS
    // (NOTIFICACAO, PRIMEIRA SESSAO, ATALHO DE TECLADO) DEIXAM A VISAO COMO ESTA
    let cliqueNaLista = 0;
    const lista = document.getElementById('listaSessoes') || document.querySelector('.sessoes .lista');
    if (lista) {
        lista.addEventListener('pointerdown', () => { cliqueNaLista = Date.now(); }, true);
        lista.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') cliqueNaLista = Date.now(); }, true);
    }
    const abreSessaoOriginal = window.abreSessao;
    if (typeof abreSessaoOriginal === 'function') window.abreSessao = function (...args) { if (!janela.hidden && Date.now() - cliqueNaLista < 1500) fecha(); return abreSessaoOriginal.apply(this, args); };

    window.abreTasks = abre;
    window.fechaTasks = fecha;
    window.tasksAlterna = alterna;
    window.tasksAtualizaSelo = atualizaSelo;
    botoesTasks().forEach(b => { if (b.id === 'btnModoTasks') b.addEventListener('click', alterna); });
})();
