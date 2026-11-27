// Servidores remotos (SSH): conversas do Claude Code rodando num servidor Linux, como o Remote-SSH do VS Code.
// - Acesso por chave própria do Red Code (<dados>/ssh/redcode_ed25519); a senha só é usada uma vez, no "preparar",
//   para instalar a chave pública no servidor, e nunca é gravada.
// - O Claude Code roda no servidor (instalado na versão do SDK, sem atualização automática); o Red Code fala com ele
//   pelo stdin/stdout de um ssh (spawnClaudeCodeProcess do SDK).
// - Os transcripts do servidor são espelhados numa pasta local (só leitura), para a lista e a conversa funcionarem como
//   as locais.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const VERSAO_CLAUDE = require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion;
const RE_ID = /^[a-z0-9-]{1,32}$/;
const RE_HOST = /^(?!-)[A-Za-z0-9.-]{1,253}$/;
const RE_USUARIO = /^[a-z_][a-z0-9_-]{0,31}$/;
// Pasta remota: absoluta, sem espaço, aspas nem "..": vai dentro de um comando de shell
const pastaRemotaValida = (p) => typeof p === 'string' && /^\/[A-Za-z0-9._/-]*$/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p) && p.length <= 300;

let PASTA = null;
function configura(pastaDados) { PASTA = pastaDados; if (fs.existsSync(path.join(PASTA, 'ssh', 'redcode_ed25519'))) protegeChave(); }
// O ssh.exe do Windows recusa chave privada que outra conta possa ler ("UNPROTECTED PRIVATE KEY FILE"): só o usuário
function protegeChave() {
    if (process.platform !== 'win32') return;
    const usuario = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    try { spawnSync('icacls', [path.join(PASTA, 'ssh', 'redcode_ed25519'), '/inheritance:r', '/grant:r', `${usuario}:F`], { windowsHide: true, timeout: 10000 }); } catch (e) { /* o ssh avisa se não deu */ }
}
const pastaSsh = () => path.join(PASTA, 'ssh');
const arqChave = () => path.join(pastaSsh(), 'redcode_ed25519');
const arqKnownHosts = () => path.join(pastaSsh(), 'known_hosts');
const dirEspelho = (id) => path.join(PASTA, 'remotos', id, 'projects');

// Servidor vindo da tela ou do dados.json: só passa o que é seguro pôr num comando ssh
function valida(s) {
    const r = {
        id: String(s && s.id || ''), nome: String(s && s.nome || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        host: String(s && s.host || '').trim(), usuario: String(s && s.usuario || '').trim(), porta: Number(s && s.porta || 22),
        pastaPadrao: String(s && s.pastaPadrao || '').trim() || '/root',
    };
    if (!RE_ID.test(r.id)) throw new Error('Id do servidor inválido.');
    if (!r.nome) throw new Error('Dê um nome ao servidor.');
    if (!RE_HOST.test(r.host)) throw new Error('Endereço do servidor inválido (só letras, números, ponto e hífen; não começa com hífen).');
    if (!RE_USUARIO.test(r.usuario)) throw new Error('Usuário inválido.');
    if (!Number.isInteger(r.porta) || r.porta < 1 || r.porta > 65535) throw new Error('Porta inválida.');
    if (!pastaRemotaValida(r.pastaPadrao)) throw new Error('Pasta padrão inválida (caminho absoluto, sem espaços).');
    return r;
}
function lista(dados) {
    const r = [];
    for (const s of (dados && dados.servidores) || []) { try { r.push(valida(s)); } catch (e) { /* registro quebrado: fica de fora */ } }
    return r;
}

// ssh.exe e ssh-keygen.exe do sistema (OpenSSH do Windows ou do Git)
let exeSsh = null;
function sshExe() {
    if (exeSsh) return exeSsh;
    const candidatos = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')];
    try { candidatos.push(...execFileSync('where.exe', ['ssh'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).split(/\r?\n/).map(x => x.trim()).filter(Boolean)); } catch (e) { /* fora do PATH */ }
    exeSsh = candidatos.find(c => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } }) || null;
    if (!exeSsh) throw new Error('Não achei o ssh.exe. Instale o "Cliente OpenSSH" do Windows (Configurações › Aplicativos › Recursos opcionais) ou o Git for Windows.');
    return exeSsh;
}
function garanteChave() {
    if (fs.existsSync(arqChave()) && fs.existsSync(arqChave() + '.pub')) return fs.readFileSync(arqChave() + '.pub', 'utf8').trim();
    fs.mkdirSync(pastaSsh(), { recursive: true });
    const keygen = path.join(path.dirname(sshExe()), 'ssh-keygen.exe');
    const r = spawnSync(fs.existsSync(keygen) ? keygen : 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'red-code', '-f', arqChave()], { windowsHide: true, timeout: 20000 });
    if (r.status !== 0 || !fs.existsSync(arqChave() + '.pub')) throw new Error('Não deu para criar a chave SSH do Red Code.');
    protegeChave();
    return fs.readFileSync(arqChave() + '.pub', 'utf8').trim();
}
// Opções comuns de todo ssh: chave e known_hosts próprios, sem senha, conferindo a chave do servidor
// Config própria (vazia) no lugar do ~/.ssh/config do usuário: nada de agente, X11, túnel, SendEnv ou ProxyCommand de lá
function arqConfigSsh() {
    const p = path.join(pastaSsh(), 'config');
    if (!fs.existsSync(p)) { fs.mkdirSync(pastaSsh(), { recursive: true }); fs.writeFileSync(p, ''); }
    return p;
}
function argsSsh(s, extra = []) {
    const comAspas = (p) => '"' + p.replace(/\\/g, '/') + '"';
    return ['-F', arqConfigSsh(), '-i', arqChave(), '-p', String(s.porta), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
        '-o', 'UserKnownHostsFile=' + comAspas(arqKnownHosts()), '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=15', ...extra, '--', `${s.usuario}@${s.host}`];
}
const aspasSh = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";

