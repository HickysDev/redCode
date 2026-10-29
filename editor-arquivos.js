// Arquivos para o editor do painel: árvore, ler e salvar preservando a codificação
// (os PHP do Royal são Latin-1/windows-1252; UTF-8 fica UTF-8), BOM e fim de linha.
// Toda operação fica presa dentro da pasta do projeto (realpath, sem escapar por link).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OCULTAS = new Set(['.git', 'node_modules', 'vendor']);
const LIMITE_BYTES = 3 * 1024 * 1024;

function erro(status, mensagem) { const e = new Error(mensagem); e.status = status; return e; }

// Caminho real dentro da pasta do projeto; senão, 403
function dentroDaPasta(cwd, caminho, opcoes) {
    try { return resolveDentro(cwd, caminho, opcoes); } catch (e) {
        if (e.code === 'ENOENT') throw erro(404, 'Arquivo ou pasta não encontrado.');
        throw e;
    }
}
function resolveDentro(cwd, caminho, { precisaExistir = true } = {}) {
    const raiz = fs.realpathSync(cwd);
    const alvo = path.resolve(raiz, caminho || '.');
    let real;
    if (precisaExistir) real = fs.realpathSync(alvo);
    else real = path.join(fs.realpathSync(path.dirname(alvo)), path.basename(alvo));
    const rel = path.relative(raiz, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw erro(403, 'Fora da pasta do projeto.');
    return { raiz, real, rel: rel.replace(/\\/g, '/') };
}

function arvore(cwd, dir) {
    const { real } = dentroDaPasta(cwd, dir || '.');
    const itens = [];
    for (const d of fs.readdirSync(real, { withFileTypes: true })) {
        if (OCULTAS.has(d.name)) continue;
        if (itens.length >= 2000) break;
        const ehPasta = d.isDirectory();
        let tamanho = 0;
        if (!ehPasta) try { tamanho = fs.statSync(path.join(real, d.name)).size; } catch (e) { /* sem acesso */ }
        itens.push({ nome: d.name, tipo: ehPasta ? 'pasta' : 'arquivo', tamanho });
    }
    return itens.sort((a, b) => (a.tipo === b.tipo ? a.nome.localeCompare(b.nome) : a.tipo === 'pasta' ? -1 : 1));
}

function utf8Valido(buf) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (e) { return false; }
}

// Windows-1252 (o "Latin-1" do Royal): igual ao ISO-8859-1, menos 0x80-0x9F, que têm “ ” – € etc.
// Os 5 bytes que a tabela não define (81, 8D, 8F, 90, 9D) passam intactos nos dois sentidos.
const CP1252 = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
const CP1252_VOLTA = new Map(Object.entries(CP1252).map(([b, u]) => [u, Number(b)]));
function decodifica1252(buf) {
    let s = '';
    for (const b of buf) s += String.fromCharCode(CP1252[b] || b);
    return s;
}
function codifica1252(texto) {
    const linhas = texto.split('\n');
    const bytes = [];
    linhas.forEach((linha, i) => {
        for (const ch of linha) {
            const u = ch.codePointAt(0);
            if (CP1252_VOLTA.has(u)) bytes.push(CP1252_VOLTA.get(u));
            else if (u <= 0xFF) bytes.push(u);
            else { const e = erro(400, `A linha ${i + 1} tem "${ch}", que não existe na codificação do arquivo (Windows-1252). Troque esse caractere.`); throw e; }
        }
        if (i < linhas.length - 1) bytes.push(0x0A);
    });
    return Buffer.from(bytes);
}
// Pastas cujo padrão é Windows-1252 (regra do Royal: nunca converter para UTF-8)
// Inclui os worktrees do Royal criados pelo painel (C:\ProjetosGit\royal-worktrees\<nome>\...)
const PASTAS_1252 = [/\\royal(\\|$)/i, /\\royal-worktrees\\/i];
const EXT_1252 = new Set(['.php', '.html', '.htm', '.txt', '.js', '.css', '.inc']);
function padraoDaPasta(real) {
    return PASTAS_1252.some(re => re.test(real)) && EXT_1252.has(path.extname(real).toLowerCase()) ? 'windows-1252' : 'utf8';
}

