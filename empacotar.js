// Gera o Red Code portátil: dist/Red Code/Red Code.exe (+ um .zip dele), a partir do Electron já
// instalado em node_modules. Não baixa nada. Uso: npm install (uma vez) e depois npm run empacotar
//
// O exe roda o servidor no próprio Node do Electron (o PC não precisa ter Node instalado) e guarda
// dados e logs em %APPDATA%\Red Code. A pasta "Red Code" pode ficar em qualquer lugar (ex.: Documentos).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = __dirname;
const DIST = path.join(RAIZ, 'dist');
const DESTINO = path.join(DIST, 'Red Code');
const ELECTRON = path.join(RAIZ, 'node_modules', 'electron', 'dist');
const pacote = require('./package.json');

// Só o código do app. Dados pessoais (dados.json, anexos/), testes, logs e afins ficam de fora.
const ARQUIVOS_RAIZ = fs.readdirSync(RAIZ).filter(a => /\.(js|html|svg)$/.test(a) && a !== 'empacotar.js');
const ARQUIVOS_DESKTOP = fs.readdirSync(path.join(RAIZ, 'desktop')).filter(a => a.endsWith('.js'));

function passo(texto) { console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${texto}`); }

// Dependências de produção (e as delas), lidas dos package.json: sem o Electron e o que só serve
// para desenvolver. Opcionais que não estão instaladas (de outro sistema) são puladas.
function dependenciasDeProducao() {
    const vistas = new Set();
    const fila = Object.keys(pacote.dependencies || {});
    while (fila.length) {
        const nome = fila.shift();
        if (vistas.has(nome)) continue;
        const pasta = path.join(RAIZ, 'node_modules', nome);
        if (!fs.existsSync(path.join(pasta, 'package.json'))) continue;
        vistas.add(nome);
        const p = JSON.parse(fs.readFileSync(path.join(pasta, 'package.json'), 'utf8'));
        fila.push(...Object.keys(p.dependencies || {}), ...Object.keys(p.optionalDependencies || {}));
    }
    return [...vistas];
}

function principal() {
    if (!fs.existsSync(path.join(ELECTRON, 'electron.exe'))) throw new Error('Electron não encontrado em node_modules. Rode "npm install" antes.');
    passo('Limpando dist/Red Code');
    try { fs.rmSync(DESTINO, { recursive: true, force: true }); }
    catch (e) { throw new Error('Não consegui apagar dist/Red Code: feche o Red Code que está rodando de lá e tente de novo.\n' + e.message); }

    passo('Copiando o Electron');
    fs.cpSync(ELECTRON, DESTINO, { recursive: true });
    fs.renameSync(path.join(DESTINO, 'electron.exe'), path.join(DESTINO, 'Red Code.exe'));
    fs.rmSync(path.join(DESTINO, 'resources', 'default_app.asar'), { force: true });

    passo('Copiando o app');
    const app = path.join(DESTINO, 'resources', 'app');
    fs.mkdirSync(path.join(app, 'desktop'), { recursive: true });
    for (const a of ARQUIVOS_RAIZ) fs.copyFileSync(path.join(RAIZ, a), path.join(app, a));
    for (const a of ARQUIVOS_DESKTOP) fs.copyFileSync(path.join(RAIZ, 'desktop', a), path.join(app, 'desktop', a));
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
        name: 'red-code', productName: 'Red Code', version: pacote.version,
        main: 'desktop/main.js', dependencies: pacote.dependencies,
    }, null, 2));

    const deps = dependenciasDeProducao();
    passo(`Copiando ${deps.length} pacotes de produção`);
    for (const nome of deps) fs.cpSync(path.join(RAIZ, 'node_modules', nome), path.join(app, 'node_modules', nome), { recursive: true });
    // O editor só usa monaco-editor/min (server.js): as outras builds (~77 MB) ficam de fora
    for (const sobra of ['dev', 'esm']) fs.rmSync(path.join(app, 'node_modules', 'monaco-editor', sobra), { recursive: true, force: true });

    passo('Compactando dist/RedCode-portatil-win64.zip');
    const zip = path.join(DIST, 'RedCode-portatil-win64.zip');
    fs.rmSync(zip, { force: true });
    // tar do Windows (10+) grava .zip com -a
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', DIST, 'Red Code'], { stdio: 'inherit' });
    const mb = (n) => (n / 1024 / 1024).toFixed(0) + ' MB';
    passo(`Pronto: ${DESTINO}\\Red Code.exe  |  zip: ${mb(fs.statSync(zip).size)}`);
}

try { principal(); } catch (e) { console.error('\nERRO: ' + e.message); process.exit(1); }
