// Fase 6, "além do app": busca em todas as conversas, linha do tempo de um arquivo,
// resumo do dia e modelos de pedido. Só leitura dos transcripts (exceto os modelos,
// guardados no dados.json do painel).
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function textoDe(conteudo) {
    if (typeof conteudo === 'string') return conteudo;
    return (conteudo || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}
const limpa = (t) => String(t || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim();
function trecho(t, i, n) { const ini = Math.max(0, i - 70); return (ini ? '…' : '') + t.slice(ini, i + n + 110) + (i + n + 110 < t.length ? '…' : ''); }

// Busca por texto (o que você e o Claude escreveram) ou por arquivo (ferramentas que tocaram nele)
async function busca(sessoes, raiz, termo, tipo, { limite = 80, tempoMs = 9000 } = {}) {
    const q = String(termo || '').trim().toLowerCase();
    if (q.length < 3) throw new Error('Digite pelo menos 3 letras.');
    const fim = Date.now() + tempoMs;
    const achados = [];
    let parouPorTempo = false;
    const fila = [...sessoes];
    // 4 conversas lidas em paralelo; a ordem continua sendo a das mais recentes primeiro
    const trabalhador = async () => {
        while (fila.length && achados.length < limite) {
            if (Date.now() > fim) { parouPorTempo = true; return; }
            await umaSessao(fila.shift());
        }
    };
    const umaSessao = async (s) => {
        const arquivo = path.join(raiz, s.projeto, s.id + '.jsonl');
        let porSessao = 0;
        const rl = readline.createInterface({ input: fs.createReadStream(arquivo, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
        for await (const linha of rl) {
            if (Date.now() > fim || porSessao >= 6 || achados.length >= limite) { rl.close(); break; }
            // Linhas enormes (imagens, resultados longos) só interessam se forem chamada de ferramenta
            if (linha.length > 150000 && (tipo !== 'arquivo' || !linha.includes('"tool_use"'))) continue;
            if (!linha.toLowerCase().includes(q)) continue;   // filtro barato antes do JSON
            let r; try { r = JSON.parse(linha); } catch (e) { continue; }
            if (r.isSidechain || !r.message) continue;
            if (tipo === 'arquivo') {
                for (const b of Array.isArray(r.message.content) ? r.message.content : []) {
                    if (!b || b.type !== 'tool_use' || !b.input) continue;
                    const caminho = b.input.file_path || b.input.path || b.input.notebook_path;
                    if (caminho && String(caminho).toLowerCase().includes(q)) {
                        achados.push({ projeto: s.projeto, id: s.id, titulo: s.titulo, nomeProjeto: s.nomeProjeto, hora: r.timestamp, ferramenta: b.name, caminho: String(caminho) });
                        porSessao++;
                    } else if (typeof b.input.command === 'string' && b.input.command.toLowerCase().includes(q)) {
                        // No Royal os PHP são editados por comando (PowerShell/Bash), não pela ferramenta Edit
                        const desc = b.input.description ? b.input.description + ': ' : '';
                        achados.push({ projeto: s.projeto, id: s.id, titulo: s.titulo, nomeProjeto: s.nomeProjeto, hora: r.timestamp, ferramenta: b.name, caminho: (desc + b.input.command).replace(/\s+/g, ' ').slice(0, 200) });
                        porSessao++;
                    }
                }
            } else if (r.type === 'user' || r.type === 'assistant') {
                const t = limpa(textoDe(r.message.content));
                const i = t.toLowerCase().indexOf(q);
                if (i < 0) continue;
                achados.push({ projeto: s.projeto, id: s.id, titulo: s.titulo, nomeProjeto: s.nomeProjeto, hora: r.timestamp, quem: r.type === 'user' ? 'você' : 'Claude', trecho: trecho(t, i, q.length) });
                porSessao++;
            }
        }
    };
    await Promise.all([trabalhador(), trabalhador(), trabalhador(), trabalhador()]);
    if (fila.length) parouPorTempo = parouPorTempo || achados.length < limite;
    achados.sort((a, b) => String(b.hora).localeCompare(String(a.hora)));
    return { achados, parouPorTempo };
}

// Resumo do dia: o que cada conversa de hoje fez
function resumoDia(sessoes, detalhe) {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const doDia = sessoes.filter(s => s.atualizado >= hoje.getTime());
    const conversas = [];
    const arquivos = new Set();
    let pedidos = 0, edicoes = 0, comandos = 0, agentes = 0;
    for (const s of doDia) {
        const d = detalhe(s.projeto, s.id);
        if (!d) continue;
        const eventosHoje = d.eventos.filter(e => Date.parse(e.hora) >= hoje.getTime());
        const ed = eventosHoje.filter(e => e.tipo === 'edicao');
        ed.forEach(e => arquivos.add(e.texto));
        const c = { projeto: s.projeto, id: s.id, titulo: s.titulo, nomeProjeto: s.nomeProjeto, modelo: d.modelo,
            pedidos: eventosHoje.filter(e => e.tipo === 'pedido').length, edicoes: ed.length,
            comandos: eventosHoje.filter(e => e.tipo === 'comando').length,
            agentes: (d.agentes || []).filter(a => Date.parse(a.inicio) >= hoje.getTime()).length,
            arquivos: [...new Set(ed.map(e => e.texto))].slice(0, 12) };
        pedidos += c.pedidos; edicoes += c.edicoes; comandos += c.comandos; agentes += c.agentes;
        conversas.push(c);
    }
    return { conversas, totais: { conversas: conversas.length, pedidos, edicoes, comandos, agentes, arquivos: arquivos.size } };
}

// Modelos de pedido (reutilizáveis no menu "/")
const MODELOS_PADRAO = [
    { nome: 'Tarefa grande: spec antes de codar', texto: 'Esta tarefa é grande ou de risco. Siga o fluxo do meu CLAUDE.md: investigue com o explorer, escreva uma spec curta (objetivo, arquivos e tabelas, o que muda, riscos, critério de pronto), mande ao spec-reviewer e só implemente depois de APROVADA. No fim, rode o test-runner e o reviewer no diff.\n\nTarefa: ' },
    { nome: 'Investigar bug', texto: 'Investigue este bug sem alterar nada ainda. Quero: causa provável com arquivo:linha, como reproduzir e a correção mínima proposta.\n\nBug: ' },
    { nome: 'Revisar o que mudou', texto: 'Revise o diff atual (git diff) procurando bugs, regressões e quebra de regra do projeto. Liste só o que tiver evidência, com arquivo:linha.' },
];
function modelos(dados) { return Array.isArray(dados.modelosPedido) ? dados.modelosPedido : MODELOS_PADRAO; }
function validaModelos(lista) {
    if (!Array.isArray(lista) || lista.length > 50) throw new Error('Lista inválida.');
    return lista.map(m => ({ nome: String(m.nome || '').trim().slice(0, 80), texto: String(m.texto || '').slice(0, 8000) })).filter(m => m.nome && m.texto);
}

module.exports = { busca, resumoDia, modelos, validaModelos };
