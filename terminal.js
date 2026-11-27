// Terminal de verdade (PowerShell, Git Bash ou CMD) para a página, por WebSocket.
// É o que o navegador sozinho não faz: um console na pasta do projeto, com php, git, npm...
// Segurança: só aceita conexão da própria página (Host e Origin locais + token secreto que
// vai no HTML; outro site não consegue ler o HTML por causa do CORS) e só em pastas conhecidas.
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const os = require('os');

const MAXIMO = 8;
const abertos = new Set();

function liga(servidorHttp, { porta, token, pastaPermitida, envDaConversa, servidorRemoto }) {
    const hostsOk = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    servidorHttp.on('upgrade', (req, socket, cabeca) => {
        const recusa = (motivo) => { socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); console.log('terminal recusado:', motivo); };
        let url;
        try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return recusa('url'); }
        if (url.pathname !== '/ws/terminal') return recusa('caminho');
        const host = req.headers.host || '';
        if (!hostsOk.has(host)) return recusa('host');                     // contra DNS rebinding
        const origem = req.headers.origin || '';
        if (origem !== `http://${host}`) return recusa('origem');
        if (url.searchParams.get('token') !== token) return recusa('token');
        // Terminal num servidor remoto (ssh -t): a pasta é de lá; aqui o pty roda na pasta do usuário
        const idRemoto = url.searchParams.get('remoto');
        let remotoTerminal = null;
        if (idRemoto) {
            const servidorR = servidorRemoto && servidorRemoto(idRemoto);
            if (!servidorR) return recusa('servidor remoto');
            const pastaR = url.searchParams.get('pastaRemota') || servidorR.pastaPadrao;
            try { remotoTerminal = require('./remoto').argsTerminal(servidorR, pastaR, url.searchParams.get('loginRemoto') === '1'); } catch (e) { return recusa('remoto: ' + e.message); }
        }
        const cwd = remotoTerminal ? os.homedir() : (url.searchParams.get('cwd') || os.homedir());
        if (!remotoTerminal && !pastaPermitida(cwd)) return recusa('pasta');
        if (abertos.size >= MAXIMO) return recusa('limite');
        // Login de uma conta do Claude (Configurações › Perfis): a página manda só o id; o servidor monta o env
        let login = null;
        const pedidoLogin = url.searchParams.get('login');
        if (pedidoLogin) {
            const m = /^claude:([a-z0-9-]{1,32})$/.exec(pedidoLogin);
            const pasta = m && require('./perfis').pastaDaConta(m[1]);
            if (!pasta) return recusa('login');
            if (!require('fs').existsSync(CLAUDE_EXE)) return recusa('login: claude.exe do SDK não encontrado em ' + CLAUDE_EXE);
            // Conta padrão: sem CLAUDE_CONFIG_DIR (apontar para ~/.claude faria o Claude procurar o .claude.json no lugar errado)
            login = m[1] === 'padrao' ? { __sem: ['CLAUDE_CONFIG_DIR'] } : { CLAUDE_CONFIG_DIR: pasta };
        }
        // Terminal de uma conversa: o servidor monta o env dela (conta + identidade do Git); a página só manda a chave
        let envConversa = null;
        const pedidoConversa = url.searchParams.get('conversa');
        if (pedidoConversa && !login) {
            if (!/^[^\\/]+\/[0-9a-f-]{36}$/i.test(pedidoConversa) || !envDaConversa) return recusa('conversa');
            try { envConversa = envDaConversa(pedidoConversa); } catch (e) { return recusa('conversa: ' + e.message); }
        }
        // /mcp (autenticar um servidor MCP) e /login (login do Claude vencido): o Claude do SDK com a conta da conversa
        const pedidoClaude = url.searchParams.get('claude');
        const comandoClaude = login ? '' : pedidoClaude === 'mcp' ? '/mcp' : pedidoClaude === 'login' ? '/login' : '';
        if (comandoClaude && !require('fs').existsSync(CLAUDE_EXE)) return recusa('claude.exe do SDK não encontrado em ' + CLAUDE_EXE);
        wss.handleUpgrade(req, socket, cabeca, (ws) => conecta(ws, cwd, url, login, envConversa, comandoClaude, remotoTerminal));
    });
}

