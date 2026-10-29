// Lançador do Painel Claude: sobe o server.js e o sobe de novo quando ele sai pedindo
// reinício (código 75). Assim o botão "Reiniciar quando estiver livre" da página funciona
// sem depender de processo destacado: o servidor espera as conversas pararem e sai sozinho.
const { spawn } = require('child_process');
const path = require('path');

const CODIGO_REINICIO = 75;

function sobe() {
    const servidor = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env, PAINEL_LANCADOR: '1' },
    });
    servidor.on('exit', (codigo, sinal) => {
        if (codigo === CODIGO_REINICIO) {
            console.log(`[lançador] ${new Date().toLocaleTimeString('pt-BR')} reiniciando o servidor com o código novo`);
            return setTimeout(sobe, 500);
        }
        // Encerrado por fora (script de reinício, Ctrl+C) ou erro: o lançador sai junto
        console.log(`[lançador] servidor saiu (código ${codigo}${sinal ? ', sinal ' + sinal : ''}); encerrando`);
        process.exit(codigo || 0);
    });
}

sobe();
