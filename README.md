# Red Code

App desktop para Windows (Electron) que acompanha e conversa com o Claude Code. Reúne em uma janela as conversas, o chat com o Claude, terminal embutido, editor, painel Git e um navegador para testes.

## Requisitos

- Claude Code com login feito no PC (conta do usuário).
- Git instalado, para o painel Git.
- VS Code opcional, para abrir arquivos.

## Usar a versão pronta

1. Baixe `RedCode-portatil-win64.zip` na página de Releases do GitHub. O arquivo fica lá porque passa do limite de tamanho do repositório.
2. Extraia numa pasta sua, por exemplo `Documentos\Red Code`. Evite `Arquivos de Programas`.
3. Abra `Red Code.exe`.

Não precisa de Node instalado. Na primeira abertura, o app cria o atalho no Menu Iniciar.

## Rodar pelo código

Requer Node 24 ou superior.

```
npm install
npm run desktop    # abre o app
npm start          # só o servidor; abre no navegador em http://127.0.0.1:4317
```

## Gerar o exe

```
npm install
npm run empacotar
```

Gera `dist\Red Code\Red Code.exe` e `dist\RedCode-portatil-win64.zip`. Não baixa nada além das dependências do `npm install`.

## Onde ficam os dados

Favoritos, vínculos, anexos e logs ficam em `%APPDATA%\Red Code`. Trocar a pasta do app por uma versão nova não apaga esses dados.

As conversas são lidas de `~/.claude/projects`. O servidor local escuta apenas em `127.0.0.1:4317`.

## Observações

- **SmartScreen:** na primeira execução o Windows pode avisar, porque o exe não é assinado. Clique em "Mais informações" e depois em "Executar assim mesmo".
- **Ícone:** o arquivo `Red Code.exe` no Explorer ainda mostra o ícone do Electron. A janela e a barra de tarefas mostram o ícone vermelho do Red Code.
- **Atalhos:** F5 ou Ctrl+R recarrega a página. O ícone na bandeja tem a opção "Sair".
