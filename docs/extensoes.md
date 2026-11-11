# Extensões do VS Code (.vsix)

O Red Code roda extensões do VS Code **de painel, comandos e configurações** (ex.: Royal Trello Diário).
Não roda extensões de editor: linguagens, depurador, temas, LSP, notebooks, terminal, SCM.

## Para quem usa

- **Instalar**: Configurações › Extensões › "Escolher .vsix…". Aparece a confirmação com nome, versão e
  quem publicou. A extensão roda com as suas permissões, como no VS Code.
- **Usar**: botão de peça no topo da lista (só aparece com extensão instalada; o selo soma os contadores
  da extensão, ex.: textos novos). Abre a gaveta à direita com os painéis dela; o ⋯ tem os comandos e o log.
- **Gerenciar**: na mesma aba — ligar/desligar, reiniciar, configurações (formulário gerado do
  `contributes.configuration`), remover e apagar dados.

## Como funciona

```text
index.html ──/api/extensoes/*──► server.js (rotaExtensoes) ──► extensoes.js ──fork/IPC──► extensoes-host.js
   gaveta, avisos, caixas            requisicaoConfiavel                instalação, eventos,         require('vscode') =
   iframe sandbox ◄── /webview, /arquivo (sem X-Painel, sandbox)        pendentes, config, cofre      extensoes-vscode.js
```

- **`extensoes.js`** (servidor): lê o `.vsix` (zip) na mão e confere **cada nome antes de gravar**
  (`..`, absoluto, `\`, `:`, links, > 200 MB → recusa). Extrai numa pasta `.novo` e só então troca a
  versão antiga. Guarda em `PASTA_DADOS/extensoes/<publisher.nome>/` e `extensoes.json`.
- **Um processo por extensão** (`fork` de `extensoes-host.js`). No exe o fork é o próprio `Red Code.exe`
  com `ELECTRON_RUN_AS_NODE=1` (o `segredos.js` apaga a variável do servidor; o host apaga de novo na 1ª
  linha). Parar = `disconnect` (a extensão roda `deactivate`) e, 2 s depois, `taskkill /T /F` (pega o
  `claude -p` que ela abriu). Servidor saindo: `taskkill` síncrono de todos no `process.on('exit')`.
- **`extensoes-vscode.js`**: a API de mentira. Lista do que existe no topo do arquivo; o que não existe
  avisa "Red Code: vscode.x não é suportado" no log da extensão.
- **Dados** em `PASTA_DADOS/extensoes-dados/<id>/`: `estado.json` (globalState), `config.json` (só o
  servidor grava), `segredos.json` (cada valor cifrado com **DPAPI do usuário**; o valor vai ao PowerShell
  pelo stdin, nunca na linha de comando), `log.txt` (gira em 5 MB).
- **Eventos** servidor → página por long-poll (`/api/extensoes/eventos?desde=`), também com a janela
  escondida (aviso do Windows). Avisos e caixas de digitar ficam **pendentes no servidor** até a página
  responder — recarregar a página mostra de novo.
- **Webview**: `iframe sandbox="allow-scripts allow-forms"` com o HTML servido por
  `/api/extensoes/webview/<id>/<viewId>` com `CSP: sandbox` + `nosniff` (origem opaca, mesmo aberto
  direto numa aba) e `Host` local. A ponte `acquireVsCodeApi` é injetada antes do `<meta>` CSP da
  extensão; o tema vai por `postMessage` (só `--vscode-*`, valores sem `<>{};`). Mensagens para o
  iframe esperam o `pronta` do documento novo. Arquivos da extensão: `/api/extensoes/arquivo/...`
  (`realpath` dentro da pasta, tipos conhecidos).
- **Árvores**: a página pede os itens; o clique manda só o `handle` e o host roda o comando **do item
  guardado** (nunca argumentos vindos da página).

## Credenciais já usadas nas conversas

Quando a caixa de digitar de uma extensão pede a **chave de API ou o token do Trello** (título/texto com "Trello"
e "chave"/"token"), a página chama `GET /api/credenciais-conversas` e mostra "Encontrados nas suas conversas":
`credenciais-conversas.js` procura nos `.jsonl` do Claude Code (conta do perfil e as outras contas ligadas a
conversas), só nos que citam o serviço, por formato (chave = 32 hex; token = 64 hex ou `ATTA…`, sempre logo depois
de `key`/`token`). A lista vai **mascarada** (`d1db…89e5`, conversa e data); o valor inteiro só sai por
`POST /api/credenciais-conversas/valor {id}` (checagem do painel) quando a pessoa clica, e preenche o campo. Nada vai
para log. Teste só com conversas inventadas: `node testes/credenciais-conversas.test.js`.

## Testes

- `node testes/extensoes.test.js [arquivo.vsix]`: sem abrir o app — .vsix malicioso recusado,
  instalação, webview, árvore, arquivos, configuração, cofre DPAPI, caixa pendente, ligar/desligar e
  processos encerrados.
- No app (cópia na 4319): instalar pela aba, gaveta, clique dentro do painel, comandos, caixas (credencial
  **falsa**: nada é gravado no Trello), recarregar com caixa aberta, tema claro/escuro, segurança das rotas.
  O iframe do painel roda em outro processo: para ler/clicar nele pelo CDP, conectar no alvo `iframe` de
  `/json`, não no da página.
- No exe empacotado (`dist/`): o host sobe como Node (3 processos principais: app, servidor, extensão) e
  fechar o app não deixa processo da extensão.
- Extensão que gera texto com o Claude ou envia para fora (Trello): testar só "Simular", nunca enviar.
