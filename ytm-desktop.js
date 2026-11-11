// Integração YouTube Music Desktop (ytmdesktop v2): o vídeo vem do Companion Server dele (http://127.0.0.1:9863) e é
// entregue ao videoNavegador.recebe() como mais uma aba (aba = -9863). Liga e desliga pela aba Integrações.
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:9863';
const APP = { appId: 'redcode_painel', appName: 'Red Code', appVersion: '1.0.0' };
const ABA = -9863;

let arquivoToken = null, recebe = null, token = '', ultimoId = '', pareandoAte = 0, ultimoErro = '';
// O que a tela do vídeo mostra: '' = nada a fazer (pareado, ou o app nem está aberto)
let aviso = '', respondeuEm = 0, ligado = false, timerCiclo = null, rodada = 0;

function configura(pastaDados, fnRecebe) {
    arquivoToken = path.join(pastaDados, 'ytm-desktop.json');
    recebe = fnRecebe;
    try { token = String(JSON.parse(fs.readFileSync(arquivoToken, 'utf8')).token || ''); } catch (e) { token = ''; }
}
const jaPareou = () => !!token;
// Para a tela: o app respondeu há pouco? e o que falta para o vídeo chegar
const estado = () => ({ ligado, aberto: ligado && Date.now() - respondeuEm < 15000, pareado: !!token, aviso });

function liga() {
    if (ligado) return;
    ligado = true;
    pareandoAte = 0;
    timerCiclo = setTimeout(ciclo, 500, ++rodada);
}
function desliga() {
    ligado = false;
    rodada++;
    clearTimeout(timerCiclo);
    aviso = '';
    some();
}

function loga(msg) { if (msg !== ultimoErro) { ultimoErro = msg; console.log('ytm desktop: ' + msg); } }

async function pede(metodo, rota, corpo, prazo) {
    const r = await fetch(BASE + rota, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(prazo || 3000),
    });
    respondeuEm = Date.now();
    let dados = null;
    try { dados = await r.json(); } catch (e) { }
    return { status: r.status, dados };
}

function some() {
    if (!ultimoId) return;
    ultimoId = '';
    try { recebe({ aba: ABA, fim: true }); } catch (e) { }
}

// DESATIVADO OU RELIGADO DURANTE UM AWAIT: A RESPOSTA ANTIGA E DESCARTADA
const valeAinda = (minhaRodada) => ligado && minhaRodada === rodada;

async function pareia(minhaRodada) {
    if (Date.now() < pareandoAte) return 15000;
    const c = await pede('POST', '/api/v1/auth/requestcode', APP);
    if (!valeAinda(minhaRodada)) return 15000;
    if (c.status === 403) { aviso = 'ligue "Enable companion authorization" no app (Settings › Integrations) para parear'; loga(aviso); return 15000; }
    if (c.status !== 200 || !c.dados || !c.dados.code) { aviso = 'o app recusou o pareamento (' + c.status + ')'; loga(aviso); return 30000; }
    aviso = 'aprove o Red Code no YouTube Music Desktop (código ' + c.dados.code + ')';
    loga(aviso);
    const t = await pede('POST', '/api/v1/auth/request', { appId: APP.appId, code: c.dados.code }, 60000).catch(() => ({ status: 0 }));
    if (!valeAinda(minhaRodada)) return 15000;
    if (t.status !== 200 || !t.dados || !t.dados.token) { pareandoAte = Date.now() + 10 * 60e3; aviso = 'pareamento não aprovado; tento de novo em 10 min'; loga(aviso); return 15000; }
    token = String(t.dados.token);
    fs.writeFileSync(arquivoToken, JSON.stringify({ token }));
    aviso = '';
    loga('pareado');
    return 500;
}

function entrega(s) {
    const v = s && s.video, p = (s && s.player) || {};
    if (!v || !/^[\w-]{11}$/.test(String(v.id || ''))) return some();
    const fila = p.queue && Array.isArray(p.queue.items) ? p.queue.items : [];
    const i = p.queue ? Number(p.queue.selectedItemIndex) : -1;
    const proximos = i >= 0 ? fila.slice(i + 1, i + 5).map(x => String(x.videoId || '')).filter(x => /^[\w-]{11}$/.test(x)) : [];
    ultimoId = v.id;
    recebe({
        aba: ABA, id: v.id, tempo: Number(p.videoProgress) || 0, duracao: Number(v.durationSeconds) || 0,
        pausado: p.trackState !== 1, esperando: p.trackState === 2, anuncio: !!p.adPlaying, taxa: 1,
        titulo: [v.title, v.author].filter(Boolean).join(' - '), site: 'YouTube Music Desktop',
        // videoType 0 = só áudio: a tela mostra o aviso de "Só música" em vez do vídeo
        modo: Number(v.videoType) === 0 ? 'ATV_PREFERRED' : 'OMV_PREFERRED',
        proximos, quando: Date.now(),
    });
}

async function passo(minhaRodada) {
    if (!token) return pareia(minhaRodada);
    const s = await pede('GET', '/api/v1/state');
    if (!valeAinda(minhaRodada)) return 5000;
    if (s.status === 401 || s.status === 403) { token = ''; try { fs.unlinkSync(arquivoToken); } catch (e) { } loga('token recusado, pareando de novo'); some(); return 2000; }
    if (s.status === 429) return 2000;
    if (s.status !== 200) { loga('estado respondeu ' + s.status); return 5000; }
    ultimoErro = '';
    aviso = '';
    entrega(s.dados);
    return 1000;
}

async function ciclo(minhaRodada) {
    let espera = 5000;
    try { espera = await passo(minhaRodada); }
    // Porta fechada: o app não está aberto (ou o Companion server está desligado); sem aviso na tela, só no log
    catch (e) { some(); espera = 5000; aviso = ''; loga('sem resposta na porta 9863: YTM Desktop fechado ou Companion server desligado'); }
    if (minhaRodada !== rodada) return;
    timerCiclo = setTimeout(ciclo, espera, minhaRodada);
}

module.exports = { configura, estado, jaPareou, liga, desliga };
