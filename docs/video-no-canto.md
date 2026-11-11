# Vídeo no canto

Mostra, numa janelinha do Red Code, uma **cópia muda** do vídeo que está tocando no YouTube / YouTube
Music, sincronizada com o que a pessoa ouve. **Não lê a tela**: quem diz o vídeo e o segundo é a fonte; o Red
Code toca a cópia por conta própria. Funciona **sem instalar nada** (leitura nativa do navegador); a extensão do
navegador é **opcional** e deixa mais preciso.

| Fonte | Como | Precisão | Quando vale |
|---|---|---|---|
| Extensão do navegador (`extensao/`, opcional) | o player do YouTube diz o tempo exato, a fila e anúncio/modo Áudio | ~10-20 ms; próxima música pronta (< 1 s) | **manda** sempre que falou nos últimos 15 s |
| Leitura nativa (`video-nativo.js` + `video-navegador.ps1`) | mídia do Windows + endereço da aba selecionada | posição que o navegador informa ao Windows; troca de música 6-8 s (sem fila) | sem extensão ativa (ex.: Chrome, outro navegador) |
| YouTube Music Desktop (`ytm-desktop.js`, Integrações) | Companion Server do app | posição do app a cada 1 s | ligado em Integrações |

`atual()` (`video-navegador.js`): cada estado guarda a `fonte` e a chave é `fonte:aba` (id de aba da extensão
e janela da leitura nativa não se misturam). Com a extensão falando há menos de 15 s, as entradas `nativo` saem
da conta: o mesmo vídeo visto pelos dois caminhos às vezes tem outro id (YouTube Music em modo Vídeo: a aba
mostra o id da música e a extensão o do clipe). Entre o que sobra vale a regra de `mudouEm` abaixo.

**Custo da leitura nativa**: medido ~12% de um núcleo (1,5% da máquina de 8 núcleos, 110 MB) enquanto ligada.
Por isso o servidor só a liga quando a extensão não falou nos últimos 30 s (`videoNavegador.extensaoAtiva()`):
com a extensão, ela fica desligada; sem extensão, liga sob demanda e desliga 60 s depois do último uso.

**Extensão do navegador**: instalar em **Configurações › Integrações › Navegador** (Brave e Edge pelos atalhos
com `--load-extension`, `instala-extensao.ps1`, com backup; o Chrome 137+ ignora a opção: só à mão). Ela manda
o estado para `POST /api/midia/video` (só com o cabeçalho `X-Redcode-Extensao` e origem `chrome-extension://`).
`principal.js` roda no mundo da página e pergunta ao player (`getCurrentTime`, `getVideoData`, a fila); a trava
`window.__redcodePrincipal` tem versão (a nova desliga a antiga ao recarregar a extensão).

## De onde vem o vídeo

```text
video-navegador.ps1 (mídia do Windows + UI Automation) ─► video-nativo.js ─┐ (aba = janela do navegador)
ytm-desktop.js (Companion Server :9863, a cada 1 s) ── players-externos.js ┤ (aba -9863)
                                                                           ▼
                                 video-navegador.js: estado por aba, atual(), yt-dlp
                                                                           │ GET /api/midia/video
                                                                 clipe.js (na página)
```

