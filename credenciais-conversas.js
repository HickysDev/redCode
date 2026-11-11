// Credenciais já usadas nas conversas do Claude Code (hoje: chave de API e token do Trello), para a pessoa reaproveitar
// quando uma extensão pede. Só roda quando a caixa de digitar pede uma delas; procura só nas conversas que citam o
// serviço. A página recebe a lista MASCARADA (começo…fim, conversa e data); o valor inteiro só sai quando a pessoa
// clica num item (rota com a checagem do painel). Nada vai para log.
const fs = require('fs');
const path = require('path');

// Formatos: chave do Trello = 32 hex; token = 64 hex (antigo) ou ATTA… (novo). A palavra antes evita pegar hash qualquer.
// Nos .jsonl o texto vem com aspas escapadas (\"), por isso a barra invertida entre a palavra e o valor; o > é do PHP ("key" => "…")
const TIPOS = {
    'trello-chave': { servico: /trello/i, re: /(?:\bkey|apiKey|api_key|TRELLO_KEY|chave)[\\"'\s:=>]{1,8}([0-9a-f]{32})(?![0-9a-zA-Z])/gi },
    'trello-token': { servico: /trello/i, re: /(?:\btoken|TRELLO_TOKEN)[\\"'\s:=>]{1,8}(ATTA[0-9A-Za-z]{60,80}|[0-9a-f]{64})(?![0-9a-zA-Z])/gi },
};
// Qual credencial a caixa de digitar está pedindo (pelo título e pelo texto dela)
function tipoDoPedido(titulo, prompt) {
    const t = `${titulo || ''} ${prompt || ''}`;
    if (!/trello/i.test(t)) return null;
    if (/token/i.test(t)) return 'trello-token';
    if (/chave|api key|\bkey\b/i.test(t)) return 'trello-chave';
    return null;
}

const cacheArquivos = new Map();   // arquivo -> { mtime, achados: { tipo: [valor] } }
const valores = new Map();         // id curto -> valor (só na memória do servidor)
const mascara = (v) => v.slice(0, 4) + '…' + v.slice(-4);
function idDe(valor) { return require('crypto').createHash('sha256').update(valor).digest('hex').slice(0, 16); }

// raizes: pastas "projects" do Claude (a da conta e as de outros perfis); tituloDe(idSessao) dá o nome da conversa
function procura(tipo, raizes, tituloDe) {
    const regra = TIPOS[tipo];
    if (!regra) return [];
    const porValor = new Map();   // valor -> { conversas: [{ titulo, data }] }
    for (const raiz of raizes) {
        if (!raiz || !fs.existsSync(raiz)) continue;
        for (const pasta of fs.readdirSync(raiz)) {
            const dir = path.join(raiz, pasta);
            let nomes;
            try { if (!fs.statSync(dir).isDirectory()) continue; nomes = fs.readdirSync(dir); } catch (e) { continue; }
            for (const nome of nomes) {
                if (!nome.endsWith('.jsonl')) continue;
                const arq = path.join(dir, nome);
                let st;
                try { st = fs.statSync(arq); } catch (e) { continue; }
                let c = cacheArquivos.get(arq);
                if (!c || c.mtime !== st.mtimeMs) {
                    c = { mtime: st.mtimeMs, achados: {} };
                    let texto = '';
                    try { texto = fs.readFileSync(arq, 'utf8'); } catch (e) { texto = ''; }
                    for (const [t, r] of Object.entries(TIPOS)) {
                        if (!r.servico.test(texto)) continue;
                        const achados = new Set();
                        for (const m of texto.matchAll(r.re)) achados.add(m[1]);
                        if (achados.size) c.achados[t] = [...achados];
                    }
                    cacheArquivos.set(arq, c);
                }
                for (const valor of c.achados[tipo] || []) {
                    const item = porValor.get(valor) || { conversas: [] };
                    item.conversas.push({ titulo: (tituloDe && tituloDe(nome.replace(/\.jsonl$/, ''))) || pasta, data: st.mtimeMs });
                    porValor.set(valor, item);
                }
            }
        }
    }
    // Mais recente primeiro; o valor fica no servidor, a página só vê o id e a máscara
    return [...porValor].map(([valor, item]) => {
        const id = idDe(valor);
        valores.set(id, valor);
        const conversas = item.conversas.sort((a, b) => b.data - a.data);
        return { id, mascara: mascara(valor), conversa: conversas[0].titulo, data: conversas[0].data, conversas: conversas.length };
    }).sort((a, b) => b.data - a.data).slice(0, 8);
}
// Valor inteiro de um item da lista (a pessoa clicou nele)
const valor = (id) => valores.get(String(id)) || null;

module.exports = { tipoDoPedido, procura, valor };
