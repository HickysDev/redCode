// Escolha da fonte do vídeo no canto (video-navegador.js): extensão x leitura nativa x YouTube Music Desktop.
// Sem abrir o app e sem rede (sem yt-dlp configurado). Uso: node testes/video-fontes.test.js
let relogio = 1_000_000;
Date.now = () => relogio;
const anda = (ms) => { relogio += ms; };
let oks = 0, falhas = 0;
const confere = (ok, t) => { ok ? oks++ : falhas++; console.log((ok ? '  ok   ' : '  FALHA ') + t); };
// Módulo novo a cada cenário (o estado das abas é do módulo)
function novo() { delete require.cache[require.resolve('../video-navegador')]; return require('../video-navegador'); }
const sinal = (v, fonte, aba, id, extra = {}) => v.recebe({ aba, id, tempo: 10, duracao: 200, pausado: false, ...(fonte ? { fonte } : {}), ...extra });
const escolhido = (v) => { const a = v.atual().video; return a ? `${a.fonte}:${a.id}` : 'nada'; };

console.log('1. Só a leitura nativa (sem extensão): ela vale');
let v = novo();
sinal(v, null, 123456, 'aaaaaaaaaaa');
confere(escolhido(v) === 'nativo:aaaaaaaaaaa', 'nativo escolhido: ' + escolhido(v));
confere(v.atual().extensao === false, 'Integrações vê a extensão como não detectada');

console.log('2. Extensão e leitura nativa no mesmo vídeo: vale a extensão');
v = novo();
sinal(v, null, 123456, 'aaaaaaaaaaa');
anda(200);
sinal(v, 'extensao', 7, 'aaaaaaaaaaa');
confere(escolhido(v) === 'extensao:aaaaaaaaaaa', 'extensão escolhida: ' + escolhido(v));
// a nativa continua mandando (mais recente): não rouba
for (let i = 0; i < 5; i++) { anda(400); sinal(v, null, 123456, 'aaaaaaaaaaa', { tempo: 10 + i * 0.4 }); }
confere(escolhido(v) === 'extensao:aaaaaaaaaaa', 'a nativa mandando depois não rouba o canto: ' + escolhido(v));
confere(v.atual().extensao === true, 'Integrações vê a extensão como detectada');

console.log('3. YouTube Music em modo Vídeo: extensão com o id do clipe, aba com o id da música');
v = novo();
sinal(v, 'extensao', 7, 'clipe000000');
anda(100);
sinal(v, null, 123456, 'musica00000');
const vistos = new Set();
for (let i = 0; i < 10; i++) { anda(300); if (i % 2) sinal(v, 'extensao', 7, 'clipe000000', { tempo: 10 + i * 0.3 }); else sinal(v, null, 123456, 'musica00000', { tempo: 10 + i * 0.3 }); vistos.add(escolhido(v)); }
confere(vistos.size === 1 && vistos.has('extensao:clipe000000'), 'sempre o clipe da extensão, sem alternar: ' + [...vistos].join(', '));

console.log('4. Extensão parou de falar (aba fechada sem aviso, navegador sem ela): a nativa volta em 15 s');
anda(16000);
sinal(v, null, 123456, 'musica00000', { tempo: 30 });
confere(escolhido(v) === 'nativo:musica00000', 'depois de 15 s sem a extensão, nativo: ' + escolhido(v));

console.log('5. Duas fontes pausadas (Opera e YouTube Music Desktop) com sinais repetidos: não se revezam');
v = novo();
sinal(v, null, 555, 'operaaaaaaa', { pausado: true });
anda(500);
sinal(v, 'ytm', -9863, 'ytmdesktop0', { pausado: true });
const antes = escolhido(v);
const vistos5 = new Set();
for (let i = 0; i < 12; i++) { anda(1000); sinal(v, null, 555, 'operaaaaaaa', { pausado: true }); sinal(v, 'ytm', -9863, 'ytmdesktop0', { pausado: true }); vistos5.add(escolhido(v)); }
confere(vistos5.size === 1 && vistos5.has(antes), `12 leituras, sempre a mesma: ${[...vistos5].join(', ')}`);
// Tocar numa delas: passa para ela
anda(1000); sinal(v, null, 555, 'operaaaaaaa', { pausado: false });
confere(escolhido(v) === 'nativo:operaaaaaaa', 'deu play no Opera: ele vai para o canto');

console.log('6. Mesmo número de aba em fontes diferentes não se mistura');
v = novo();
sinal(v, 'extensao', 42, 'extensao042');
sinal(v, null, 42, 'nativo04200');
v.recebe({ aba: 42, fim: true });   // a nativa fechou a janela 42
confere(escolhido(v) === 'extensao:extensao042', 'o fim da janela 42 da leitura nativa não apaga a aba 42 da extensão: ' + escolhido(v));
v.recebe({ aba: 42, fim: true, fonte: 'extensao' });
confere(escolhido(v) === 'nada', 'fim da aba 42 da extensão: nada no canto');

console.log('7. YouTube Music Desktop sozinho');
v = novo();
sinal(v, 'ytm', -9863, 'ytmdesktop0');
confere(escolhido(v) === 'ytm:ytmdesktop0', 'ytm escolhido: ' + escolhido(v));
// e a extensão falando de outro vídeo não tira o YTM Desktop da conta (só a nativa sai)
anda(100); sinal(v, 'extensao', 3, 'outrovideo0', { pausado: true });
confere(escolhido(v) === 'ytm:ytmdesktop0', 'extensão pausada noutro vídeo: o YTM Desktop tocando continua: ' + escolhido(v));

console.log(`\n${oks} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
