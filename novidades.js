// Novidades de cada versão: aparecem num modal na primeira abertura depois de atualizar (e em Configurações › Sistema
// › Ver novidades). As notas da release do GitHub saem daqui também.
// A versão mais nova fica em cima. Cada item: "Título curto: o que mudou, do jeito que a pessoa usa"
module.exports = [
    {
        versao: '1.0.23', data: '2026-11-18', itens: [
            'Botões nas respostas do Claude, como no ChatGPT: copiar, gostei / não gostei (marca só sua), ler em voz alta com a voz em português do Windows, compartilhar (copia sua pergunta e a resposta, prontas para colar) e ⋯ com citar na sua mensagem e copiar sem formatação ou em Markdown',
            'Esc não para mais o Claude: a resposta só é interrompida pelo botão Parar (o Esc continua fechando janelas e limpando a procura)',
            'Red Code mais leve com o tempo: o editor de código de uma pasta que ficou 5 minutos fora de vista é fechado (cada um pesava centenas de MB e ficava aberto para sempre); o que tem alteração não salva fica',
        ],
    },
    {
        versao: '1.0.22', data: '2026-11-17', itens: [
            'Grupos na lista de conversas: crie grupos com nome, cor e ícone e coloque conversas neles pelo menu ⋯ ou arrastando; arraste o grupo para mudar a ordem. A lista ganha as divisórias Grupos e Projetos, e as conversas de projetos diferentes aparecem separadas em cartões (feito pelo Guilherme)',
            'Fixadas e Arquivo viram botões ao lado da busca: as Fixadas ficam no topo e o Arquivo no fim, quando ligado. As abas agora são Todas, Ativas, Hoje, Semana e Mês (feito pelo Guilherme)',
            'Subagentes na lista: cada conversa mostra mini-slimes dos agentes que estão rodando nela (feito pelo Guilherme)',
            '/clear sem sair da conversa: limpa o contexto e a próxima mensagem continua na mesma entrada da lista, com o mesmo nome (feito pelo Guilherme)',
            'Player do rodapé: clique ou arraste a barra de progresso para avançar ou voltar a música (feito pelo Guilherme)',
            'Agente parado junto com a conversa: ao parar a resposta (Esc ou Parar), o agente que ela tinha lançado deixa de aparecer como rodando',
        ],
    },
    {
        versao: '1.0.21', data: '2026-11-16', itens: [
            'Mascotes dançam com música: com uma música tocando, de vez em quando (a cada 1 a 3 minutos) os mascotes dançam por alguns segundos. São 12 danças sorteadas, como balancinho, moonwalk, robô, rock, cambalhota e valsinha, e as de grupo: festa com globo de discoteca, coreografia espelhada e karaokê. Pausou a música, eles param',
            'Parar agentes: passe o mouse no mascote de um agente e clique no quadradinho para parar só aquele agente; a conversa continua',
            'Ver o terminal: clique no mascote de um comando rodando em segundo plano para abrir uma aba com a saída dele ao vivo',
            'Pensando sem sumir: quando o Claude pensa por mais de 90 segundos, a conversa continua aparecendo como trabalhando na lista',
        ],
    },
    {
        versao: '1.0.20', data: '2026-11-16', itens: [
            'Quartinho do mascote: cada mascote dos agentes agora mora num quartinho atrás dele. São 9 temas prontos (Gamer, Escritório, Cabana, Biblioteca, Nave, Matrix, Doce, Balada e um que combina com a cor dele) e dá para montar o seu: parede, piso, cores, janela (dia, pôr do sol, noite, chuva, cidade, espaço, Matrix), 13 móveis e enfeites e 6 iluminações. Quem preferir pode deixar só o mascote',
            'Personalidade e atributos: escolha entre 8 personalidades (animado, curioso, zen, caótico, sarcástico, tímido, ranzinza, sonhador). O mascote fala num balão quando você clica nele e de vez em quando sozinho, com frases sorteadas. Energia muda o ritmo, Tagarelice o quanto ele fala, Sono faz cochilar e Carisma faz brilhar',
            'Mais roupas e acessórios: o mascote ganhou roupas com cor própria, estampas, costas (braços, pés, rabo, asas), bochechas, mais chapéus e óculos, e pode usar vários acessórios e até 3 objetos ao mesmo tempo',
            'Editor do mascote em três grupos: Mascote, Quartinho e Personalidade, com prévia grande e o botão Aleatório sorteando tudo, inclusive o quarto',
        ],
    },
    {
        versao: '1.0.19', data: '2026-11-16', itens: [
            'Red Code bem mais leve: com música tocando e uma conversa trabalhando, o uso do processador pela tela caiu de cerca de 50% para 3%. As animações (ponto pulsando, giro e brilho do "trabalhando", anel da pergunta) continuam iguais, só deixaram de pesar',
            'Conversa atualiza só o que mudou: a tela troca apenas o trecho novo em vez de remontar a conversa inteira (3 vezes mais rápido), e o texto que você selecionou não se perde mais quando chega novidade',
            'Janela escondida não trabalha: com o Red Code minimizado ou escondido a conversa aberta deixa de ser consultada, e atualiza na hora quando você volta',
        ],
    },
    {
        versao: '1.0.18', data: '2026-11-13', itens: [
            'Tasks: nova visão no seletor do topo (Chat | Código | Tasks) ou com Ctrl+Shift+T. Mostra num só lugar as conversas trabalhando ou esperando você, o plano de cada uma, os subagentes e pulsos de luz do Claude recebendo e respondendo (feita pelo Guilherme)',
            'Respostas do Claude na Tasks: o painel Agora mostra as respostas que o Claude vai dando em cada conversa, junto com os avisos',
            'Em segundo plano: conversa com comando ou processo ainda rodando (como uma bateria de testes acompanhada no terminal) aparece como "Em segundo plano" na lista e na Tasks',
        ],
    },
    {
        versao: '1.0.17', data: '2026-11-11', itens: [
            'Correção da 1.0.16: as perguntas do Claude voltam a aparecer no Red Code (não ficam mais como "responda no VS Code") e o painel volta a se atualizar sozinho',
            'Botão de extensões de volta no topo da lista',
        ],
    },
    {
        versao: '1.0.16', data: '2026-11-11', itens: [
            'Explorar: botão no topo da lista mostra a árvore da pasta da conversa no lugar da lista; clicar num arquivo abre como aba no ao vivo',
            'Editor no ao vivo: o ao vivo vira o editor de código, com as cores e o tema dele; a edição do Claude anima dentro do editor (vermelho sai, verde entra)',
            'Trava durante a edição do Claude: o arquivo fica só leitura até ele terminar; abas mostram não salvo e cadeado, e fechar com alteração pergunta antes',
            'Versão: em Configurações › Sistema aparece a versão instalada e a que está no GitHub',
        ],
    },
    {
        versao: '1.0.15', data: '2026-11-11', itens: [
            'Credenciais das conversas: quando uma extensão pede a chave ou o token do Trello, a caixa lista (mascarados) os que já apareceram nas suas conversas; um clique preenche',
            'Vídeo no canto sem a tela do YouTube: o vídeo vem sempre direto (yt-dlp), sem título, logo nem botão de play por cima. Sem o yt-dlp, o canto oferece instalar',
        ],
    },
    {
        versao: '1.0.14', data: '2026-11-11', itens: [
            'Alças do vídeo no canto: coladas na borda (arco no canto de cima e tracinho na borda direita); a alça de baixo saiu e o canto de cima redimensiona também com o vídeo encaixado',
            'Esticar a imagem: com o formato mudado pela alça, um botão escolhe entre faixas pretas e a imagem esticada',
            'Arrastar o vídeo ficou à prova de soltar perdido: se o botão do mouse escapar, ele não desanexa nem encaixa sem querer',
        ],
    },
    {
        versao: '1.0.13', data: '2026-11-11', itens: [
            'Tamanho do vídeo no canto: alça nova na borda direita estica só para o lado, o canto de cima também redimensiona com o vídeo encaixado e o duplo clique numa alça volta ao formato do vídeo',
            'Janela solta do vídeo: a barra com os botões aparece ao passar o mouse',
            'Um vídeo só: abrir o vídeo no canto fecha a janela solta',
        ],
    },
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
