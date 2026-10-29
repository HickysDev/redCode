// Fase 5: tarefas agendadas e fila de pedidos. Roda dentro do servidor (enquanto o painel
// estiver aberto). Nunca aprova nada sozinho: cartões de permissão esperam o usuário.
const crypto = require('crypto');

const MODOS_OK = ['default', 'acceptEdits', 'plan'];
const MODELOS_OK = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const ESFORCOS_OK = ['low', 'medium', 'high'];

function validaPedido(p, pastaConhecida) {
    const texto = String(p.texto || '').trim();
    if (!texto || texto.length > 8000) throw new Error('O texto do pedido precisa ter de 1 a 8000 caracteres.');
    if (!pastaConhecida(p.cwd)) throw new Error('Pasta de projeto desconhecida: ' + p.cwd);
    const modo = p.modo || 'default';
    if (!MODOS_OK.includes(modo)) throw new Error('Modo não permitido em tarefa automática (use Perguntar, Aceitar edições ou Planejar).');
    const modelo = p.modelo || 'claude-opus-5-5';
    if (!MODELOS_OK.includes(modelo)) throw new Error('Modelo inválido.');
    const esforco = ESFORCOS_OK.includes(p.esforco) ? p.esforco : 'medium';
    return { cwd: String(p.cwd), texto, modo, modelo, esforco };
}

function validaAgendamentos(lista, pastaConhecida, anteriores = []) {
    if (!Array.isArray(lista) || lista.length > 20) throw new Error('Até 20 tarefas agendadas.');
    return lista.map(a => {
        const base = validaPedido(a, pastaConhecida);
        const nome = String(a.nome || '').trim().slice(0, 80) || 'Tarefa';
        const q = a.quando || {};
        let quando;
        if (q.tipo === 'intervalo') {
            const minutos = Math.round(Number(q.minutos));
            if (!(minutos >= 30 && minutos <= 7 * 24 * 60)) throw new Error(`"${nome}": o intervalo precisa ser de pelo menos 30 minutos.`);
            quando = { tipo: 'intervalo', minutos };
        } else {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(q.hora || ''))) throw new Error(`"${nome}": hora inválida (use HH:MM).`);
            const dias = [...new Set((q.dias || []).map(Number).filter(d => d >= 0 && d <= 6))];
            if (!dias.length) throw new Error(`"${nome}": escolha pelo menos um dia.`);
            quando = { tipo: 'dias', hora: q.hora, dias };
        }
        const id = /^[a-f0-9]{12}$/.test(String(a.id)) ? a.id : crypto.randomBytes(6).toString('hex');
        const antes = anteriores.find(x => x.id === id);
        return { id, nome, ...base, quando, ativo: a.ativo !== false, ultima: antes ? antes.ultima : null, criado: antes ? antes.criado : new Date().toISOString() };
    });
}

const SUBIDA = new Date();   // o primeiro intervalo conta a partir da subida do servidor (sem rajada ao abrir)
// Venceu? (não roda atrasado: só na janela atual)
function venceu(a, agora = new Date(), subida = SUBIDA) {
    if (!a.ativo) return false;
    const ultima = a.ultima && a.ultima.hora ? new Date(a.ultima.hora) : null;
    if (a.quando.tipo === 'intervalo') {
        const base = new Date(Math.max(ultima ? ultima.getTime() : 0, new Date(a.criado || agora).getTime(), subida.getTime()));
        return agora - base >= a.quando.minutos * 60000;
    }
    if (!a.quando.dias.includes(agora.getDay())) return false;
    const [h, m] = a.quando.hora.split(':').map(Number);
    const alvo = new Date(agora); alvo.setHours(h, m, 0, 0);
    // Só dentro de 10 min depois da hora marcada (painel fechado na hora = não roda atrasado)
    if (agora < alvo || agora - alvo > 10 * 60000) return false;
    return !(ultima && ultima >= alvo);
}