// ---------- Preparar: chave do servidor conferida, chave pública instalada, Claude Code na versão do SDK ----------
function fingerprintDe(blob) { return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''); }
function tipoDaChave(blob) { const n = blob.readUInt32BE(0); return blob.subarray(4, 4 + n).toString(); }
function gravaKnownHost(s, blob) {
    fs.mkdirSync(pastaSsh(), { recursive: true });
    // Porta diferente de 22: o ssh procura a linha como [host]:porta
    const nome = s.porta === 22 ? s.host : `[${s.host}]:${s.porta}`;
    const linhas = (fs.existsSync(arqKnownHosts()) ? fs.readFileSync(arqKnownHosts(), 'utf8').split(/\r?\n/) : []).filter(l => l && l.split(' ')[0] !== nome);
    linhas.push(`${nome} ${tipoDaChave(blob)} ${blob.toString('base64')}`);
    fs.writeFileSync(arqKnownHosts(), linhas.join('\n') + '\n');
}
// senha: só em memória; fingerprint: o que a pessoa confirmou na tela (sem ele, devolve o do servidor para confirmar)
function preparar(sCru, senha, fingerprintConfirmado, avisa = () => {}) {
    const s = valida(sCru);
    const { Client } = require('ssh2');
    const publica = garanteChave();
    return new Promise((ok, falha) => {
        const c = new Client();
        let fpServidor = '', blobServidor = null, terminou = false;
        const fim = (erro, valor) => { if (terminou) return; terminou = true; try { c.end(); } catch (e) { /* já fechou */ } erro ? falha(erro) : ok(valor); };
        const roda = (cmd, ms = 60000) => new Promise((res, rej) => c.exec(cmd, (e, st) => {
            if (e) return rej(e);
            let saida = '';
            const prazo = setTimeout(() => { try { st.close(); } catch (x) { /* já fechou */ } rej(new Error('O servidor demorou demais para responder.')); }, ms);
            st.on('data', d => { saida += d; }).stderr.on('data', d => { saida += d; });
            st.on('close', (codigo) => { clearTimeout(prazo); res({ codigo, saida: saida.trim() }); });
        }));
        c.on('ready', async () => {
            try {
                gravaKnownHost(s, blobServidor);
                avisa('Instalando a chave do Red Code no servidor');
                const chave = await roda(`mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qF ${aspasSh(publica)} ~/.ssh/authorized_keys || printf '\\n%s\\n' ${aspasSh(publica)} >> ~/.ssh/authorized_keys) && echo ok`);
                if (!/ok$/.test(chave.saida)) throw new Error('Não deu para instalar a chave no servidor.');
                let versao = (await roda('"$HOME/.local/bin/claude" --version 2>/dev/null | head -1')).saida;
                if (!versao.startsWith(VERSAO_CLAUDE + ' ')) {
                    avisa(`Instalando o Claude Code ${VERSAO_CLAUDE} no servidor (pode levar alguns minutos)`);
                    const inst = await roda(`command -v curl >/dev/null || { echo "sem curl"; exit 9; }; curl -fsSL https://claude.ai/install.sh | DISABLE_AUTOUPDATER=1 bash -s ${aspasSh(VERSAO_CLAUDE)} 2>&1 | tail -5`, 10 * 60 * 1000);
                    if (inst.codigo === 9) throw new Error('O servidor não tem curl para instalar o Claude Code.');
                    versao = (await roda('"$HOME/.local/bin/claude" --version 2>/dev/null | head -1')).saida;
                    if (!versao.startsWith(VERSAO_CLAUDE + ' ')) throw new Error('A instalação do Claude Code não terminou: ' + inst.saida.slice(-300));
                }
                const login = (await roda('test -f ~/.claude/.credentials.json && echo sim || echo nao')).saida === 'sim';
                fim(null, { ok: true, versao, login, fingerprint: fpServidor });
            } catch (e) { fim(e); }
        });
        c.on('error', (e) => {
            if (blobServidor && fpServidor !== fingerprintConfirmado) return fim(null, { confirmar: fpServidor, tipo: tipoDaChave(blobServidor) });
            fim(new Error(/authentication/i.test(e.message) ? 'Usuário ou senha recusados pelo servidor.' : 'Não deu para conectar: ' + e.message));
        });
        c.connect({
            host: s.host, port: s.porta, username: s.usuario, password: String(senha || ''), readyTimeout: 20000,
            hostVerifier: (blob) => { blobServidor = Buffer.from(blob); fpServidor = fingerprintDe(blobServidor); return fpServidor === fingerprintConfirmado; },
        });
    });
}

