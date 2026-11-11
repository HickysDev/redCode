// Vídeo no canto: o video-nativo (aba selecionada de cada navegador) e os players externos avisam qual vídeo do
// YouTube toca e em que segundo; o Red Code toca uma cópia muda dele (player do YouTube ou, se o vídeo não deixa incorporar, o endereço
// direto só do vídeo, tirado pelo yt-dlp). Nada de ler a tela.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const abas = new Map();   // aba do navegador -> último estado recebido
// SUMIR POR UM CICLO (FALHA DE LEITURA) E VOLTAR IGUAL NAO PODE CONTAR COMO MUDANCA E ROUBAR O CANTO
const sumidas = new Map();

function recebe(c) {
    const aba = Number(c.aba);
    if (!Number.isFinite(aba)) throw new Error('Aba inválida.');
    if (c.fim) { if (abas.has(aba)) sumidas.set(aba, { ...abas.get(aba), sumiuEm: Date.now() }); abas.delete(aba); return; }
    const id = String(c.id || '');
    if (id && !/^[\w-]{11}$/.test(id)) throw new Error('Vídeo inválido.');
    // Vídeo novo numa aba: já pede o endereço direto (fica em cache) para a opção B entrar sem esperar o yt-dlp
    const sumida = sumidas.get(aba);
    sumidas.delete(aba);
    const antes = abas.get(aba) || (sumida && Date.now() - sumida.sumiuEm < 30000 ? sumida : undefined);
    if (id && (!antes || antes.id !== id) && caminhoYtdlp()) urlDoVideo(id).catch(() => { });
    // Próximas da fila: já busca o endereço, para a troca de música no B ser na hora
    if (Array.isArray(c.proximos) && caminhoYtdlp()) for (const p of c.proximos.slice(0, 4)) if (/^[\w-]{11}$/.test(String(p))) buscaAntes(String(p));
    const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
    const recebidoEm = Number(c.quando) > 0 && Math.abs(Date.now() - Number(c.quando)) < 5000 ? Math.min(Date.now(), Number(c.quando)) : Date.now();
    const tempo = num(c.tempo, 1e7), pausado = !!c.pausado;
    const esperado = antes ? antes.tempo + (antes.pausado ? 0 : (recebidoEm - antes.recebidoEm) / 1000 * antes.taxa) : 0;
    // SINAL REPETIDO NAO CONTA COMO MUDANCA: SENAO DUAS FONTES PAUSADAS SE REVEZAM NO CANTO
    const mudou = !antes || antes.id !== id || antes.pausado !== pausado || Math.abs(tempo - esperado) > 3;
    abas.set(aba, {
        aba, id, tempo, duracao: num(c.duracao, 1e7), pausado, taxa: num(c.taxa, 16) || 1,
        titulo: String(c.titulo || '').slice(0, 300), site: String(c.site || '').slice(0, 60), modo: String(c.modo || '').slice(0, 40),
        anuncio: !!c.anuncio, esperando: !!c.esperando, folga: num(c.folga, 2),
        proximos: Array.isArray(c.proximos) ? c.proximos.slice(0, 4).map(String) : [],
        // Momento da leitura na página (se o relógio bate): a conta do tempo parte dele, sem o atraso do envio
        recebidoEm, mudouEm: mudou ? recebidoEm : antes.mudouEm,
    });
}
// O vídeo a mostrar: o que começou a tocar por último; sem nenhum tocando, o que mudou de estado por último
function atual() {
    const agora = Date.now();
    for (const [aba, e] of abas) if (agora - e.recebidoEm > 6 * 3600e3) abas.delete(aba);
    for (const [aba, e] of sumidas) if (agora - e.sumiuEm > 30000) sumidas.delete(aba);
    const lista = [...abas.values()].filter(e => e.id);
    // Tocando sem avisar há 15 s: a aba travou ou foi descarregada; não conta como tocando
    const tocando = lista.filter(e => !e.pausado && agora - e.recebidoEm < 15000).sort((a, b) => b.mudouEm - a.mudouEm);
    const escolhido = tocando[0] || lista.sort((a, b) => b.mudouEm - a.mudouEm)[0] || null;
    // urlPronta: o endereço direto já está no cache (a cópia pode ir direto para o B, sem passar pelo A)
    const c = escolhido && cacheUrls.get(escolhido.id);
    const video = escolhido ? { ...escolhido, urlPronta: !!(c && agora - c.em < 3 * 3600e3) } : null;
    return { agora, video };
}

