# Testes

Teste é no app de verdade, numa **cópia** separada: nunca no Red Code aberto do usuário (porta 4317),
nunca no `settings.json` real dele.

## Subir uma cópia

```js
const app = spawn('node_modules/electron/dist/electron.exe',
    ['desktop/main.js', '--user-data-dir=' + pastaTemporaria, '--remote-debugging-port=9340'],
    { env: { ...process.env, PAINEL_PORTA: '4319', PAINEL_DADOS: pastaTemporaria } });
```

- `--user-data-dir` e `PAINEL_DADOS` numa pasta temporária: perfil limpo, sem tocar nos dados do usuário.
- `PAINEL_PORTA=4319`: a cópia lê o navegador sozinha, então o vídeo no canto funciona nela. O YouTube
  Music Desktop precisa ser ativado na cópia (Configurações › Integrações), com outro pareamento.
- Mexer no `settings.json` do Claude: subir o servidor com `CLAUDE_CONFIG_DIR` apontando para uma
  pasta temporária com um `settings.json` de mentira.
- Precisa do yt-dlp: copiar `bin/yt-dlp.exe` para `<pasta>/bin/`.
- No fim, matar a cópia (`taskkill /F /T /PID`) e conferir que não sobrou `electron.exe` com
  `redcode-teste-` na linha de comando.

## Controlar pela porta de depuração (CDP)

- `GET http://127.0.0.1:9340/json` lista as páginas; a principal é `http://127.0.0.1:4319/`.
- `Runtime.evaluate` roda JS na página (as funções e `let` globais do `index.html` ficam acessíveis:
  `midiaAtual`, `abrePip()`, `abreConfig('atalhos')`...).
- `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` simulam mouse e teclado de verdade (hover,
  arrastar, atalhos). `Page.captureScreenshot` com `clip` tira print de um pedaço.
- A cópia **abre minimizada** quando o Red Code do usuário está aberto: chamar
  `window.painelDesktop.mostrar()` antes, senão `document.hidden` pausa o player e o vídeo.
- A página **recarrega** logo depois que o servidor sobe: esperar ~10 s ou repetir a leitura até o
  estado esperado aparecer.
- Janela coberta por outras: o Chromium congela animações e a pintura. Medir pelo estado (classes,
  `getComputedStyle`, `getAnimations()`), não só pelo print.
- Posição de janela sem moldura: `screenX`/`outerWidth` da página não são confiáveis; ler pelo Windows
  (`GetWindowRect`).

## Conferências depois de mexer

```bash
node --check server.js            # e cada .js mexido
node -e "const s=require('fs').readFileSync('index.html','utf8');const re=/<script>([\s\S]*?)<\/script>/g;let m;while((m=re.exec(s)))new Function(m[1]);console.log('ok')"
```

- PowerShell (`.ps1`): `[System.Management.Automation.Language.Parser]::ParseFile(...)` sem erros.
- Mudança visual: print no tema claro e no escuro.
- Correção de bug: reproduzir o bug antes (ou trocar a função pela versão antiga só na página de
  teste) e mostrar o antes e o depois.
- Processo longo (bateria de testes): andamento num arquivo `ANDAMENTO-*.txt` e, dentro do Red Code,
  `ACOMPANHAR: <caminho>` em vez de abrir janela do PowerShell.