// ---------- Rodar com a chave (ssh.exe) ----------
// Comando que roda o Claude Code no servidor. O SDK repassa o ambiente inteiro deste computador (tokens, sessão,
// socket); para o servidor vão só estas, as que o próprio SDK liga
const VARIAVEIS_REMOTO = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_SDK_READS_SESSION_STATE'];
function comandoClaude(cwd, args, env) {
    if (!pastaRemotaValida(cwd)) throw new Error('Pasta remota inválida.');
    const vars = VARIAVEIS_REMOTO.filter(k => env && env[k] !== undefined && /^[A-Za-z0-9._-]{0,60}$/.test(String(env[k])))
        .map(k => `${k}=${aspasSh(env[k])}`);
    return `cd ${aspasSh(cwd)} && exec env DISABLE_AUTOUPDATER=1 ${vars.join(' ')} "$HOME/.local/bin/claude" ${(args || []).map(aspasSh).join(' ')}`;
}
// spawnClaudeCodeProcess do SDK: o processo local é o ssh; o Claude Code roda lá, na pasta da conversa
function spawnClaude(sCru, cwd, o) {
    const s = valida(sCru);
    const filho = spawn(sshExe(), [...argsSsh(s, ['-T']), comandoClaude(cwd, o.args, o.env)], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    if (o.signal) o.signal.addEventListener('abort', () => { try { filho.kill(); } catch (e) { /* já saiu */ } }, { once: true });
    return filho;
}
// Terminal no servidor (ssh -t): uma pasta remota ou o login do Claude Code
function argsTerminal(sCru, pasta, login) {
    const s = valida(sCru);
    if (!pastaRemotaValida(pasta)) throw new Error('Pasta remota inválida.');
    const comando = login ? 'exec "$HOME/.local/bin/claude" /login' : `cd ${aspasSh(pasta)} 2>/dev/null; exec bash -l`;
    return { exe: sshExe(), args: [...argsSsh(s, ['-t']), comando] };
}

// ---------- Espelho dos transcripts ----------
// ("./" antes do caminho: a pasta do projeto começa com hífen, como -root, e o tail/head leriam como opção)
// Um ssh por ciclo: o script remoto lista os arquivos dos últimos 7 dias e manda só o que cresceu (ou o arquivo inteiro,
// quando encolheu ou é um .meta.json que mudou). Formato: "F tamanho mtime caminho" e "D n inteiro caminho" + n bytes.
const RE_CAMINHO = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){1,3}$/;
// Caminho que veio do servidor: sem "." nem "..", só transcript, e sempre dentro da pasta do espelho
const caminhoSeguro = (rel) => RE_CAMINHO.test(rel) && /\.(jsonl|meta\.json)$/.test(rel) && !rel.split('/').some(p => p === '.' || p === '..');
const POR_ARQUIVO = 8 * 1024 * 1024, POR_CICLO = 32 * 1024 * 1024;   // arquivo grande vem aos poucos, em vários ciclos
const sincronizando = new Map();   // id -> promessa do ciclo em andamento
const estadoServidor = new Map();  // id -> { ok, erro, em }
function locais(id) {
    const base = dirEspelho(id), r = [];
    const anda = (dir, rel, nivel) => {
        let itens = [];
        try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const it of itens) {
            const relativo = rel ? rel + '/' + it.name : it.name;
            if (it.isDirectory()) { if (nivel < 3) anda(path.join(dir, it.name), relativo, nivel + 1); }
            else if (caminhoSeguro(relativo)) {
                const st = fs.statSync(path.join(dir, it.name));
                r.push(`${st.size} ${Math.floor(st.mtimeMs / 1000)} ${relativo}`);
            }
        }
    };
    anda(base, '', 0);
    return r;
}
function scriptEspelho(id) {
    const conhecidos = locais(id).join('\n');
    return [
        'cd "$HOME/.claude/projects" 2>/dev/null || exit 0',
        `CONHECIDOS='${conhecidos}'`,
        'tot=0',
        "find . -type f \\( -name '*.jsonl' -o -name '*.meta.json' \\) -mtime -7 -printf '%s %T@ %P\\n' | while read -r tam mt cam; do",
        '  case "$cam" in *[!A-Za-z0-9._/-]*|*..*) continue;; esac',
        `  [ "$tot" -ge ${POR_CICLO} ] && break`,
        '  mt=${mt%.*}',
        "  linha=$(printf '%s\\n' \"$CONHECIDOS\" | awk -v c=\"$cam\" '$3==c {print $1\" \"$2; exit}')",
        '  off=${linha% *}; mtl=${linha#* }; [ -z "$linha" ] && off=0 && mtl=0',
        '  echo "F $tam $mt $cam"',
        '  case "$cam" in *.meta.json) [ "$mt" != "$mtl" ] && off=-1;; esac',
        // Depois dos bytes, "E caminho": se o arquivo mudou no meio e veio menos, o Red Code descarta o bloco
        `  if [ "$tam" -lt "$off" ] || [ "$off" = "-1" ]; then n=$tam; [ "$n" -gt ${POR_ARQUIVO} ] && n=${POR_ARQUIVO}; echo "D $n 1 $cam"; head -c "$n" "./$cam"; printf '\\nE %s\\n' "$cam"; tot=$((tot+n));`,
        `  elif [ "$tam" -gt "$off" ]; then n=$((tam-off)); [ "$n" -gt ${POR_ARQUIVO} ] && n=${POR_ARQUIVO}; echo "D $n 0 $cam"; tail -c +$((off+1)) "./$cam" | head -c "$n"; printf '\\nE %s\\n' "$cam"; tot=$((tot+n)); fi`,
        'done',
    ].join('\n');
}
// completo = o ssh terminou normalmente; cortado (prazo), aplica o que chegou inteiro e descarta o resto
function aplicaSaida(id, buf, completo) {
    const base = path.resolve(dirEspelho(id));
    const dentro = (rel) => { const p = path.resolve(base, ...rel.split('/')); return p.startsWith(base + path.sep) ? p : null; };
    let i = 0, ultimoF = null, quebrou = false;
    const linha = () => { const f = buf.indexOf(0x0a, i); if (f < 0) return null; const l = buf.subarray(i, f).toString('utf8'); i = f + 1; return l; };
    const mtimes = new Map();
    for (let l = linha(); l !== null; l = linha()) {
        const f = l.match(/^F (\d+) (\d+) (.+)$/);
        if (f) { if (caminhoSeguro(f[3])) { mtimes.set(f[3], Number(f[2])); ultimoF = f[3]; } continue; }
        const d = l.match(/^D (\d+) ([01]) (.+)$/);
        const destino = d && caminhoSeguro(d[3]) ? dentro(d[3]) : null;
        if (!destino) { quebrou = true; break; }
        const n = Number(d[1]), dados = buf.subarray(i, i + n), fim = Buffer.from('\nE ' + d[3] + '\n');
        // Bloco sem o fecho certo: veio cortado ou o arquivo mudou no meio — não grava, o próximo ciclo refaz
        if (dados.length !== n || !buf.subarray(i + n, i + n + fim.length).equals(fim)) { mtimes.delete(d[3]); quebrou = true; break; }
        i += n + fim.length;
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        if (d[2] === '1') fs.writeFileSync(destino, dados); else fs.appendFileSync(destino, dados);
        // Arquivo que veio só em parte (limite por arquivo): o mtime fica para quando vier inteiro
        if (n === POR_ARQUIVO) mtimes.delete(d[3]);
        if (ultimoF === d[3]) ultimoF = null;
    }
    // Saída cortada: o último arquivo anunciado pode ter ficado sem o bloco dele
    if ((quebrou || !completo) && ultimoF) mtimes.delete(ultimoF);
    // mtime do servidor no espelho: situação, 7 dias e a trava do envio olham o tempo real de lá
    for (const [rel, mt] of mtimes) { const p = dentro(rel); if (p) try { fs.utimesSync(p, mt, mt); } catch (e) { /* ainda não veio */ } }
}
function sincroniza(sCru) {
    const s = valida(sCru);
    if (sincronizando.has(s.id)) return sincronizando.get(s.id);
    if (!fs.existsSync(arqChave())) return Promise.resolve(false);
    const p = new Promise((ok) => {
        let filho;
        try { filho = spawn(sshExe(), [...argsSsh(s, ['-T']), 'sh -s'], { cwd: os.tmpdir(), windowsHide: true }); } catch (e) { estadoServidor.set(s.id, { ok: false, erro: e.message, em: Date.now() }); return ok(false); }
        const pedacos = [];
        let erro = '', cortado = false;
        const prazo = setTimeout(() => { cortado = true; try { filho.kill(); } catch (e) { /* já saiu */ } }, 60000);
        filho.stdout.on('data', d => pedacos.push(d));
        filho.stderr.on('data', d => { if (erro.length < 2000) erro += d; });
        filho.on('error', (e) => { erro = e.message; });
        filho.on('close', (codigo) => {
            clearTimeout(prazo);
            // Cortado pelo prazo (link lento): o que chegou inteiro já vale, o resto vem no próximo ciclo
            try { if (codigo === 0 || cortado) aplicaSaida(s.id, Buffer.concat(pedacos), codigo === 0); } catch (e) { erro = e.message; }
            if (cortado) erro = erro || 'leitura cortada pelo prazo; continua no próximo ciclo';
            estadoServidor.set(s.id, { ok: codigo === 0, erro: codigo === 0 ? '' : (erro.trim().split('\n').pop() || 'sem conexão'), em: Date.now() });
            ok(codigo === 0);
        });
        filho.stdin.end(scriptEspelho(s.id) + '\n');
    }).finally(() => sincronizando.delete(s.id));
    sincronizando.set(s.id, p);
    return p;
}
const temChave = () => !!PASTA && fs.existsSync(arqChave());

module.exports = { configura, valida, lista, preparar, spawnClaude, argsTerminal, sincroniza, dirEspelho, estadoServidor, pastaRemotaValida, temChave, VERSAO_CLAUDE, RE_ID };
