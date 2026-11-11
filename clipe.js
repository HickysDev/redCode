// Vídeo da mídia que está tocando: o servidor diz qual vídeo do YouTube toca e em que segundo (aba selecionada do
// navegador ou player externo ligado em Integrações); aqui toca uma cópia muda dele, sincronizada. A = player do YouTube (incorporado); B = endereço direto só do vídeo, pelo yt-dlp, para o
// vídeo que não deixa incorporar. Usado no quadrinho do canto (index.html) e na janela desanexada (clipe.html).
(function () {
    const ORIGEM_YT = 'https://www.youtube.com';
    const PET_CARREGANDO = '<div class="pet pet-video" style="--cor-pet:#e8483d"><div class="pet-corpo"><span class="pet-boca"></span><span class="pet-balde" aria-hidden="true"><svg viewBox="0 0 14 16" width="14" height="16"><circle cx="3.6" cy="4.4" r="2.6" fill="#fff4d6"/><circle cx="7" cy="3.2" r="2.9" fill="#fff"/><circle cx="10.4" cy="4.4" r="2.6" fill="#fff4d6"/><path d="M1 5.6h12l-1.6 10H2.6z" fill="#fff"/><path d="M3.3 5.6h2l.3 10H4.1zM8.7 5.6h2l-1.1 10H8z" fill="#e8483d"/></svg></span><span class="pet-grao g1"></span><span class="pet-grao g2"></span><span class="pet-grao g3"></span></div><div class="pet-sombra"></div><span class="pet-nome pet-faz">Carregando o vídeo</span></div>';
    const pega = async (url) => { const r = await fetch(url, { headers: { 'X-Painel': '1' } }); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.erro || 'erro'), { codigo: d.codigo }); return d; };
    window.ClipeMusica = function (caixa, opcoes) {
        opcoes = opcoes || {};
        const tela = caixa.querySelector('.clipe-tela');
        const aviso = caixa.querySelector('.clipe-aviso');
        let tempoYtEm = 0, taxaYt = 1, saltoEm = 0, latencia = { A: 0, B: 0 }, medeSalto = null, inicioB = 0, segurando = false;
        // No app: acesso ao <video> de dentro do player do YouTube (tempo exato, velocidade fina); fora dele, a API
        const ytDireto = window.painelDesktop && window.painelDesktop.clipe && window.painelDesktop.clipe.yt;
        let ritmoA = 1, lendoYt = false, anuncioCopia = false, anuncioDesde = 0, temYtdlp = false;
        // Troca para o B: o vídeo que está sendo preparado escondido e os vídeos em que o B não deu certo
        let preparando = null, semDireto = '';
        // O que falta no YouTube Music Desktop para o vídeo chegar (ligar a autorização, aprovar no app)
        let avisoYtm = '', avisoYtmMostrado = '';
        let fonte = null, atualId = '', modo = '', iframe = null, video = null, pronto = false, tempoYt = 0, estadoYt = -1, ultimoAjuste = 0, chamaPlayer = null, pedido = 0, ultimo = null, estado = '';
        const AVISOS = {
            'sem-video': () => 'Nenhum vídeo do YouTube tocando agora. No navegador, deixe a aba do YouTube selecionada (pode minimizar ou cobrir a janela).',
            'so-musica': () => 'Só música: no YouTube Music está no modo "Áudio" (troque para "Vídeo" para ver o clipe).',
            anuncio: () => 'Anúncio no YouTube: o vídeo volta quando ele acabar.',
            carregando: () => 'Carregando o vídeo…',
            'sem-ytdlp': () => 'Para ver o vídeo aqui, o Red Code usa o yt-dlp (baixa só o vídeo, sem a tela do YouTube).',
            falhou: () => 'Não deu para tocar este vídeo aqui.',
        };
        function mudaEstado(novo) {
            if (novo === estado && avisoYtm === avisoYtmMostrado) return;
            estado = novo;
            avisoYtmMostrado = avisoYtm;
            const texto = AVISOS[novo] ? AVISOS[novo]() : '';
            aviso.textContent = texto;
            // Carregando: um pet como o dos agentes, pulando com um play na mão
            if (novo === 'carregando') aviso.innerHTML = PET_CARREGANDO;
            aviso.hidden = !texto;
            if (avisoYtm && novo === 'sem-video') { const linha = document.createElement('small'); linha.style.display = 'block'; linha.style.marginTop = '6px'; linha.textContent = avisoYtm; aviso.appendChild(linha); }
            if (novo === 'sem-ytdlp') aviso.insertAdjacentHTML('beforeend', ' <button type="button" class="mini" data-instalar-ytdlp>Instalar o yt-dlp</button>');
            caixa.classList.toggle('clipe-com-aviso', !!texto && novo !== 'carregando');
            caixa.classList.toggle('clipe-carregando', novo === 'carregando');
            if (opcoes.aoEstado) opcoes.aoEstado(novo);
        }
        aviso.addEventListener('click', async (ev) => {
            const b = ev.target.closest('[data-instalar-ytdlp]');
            if (!b) return;
            b.disabled = true; b.textContent = 'Baixando o yt-dlp…';
            try { await fetch('/api/midia/ytdlp', { method: 'POST', headers: { 'X-Painel': '1' } }).then(r => { if (!r.ok) throw new Error(); }); atualId = ''; }
            catch (e) { b.textContent = 'Não deu para baixar'; }
        });
        function limpa() {
            clearInterval(chamaPlayer);
            if (iframe) { iframe.remove(); iframe = null; }
            if (video) { video.removeAttribute('src'); video.load(); video.remove(); video = null; }
            if (preparando && preparando.v) { preparando.v.removeAttribute('src'); preparando.v.remove(); }
            preparando = null;
            pronto = false; estadoYt = -1; tempoYt = 0; modo = '';
        }
        // Onde o vídeo do navegador está agora: o último tempo recebido + o que passou desde então (se tocando)
        function tempoAgora() {
            if (!fonte) return 0;
            const passou = fonte.pausado || fonte.anuncio || fonte.esperando ? 0 : Math.max(0, (Date.now() - fonte.lidoEm) / 1000) * (fonte.taxa || 1);
            return fonte.tempo + passou;
        }
        const manda = (msg) => { if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), ORIGEM_YT); };
        const comando = (func, args) => manda({ event: 'command', func, args: args || [] });
        // A: player do YouTube incorporado, mudo, sem controles
        function tocaIncorporado(id) {
            limpa();
            modo = 'A';
            mudaEstado('carregando');
            iframe = document.createElement('iframe');
            iframe.allow = 'autoplay; encrypted-media';
            iframe.referrerPolicy = 'strict-origin-when-cross-origin';
            iframe.src = `${ORIGEM_YT}/embed/${id}?enablejsapi=1&autoplay=1&mute=1&controls=0&rel=0&playsinline=1&iv_load_policy=3&cc_load_policy=0&disablekb=1&fs=0&start=${Math.floor(tempoAgora())}&origin=${encodeURIComponent(location.origin)}`;
            // O player só manda eventos depois de ouvir "listening": repete até ele dizer que está pronto
            iframe.addEventListener('load', () => {
                let vezes = 0;
                clearInterval(chamaPlayer);
                chamaPlayer = setInterval(() => { if (pronto || ++vezes > 40) return clearInterval(chamaPlayer); manda({ event: 'listening' }); }, 250);
            });
            tela.appendChild(iframe);
        }
        // Com o yt-dlp: o B é o mais preciso (medido: ~20 ms, sem anúncio) mas leva uns segundos para ter o endereço.
        // Então o A aparece primeiro e o B se prepara escondido por baixo: quando fica a menos de 60 ms do navegador
        // (ou passados 8 s), assume no lugar do A, sem piscar
        async function preparaDireto(id) {
            if (preparando || semDireto === id || modo !== 'A') return;
            preparando = { id };
            let url;
            try { url = (await pega('/api/midia/video-url?id=' + encodeURIComponent(id))).url; }
            catch (e) { semDireto = id; preparando = null; return; }
            if (atualId !== id || modo !== 'A') { preparando = null; return; }
            const v = Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true });
            v.style.opacity = '0';
            preparando = { id, v, desde: Date.now(), perto: 0 };
            v.addEventListener('error', () => { if (preparando && preparando.v === v) { v.remove(); preparando = null; semDireto = id; } });
            v.addEventListener('loadedmetadata', () => { v.currentTime = tempoAgora() + 0.3; });
            v.src = url;
            tela.insertBefore(v, tela.firstChild);
        }
        // Chamado a cada volta da sincronia: acerta o B escondido pelo ritmo e troca quando ele está junto
        function acertaPreparado() {
            const pr = preparando;
            if (!pr || !pr.v) return;
            if (pr.id !== atualId || modo !== 'A') { pr.v.remove(); preparando = null; return; }
            const v = pr.v;
            if (v.readyState < 2) return;
            const parado = fonte && (fonte.pausado || fonte.anuncio || fonte.esperando);
            if (parado) { if (!v.paused) v.pause(); return; }
            if (v.paused) v.play().catch(() => { });
            const dif = tempoAgora() - v.currentTime;
            if (Math.abs(dif) > 2) { v.currentTime = tempoAgora() + 0.3; return; }
            v.playbackRate = (fonte.taxa || 1) * (1 + Math.max(-0.1, Math.min(0.1, dif * 0.5)));
            pr.perto = Math.abs(dif) < 0.06 ? pr.perto + 1 : 0;
            if (pr.perto >= 3 || Date.now() - pr.desde > 8000) {
                // Assume: some o A, o B fica no lugar
                clearInterval(chamaPlayer);
                if (iframe) { iframe.remove(); iframe = null; }
                pronto = false; estadoYt = -1; tempoYt = 0; tempoYtEm = 0;
                video = v; video.style.opacity = '';
                video.addEventListener('error', () => { if (video === v) mudaEstado('falhou'); });
                modo = 'B'; preparando = null; saltoEm = Date.now(); inicioB = Date.now();
                if (opcoes.aoProporcao && v.videoWidth) opcoes.aoProporcao(v.videoWidth / v.videoHeight);
                if (estado === 'carregando') mudaEstado('');
            }
        }
        // B: endereço direto só do vídeo (yt-dlp) num <video> daqui
        async function tocaDireto(id) {
            limpa();
            modo = 'B';
            mudaEstado('carregando');
            const meu = ++pedido;
            let url;
            try { url = (await pega('/api/midia/video-url?id=' + encodeURIComponent(id))).url; }
            catch (e) { if (meu === pedido) mudaEstado(e.codigo === 'sem-ytdlp' ? 'sem-ytdlp' : 'falhou'); return; }
            if (meu !== pedido || atualId !== id) return;
            video = Object.assign(document.createElement('video'), { muted: true, autoplay: true, playsInline: true });
            video.addEventListener('loadedmetadata', () => { video.currentTime = tempoAgora() + 0.3; inicioB = Date.now(); if (opcoes.aoProporcao && video.videoWidth) opcoes.aoProporcao(video.videoWidth / video.videoHeight); });
            video.addEventListener('playing', () => { if (estado === 'carregando') mudaEstado(''); });
            // Com a música pausada o "playing" não vem: o primeiro quadro já basta para sair do carregando
            video.addEventListener('loadeddata', () => { if (estado === 'carregando') mudaEstado(''); });
            video.addEventListener('error', () => { if (video) mudaEstado('falhou'); });
            video.src = url;
            tela.appendChild(video);
        }
        window.addEventListener('message', aoMensagem);
        function aoMensagem(ev) {
            if (!iframe || ev.source !== iframe.contentWindow) return;
            let d;
            try { d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
            if (!d || !d.event) return;
            if (d.event === 'onReady' || (d.event === 'initialDelivery' && !pronto)) { pronto = true; comando('mute'); sincroniza(true); mudaEstado(''); }
            // 101/150/153: o dono não deixa tocar fora do YouTube (ou falta a origem) -> B
            else if (d.event === 'onError') { if (modo === 'A' && atualId) tocaDireto(atualId); }
            else if (d.event === 'onStateChange') estadoYt = d.info;
            else if (d.event === 'infoDelivery' && d.info) {
                if (typeof d.info.currentTime === 'number') { tempoYt = d.info.currentTime; tempoYtEm = Date.now(); }
                if (typeof d.info.playbackRate === 'number') taxaYt = d.info.playbackRate;
                if (typeof d.info.playerState === 'number') estadoYt = d.info.playerState;
            }
        }
        // Onde a cópia está agora (no player do YouTube: o último informe + o que passou, se tocando)
        function copiaAgora() {
            if (modo === 'B') return video && video.readyState >= 1 ? video.currentTime : null;
            if (modo === 'A' && pronto && tempoYtEm) return tempoYt + (estadoYt === 1 ? (Date.now() - tempoYtEm) / 1000 * (taxaYt || 1) : 0);
            return null;
        }
        // Ajustes da sincronia (window.__clipeAjustes troca para medir outras estratégias)
        // B (vídeo direto): ritmo a cada 100 ms, zona morta de 15 ms -> ~10-20 ms de diferença (mediana). A (player do
        // YouTube): ele não acelera de verdade quando a velocidade muda, então pula a partir de 0,25 s, compensando o
        // tempo que o player leva para voltar a tocar -> ~80 ms
        const AJUSTES = { estrategia: 'ritmo', limiteA: 0.25, limiteB: 0.5, esperaA: 3000, esperaB: 2000, limiteSalto: 2, ganho: 0.4, maxRitmo: 0.1, zona: 0.015, compensa: true, frequencia: 100 };
        const ajustes = () => Object.assign({}, AJUSTES, window.__clipeAjustes || {});
        function pula(alvo, aj) {
            const lat = aj.compensa ? latencia[modo] : 0;
            saltoEm = Date.now();
            if (modo === 'A') comando('seekTo', [alvo + lat, true]); else video.currentTime = alvo + lat;
            // Mede quanto o pulo atrasou (o player leva um tempo para voltar a tocar) e aprende para o próximo
            if (aj.compensa) medeSalto = Date.now() + (modo === 'A' ? 1800 : 1000);
        }
        // Acompanha o navegador: tocar/pausar, velocidade e posição
        function sincroniza(forca) {
            if (!fonte || !modo) return;
            if (preparando) acertaPreparado();
            const aj = ajustes();
            // Carregando no navegador (buffer): espera junto, senão a cópia sai na frente
            const parado = fonte.pausado || fonte.anuncio || fonte.esperando;
            const alvo = tempoAgora();
            const taxa = fonte.taxa || 1;
            // No app: lê o <video> do player direto (tempo exato, anúncio, ritmo); já com imagem, o player está pronto
            // mesmo que o aviso "onReady" por mensagem ainda não tenha chegado (às vezes demora vários segundos)
            if (modo === 'A' && ytDireto && aj.direto !== false && !lendoYt) {
                lendoYt = true;
                ytDireto(ritmoA).then((i) => {
                    lendoYt = false;
                    if (!i || modo !== 'A') return;
                    anuncioCopia = !!i.anuncio;
                    if (i.anuncio) return;
                    tempoYt = i.t; tempoYtEm = Date.now(); taxaYt = i.r;
                    if (!i.p && estadoYt !== 3) estadoYt = 1;
                    if (!pronto && i.pronto >= 2) { pronto = true; comando('mute'); mudaEstado(''); }
                }, () => { lendoYt = false; });
            }
            if (modo === 'A' && pronto) {
                // 1 = tocando, 3 = carregando
                if (!parado && estadoYt !== 1 && estadoYt !== 3) comando('playVideo');
                if (parado && (estadoYt === 1 || estadoYt === 3)) comando('pauseVideo');
            } else if (modo === 'B' && video && video.readyState >= 1) {
                if (parado && !video.paused) video.pause();
                if (!parado && video.paused && !segurando) video.play().catch(() => { });
            } else return;
            const copia = copiaAgora();
            if (copia == null) return;
            const dif = alvo - copia;   // > 0: a cópia está atrás
            // Só aprende com diferença pequena (uma grande é troca de música ou pulo no navegador, não atraso do pulo)
            if (medeSalto && Date.now() >= medeSalto && !parado) { if (Math.abs(dif) < 1.5) latencia[modo] = Math.max(0, Math.min(1.5, latencia[modo] + dif * 0.7)); medeSalto = null; }
            const ritmoFino = modo === 'B' || aj.ritmoA === true;
            if (aj.estrategia === 'ritmo' && ritmoFino && !parado) {
                // Diferença pequena: acelera ou freia um pouco até alcançar (sem pular, a imagem não engasga)
                if (forca || Math.abs(dif) > aj.limiteSalto) { if (forca || Date.now() - saltoEm > 2500) pula(alvo, aj); return; }
                // B à frente: para exatamente pela diferença (o trecho já está carregado, volta na hora) -- mais certo que pular
                if (modo === 'B' && dif < -(aj.segura || 0.12) && dif > -3) {
                    if (!segurando) { segurando = true; video.pause(); setTimeout(() => { segurando = false; if (modo === 'B' && video && fonte && !fonte.pausado) video.play().catch(() => { }); }, Math.max(0, -dif * 1000 - 15)); }
                    return;
                }
                if (segurando) return;
                // Recém-entrado (até 8 s): o vídeo entra com uns décimos de atraso; pular acerta em ~1 s, o ritmo levaria vários
                if (modo === 'B' && Date.now() - inicioB < 8000 && Math.abs(dif) > (aj.saltoInicio || 0.2) && Date.now() - saltoEm > 1200) { pula(alvo, aj); return; }
                const ritmo = Math.abs(dif) < aj.zona ? taxa : taxa * (1 + Math.max(-aj.maxRitmo, Math.min(aj.maxRitmo, dif * aj.ganho)));
                if (modo === 'B') { if (Math.abs(video.playbackRate - ritmo) > 0.004) video.playbackRate = ritmo; }
                else if (ytDireto && aj.direto !== false) ritmoA = ritmo;
                else comando('setPlaybackRate', [Math.round(ritmo * 100) / 100]);
                return;
            }
            // Pular quando passa do limite
            if (modo === 'B') { if (video.playbackRate !== taxa) video.playbackRate = taxa; }
            else { ritmoA = taxa; comando('setPlaybackRate', [taxa]); }
            const limite = modo === 'A' ? aj.limiteA : aj.limiteB, espera = modo === 'A' ? aj.esperaA : aj.esperaB;
            if (forca || (Math.abs(dif) > limite && Date.now() - saltoEm > espera)) pula(alvo, aj);
        }
        // O que o servidor sabe agora (navegador ou player externo)
        async function le() {
            let r;
            try { r = await pega('/api/midia/video'); } catch (e) { return; }
            temYtdlp = !!r.ytdlp;
            avisoYtm = (r.avisosPlayers || []).join(' · ');
            if (temYtdlp && modo === 'A' && atualId && !preparando && semDireto !== atualId && (window.__clipeAjustes || {}).trocaB !== false) preparaDireto(atualId);
            if (modo === 'A' && anuncioCopia && temYtdlp && atualId) {
                if (!anuncioDesde) anuncioDesde = Date.now();
                else if (Date.now() - anuncioDesde > 1500) { anuncioDesde = 0; anuncioCopia = false; tocaDireto(atualId); }
            } else anuncioDesde = 0;
            const v = r.video;
            // Relógio do servidor x daqui: o "lidoEm" vira hora local
            fonte = v ? { ...v, lidoEm: Date.now() - Math.max(0, (r.agora || 0) - v.recebidoEm) } : null;
            if (!v) { limpa(); atualId = ''; return mudaEstado('sem-video'); }
            if (v.modo && /ATV/.test(v.modo)) { limpa(); atualId = ''; return mudaEstado('so-musica'); }
            if (v.id !== atualId) {
                atualId = v.id;
                latencia = { A: 0, B: 0 }; medeSalto = null;
                if (opcoes.aoProporcao) opcoes.aoProporcao(16 / 9);
                if (opcoes.aoTrocar) opcoes.aoTrocar(v);
                // Endereço direto já buscado (a fila foi buscada antes): vai direto para o B, que entra em ~1 s
                // Só o endereço direto (yt-dlp): o player do YouTube incorporado mostra título, logo e botão de play por
                // cima do vídeo (a cada pulo da sincronia) e não dá para esconder. Sem yt-dlp: pede para instalar.
                // (__clipeAjustes.incorporado liga o player do YouTube só para testes)
                if ((window.__clipeAjustes || {}).incorporado) tocaIncorporado(v.id);
                else if (temYtdlp) tocaDireto(v.id);
                else { limpa(); mudaEstado('sem-ytdlp'); }
            }
            if (v.anuncio) mudaEstado('anuncio');
            else if (estado === 'anuncio') mudaEstado(pronto || (video && !video.paused) ? '' : 'carregando');
            sincroniza(false);
        }
        // A cada 250 ms (é tudo no próprio PC): pausa, pulo e troca de música do navegador chegam rápido
        const relogio = setInterval(le, 250);
        let relogioSinc = null;
        const ligaSinc = () => { clearInterval(relogioSinc); relogioSinc = setInterval(() => sincroniza(false), ajustes().frequencia); };
        ligaSinc();
        le();
        return {
            // Compatível com a chamada do player do Windows (não precisa mais: quem manda é o servidor)
            atualiza() { },
            atual: () => fonte,
            // Onde a cópia está (para conferir a sincronia)
            tempoCopia: () => modo === 'B' ? (video ? video.currentTime : null) : (pronto ? tempoYt : null),
            modo: () => modo,
            // Usa o endereço direto (B) no vídeo atual, mesmo que ele deixe incorporar (teste e conserto manual)
            forcaDireto: () => { if (atualId) tocaDireto(atualId); },
            estado: () => estado,
            // Medição: onde o vídeo do navegador está e onde a cópia está, agora
            medida: () => ({ alvo: fonte ? tempoAgora() : null, copia: copiaAgora(), modo, anuncioCopia, latencia: { ...latencia }, ritmo: modo === 'B' && video ? video.playbackRate : taxaYt }),
            religaSinc: ligaSinc,
            destroi() { clearInterval(relogio); clearInterval(relogioSinc); window.removeEventListener('message', aoMensagem); pedido++; limpa(); },
        };
    };
})();
