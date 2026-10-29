// Controle do código-fonte do Red Code (como a extensão Git do VS Code): estado, diff, grafo,
// branches, stash, worktrees e ações (stage, commit, fetch/pull/push, trocar branch...).
// Sempre execFile com argumentos em lista (sem shell) e '--' antes de caminhos.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Executáveis por caminho absoluto: no Windows a busca começa pela pasta atual do processo,
// então um git.exe/powershell.exe dentro de um repositório clonado seria executado.
const GIT_EXE = (() => {
    for (const p of (process.env.PATH || '').split(path.delimiter)) {
        if (!p || !path.isAbsolute(p)) continue;
        const exe = path.join(p, process.platform === 'win32' ? 'git.exe' : 'git');
        if (fs.existsSync(exe)) return exe;
    }
    return 'git';
})();
const POWERSHELL_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function erro(status, mensagem) { const e = new Error(mensagem); e.status = status; return e; }

// Ambiente de todo comando git do painel:
// - LITERAL_PATHSPECS: caminho é caminho (um arquivo chamado "*" ou ":(top)" não vira curinga)
// - OPTIONAL_LOCKS=0: leituras não pegam o index.lock (não atrapalham o Claude nem o VS Code)
// - TERMINAL_PROMPT=0: sem credencial, falha na hora em vez de esperar um prompt invisível
const AMBIENTE_GIT = { GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
let ultimaSaida = '';   // saída do último comando (ex.: linhas dos hooks do repo), para mostrar ao usuário
function git(args, cwd, { tempo = 30000, buffer = false, entrada, literal = true } = {}) {
    return new Promise((resolve, rejeita) => {
        const filho = execFile(GIT_EXE, args, { cwd, timeout: tempo, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', env: { ...process.env, ...AMBIENTE_GIT, ...(literal ? {} : { GIT_LITERAL_PATHSPECS: '0' }) } }, (falha, saida, saidaErro) => {
            // Hooks (ex.: commit-msg do Royal) explicam a recusa no stdout: devolve as duas saídas
            const junto = [buffer ? '' : String(saida || ''), String(saidaErro || '')].join('\n').trim();
            if (falha) return rejeita(erro(400, (falha.killed ? 'O git demorou demais e foi interrompido.\n' : '') + (junto.split('\n').slice(-25).join('\n') || falha.message)));
            if (!buffer) ultimaSaida = junto;
            resolve(saida);
        });
        if (entrada != null) { filho.stdin.on('error', () => {}); filho.stdin.end(entrada); }
    });
}
const texto = (buf) => { const u = buf.toString('utf8'); return u.includes('�') ? buf.toString('latin1') : u; };

async function raizDo(cwd) {
    try { return path.resolve((await git(['rev-parse', '--show-toplevel'], cwd)).trim()); } catch (e) { return null; }
}

// Caminho de arquivo dentro do repo (relativo), sem escapar e sem virar opção do git
function caminhoSeguro(raiz, p) {
    const s = String(p || '');
    if (!s || s.startsWith('-')) throw erro(400, 'Caminho inválido.');
    const abs = path.resolve(raiz, s);
    const rel = path.relative(raiz, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw erro(403, 'Fora do repositório.');
    return rel.replace(/\\/g, '/');
}
async function branchValida(raiz, nome) {
    const s = String(nome || '');
    if (!s || s.startsWith('-')) throw erro(400, 'Nome de branch inválido.');
    try { await git(['check-ref-format', '--branch', s], raiz); } catch (e) { throw erro(400, 'Nome de branch inválido.'); }
    return s;
}

// ---------- Estado (como o painel do VS Code) ----------
async function estado(cwd) {
    const raiz = await raizDo(cwd);
    if (!raiz) return { repo: null };
    const [branchBruto, statusBruto, worktreesBruto, stashBruto, gitDir] = await Promise.all([
        git(['rev-parse', '--abbrev-ref', 'HEAD'], raiz).catch(() => 'HEAD'),
        git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], raiz, { buffer: true }),
        git(['worktree', 'list', '--porcelain'], raiz).catch(() => ''),
        git(['stash', 'list', '--format=%gd%x1f%s%x1f%cr%x1f%H'], raiz).catch(() => ''),
        git(['rev-parse', '--git-dir'], raiz).then(s => path.resolve(raiz, s.trim())).catch(() => null),
    ]);
    let branch = branchBruto.trim();
    let upstream = null, ahead = 0, behind = 0, hash = null;
    const staged = [], unstaged = [], untracked = [], conflitos = [];
    const partes = texto(statusBruto).split('\0');
    for (let i = 0; i < partes.length; i++) {
        const l = partes[i];
        if (!l) continue;
        if (l.startsWith('# branch.oid ')) hash = l.slice(13);
        else if (l.startsWith('# branch.head ')) branch = l.slice(14);
        else if (l.startsWith('# branch.upstream ')) upstream = l.slice(18);
        else if (l.startsWith('# branch.ab ')) { const m = l.match(/\+(\d+) -(\d+)/); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
        else if (l[0] === '1' || l[0] === '2') {
            const campos = l.split(' ');
            const xy = campos[1];
            let caminho = campos.slice(l[0] === '1' ? 8 : 9).join(' ');
            let origem = null;
            if (l[0] === '2') origem = partes[++i];   // rename/cópia: o caminho antigo vem no item seguinte
            if (xy[0] !== '.') staged.push({ caminho, letra: xy[0], origem });
            if (xy[1] !== '.') unstaged.push({ caminho, letra: xy[1] });
        } else if (l[0] === 'u') {
            conflitos.push({ caminho: l.split(' ').slice(10).join(' '), letra: 'U' });
        } else if (l[0] === '?') untracked.push({ caminho: l.slice(2), letra: 'U' });
    }
    const worktrees = [];
    for (const bloco of worktreesBruto.split(/\r?\n\r?\n/)) {
        const c = (bloco.match(/^worktree (.+)$/m) || [])[1];
        if (!c) continue;
        const caminho = path.resolve(c.replace(/\//g, path.sep));
        worktrees.push({ caminho, branch: ((bloco.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) || (/^detached$/m.test(bloco) ? '(destacado)' : ''), atual: caminho.toLowerCase() === raiz.toLowerCase(), principal: worktrees.length === 0 });
    }
    const stashes = stashBruto.split(/\r?\n/).filter(Boolean).map((l, i) => { const [ref, msg, quando, hash] = l.split('\x1f'); return { indice: i, ref, mensagem: msg, quando, hash }; });
    const emAndamento = gitDir ? (fs.existsSync(path.join(gitDir, 'MERGE_HEAD')) ? 'merge' : fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply')) ? 'rebase' : fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD')) ? 'cherry-pick' : null) : null;
    return { repo: raiz, nome: path.basename(raiz), branch, hash: hash && hash.slice(0, 8), upstream, ahead, behind, staged, unstaged, untracked, conflitos, worktrees, stashes, emAndamento };
}

// ---------- Diff de um arquivo ----------
async function diff(cwd, arquivo, staged) {
    const raiz = await raizDo(cwd);
    if (!raiz) throw erro(400, 'Não é um repositório git.');
    const rel = caminhoSeguro(raiz, arquivo);
    let saida = await git(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', rel], raiz, { buffer: true });
    if (!saida.length && !staged) {
        // Arquivo novo (não rastreado): mostra o conteúdo inteiro como adicionado
        const abs = path.join(raiz, rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= 2 * 1024 * 1024) {
            const linhas = texto(fs.readFileSync(abs)).split(/\r?\n/);
            return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${linhas.length} @@\n` + linhas.map(l => '+' + l).join('\n');
        }
    }
    return texto(saida);
}

// ---------- Grafo ----------
async function log(cwd, n) {
    const raiz = await raizDo(cwd);
    if (!raiz) throw erro(400, 'Não é um repositório git.');
    const qtd = Math.max(20, Math.min(300, Number(n) || 150));
    const saida = await git(['log', '--branches', '--remotes', '--tags', 'HEAD', '--graph', '--date-order', `-n${qtd}`, '--format=%x1f%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s'], raiz, { buffer: true });
    return texto(saida).split(/\r?\n/).filter(Boolean).map(l => {
        const i = l.indexOf('\x1f');
        if (i < 0) return { grafo: l };
        const [hash, curto, autor, quando, refs, assunto] = l.slice(i + 1).split('\x1f');
        return { grafo: l.slice(0, i), hash, curto, autor, quando, refs: refs ? refs.split(', ').filter(Boolean) : [], assunto };
    });
}
async function commit(cwd, hash, arquivo) {
    const raiz = await raizDo(cwd);
    if (!raiz) throw erro(400, 'Não é um repositório git.');
    if (!/^[0-9a-f]{7,40}$/i.test(String(hash))) throw erro(400, 'Hash inválido.');
    if (arquivo) return texto(await git(['show', '--no-color', '--format=', hash, '--', caminhoSeguro(raiz, arquivo)], raiz, { buffer: true }));
    const cab = await git(['show', '--no-color', '-s', '--format=%H%x1f%an <%ae>%x1f%ad%x1f%D%x1f%B', '--date=format:%d/%m/%Y %H:%M', hash], raiz);
    const [h, autor, data, refs, corpo] = cab.split('\x1f');
    const arquivos = (await git(['show', '--no-color', '--format=', '--name-status', hash], raiz)).split(/\r?\n/).filter(Boolean).map(l => { const p = l.split('\t'); return { letra: p[0][0], caminho: p[p.length - 1] }; });
    return { hash: h, autor, data, refs, mensagem: (corpo || '').trim(), arquivos };
}

async function branches(cwd) {
    const raiz = await raizDo(cwd);
    if (!raiz) throw erro(400, 'Não é um repositório git.');
    const saida = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:relative)%1f%(HEAD)', 'refs/heads', 'refs/remotes'], raiz);
    return saida.split(/\r?\n/).filter(Boolean).map(l => { const [ref, nome, upstream, quando, atual] = l.split('\x1f'); return { nome, remota: ref.startsWith('refs/remotes/'), upstream, quando, atual: atual === '*' }; }).filter(b => !/\/HEAD$/.test(b.nome));
}

// ---------- Ações ----------
let filaAcoes = Promise.resolve();
function acao(cwd, c) {
    const vez = filaAcoes.then(() => acaoAgora(cwd, c));
    filaAcoes = vez.catch(() => {});
    return vez;
}
async function acaoAgora(cwd, c) {
    const raiz = await raizDo(cwd);
    if (!raiz) throw erro(400, 'Não é um repositório git.');
    const arquivos = () => { const l = (Array.isArray(c.arquivos) ? c.arquivos : []).map(a => caminhoSeguro(raiz, a)); if (!l.length) throw erro(400, 'Nenhum arquivo.'); return l; };
    // Rede e comandos que disparam hooks (no Royal o post-checkout/post-merge sincronizam o programador7):
    // tempo longo para não cortar um envio no meio
    const rede = { tempo: 300000 };
    ultimaSaida = '';
    switch (c.acao) {
        case 'stage': await git(['add', '--', ...arquivos()], raiz); break;
        case 'unstage': await git(['restore', '--staged', '--', ...arquivos()], raiz); break;
        case 'stage-tudo': await git(['add', '-A'], raiz); break;
        case 'unstage-tudo': await git(['restore', '--staged', '--', '.'], raiz).catch(() => git(['reset', '-q'], raiz)); break;
        case 'descartar': {
            const lista = arquivos();
            const st = await estado(raiz);
            const naoRastreados = new Set(st.untracked.map(u => u.caminho));
            const rastreados = lista.filter(a => !naoRastreados.has(a)), novos = lista.filter(a => naoRastreados.has(a));
            if (rastreados.length) await git(['restore', '--', ...rastreados], raiz);
            if (novos.length) await paraLixeira(novos.map(a => path.join(raiz, a)));
            break;
        }
        case 'commit': {
            const msg = String(c.mensagem || '').trim();
            if (!msg && !c.amend) throw erro(400, 'Escreva a mensagem do commit.');
            if (msg.length > 5000) throw erro(400, 'Mensagem longa demais.');
            if (c.prepararTudo) await git(['add', '-A'], raiz);
            await git(['commit', ...(c.amend ? ['--amend'] : []), ...(msg ? ['-F', '-'] : ['--no-edit'])], raiz, { entrada: msg ? msg + '\n' : undefined, tempo: 300000 });
            break;
        }
        case 'fetch': await git(['fetch', '--prune'], raiz, rede); break;
        case 'pull': await git(['pull', '--ff-only'], raiz, rede); break;
        case 'push': {
            const st = await estado(raiz);
            if (st.branch === 'HEAD' || st.branch === '(detached)' || !st.branch) throw erro(400, 'HEAD destacado: crie uma branch antes do push.');
            if (st.upstream) await git(['push'], raiz, rede);
            else await git(['push', '-u', 'origin', await branchValida(raiz, st.branch)], raiz, rede);
            break;
        }
        case 'trocar-branch': {
            const nome = await branchValida(raiz, c.branch);
            // Branch remota (origin/x): cria a local acompanhando o remoto
            if (c.remota) await git(['switch', '--track', nome], raiz, rede);
            else await git(['switch', nome], raiz, rede);
            break;
        }
        case 'criar-branch': await git(['switch', '-c', await branchValida(raiz, c.nome)], raiz, rede); break;
        // Sem LITERAL: com ele o stash -u guarda os não rastreados mas não os tira da pasta
        case 'stash': await git(['stash', 'push', '--include-untracked', ...(c.mensagem ? ['-m', String(c.mensagem).slice(0, 200)] : [])], raiz, { literal: false }); break;
        case 'stash-aplicar': case 'stash-pop': case 'stash-apagar': {
            const i = Number(c.indice);
            if (!Number.isInteger(i) || i < 0 || i > 500) throw erro(400, 'Stash inválido.');
            // A lista na tela pode estar velha: confere que stash@{i} ainda é o mesmo que o usuário viu
            const atual = (await git(['rev-parse', '--verify', '-q', `stash@{${i}}`], raiz).catch(() => '')).trim();
            if (!/^[0-9a-f]{40}$/i.test(String(c.hash || '')) || atual.toLowerCase() !== String(c.hash).toLowerCase()) throw erro(409, 'A lista de stash mudou desde que a tela foi atualizada. Confira e tente de novo.');
            await git(['stash', c.acao === 'stash-aplicar' ? 'apply' : c.acao === 'stash-pop' ? 'pop' : 'drop', `stash@{${i}}`], raiz, { literal: false });
            break;
        }
        default: throw erro(400, 'Ação desconhecida.');
    }
    const saidaHooks = ultimaSaida;
    const novo = await estado(raiz);
    novo.saida = saidaHooks.split('\n').slice(-30).join('\n');   // ex.: "[sync] ..." do hook do Royal
    return novo;
}
// O repo tem hooks que mexem fora daqui ao trocar de branch / pull? (ex.: Royal sincroniza o programador7)
async function hooksComEfeito(cwd) {
    const raiz = await raizDo(cwd);
    if (!raiz) return [];
    const caminho = (await git(['config', '--get', 'core.hooksPath'], raiz).catch(() => '')).trim() || path.join(await git(['rev-parse', '--git-common-dir'], raiz).then(s => path.resolve(raiz, s.trim())), 'hooks');
    const pasta = path.resolve(raiz, caminho);
    const achados = [];
    for (const h of ['post-checkout', 'post-merge', 'pre-commit', 'commit-msg', 'pre-push']) {
        try { const t = fs.readFileSync(path.join(pasta, h), 'utf8'); if (/rsync|ssh |scp |curl |sftp/i.test(t)) achados.push(h); } catch (e) { /* sem hook */ }
    }
    return achados;
}
// Commits que vão subir no push (para a confirmação)
async function aSubir(cwd) {
    const raiz = await raizDo(cwd);
    if (!raiz) return [];
    try { return (await git(['log', '--format=%h %s', '@{u}..HEAD'], raiz)).split(/\r?\n/).filter(Boolean); }
    // Sem upstream: só o que nenhuma branch remota tem ainda
    catch (e) { return (await git(['log', '--format=%h %s', '-n', '50', 'HEAD', '--not', '--remotes'], raiz).catch(() => '')).split(/\r?\n/).filter(Boolean); }
}

// Não rastreado descartado vai para a Lixeira do Windows (dá para recuperar). Os caminhos (já
// conferidos dentro do repo) entram pela entrada padrão do script fixo, nunca colados no texto
// (com -Command o PowerShell cola os argumentos extras no comando, então $args não serve).
async function paraLixeira(caminhos) {
    const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; $input | ForEach-Object { if (-not $_) { return }; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)); if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin") } elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin") } }';
    await new Promise((resolve, rejeita) => {
        const f = execFile(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000 }, (falha, _s, se) => falha ? rejeita(erro(500, 'Não consegui mandar para a Lixeira (nada foi apagado): ' + (se || falha.message))) : resolve());
        f.stdin.on('error', () => {});
        f.stdin.end(caminhos.map(c => Buffer.from(c, 'utf8').toString('base64')).join('\n') + '\n');
    });
    const sobrou = caminhos.filter(c => fs.existsSync(c));
    if (sobrou.length) throw erro(500, 'Não consegui mandar para a Lixeira: ' + sobrou.map(c => path.basename(c)).join(', '));
}

module.exports = { estado, diff, log, commit, branches, acao, aSubir, hooksComEfeito };
