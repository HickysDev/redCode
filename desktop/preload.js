// Ponte mínima entre o app desktop e a página. A página continua sem acesso ao Node;
// recursos nativos entram nas fases seguintes, um a um.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('painelDesktop', {
    desktop: true,
    // Traz a janela para frente (ex.: clique numa notificação com o app escondido na bandeja)
    mostrar: () => ipcRenderer.send('painel:mostrar'),
    // Abre o seletor de pastas do Windows (null se cancelar)
    escolherPasta: () => ipcRenderer.invoke('painel:escolher-pasta'),
    // Configurações › Sistema: iniciar com o Windows (ler e gravar) e Desenvolvedor: abrir a pasta dos logs
    inicioWindows: () => ipcRenderer.invoke('painel:inicio-windows'),
    defineInicioWindows: (ligar) => ipcRenderer.invoke('painel:define-inicio-windows', !!ligar),
    abrirLogs: () => ipcRenderer.invoke('painel:abrir-logs'),
    // Configurações › Atalhos: atalho global de mostrar/esconder (sem argumento = só lê; '' = desliga)
    atalhoJanela: (novo) => ipcRenderer.invoke('painel:atalho-janela', novo === undefined ? undefined : String(novo)),
    // Versão nova (cartão no rodapé): estado atual, avisos de mudança e ações (baixar, reiniciar, dispensar)
    atualizacao: {
        estado: () => ipcRenderer.invoke('painel:atualizacao-estado'),
        acao: (acao) => ipcRenderer.invoke('painel:atualizacao-acao', String(acao)),
        aoMudar: (fn) => ipcRenderer.on('painel:atualizacao', (ev, estado) => fn(estado)),
    },
    // Vídeo da mídia (janela desanexada): a altura acompanha a proporção do vídeo
    clipe: {
        proporcao: (r) => ipcRenderer.invoke('painel:clipe-proporcao', Number(r) || 0),
        // Onde a janela solta nasce (vídeo arrastado para fora do Red Code)
        soltaEm: (b) => ipcRenderer.invoke('painel:clipe-solta-em', b),
        // Player do YouTube incorporado: tempo exato e velocidade fina (só no app)
        yt: (ritmo) => ipcRenderer.invoke('painel:clipe-yt', ritmo == null ? null : Number(ritmo)),
        // Janela solta: o ponteiro entrou ou saiu dela (mostra ou esconde a barra)
        aoPairar: (fn) => ipcRenderer.on('painel:clipe-pairando', (ev, dentro) => fn(!!dentro)),
    },
});
