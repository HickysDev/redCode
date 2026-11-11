# Versões, novidades e publicação

## Regra

Quando o usuário pede **commit e push**, a entrega é a versão nova completa, sem perguntar de novo:

1. **Versão**: subir o `version` do `package.json` (1.0.9 → 1.0.10). Uma versão por publicação.
2. **Novidades**: acrescentar a versão no topo do `novidades.js` com o que entrou.
3. **Commit**: `git add` só dos arquivos da tarefa (nunca `-A`). Mensagem
   `Versao X.Y.Z: resumo` + lista do que entrou + linha `Co-Authored-By`.
4. **Push** no `main`.
5. **Exe**: `node empacotar.js` → `dist/Red Code/Red Code.exe` e `dist/RedCode-portatil-win64.zip`.
6. **Release**: `node ferramentas/publicar-release.js` (tag `vX.Y.Z`, notas do `novidades.js`, zip
   anexado). No fim o script confere que a versão anterior enxerga a nova.

Sem pedido de push, não publicar: só deixar pronto e perguntar.

## novidades.js

```js
module.exports = [
    { versao: '1.0.9', data: '2026-11-11', itens: [
        'Player com disco: passe o mouse na capa do player e ela vira um vinil girando, com ...',
    ] },
    // ... versões anteriores, a mais nova em cima
];
```

- Um item por novidade, do jeito que a pessoa usa: **"Título curto: o que mudou"** (o título vira
  negrito no modal). Correção também entra, se a pessoa percebia o problema.
- O mesmo texto vira a nota da release no GitHub.
- A tela mostra num modal, na primeira abertura depois de atualizar, as versões entre a que estava
  instalada (`painelPref_novidadesVistas`) e a atual. Fica "vista" só ao fechar o modal (a página
  recarrega quando o servidor sobe). Na primeira vez com o recurso, mostra só a atual.
- **Configurações › Sistema › Ver novidades** mostra de novo só a última atualização baixada
  (`painelPref_novidadesDesde`), não o histórico inteiro.
- Rota: `GET /api/novidades` → `{ versaoApp, versoes }` (relê o arquivo a cada pedido).

## Como o app se atualiza

- **Exe**: ao abrir e de 6 em 6 h, `desktop/atualizacao.js` consulta a última release; achando
  versão maior com um asset `/portatil.*\.zip$/`, mostra o cartão acima do player. Baixa, extrai e
  troca a pasta do programa ao fechar. Os dados em `%APPDATA%\Red Code` não são tocados.
- **Configurações › Sistema › Buscar atualizações** confere na hora (e traz de volta uma versão
  dispensada).
- **Pelo código (clone)**: ao abrir, `git fetch` + `pull --ff-only` se a pasta estiver limpa. O
  `package-lock.json` alterado sozinho é restaurado antes; outras alterações locais travam o pull e o
  log diz quais arquivos. Mudou `package.json` → `npm install`; mudou `desktop/` → o app reabre.

## Empacotar

`empacotar.js` copia o Electron de `node_modules`, os arquivos `.js/.html/.svg/.ps1` da raiz, a pasta
`desktop/` e só as dependências de produção. Arquivo novo na raiz com essas extensões
entra sozinho; pasta nova precisa ser acrescentada no `empacotar.js`. `ferramentas/` não vai no exe.