function validaFila(lista, pastaConhecida) {
    if (!Array.isArray(lista) || lista.length > 50) throw new Error('Até 50 itens na fila.');
    return lista;
}

const PRAZO_PERMISSAO_MS = 3 * 60 * 60 * 1000;   // execução parada num cartão de permissão por 3 h é encerrada

// Liga o agendador e a fila ao servidor
function inicia({ leDados, gravaDados, pastaConhecida, chat, garanteUso, bloqueado, avisa }) {
    let rodandoAgendada = null;   // { id, chave }
    // Ao subir: o que estava "rodando" antes do reinício não está mais (senão a fila trava)
    {
        const d = leDados();
        let mudou = false;
        for (const i of d.fila || []) if (i.status === 'rodando') { i.status = 'erro'; i.erro = 'Interrompido: o painel reiniciou durante a execução.'; mudou = true; }
        for (const a of d.agendamentos || []) if (a.ultima && a.ultima.status === 'rodando') { a.ultima.status = 'interrompida (o painel reiniciou)'; mudou = true; }
        if (mudou) gravaDados(d);
    }
    // Terminou de verdade: ociosa/encerrada, sem cartão pendente e sem agente em segundo plano
    const conversaTerminou = (chave) => {
        const c = chat.estado().find(x => x.chave === chave);
        if (!c || !c.vivo) return true;
        return c.status !== 'rodando' && c.status !== 'parando' && !c.pendentes.length && !chat.agentesRodandoNa(chave);
    };
    // Cartão de permissão esquecido: depois do prazo, nega com explicação e libera a vez
    const pendenteDesde = new Map();
    const venceuPrazo = (chave) => {
        const c = chat.estado().find(x => x.chave === chave);
        if (!c || !c.pendentes.length) { pendenteDesde.delete(chave); return false; }
        if (!pendenteDesde.has(chave)) pendenteDesde.set(chave, Date.now());
        if (Date.now() - pendenteDesde.get(chave) < PRAZO_PERMISSAO_MS) return false;
        for (const p of c.pendentes) chat.responder(p.id, { decisao: 'negar', mensagem: 'Execução automática: ninguém respondeu o pedido de permissão em 3 horas. Pare aqui e resuma o que ficou pendente.' });
        pendenteDesde.delete(chave);
        return true;
    };
    // Uso do plano: precisa estar disponível e abaixo de 90% no limite de 5 h para disparar
    const usoPermite = async () => {
        const uso = await garanteUso();
        return !!(uso && uso.disponivel && uso.limites && !uso.limites.some(l => (l.grupo === 'session' || /sess/i.test(l.nome)) && l.percentual >= 90));
    };
    const dispara = async (pedido, prefixo, aoNascer) => {
        const conversa = await chat.enviar({ ...pedido, texto: prefixo + pedido.texto, aoCriarSessao: (projeto, sessionId) => aoNascer(`${projeto}/${sessionId}`) });
        return conversa.chave;
    };
    const ciclo = async () => {
        const dados = leDados();
        // 1) Agendadas: uma por vez
        if (rodandoAgendada && rodandoAgendada.chave) {   // chave null = começando agora: continua em andamento
            const estourou = venceuPrazo(rodandoAgendada.chave);
            if (estourou || conversaTerminou(rodandoAgendada.chave)) {
                const d = leDados();
                const a = (d.agendamentos || []).find(x => x.id === rodandoAgendada.id);
                if (a && a.ultima) { a.ultima.status = estourou ? 'erro: parou esperando permissão' : 'terminou'; gravaDados(d); avisa({ tipo: 'agendada-terminou', nome: a.nome, sessao: a.ultima.sessao }); }
                rodandoAgendada = null;
            }
        }
        // Reinício seguro agendado: não começa nada novo (senão ele nunca acontece)
        const podeDisparar = !bloqueado() && await usoPermite();
        if (!rodandoAgendada && podeDisparar) {
            const a = (dados.agendamentos || []).find(x => venceu(x) && pastaConhecida(x.cwd));
            if (a) await rodaAgendada(a.id);
        }
        // 2) Fila: um item por vez; pausa com o limite de 5 h acima de 90% ou uso indisponível
        const fila = dados.fila || [];
        const rodando = fila.find(i => i.status === 'rodando');
        if (rodando) {
            const estourou = rodando.chave && venceuPrazo(rodando.chave);
            if (rodando.chave && (estourou || conversaTerminou(rodando.chave))) {
                const d = leDados();
                const it = (d.fila || []).find(i => i.id === rodando.id);
                if (it) {
                    it.status = estourou ? 'erro' : 'feito'; if (estourou) it.erro = 'Parou esperando permissão por 3 h.';
                    it.fim = new Date().toISOString(); gravaDados(d); avisa({ tipo: 'fila-feito', nome: it.texto.slice(0, 60), sessao: it.sessao });
                }
            }
            return;
        }
        if (dados.filaPausada || !podeDisparar) return;
        const prox = fila.find(i => i.status === 'esperando');
        if (!prox) return;
        try {
            const pedido = validaPedido(prox, pastaConhecida);
            const d = leDados();
            const it = d.fila.find(i => i.id === prox.id);
            it.status = 'rodando'; it.inicio = new Date().toISOString();
            gravaDados(d);
            const chave = await dispara(pedido, '[Fila do painel] ', (sessao) => { const d2 = leDados(); const x = (d2.fila || []).find(i => i.id === prox.id); if (x) { x.sessao = sessao; gravaDados(d2); } });
            const d3 = leDados(); const x3 = d3.fila.find(i => i.id === prox.id); if (x3) { x3.chave = chave; gravaDados(d3); }
        } catch (e) {
            const d = leDados(); const it = (d.fila || []).find(i => i.id === prox.id); if (it) { it.status = 'erro'; it.erro = e.message; gravaDados(d); }
        }
    };
    async function rodaAgendada(id) {
        if (rodandoAgendada) throw new Error('Outra tarefa agendada está rodando. Tente quando ela terminar.');
        if (bloqueado()) throw new Error('O painel vai reiniciar assim que estiver livre: tarefas novas esperam o reinício.');
        const d = leDados();
        const a = (d.agendamentos || []).find(x => x.id === id);
        if (!a) throw new Error('Tarefa não encontrada.');
        const pedido = validaPedido(a, pastaConhecida);
        // Reserva a vez ANTES de esperar o início da conversa (dois cliques ou dois ciclos não disparam duas)
        rodandoAgendada = { id, chave: null };
        a.ultima = { hora: new Date().toISOString(), sessao: null, status: 'rodando' };
        gravaDados(d);
        try {
            const chave = await dispara(pedido, `[Tarefa agendada: ${a.nome}] `, (sessao) => { const d2 = leDados(); const x = (d2.agendamentos || []).find(y => y.id === id); if (x && x.ultima) { x.ultima.sessao = sessao; gravaDados(d2); } });
            rodandoAgendada = { id, chave };
        } catch (e) {
            rodandoAgendada = null;
            const d3 = leDados(); const x = (d3.agendamentos || []).find(y => y.id === id); if (x && x.ultima) { x.ultima.status = 'erro: ' + e.message; gravaDados(d3); }
            throw e;
        }
        avisa({ tipo: 'agendada-comecou', nome: a.nome });
        return { ok: true };
    }
    // Um ciclo por vez (o anterior pode demorar: leitura do uso do plano, início de conversa)
    let emCiclo = false;
    const timer = setInterval(async () => {
        if (emCiclo) return;
        emCiclo = true;
        try { await ciclo(); } catch (e) { console.log('automação:', e.message); } finally { emCiclo = false; }
    }, 30000);
    timer.unref();
    return { rodaAgendada, ciclo: async () => { if (emCiclo) return; emCiclo = true; try { await ciclo(); } finally { emCiclo = false; } }, emAndamento: () => rodandoAgendada };
}

module.exports = { inicia, validaAgendamentos, validaPedido, validaFila, venceu };
