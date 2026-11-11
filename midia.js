// Player do rodapé: o que está tocando no Windows (Spotify, YouTube no navegador...) pelos controles de mídia do sistema.
// Um PowerShell só (midia.ps1) fica ligado enquanto a tela pergunta; 60 s sem perguntar, ele é desligado.
const { spawn } = require('child_process');
const path = require('path');

const COMANDOS = ['alternar', 'proxima', 'anterior'];
let ultimoErro = '';
let proc = null, estado = { nada: true, versao: 0 }, capa = null, versaoCapa = 0, ultimoUso = 0, timerOcioso = null, falhas = 0, esperaReligar = 0;
// Cada mudança ganha um número; quem pediu com o número antigo é respondido na hora
let versao = 0;
const esperando = new Set();
function mudou(novo) {
    estado = { ...novo, versao: ++versao };
    for (const fn of esperando) fn();
    esperando.clear();
}

function liga() {
    if (proc || process.platform !== 'win32' || Date.now() < esperaReligar) return;
    const meu = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'midia.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc = meu;
    let resto = '';
    meu.stdout.setEncoding('utf8');
    meu.stdout.on('data', (pedaco) => {
        if (proc !== meu) return;
        const linhas = (resto + pedaco).split(/\r?\n/);
        resto = linhas.pop();
        for (const linha of linhas) {
            if (!linha.trim()) continue;
            let o;
            try { o = JSON.parse(linha); } catch (e) { continue; }
            falhas = 0;
            // Erro novo do script (ex.: serviço de mídia do Windows sem resposta): vai para o servidor.log uma vez
            if (o.erro && o.erro !== ultimoErro) console.log('player: ' + (o.erro === 'servico' ? 'o serviço de mídia do Windows não respondeu (reiniciar o Windows Explorer costuma resolver)' : o.erro));
            ultimoErro = o.erro || '';
            // Capa só vem quando a música muda ('' = música sem capa)
            if (typeof o.capa === 'string') { capa = o.capa ? Buffer.from(o.capa, 'base64') : null; versaoCapa++; }
            delete o.capa;
            mudou({ ...o, capa: capa ? versaoCapa : 0, lidoEm: Date.now() });
        }
    });
    const morreu = () => {
        if (proc !== meu) return;
        proc = null;
        // Caiu sozinho: tenta de novo mais tarde (cada falha seguida espera mais, até 5 min)
        if (Date.now() - ultimoUso < 60000) { falhas++; esperaReligar = Date.now() + Math.min(300000, 5000 * 2 ** (falhas - 1)); }
    };
    meu.on('exit', morreu);
    meu.on('error', morreu);
    meu.stdin.on('error', () => { /* processo já fechou */ });
}
function desliga() {
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.stdin.end(); } catch (e) { /* já fechado */ }
    setTimeout(() => { try { p.kill(); } catch (e) { /* já saiu */ } }, 3000);
    mudou({ nada: true });
}
function usado() {
    ultimoUso = Date.now();
    liga();
    clearTimeout(timerOcioso);
    timerOcioso = setTimeout(desliga, 60000);
    timerOcioso.unref();
}
function le() { usado(); return estado; }
// Responde quando o estado mudar desde a versão que a tela tem (ou ao fim do prazo, com o mesmo estado)
function espera(versaoTela, prazo) {
    usado();
    if (Number(versaoTela) !== estado.versao) return Promise.resolve(estado);
    return new Promise((resolve) => {
        const fim = () => { clearTimeout(t); esperando.delete(fim); resolve(estado); };
        const t = setTimeout(fim, prazo);
        esperando.add(fim);
    });
}
function comando(acao) {
    if (!COMANDOS.includes(acao)) throw new Error('Comando de mídia inválido.');
    usado();
    if (!proc) throw new Error('O player do Windows não está disponível agora.');
    proc.stdin.write(acao + '\n');
}
function capaAtual() { return capa; }

module.exports = { le, espera, comando, capaAtual, desliga };