- **Navegador comum, sem extensão** (`video-navegador.ps1` + `video-nativo.js`): Chrome, Edge, Brave,
  Opera, Vivaldi, Firefox e outros. O script junta as sessões de mídia do Windows (título, tocar/pausar,
  posição) com as janelas do navegador: a janela cujo **título** (= aba selecionada) contém o título da
  música tem o **endereço lido da barra** pela UI Automation, e dele sai o id do vídeo. Por isso o vídeo
  só aparece com a **aba do YouTube selecionada** na janela dela (minimizada ou coberta vale).
  - Não desce em `Document` (ler a página ligaria a acessibilidade do site e pesaria no navegador). O
    endereço só é relido quando o título da janela muda (ou a cada 10 s).
  - No Opera o endereço fica num Edit dentro de outro Edit vazio: o script desce dentro de Edit.
  - Casamento: primeiro pelo título (preferindo a sessão do mesmo navegador da janela); reserva só com
    uma sessão daquele navegador e uma única janela com "youtube" no título (YouTube Music, título
    diferente da música).
  - Tempo = `Position + (agora - LastUpdatedTime) x taxa`. Cuidado no PowerShell: `[math]::Max(0, x)`
    escolhe a versão inteira e arredonda; usar `0.0`.
  - Liga sob demanda (como o `midia.js`): ao abrir o vídeo e também quando o player do rodapé vê um
    navegador tocando (`ehNavegador` em `/api/midia`), para o vídeo e o yt-dlp já estarem prontos.
    60 s sem uso, desliga. Cada processo guarda a própria instância (`const meu`): saída atrasada do
    antigo é ignorada.
  - Testado no Opera. Chrome, Edge e Firefox com vídeo tocando ainda sem teste ponta a ponta.
- **Players externos** (`players-externos.js`, aba **Configurações › Integrações › Music Player**):
  registro de integrações ligadas (`players-externos.json`). Hoje só o **YouTube Music Desktop**
  (`ytm-desktop.js`): Integrar abre os passos (Companion server e "Enable companion authorization") e
  Ativar pareia (token em `ytm-desktop.json`); lê `/api/v1/state` a cada 1 s e entrega como a aba
  `-9863`. Desativar guarda o pareamento. Resposta que chega depois de desativar é descartada
  (`valeAinda`). Novo player = novo item em `PLAYERS` com `configura/estado/jaPareou/liga/desliga`.
- **Qual vídeo vai para o canto** (`atual()`): o que começou a tocar por último; sem nenhum tocando, o
  que mudou de estado por último (`mudouEm`: id, tocar/pausar ou pulo de tempo). Sinal repetido não
  conta, nem a aba que some por um ciclo e volta igual (senão duas fontes pausadas se revezam).

## Como a cópia toca (`clipe.js`)

- **A — player do YouTube incorporado**: entra rápido, mas muitos clipes não deixam incorporar e ele
  mostra anúncio. No app, `painel:clipe-yt` entra no quadro do player e lê o tempo exato.
- **B — endereço direto pelo yt-dlp** (`<video>` próprio, só vídeo até 720p): o mais preciso
  (~10-20 ms). O endereço leva ~4,5 s para sair, fica em cache 3 h e as **próximas da fila são
  buscadas antes** (duas de cada vez). Com o endereço já pronto (`urlPronta`), entra direto no B.
- Sem endereço pronto: A primeiro e B preparado escondido, que assume quando fica a menos de 60 ms.
- **Sincronia** (B): ritmo fino a cada 100 ms (zona morta 15 ms, ganho 0,4, até ±10%); cópia à
  **frente** pausa exatamente pela diferença; nos primeiros 8 s, pula quando passa de 0,2 s
  (compensando o atraso aprendido do pulo). Anúncio na cópia por mais de 1,5 s → vai para o B.
- Medidas: troca de música com endereço pronto ~0,8 s de imagem e 0,2-0,4 s para acertar; sem
  endereço, 6-8 s (yt-dlp).

## Na tela

- Encaixado acima do player (a lista sobe), com alça no canto de baixo à direita para diminuir.
- Arrastar: solta do canto e flutua; soltar em cima do player encaixa de volta.
- **Arrastar para fora da janela do Red Code** e soltar: vira janela própria, sempre por cima
  (`clipe.html`), nascendo onde foi solta e do mesmo tamanho (`painel:clipe-solta-em`). Também pelo
  botão Desanexar.
- `Alt+V` (configurável) abre ou fecha; com a janela solta, fecha ela. Fechar não mostra aviso.
- Enquanto carrega: pet comendo pipoca. YouTube Music em modo "Áudio" mostra "Só música".
- Fora do app (página aberta no navegador, sem `painelDesktop`), o player incorporado (A) fica em
  "Carregando" sem avisar erro; o vídeo aparece pelo B quando o yt-dlp está instalado.
