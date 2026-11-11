// Atualização ao abrir o Red Code.
// Pelo código (git clone): git fetch + pull --ff-only antes de subir o servidor. Só com a pasta limpa (alteração
// sua não commitada = não puxa) e só avançando (sem merge). Dependências mudaram: npm install.
// Pelo exe: confere a última release do GitHub; versão nova: pergunta, baixa o zip e troca a pasta do programa
// quando o app fecha (os dados ficam em %APPDATA%\Red Code e não são tocados).
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const REPO = 'HickysDev/redCode';
// Git e npm nunca abrem janela de login/pergunta: sem rede ou sem acesso, só não atualiza
const ENV_QUIETO = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

function roda(exe, args, cwd, tempo) {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { cwd, env: ENV_QUIETO, timeout: tempo, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: /\.cmd$/i.test(exe) }, (erro, saida, saidaErro) => {
            if (erro) { erro.message += ' ' + String(saidaErro || '').trim(); return reject(erro); }
            resolve(String(saida).trim());
        });
    });
}

// ---------- Pelo código ----------
// O package-lock.json muda sozinho (npm install com outra versão do npm) e travava o pull para sempre: se ele é a
// única alteração local, volta ao do git. Devolve o que ainda está alterado ('' = pasta limpa)
async function alteracoesLocais(git, log) {
    let status = await git(['status', '--porcelain', '--untracked-files=no']).catch(() => 'erro');
    const arquivos = status.split(/\r?\n/).filter(Boolean).map(l => l.trim().replace(/^\S+\s+/, ''));
    if (arquivos.length && arquivos.every(a => a === 'package-lock.json')) {
        try { await git(['checkout', '--', 'package-lock.json']); if (log) log('package-lock.json alterado localmente: restaurado para puxar'); status = ''; }
        catch (e) { if (log) log('não deu para restaurar o package-lock.json: ' + e.message.slice(0, 160)); }
    }
    return status;
}
async function pelaFonte(pasta, log) {
    const git = (args, tempo = 15000) => roda('git', ['-C', pasta, ...args], pasta, tempo);
    try { await git(['rev-parse', '--is-inside-work-tree']); } catch (e) { return { motivo: 'não é um clone do git' }; }
    const locais = await alteracoesLocais(git, log);
    if (locais) return { motivo: 'há alterações locais (não puxa para não mexer nelas): ' + locais.split(/\r?\n/).map(l => l.trim().replace(/^\S+\s+/, '')).slice(0, 5).join(', ') };
    try { await git(['rev-parse', '--abbrev-ref', '@{u}']); } catch (e) { return { motivo: 'a branch não segue nenhuma do GitHub' }; }
    try { await git(['fetch', '--quiet'], 20000); } catch (e) { return { motivo: 'sem acesso ao GitHub agora' }; }
    const faltam = Number(await git(['rev-list', '--count', 'HEAD..@{u}']).catch(() => '0')) || 0;
    if (!faltam) return { motivo: 'já está na última versão' };
    const antes = await git(['rev-parse', 'HEAD']);
    try { await git(['pull', '--ff-only', '--quiet'], 60000); } catch (e) { return { motivo: 'o pull não deu (' + e.message.slice(0, 160) + ')' }; }
    const mudou = (await git(['diff', '--name-only', antes, 'HEAD']).catch(() => '')).split(/\r?\n/).filter(Boolean);
    log(`atualizado pelo git: ${faltam} commit(s) novo(s)`);
    let dependencias = false;
    if (mudou.some(a => /^package(-lock)?\.json$/.test(a))) {
        log('package.json mudou: npm install');
        try { await roda(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], pasta, 10 * 60000); dependencias = true; }
        catch (e) { log('npm install falhou: ' + e.message.slice(0, 300)); }
    }
    // O app desktop já está carregado: se ele mudou, precisa reabrir para valer
    return { atualizou: true, commits: faltam, dependencias, desktopMudou: mudou.some(a => a.startsWith('desktop/')) };
}

// Só confere (sem puxar): quantos commits novos há no GitHub; 0 se a pasta tem alteração local ou sem rede
async function atrasoFonte(pasta) {
    const git = (args, tempo = 15000) => roda('git', ['-C', pasta, ...args], pasta, tempo);
    try {
        if (await alteracoesLocais(git)) return 0;
        await git(['rev-parse', '--abbrev-ref', '@{u}']);
        await git(['fetch', '--quiet'], 20000);
        return Number(await git(['rev-list', '--count', 'HEAD..@{u}'])) || 0;
    } catch (e) { return 0; }
}