function ler(cwd, caminho) {
    const { real, rel } = dentroDaPasta(cwd, caminho);
    const st = fs.statSync(real);
    if (!st.isFile()) throw erro(400, 'Não é um arquivo.');
    if (st.size > LIMITE_BYTES) throw erro(413, 'Arquivo grande demais para o editor (mais de 3 MB).');
    let buf = fs.readFileSync(real);
    if (buf.includes(0)) throw erro(415, 'Arquivo binário: o editor só abre texto.');
    const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (bom) buf = buf.subarray(3);
    // Só ASCII: vale o padrão da pasta (Royal = Windows-1252), e dá para trocar na barra de status.
    // Com acentos: UTF-8 válido é UTF-8; senão é Windows-1252.
    const soAscii = !buf.some(b => b > 0x7F);
    const codificacao = soAscii ? padraoDaPasta(real) : utf8Valido(buf) ? 'utf8' : 'windows-1252';
    const texto = codificacao === 'windows-1252' ? decodifica1252(buf) : buf.toString('utf8');
    const crlf = (texto.match(/\r\n/g) || []).length, lfSozinho = (texto.match(/(^|[^\r])\n/g) || []).length;
    const eol = crlf && lfSozinho ? 'misto' : crlf ? 'crlf' : 'lf';
    return { caminho: real, rel, conteudo: texto.replace(/\r\n/g, '\n'), codificacao, soAscii, bom, eol, mtime: st.mtimeMs };
}

function salvar(cwd, { caminho, conteudo, codificacao, bom, eol, mtimeLido }) {
    // Só salva arquivo que já existe (o editor não cria arquivos) e nunca dentro de .git
    const { real, rel } = dentroDaPasta(cwd, caminho);
    if (/(^|\/)\.git(\/|$)/i.test(rel)) throw erro(403, 'O editor não grava dentro de .git.');
    if (mtimeLido != null && Math.abs(fs.statSync(real).mtimeMs - Number(mtimeLido)) > 1) {
        throw erro(409, 'O arquivo mudou no disco depois que você abriu (talvez o Claude editou). Recarregue antes de salvar.');
    }
    if (!['utf8', 'windows-1252'].includes(codificacao)) throw erro(400, 'Codificação desconhecida.');
    const texto = String(conteudo).replace(/\r\n/g, '\n');
    // Não grava "?" no lugar de caractere que não existe na codificação: avisa a linha
    let buf = codificacao === 'windows-1252' ? codifica1252(texto) : Buffer.from(texto, 'utf8');
    if (eol === 'crlf') buf = Buffer.from(buf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
    if (codificacao === 'utf8' && bom) buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]);
    const tmp = real + '.painel-tmp';
    fs.writeFileSync(tmp, buf);
    // No Windows o antivírus ou outro programa às vezes segura o arquivo: tenta de novo
    for (let tentativa = 0; ; tentativa++) {
        try { fs.renameSync(tmp, real); break; } catch (e) {
            if (tentativa >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch (x) { /* já saiu */ } throw e; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
    }
    return { mtime: fs.statSync(real).mtimeMs };
}

// Erros de sintaxe: php -l para PHP, node --check para JS
function phpDoSistema() {
    return fs.existsSync('C:\\xampp\\php\\php.exe') ? 'C:\\xampp\\php\\php.exe' : 'php';
}
function diagnosticos(cwd, caminho) {
    const { real } = dentroDaPasta(cwd, caminho);
    const ext = path.extname(real).toLowerCase();
    let cmd, args;
    if (ext === '.php') { cmd = phpDoSistema(); args = ['-l', '-d', 'display_errors=1', real]; }
    else if (['.js', '.cjs', '.mjs'].includes(ext)) { cmd = process.execPath; args = ['--check', real]; }
    else return Promise.resolve({ verificado: false, erros: [] });
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 }, (falha, saida, saidaErro) => {
            const texto = `${saida || ''}\n${saidaErro || ''}`;
            const erros = [];
            if (ext === '.php') {
                for (const m of texto.matchAll(/(?:PHP )?(Parse error|Fatal error|Warning|Deprecated):\s*(.+?) in .+? on line (\d+)/g)) {
                    // O php imprime o mesmo erro na saída e no stderr: guarda uma vez só
                    const mensagem = `${m[1]}: ${m[2]}`;
                    if (!erros.some(e => e.linha === Number(m[3]) && e.mensagem === mensagem)) erros.push({ linha: Number(m[3]), mensagem });
                }
            } else if (falha) {
                const linha = (texto.match(/:(\d+)\s*\r?\n/) || [])[1];
                const msg = (texto.match(/^(SyntaxError|ReferenceError|TypeError)[^\r\n]*/m) || [texto.trim().split('\n').pop()])[0];
                erros.push({ linha: Number(linha) || 1, mensagem: msg });
            }
            if (falha && falha.code === 'ENOENT') return resolve({ verificado: false, erros: [], aviso: `Não achei ${cmd}.` });
            resolve({ verificado: true, erros });
        });
    });
}

module.exports = { arvore, ler, salvar, diagnosticos, dentroDaPasta };
