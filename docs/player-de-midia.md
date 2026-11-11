# Player do rodapé

Mostra o que está tocando no Windows (YouTube no navegador, Spotify, YouTube Music Desktop...) pelos
controles de mídia do sistema, com tocar/pausar, próxima e anterior.

## Leitura da mídia

- `midia.ps1` (um PowerShell só, ligado enquanto a tela pergunta; 60 s sem perguntar, desliga):
  confere **a cada ~120 ms** só o app e o tocar/pausar (leitura barata); mudou, lê na hora título,
  capa (só quando a música muda) e posição. Leitura completa também a cada 900 ms.
- `midia.js`: cada mudança ganha um **número de versão**. `GET /api/midia?versao=N` segura a resposta
  até mudar (até 20 s). A página fica nesse laço (`vigiaMidia`), então tocar/pausar de fora aparece
  em ~100-170 ms.
- Sumiu a mídia por um instante (troca de música): a tela segura a última por 5 s.
- Comandos (`alternar`, `proxima`, `anterior`): `POST /api/midia`.
- Com um navegador tocando, o `GET /api/midia` também liga o leitor do vídeo no canto
  (`videoNativo.usado()`), para o vídeo já estar pronto quando a pessoa abrir.

## Aberto (disco)

- **Só abre com o mouse parado na capa** (~0,2 s); passar por cima não abre. Aberto, fica aberto
  enquanto o mouse estiver em qualquer parte do player (para usar os botões) e fecha ao sair dele.
- A capa vira um vinil girando (para quando pausa), o nome em até 2 linhas, o tempo andado / total
  ao vivo, e o botão "anterior" (`.pm-so-aberto`, só aparece aberto).
- O cartão "Limites de uso" sobe junto (`--player-aberto`, medido com `ResizeObserver`).
- Classes: `.player-midia.aberto`, `.pausado`, `.sem-tempo`.

## Vídeo no canto

O botão de vídeo do player abre o [vídeo no canto](video-no-canto.md); some para apps só de áudio
(Spotify, Deezer...).
