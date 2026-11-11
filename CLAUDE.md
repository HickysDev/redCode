# CLAUDE.md — Red Code

App desktop (Electron + servidor Node) que acompanha e conversa com o Claude Code. Repositório
`HickysDev/redCode`, branch `main`. Este arquivo tem só o que vale em toda tarefa; o detalhe de cada
assunto está em [docs/](docs/README.md).

## Regras

- **Responder em português.** Textos da tela, comentários e commits também em português.
- **Commit + push pedido = versão nova completa**, sem perguntar de novo: subir a versão no
  `package.json`, registrar o que entrou no `novidades.js`, commit, push, `node empacotar.js` e
  release no GitHub (`node ferramentas/publicar-release.js`). Passo a passo:
  [docs/versoes-e-publicacao.md](docs/versoes-e-publicacao.md).
- **Push só com pedido explícito.** Terminar uma tarefa não é pedido de push: perguntar.
- **Toda novidade visível vai para o `novidades.js`** (é o modal que a pessoa vê ao atualizar e a nota
  da release). Uma frase por item: "Título: o que mudou, do jeito que a pessoa usa".
- **Testar no app antes de dizer que funciona**: cópia do app em porta própria, nunca a do Red Code
  aberto do usuário (4317). Ver [docs/testes.md](docs/testes.md).
- **Não deslogar a conta do Claude** nem mexer no `settings.json` real do usuário em teste (usar
  `CLAUDE_CONFIG_DIR` temporário).
- **Dentro do próprio Red Code, não abrir janela externa do PowerShell** para acompanhar processo
  longo: gravar o andamento num arquivo e imprimir `ACOMPANHAR: <caminho absoluto>`.
- **Imagens para o usuário** (prints, exemplos) vão na resposta como `![descrição](C:\caminho\arquivo.png)`.
- **Exemplos antes de mexer no visual** quando o pedido é aberto ("faça N exemplos"): gerar prints
  com a música/dados reais e deixar a pessoa escolher.

## Código

- Sem framework na tela: `index.html` tem o HTML, o CSS e o JS da página principal; jQuery não é usado.
- Arquivos são **UTF-8** (diferente do ERP Royal). O Edit tool pode ser usado aqui.
- Comentários `//` em português, curtos, explicando o porquê. Nomes em português, palavra inteira.
- Servidor sem dependência nova sem pedido (o `server.js` é só Node). Nada de módulo ES na página.
- Página fala com o servidor por `fetch` com o cabeçalho `X-Painel: 1`; rotas novas checam
  `requisicaoConfiavel(req)`. Rota que vai para `rotaChat` precisa estar na lista de caminhos dela.
- Ao editar por script (node), o arquivo tem linhas CRLF e LF misturadas: procurar o trecho nas duas
  formas. Barra invertida em regex dentro de `node -e` com aspas do bash se perde: preferir o Edit tool.
- Conferir a sintaxe depois de mexer: `node --check arquivo.js`; para o `index.html`, compilar cada
  `<script>` com `new Function(...)` (ver [docs/testes.md](docs/testes.md)).

## Documentação

| Assunto | Arquivo |
|---|---|
| Como o app é montado (processos, módulos, dados, portas) | [docs/arquitetura.md](docs/arquitetura.md) |
| Versão, novidades, exe e release; atualização automática | [docs/versoes-e-publicacao.md](docs/versoes-e-publicacao.md) |
| Testar no app sem mexer no Red Code do usuário | [docs/testes.md](docs/testes.md) |
| Vídeo no canto (extensão opcional, leitura nativa do navegador, Integrações/YouTube Music Desktop, yt-dlp, sincronia) | [docs/video-no-canto.md](docs/video-no-canto.md) |
| Player do rodapé (mídia do Windows, disco ao passar o mouse) | [docs/player-de-midia.md](docs/player-de-midia.md) |
| Atalhos de teclado configuráveis | [docs/atalhos.md](docs/atalhos.md) |
| Lista de conversas (estados, segundo plano, troca de conversa) | [docs/lista-de-conversas.md](docs/lista-de-conversas.md) |
| Extensões do VS Code (.vsix) | [docs/extensoes.md](docs/extensoes.md) |