// ---------- yt-dlp (opção B): endereço direto só do vídeo, para os vídeos que não deixam incorporar ----------
let PASTA_BIN = null;
const configura = (pastaDados) => { PASTA_BIN = path.join(pastaDados, 'bin'); };
const caminhoYtdlp = () => (PASTA_BIN && fs.existsSync(path.join(PASTA_BIN, 'yt-dlp.exe'))) ? path.join(PASTA_BIN, 'yt-dlp.exe') : null;
const cacheUrls = new Map();   // id -> { url, em }
// Busca antecipada: duas de cada vez (cada uma leva ~4 s), sem repetir o que já está no cache ou na espera
const esperaBusca = [], buscando = new Set();
const BUSCAS_JUNTAS = 2;
function buscaAntes(id) {
    const c = cacheUrls.get(id);
    if ((c && Date.now() - c.em < 3 * 3600e3) || buscando.has(id) || esperaBusca.includes(id)) return;
    esperaBusca.push(id);
    if (esperaBusca.length > 8) esperaBusca.shift();
    if (buscando.size < BUSCAS_JUNTAS) proximaBusca();
}
function proximaBusca() {
    const id = esperaBusca.shift();
    if (!id) return;
    buscando.add(id);
    urlDoVideo(id).catch(() => { }).finally(() => { buscando.delete(id); proximaBusca(); });
}
const emCurso = new Map();   // id -> busca do yt-dlp em andamento (quem pede o mesmo id espera a mesma)
function urlDoVideo(id) {
    if (!/^[\w-]{11}$/.test(String(id))) return Promise.reject(new Error('Vídeo inválido.'));
    const c = cacheUrls.get(id);
    // O endereço do YouTube vence em ~6 h: usa por 3 h
    if (c && Date.now() - c.em < 3 * 3600e3) return Promise.resolve(c.url);
    const exe = caminhoYtdlp();
    if (!exe) return Promise.reject(Object.assign(new Error('O yt-dlp não está instalado.'), { codigo: 'sem-ytdlp' }));
    if (emCurso.has(id)) return emCurso.get(id);
    const busca = new Promise((resolve, rejeita) => {
        // Só o vídeo (sem áudio: a cópia é muda), até 720p
        execFile(exe, ['-g', '--no-playlist', '--no-warnings', '-f', 'bv*[height<=720]/b[height<=720]/bv*/b', 'https://www.youtube.com/watch?v=' + id], { timeout: 45000, windowsHide: true }, (erro, saida, saidaErro) => {
            const url = String(saida || '').split(/\r?\n/).find(l => /^https?:\/\//.test(l));
            if (erro || !url) return rejeita(new Error('O yt-dlp não conseguiu o vídeo: ' + String(saidaErro || (erro && erro.message) || '').trim().split(/\r?\n/).pop().slice(0, 200)));
            cacheUrls.set(id, { url, em: Date.now() });
            if (cacheUrls.size > 50) cacheUrls.delete(cacheUrls.keys().next().value);
            resolve(url);
        });
    });
    emCurso.set(id, busca);
    busca.catch(() => { }).finally(() => emCurso.delete(id));
    return busca;
}
// Baixa o yt-dlp oficial (GitHub do projeto) para a pasta de dados do Red Code. Só quando a pessoa clica em instalar
async function instalaYtdlp() {
    if (!PASTA_BIN) throw new Error('Pasta de dados não configurada.');
    fs.mkdirSync(PASTA_BIN, { recursive: true });
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error('Não deu para baixar o yt-dlp (' + r.status + ').');
    const destino = path.join(PASTA_BIN, 'yt-dlp.exe');
    fs.writeFileSync(destino + '.novo', Buffer.from(await r.arrayBuffer()));
    fs.renameSync(destino + '.novo', destino);
    return destino;
}

module.exports = { recebe, atual, configura, caminhoYtdlp, urlDoVideo, instalaYtdlp };
