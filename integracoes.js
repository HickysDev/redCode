// Fase 4: integrações. GitHub pelo gh (só leitura: PRs e execuções de CI), hooks configurados
// (lista, para conferir o que roda) e card do Trello ligado a cada conversa.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function roda(cmd, args, cwd) {
    return new Promise((resolve) => {
        execFile(cmd, args, { cwd, timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (erro, saida, saidaErro) => {
            resolve({ erro: erro ? (erro.code === 'ENOENT' ? 'ENOENT' : String(saidaErro || erro.message).trim()) : null, saida: String(saida || '') });
        });
    });
}

async function github(cwd) {
    const v = await roda('gh', ['--version'], cwd);
    if (v.erro === 'ENOENT') return { disponivel: false, motivo: 'O GitHub CLI (gh) não está instalado. Para ver PRs e CI aqui: instale com "winget install GitHub.cli" e entre com "gh auth login" (o login é feito por você, no terminal).' };
    const prs = await roda('gh', ['pr', 'list', '--state', 'all', '--limit', '10', '--json', 'number,title,state,headRefName,url,updatedAt,isDraft'], cwd);
    if (prs.erro) return { disponivel: false, motivo: /auth|login/i.test(prs.erro) ? 'O gh está instalado, mas sem login. Rode "gh auth login" no terminal.' : 'gh: ' + prs.erro.split('\n')[0] };
    const runs = await roda('gh', ['run', 'list', '--limit', '8', '--json', 'name,status,conclusion,headBranch,url,createdAt,event'], cwd);
    const ler = (r) => { try { return JSON.parse(r.saida || '[]'); } catch (e) { return []; } };
    return { disponivel: true, prs: ler(prs), execucoes: runs.erro ? [] : ler(runs), avisoCi: runs.erro ? 'Não consegui ler o CI: ' + runs.erro.split('\n')[0] : null };
}

// Hooks configurados (seus, locais e do projeto): o que roda e quando
function hooks(cwd) {
    const fontes = [
        ['seu', path.join(os.homedir(), '.claude', 'settings.json')],
        ['seu (local)', path.join(os.homedir(), '.claude', 'settings.local.json')],
    ];
    if (cwd) fontes.push(['projeto', path.join(cwd, '.claude', 'settings.json')], ['projeto (local)', path.join(cwd, '.claude', 'settings.local.json')]);
    const lista = [];
    for (const [origem, arquivo] of fontes) {
        let json;
        try { json = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (e) { continue; }
        for (const [evento, grupos] of Object.entries(json.hooks || {})) {
            for (const g of Array.isArray(grupos) ? grupos : []) {
                for (const hk of g.hooks || []) lista.push({ origem, arquivo, evento, matcher: g.matcher || '', tipo: hk.type, comando: String(hk.command || hk.url || '').slice(0, 400), timeout: hk.timeout || null });
            }
        }
    }
    return lista;
}

// Trello: só aceita endereço de card do trello.com
function validaTrello(url) {
    if (url == null || url === '') return null;
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || u.hostname !== 'trello.com' || !/^\/c\/[A-Za-z0-9]+/.test(u.pathname)) throw new Error('Use o endereço do card: https://trello.com/c/…');
    return u.origin + u.pathname;
}

module.exports = { github, hooks, validaTrello };
