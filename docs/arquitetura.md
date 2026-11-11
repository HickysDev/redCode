# Arquitetura

## Três partes

```text
desktop/main.js (Electron)  ── sobe como processo filho ──►  server.js (Node, porta 4317)
        │ janela, bandeja, atalho global,                          │ lê os transcripts do Claude Code,
        │ atualização, janelas extras                              │ conversa pelo SDK, git, terminal...
        ▼                                                          ▼
   index.html (a página) ───────── fetch /api/... (X-Painel: 1) ───┘
```

- **`desktop/main.js`**: casca do Electron. Abre a janela, a bandeja, o atalho global, a tela de
  abertura e as janelas extras (editor, vídeo solto). Sobe o `server.js` como processo filho e o
  sobe de novo se ele cair. Empacotado, o próprio `Red Code.exe` roda o servidor
  (`ELECTRON_RUN_AS_NODE`); pelo código, usa o Node do sistema.
- **`server.js`**: servidor HTTP local, só Node. Lê `~/.claude/projects` e entrega o estado de cada
  conversa, conversa com o Claude Code pelo SDK (`chat.js`) e expõe git, terminal, editor, mídia etc.
- **`index.html`**: a página principal inteira (HTML, CSS e JS num arquivo só, sem framework). Fala
  com o servidor por `fetch` com `X-Painel: 1`; as rotas sensíveis checam `requisicaoConfiavel(req)`.
- **`desktop/preload.js`**: a ponte `window.painelDesktop` (mostrar a janela, atualização, atalho
  global, vídeo solto...). A página não tem acesso ao Node.

## Módulos do servidor

| Arquivo | Faz |
|---|---|
| `chat.js` | Conversa pelo SDK do Claude Code; permissões, perguntas e tarefas em segundo plano (`tarefasBg`) |
| `perfis.js` | Perfis = conta do Claude (`CLAUDE_CONFIG_DIR`) + identidade do Git; trocar de perfil sobe o servidor de novo |
| `login.js` | Estado do login e `claude auth login`. Não há logout de propósito |
| `git-scm.js`, `worktrees.js` | Painel Git e cópias isoladas para conversas em paralelo |
| `editor-arquivos.js`, `editor.js`, `editor-md.js`, `formatador.js` | Editor (Monaco), preservando a codificação dos arquivos |
| `terminal.js` | Terminal por WebSocket (node-pty) |
| `midia.js` + `midia.ps1` | Player do rodapé (mídia do Windows) — [player-de-midia.md](player-de-midia.md) |
| `video-navegador.js`, `video-nativo.js` + `video-navegador.ps1`, `players-externos.js`, `ytm-desktop.js`, `clipe.js` | Vídeo no canto e Integrações — [video-no-canto.md](video-no-canto.md) |
| `novidades.js` | O que entrou em cada versão — [versoes-e-publicacao.md](versoes-e-publicacao.md) |
| `automacao.js`, `alem.js`, `integracoes.js`, `plugins.js`, `vscode-ponte.js` | Agendadas e fila, busca e resumo, GitHub/Trello/hooks, plugins, ponte com o VS Code |
| `segredos.js` | Lê os segredos que o app passa por variável de ambiente e os apaga do `process.env` |
| `desktop/atualizacao.js` | Atualização ao abrir (exe pela release, código pelo git) |
| `desktop/navegador.js` | Navegador embutido que o Claude controla |

## Dados

| Onde | O quê |
|---|---|
| `%APPDATA%\Red Code` | Exe: dados do app, `servidor.log`, `app.log`, `atalhos.json`, `ytm-desktop.json`, `players-externos.json`, `bin\yt-dlp.exe` |
| Pasta do clone | Rodando pelo código: `dados.json`, `servidor.log` e afins ficam na própria pasta (ignorados no git) |
| `localStorage` da página | Preferências da tela (`painelPref_*`: tema, vídeo, atalhos, novidades vistas...) |
| `~/.claude` (ou `CLAUDE_CONFIG_DIR` do perfil) | Transcripts, `settings.json` (ex.: `autoCompactWindow`) — do Claude Code, não do app |

O clone aberto pelo `electron.exe` sem `--user-data-dir` usa a mesma pasta `Roaming\Red Code` do exe,
para ter o mesmo tema e as mesmas preferências. Com isso, os dois dividem também a trava de instância
única: abrir um com o outro aberto só traz o primeiro para a frente.

## Portas e o modo anexar

- `PAINEL_PORTA` (padrão **4317**) é a porta do servidor; `PAINEL_DADOS` muda a pasta de dados.
- Se já há um Red Code respondendo na porta, o app **anexa** a ele em vez de subir outro servidor.
  A `/api/versao` diz a versão (`versaoApp`); servidor mais velho que o app (ou sem número) recebe o
  pedido de sair quando estiver livre (`assumeServidor`), e o app assume em seguida
  (`confereVersaoAnexado` em `desktop/main.js`).
- O vídeo no canto não depende de porta: cada servidor (4317, ou 4319 do app de teste) lê o navegador e
  o YouTube Music Desktop por conta própria.
