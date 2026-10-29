// Segredos que o app desktop passa ao servidor por variáveis de ambiente.
// São lidos aqui uma vez e APAGADOS do process.env, para não vazarem por herança para os
// processos que o servidor sobe (Claude Code, comandos Bash, terminais). Este módulo precisa
// ser o primeiro require do server.js.
const navegador = {
    porta: process.env.PAINEL_NAVEGADOR_PORTA || null,
    token: process.env.PAINEL_NAVEGADOR_TOKEN || null,
};
delete process.env.PAINEL_NAVEGADOR_PORTA;
delete process.env.PAINEL_NAVEGADOR_TOKEN;
// No Red Code.exe o servidor roda no Node do próprio exe (ELECTRON_RUN_AS_NODE=1). Herdada, essa
// variável faria qualquer app Electron aberto pelos terminais (VS Code, por exemplo) virar Node.
delete process.env.ELECTRON_RUN_AS_NODE;

module.exports = { navegador };
