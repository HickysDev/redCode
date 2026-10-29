// Worktrees git para conversas em paralelo: cada conversa trabalha numa cópia isolada do
// repositório, num branch painel/<nome>. O painel só cria, lista e remove (cópia limpa);
// juntar ao branch principal, push etc. ficam com o usuário.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args, cwd) {
    return new Promise((resolve, rejeita) => {
        execFile('git', args, { cwd, timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (erro, saida, saidaErro) => {
            if (erro) return rejeita(new Error((saidaErro || erro.message).trim().split('\n').slice(-2).join(' ')));
            resolve(String(saida).trim());
        });
    });
}

async function repoDe(cwd) {
    try { return path.resolve(await git(['rev-parse', '--show-toplevel'], cwd)); } catch (e) { return null; }
}

function slug(nome) {
    const base = String(nome || 'conversa').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conversa';
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `${base}-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// Não versionados que importam para a segurança e o uso: tudo da .claude que o git não rastreia
// (no Royal a pasta inteira é ignorada: regras, skills, hooks, settings.local.json com o
// guarda-royal) e o .mcp.json. Ficam na mesma máquina, numa pasta também não versionada.
async function naoRastreados(repo) {
    const lista = new Set();
    for (const extra of [['--others', '--exclude-standard'], ['--others', '--ignored', '--exclude-standard']]) {
        try { (await git(['ls-files', ...extra, '--', '.claude', '.mcp.json'], repo)).split(/\r?\n/).filter(Boolean).forEach(f => lista.add(f)); } catch (e) { /* nada */ }
    }
    return [...lista];
}
// Marca as cópias no exclude comum a todos os worktrees: o status fica limpo e o remove funciona
async function excluiDoGit(repo, arquivos) {
    if (!arquivos.length) return;
    const comum = path.resolve(repo, await git(['rev-parse', '--git-common-dir'], repo));
    const arq = path.join(comum, 'info', 'exclude');
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    const atual = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '';
    // Padrões do git: escapa curingas ([ ] * ? !) e # no início para casar só o arquivo exato
    const novos = arquivos.map(f => '/' + f.replace(/\\/g, '/').replace(/[[\]*?!#]/g, (c) => '\\' + c)).filter(l => !atual.split(/\r?\n/).includes(l));
    if (novos.length) fs.appendFileSync(arq, (atual && !atual.endsWith('\n') ? '\n' : '') + '# copias do Painel Claude nos worktrees\n' + novos.join('\n') + '\n');
}

async function criar(cwd, nome) {
    const repo = await repoDe(cwd);
    if (!repo) throw new Error('Esta pasta não é um repositório git.');
    const s = slug(nome);
    const destino = path.join(path.dirname(repo), path.basename(repo) + '-worktrees', s);
    if (fs.existsSync(destino)) throw new Error('Já existe uma pasta com esse nome.');
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const branch = `painel/${s}`;
    await git(['worktree', 'add', '-b', branch, destino, 'HEAD'], repo);
    const copiados = [];
    for (const rel of await naoRastreados(repo)) {
        const origem = path.join(repo, rel), alvo = path.join(destino, rel);
        if (!fs.existsSync(origem) || fs.existsSync(alvo) || !fs.statSync(origem).isFile()) continue;
        fs.mkdirSync(path.dirname(alvo), { recursive: true });
        fs.copyFileSync(origem, alvo);
        copiados.push(rel);
    }
    await excluiDoGit(repo, copiados);
    return { cwd: destino, branch, repo, copiados };
}

async function listar(cwd) {
    const repo = await repoDe(cwd);
    if (!repo) return { repo: null, lista: [] };
    const texto = await git(['worktree', 'list', '--porcelain'], repo);
    const lista = [];
    for (const bloco of texto.split(/\r?\n\r?\n/)) {
        const caminho = (bloco.match(/^worktree (.+)$/m) || [])[1];
        const branch = ((bloco.match(/^branch refs\/heads\/(.+)$/m) || [])[1] || '');
        if (!caminho || !branch.startsWith('painel/')) continue;
        // O git devolve C:/... com barras normais: normaliza para comparar com o pedido
        const item = { caminho: path.resolve(caminho.replace(/\//g, path.sep)), branch, pendentes: null, aFrente: null };
        try { item.pendentes = (await git(['status', '--porcelain'], item.caminho)).split('\n').filter(Boolean).length; } catch (e) { /* pasta sumiu */ }
        try { item.aFrente = Number(await git(['rev-list', '--count', `HEAD..${branch}`], repo)); } catch (e) { /* sem base */ }
        lista.push(item);
    }
    return { repo, lista };
}

async function remover(cwd, caminho) {
    const { repo, lista } = await listar(cwd);
    if (!repo) throw new Error('Esta pasta não é um repositório git.');
    const alvo = lista.find(w => w.caminho.toLowerCase() === path.resolve(String(caminho)).toLowerCase());
    if (!alvo) throw new Error('Esse worktree não é do painel (só removo branches painel/*).');
    if (alvo.pendentes) throw new Error(`O worktree tem ${alvo.pendentes} alteração(ões) não commitada(s). Commite ou descarte antes de remover.`);
    try {
        await git(['worktree', 'remove', alvo.caminho], repo);
    } catch (e) {
        // Algum programa segura a pasta (editor, explorador, antivírus): limpa o registro do git e diz o que sobrou
        try { await git(['worktree', 'prune'], repo); } catch (x) { /* nada */ }
        const sobrou = fs.existsSync(alvo.caminho);
        throw new Error(`Não consegui remover: ${e.message}.${sobrou ? ` A pasta ${alvo.caminho} ficou no disco (feche o programa que a usa e apague-a).` : ''} O branch ${alvo.branch} continua no repositório.`);
    }
    return { removido: alvo.caminho, branchMantido: alvo.branch };
}

module.exports = { repoDe, criar, listar, remover };
