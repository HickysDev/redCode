// Novidades de cada versão: aparecem num modal na primeira abertura depois de atualizar (e em Configurações › Sistema
// › Ver novidades). As notas da release do GitHub saem daqui também.
// A versão mais nova fica em cima. Cada item: "Título curto: o que mudou, do jeito que a pessoa usa"
module.exports = [
    {
        versao: '1.0.12', data: '2026-11-11', itens: [
            'Vídeo no canto sem extensão: o vídeo vem da aba do YouTube que estiver selecionada no navegador (pode minimizar ou cobrir a janela), em qualquer navegador',
            'Extensão do navegador opcional: continua funcionando e, quando instalada, deixa o vídeo mais preciso (sincronia fina, próxima música já pronta). Instale ou veja o status em Configurações › Integrações',
            'Integrações: nova aba em Configurações. O YouTube Music Desktop se conecta por lá, com Integrar e Desativar',
            'Editor ao vivo: feche abas pelo × ou pelo botão do meio do mouse, como no VS Code',
            'Painel Git: não fecha mais ao arrastar a largura dele com o editor ao vivo aberto',
        ],
    },
    {
        versao: '1.0.11', data: '2026-11-11', itens: [
            'Extensões do VS Code: instale um .vsix em Configurações › Extensões e use os painéis dela no botão de peça no topo da lista (extensões de painel, comandos e configurações, como o Royal Trello Diário)',
            'Arquivos citados como link: quando o Claude cita um arquivo como link do Markdown, dá para clicar e abrir, como os outros caminhos',
            'Selos da lista: "Agente rodando" e os outros selos longos cabem na lista (o texto inteiro aparece ao parar o mouse em cima)',
        ],
    },
    {
        versao: '1.0.10', data: '2026-11-11', itens: [
            'Tarefas em segundo plano na lista: conversa com um comando ou teste rodando em segundo plano aparece como trabalhando, com o nome da tarefa',
            'Player com disco pela capa: o disco abre só com o mouse parado na capa do álbum; aberto, continua aberto enquanto o mouse estiver no player',
        ],
    },
    {
        versao: '1.0.9', data: '2026-11-11', itens: [
            'Novidades ao atualizar: depois de cada atualização, esta janela mostra o que entrou. Para rever, vá em Configurações › Sistema › Ver novidades',
            'Player com disco: passe o mouse no player do rodapé e a capa vira um vinil girando, com o nome inteiro, o tempo da música e o botão de anterior',
            'Carregando ao abrir: o Red Code mostra uma tela de carregando até a lista de conversas chegar, em vez da tela vazia',
            'Troca de conversa: com o Claude rodando, trocar de conversa não volta mais sozinho para a anterior',
            'Alt+V: fechar o vídeo não mostra mais aviso',
        ],
    },
    {
        versao: '1.0.8', data: '2026-11-11', itens: [
            'Vídeo fora do Red Code: arraste o vídeo para fora da janela e solte; ele vira uma janela própria, sempre por cima das outras, como o picture-in-picture do navegador',
        ],
    },
    {
        versao: '1.0.7', data: '2026-11-11', itens: [
            'Atalhos configuráveis: em Configurações › Atalhos, troque as teclas do vídeo, da busca, do terminal, da lista, do editor e do mostrar/esconder o Red Code',
            'Alt+V: abre ou fecha o vídeo no canto',
            'Compactar a conversa sozinho: a chave em Configurações volta a ligar',
        ],
    },
    {
        versao: '1.0.6', data: '2026-11-11', itens: [
            'YouTube Music Desktop: o vídeo no canto também funciona com o app (Companion Server); a tela do vídeo diz o que falta para parear',
            'Dois Red Code abertos: se um mais antigo estiver usando a porta, o mais novo avisa e assume assim que o antigo estiver livre',
            'Atualização pelo código não trava mais por causa do package-lock.json',
        ],
    },
    {
        versao: '1.0.5', data: '2026-11-10', itens: [
            'Player do rodapé na hora: tocar ou pausar fora do Red Code aparece em menos de 0,2 s (antes até ~3 s)',
        ],
    },
    {
        versao: '1.0.4', data: '2026-11-10', itens: [
            'Vídeo no canto pela extensão do navegador: o Red Code toca uma cópia muda do vídeo do YouTube / YouTube Music, sincronizada com o que você ouve',
            'Instalar a extensão e o yt-dlp pelo próprio Red Code',
            'Vídeo encaixado acima do player, com alça para diminuir, e um pet comendo pipoca enquanto carrega',
            'Buscar atualizações: botão em Configurações › Sistema',
        ],
    },
];