// Executável do Claude que vem com o SDK (o mesmo que as conversas usam)
const CLAUDE_EXE = require('path').join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-' + (process.arch === 'arm64' ? 'arm64' : 'x64'), 'claude.exe');
// Git Bash: o bash.exe da instalação do Git (pasta padrão, a do usuário ou a do git que está no PATH)
let bashAchado;
function caminhoGitBash() {
    if (bashAchado !== undefined) return bashAchado;
    const path = require('path'), fsx = require('fs');
    const candidatos = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
        .filter(Boolean).map(p => path.join(p, 'Git', 'bin', 'bash.exe'));
    try {
        const git = require('child_process').execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).split(/\r?\n/)[0].trim();
        if (git) candidatos.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'));
    } catch (e) { /* git fora do PATH */ }
    bashAchado = candidatos.find(c => { try { return fsx.statSync(c).isFile(); } catch (e) { return false; } }) || null;
    return bashAchado;
}
// Shell pedido pela página: executável, argumentos e o que muda no env
function shellPedido(nome) {
    if (nome === 'cmd') return { exe: process.env.ComSpec || 'cmd.exe', args: [], nome: 'CMD' };
    if (nome === 'gitbash') {
        const bash = caminhoGitBash();
        if (!bash) return { erro: 'Git Bash não encontrado. Instale o Git for Windows (git-scm.com) ou escolha outro terminal.' };
        // --login carrega o .bashrc; CHERE_INVOKING mantém a pasta do projeto em vez de ir para a home
        return { exe: bash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1', MSYSTEM: 'MINGW64' }, nome: 'Git Bash' };
    }
    return { exe: 'powershell.exe', args: ['-NoLogo'], nome: 'PowerShell' };
}
function conecta(ws, cwd, url, login, envConversa, comandoClaude, remotoTerminal) {
    const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('cols')) || 100));
    const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 24));
    let p;
    try {
        // Login (/login) e /mcp: abrem o Claude e, ao sair dele, o PowerShell fica (dá para fechar a aba). Sempre PowerShell.
        const doClaude = login ? '/login' : comandoClaude;
        const shell = remotoTerminal ? remotoTerminal : doClaude ? { exe: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', `& '${CLAUDE_EXE.replace(/'/g, "''")}' ${doClaude}`] } : shellPedido(url.searchParams.get('shell'));
        if (shell.erro) { ws.send(`\r\n\x1b[31m${shell.erro}\x1b[0m\r\n`); return ws.close(); }
        const base = login ? (() => { const e = { ...process.env, ...login }; for (const k of (login.__sem || [])) delete e[k]; delete e.__sem; return e; })() : (envConversa || process.env);
        p = pty.spawn(shell.exe, shell.args, { name: 'xterm-256color', cwd, cols, rows, env: shell.env ? { ...base, ...shell.env } : base, useConpty: true });
    } catch (e) {
        ws.send(`\r\nNão consegui abrir o terminal: ${e.message}\r\n`);
        return ws.close();
    }
    p.__cwd = cwd;
    abertos.add(p);
    p.onData((dados) => { if (ws.readyState === 1) ws.send(dados); });
    p.onExit(() => { abertos.delete(p); if (ws.readyState === 1) ws.close(); });
    ws.on('message', (bruto) => {
        let m;
        try { m = JSON.parse(String(bruto)); } catch (e) { return; }
        if (m.tipo === 'entrada' && typeof m.dados === 'string') p.write(m.dados);
        else if (m.tipo === 'tamanho') {
            const c = Math.max(20, Math.min(400, Number(m.cols) || 0)), r = Math.max(5, Math.min(200, Number(m.rows) || 0));
            try { p.resize(c, r); } catch (e) { /* terminal já saiu */ }
        }
    });
    ws.on('close', () => { abertos.delete(p); try { p.kill(); } catch (e) { /* já saiu */ } });
}

// Pastas onde há terminal aberto (um terminal segura a pasta: não dá para remover um worktree com ele)
const pastasAbertas = () => [...abertos].map(p => p.__cwd).filter(Boolean);

// Abrir fora do Red Code: janela própria do Windows com o mesmo terminal da aba, na mesma pasta.
// Aba que acompanha um arquivo vira um PowerShell com Get-Content -Wait nele.
function abreExterno(pasta, nome, arquivo) {
    const { spawn } = require('child_process'), path = require('path'), fsx = require('fs');
    const abre = (args, cwd) => spawn('cmd.exe', ['/c', 'start', '""', ...args], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    if (arquivo) {
        const titulo = 'Acompanhando ' + path.basename(arquivo);
        return abre(['powershell.exe', '-NoExit', '-NoLogo', '-Command', `$Host.UI.RawUI.WindowTitle = '${titulo.replace(/'/g, "''")}'; Get-Content -LiteralPath '${arquivo.replace(/'/g, "''")}' -Wait -Tail 60`], path.dirname(arquivo));
    }
    if (nome === 'cmd') return abre([process.env.ComSpec || 'cmd.exe', '/K'], pasta);
    if (nome === 'gitbash') {
        const bash = caminhoGitBash();
        if (!bash) throw new Error('Git Bash não encontrado.');
        // git-bash.exe (janela própria do Git) quando existe; senão o bash.exe num console
        const gitBash = path.join(path.dirname(path.dirname(bash)), 'git-bash.exe');
        if (fsx.existsSync(gitBash)) return abre([gitBash, '--cd=' + pasta], pasta);
        return abre([bash, '--login', '-i'], pasta);
    }
    return abre(['powershell.exe', '-NoExit', '-NoLogo'], pasta);
}

module.exports = { liga, quantos: () => abertos.size, pastasAbertas, temGitBash: () => !!caminhoGitBash(), abreExterno };