// ---------- Pelo exe (releases do GitHub) ----------
function pedeJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'red-code', Accept: 'application/vnd.github+json' }, timeout: 10000 }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return pedeJson(r.headers.location).then(resolve, reject); }
            if (r.statusCode !== 200) { r.resume(); return reject(new Error('GitHub respondeu ' + r.statusCode)); }
            let corpo = '';
            r.setEncoding('utf8');
            r.on('data', (p) => { corpo += p; });
            r.on('end', () => { try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); } });
        });
        req.on('timeout', () => req.destroy(new Error('sem resposta do GitHub')));
        req.on('error', reject);
    });
}
function baixa(url, destino, progresso, voltas = 0) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'red-code' }, timeout: 30000 }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && voltas < 5) { r.resume(); return baixa(r.headers.location, destino, progresso, voltas + 1).then(resolve, reject); }
            if (r.statusCode !== 200) { r.resume(); return reject(new Error('download respondeu ' + r.statusCode)); }
            const total = Number(r.headers['content-length']) || 0;
            let feito = 0;
            const arq = fs.createWriteStream(destino);
            r.on('data', (p) => { feito += p.length; if (total) progresso(feito / total); });
            r.pipe(arq);
            arq.on('finish', () => arq.close(() => resolve()));
            arq.on('error', reject);
            r.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('download parado')));
        req.on('error', reject);
    });
}
const numeros = (v) => String(v).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
function maisNova(a, b) {
    const x = numeros(a), y = numeros(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
}
// Procura versão nova; não baixa nada
async function releaseNova(versaoAtual) {
    const r = await pedeJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const versao = String(r.tag_name || '').replace(/^v/i, '');
    if (!versao || !maisNova(versao, versaoAtual)) return null;
    const zip = (r.assets || []).find(a => /portatil.*\.zip$/i.test(a.name));
    if (!zip) return null;
    return { versao, url: zip.browser_download_url, tamanho: zip.size, notas: String(r.body || '').slice(0, 1500), pagina: r.html_url };
}
// Versão do package.json na main do GitHub (o que está lá no git, já publicado em release ou não)
async function versaoGithub() {
    const r = await pedeJson(`https://raw.githubusercontent.com/${REPO}/main/package.json?t=${Date.now()}`);
    return String(r.version || '');
}
// Baixa e extrai; devolve a pasta "Red Code" nova pronta para copiar por cima da atual
async function preparaRelease(info, pastaDados, progresso, log) {
    const pasta = path.join(pastaDados, 'atualizacao');
    fs.rmSync(pasta, { recursive: true, force: true });
    fs.mkdirSync(pasta, { recursive: true });
    const zip = path.join(pasta, `RedCode-${info.versao}.zip`);
    log(`baixando a versão ${info.versao}`);
    await baixa(info.url, zip, progresso);
    const extraido = path.join(pasta, 'novo');
    fs.mkdirSync(extraido, { recursive: true });
    await roda(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extraido], pasta, 10 * 60000);
    const novo = path.join(extraido, 'Red Code');
    if (!fs.existsSync(path.join(novo, 'Red Code.exe'))) throw new Error('o zip baixado não tem o Red Code.exe');
    fs.rmSync(zip, { force: true });
    return novo;
}
// Depois que o app fechar: copia a pasta nova por cima da do programa e (se pedido) abre de novo
function aplicaAoSair(novo, pastaApp, exe, reabrir, pastaDados) {
    const script = path.join(pastaDados, 'atualizacao', 'aplica.ps1');
    fs.writeFileSync(script, [
        'param([string]$De, [string]$Para, [string]$Exe, [string]$Abrir)',
        '# Espera todo processo do Red Code daquela pasta fechar (a janela e o servidor)',
        '$limite = (Get-Date).AddMinutes(2)',
        'while ((Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Para, [StringComparison]::OrdinalIgnoreCase) }) -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }',
        'Start-Sleep -Seconds 1',
        'robocopy $De $Para /E /IS /IT /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null',
        'Remove-Item -LiteralPath (Split-Path $De -Parent) -Recurse -Force -ErrorAction SilentlyContinue',
        "if ($Abrir -eq '1') { Start-Process -FilePath $Exe }",
    ].join('\r\n'), 'ascii');
    // Por meio do start: o script se desprende do Red Code (senão pode morrer junto quando ele fecha)
    spawn('cmd.exe', ['/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-De', novo, '-Para', pastaApp, '-Exe', exe, '-Abrir', reabrir ? '1' : '0'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { pelaFonte, atrasoFonte, releaseNova, versaoGithub, preparaRelease, aplicaAoSair, maisNova };
