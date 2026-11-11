const fs = require('fs');
const path = require('path');

const PLAYERS = [
    {
        id: 'ytm-desktop', nome: 'YouTube Music Desktop', modulo: require('./ytm-desktop'),
        descricao: 'Música e vídeo no canto vindos do app de desktop do YouTube Music.',
        site: 'https://ytmdesktop.app',
        passos: [
            'Abra o YouTube Music Desktop e vá em Settings › Integrations.',
            'Ligue "Companion server".',
            'Ligue "Enable companion authorization" (só para parear; o app desliga sozinho depois).',
            'Clique em Ativar aqui e aprove o pedido do Red Code que aparece no app.',
        ],
    },
];

let arquivo = null, ligados = {};

function salva() { fs.writeFileSync(arquivo, JSON.stringify({ ligados }, null, 2)); }

function configura(pastaDados, recebe) {
    arquivo = path.join(pastaDados, 'players-externos.json');
    for (const p of PLAYERS) p.modulo.configura(pastaDados, recebe);
    try { ligados = JSON.parse(fs.readFileSync(arquivo, 'utf8')).ligados || {}; }
    // QUEM JA TINHA PAREADO ANTES DA ABA INTEGRACOES CONTINUA LIGADO
    catch (e) { ligados = Object.fromEntries(PLAYERS.map(p => [p.id, p.modulo.jaPareou()])); salva(); }
    for (const p of PLAYERS) if (ligados[p.id]) p.modulo.liga();
}

const descreve = (p) => ({ id: p.id, nome: p.nome, descricao: p.descricao, site: p.site, passos: p.passos, ...p.modulo.estado(), ligado: !!ligados[p.id] });
const lista = () => PLAYERS.map(descreve);
const avisos = () => PLAYERS.filter(p => ligados[p.id] && p.modulo.estado().aviso).map(p => p.nome + ': ' + p.modulo.estado().aviso);

function executa(id, acao) {
    const p = PLAYERS.find(x => x.id === id);
    if (!p) throw new Error('Integração não encontrada.');
    if (acao === 'ligar') { ligados[id] = true; p.modulo.liga(); }
    else if (acao === 'desligar') { ligados[id] = false; p.modulo.desliga(); }
    else throw new Error('Ação inválida.');
    salva();
    return descreve(p);
}

module.exports = { configura, lista, avisos, executa };
