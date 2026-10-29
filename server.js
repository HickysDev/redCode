// Painel Claude - servidor local que lê os transcripts do Claude Code (~/.claude/projects)
// e entrega o estado de cada sessão para a página. Sem dependências: só Node.
// Primeiro de tudo: tira do ambiente os segredos do app (antes de qualquer processo filho nascer)
require('./segredos');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const terminal = require('./terminal');
const editorArquivos = require('./editor-arquivos');
const worktrees = require('./worktrees');
const alem = require('./alem');
const integracoes = require('./integracoes');
const automacao = require('./automacao');
const gitScm = require('./git-scm');
const chat = require('./chat');
const cacheComandos = new Map();
const cacheUso = { dados: null, em: 0, pedido: null };

const PORTA = Number(process.env.PAINEL_PORTA || 4317);
const RAIZ_PROJETOS = path.join(os.homedir(), '.claude', 'projects');
const DIAS_LISTADOS = 7;
const SEGUNDOS_ATIVA = 90;
const LIMITE_EVENTOS = 400;
const LIMITE_TEXTO = 700;
const LIMITE_CONVERSA = 60000;
const BLOCO = 8 * 1024 * 1024;
const LIMITE_LINHA = 20 * 1024 * 1024;
const LIMITE_LINHAS_CODIGO = 80;

// Cache de leitura incremental por arquivo: { offset, sobra, estado }
const cache = new Map();

// Imagens vistas nas conversas (prints, imagens lidas, imagens coladas).
// Guarda só onde a imagem está no transcript (arquivo + posição da linha); o conteúdo é lido
// na hora em que a página pede. O id é aleatório e só existe para o que apareceu num transcript.
const imagens = new Map();
function guardaImagens(blocos, origem, chaveBloco) {
    const ids = [];
    if (!origem) return ids;
    let n = 0;
    for (const c of (Array.isArray(blocos) ? blocos : [])) {
        if (c.type !== 'image' || !c.source || c.source.type !== 'base64' || !c.source.data) continue;
        const id = crypto.createHash('sha1').update(`${origem.arquivo}:${origem.offset}:${chaveBloco}:${n}`).digest('hex').slice(0, 20);
        imagens.set(id, { ...origem, chaveBloco, n, tipo: c.source.media_type || 'image/png' });
        ids.push(id);
        n++;
    }
    return ids;
}

// Relatórios e arquivos gerados (para o botão "Abrir"): id secreto -> caminho no disco.
// Só entra o que o Claude criou/editou ou citou num link, e só com extensão de relatório.
const SAL_ARQUIVOS = crypto.randomBytes(16);
const arquivosAbriveis = new Map();
const EXTENSOES_RELATORIO = /\.(html?|pdf|md|csv|tsv|txt|json|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|webp)$/i;
function registraArquivo(caminho, cwd) {
    if (!caminho || !EXTENSOES_RELATORIO.test(caminho) || /^[a-z]+:\/\//i.test(caminho)) return null;
    const absoluto = path.resolve(cwd || '.', String(caminho).replace(/^file:\/\/\/?/i, '').replace(/[#?].*$/, ''));
    const id = crypto.createHmac('sha256', SAL_ARQUIVOS).update(absoluto.toLowerCase()).digest('hex').slice(0, 24);
    arquivosAbriveis.set(id, absoluto);
    return id;
}
// Links para arquivos citados numa resposta: [texto](caminho) e `caminho`
function arquivosCitados(texto, cwd) {
    const achados = new Map();
    const candidatos = [];
    for (const m of String(texto).matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) candidatos.push({ nome: m[1], caminho: m[2] });
    for (const m of String(texto).matchAll(/`([^`\n]+\.[A-Za-z]{2,5})`/g)) candidatos.push({ nome: null, caminho: m[1] });
    for (const c of candidatos) {
        if (!EXTENSOES_RELATORIO.test(c.caminho.replace(/[#?].*$/, ''))) continue;
        const absoluto = path.resolve(cwd || '.', c.caminho.replace(/^file:\/\/\/?/i, '').replace(/[#?].*$/, ''));
        if (achados.has(absoluto) || !fs.existsSync(absoluto)) continue;
        achados.set(absoluto, { id: registraArquivo(absoluto), nome: path.basename(absoluto) });
    }
    return [...achados.values()];
}

// Relê a linha do transcript e devolve os bytes da imagem
function leImagem(ponteiro) {
    const fd = fs.openSync(ponteiro.arquivo, 'r');
    const buffer = Buffer.alloc(ponteiro.tamanho);
    try { fs.readSync(fd, buffer, 0, ponteiro.tamanho, ponteiro.offset); } finally { fs.closeSync(fd); }
    const registro = JSON.parse(buffer.toString('utf8'));
    let blocos = (registro.message && registro.message.content) || [];
    if (ponteiro.chaveBloco === 'comentario') {
        // Comentário feito no meio do trabalho: os blocos ficam no anexo da fila
        const prompt = registro.attachment && registro.attachment.prompt;
        blocos = Array.isArray(prompt) ? prompt : [];
    } else if (ponteiro.chaveBloco !== 'mensagem') {
        const resultado = blocos.find(b => b.type === 'tool_result' && b.tool_use_id === ponteiro.chaveBloco);
        blocos = (resultado && resultado.content) || [];
    }
    const imagem = blocos.filter(c => c.type === 'image')[ponteiro.n];
    return imagem ? Buffer.from(imagem.source.data, 'base64') : null;
}

function corta(texto, limite = LIMITE_TEXTO) {
    texto = String(texto || '').trim();
    return texto.length > limite ? texto.slice(0, limite) + '…' : texto;
}

function nomeProjeto(pasta) {
    // "c--ProjetosGit-royal" -> "royal"; pastas de rascunho do app viram "rascunho"
    if (/scratch-workspaces/i.test(pasta)) return 'rascunho do app';
    const partes = pasta.split('-').filter(Boolean);
    return partes[partes.length - 1] || pasta;
}

function limpaTextoUsuario(texto) {
    return String(texto || '')
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/<\/?(command-name|command-message|command-args|local-command-stdout)>/g, '')
        .trim();
}

function estadoVazio() {
    return {
        titulo: '', modelo: '', esforco: '', custo: null, inicio: null, ultimo: null,
        eventos: [], plano: [], tarefas: {}, agentes: {}, tokens: {}, porId: {},
        contagem: { leituras: 0, edicoes: 0, comandos: 0, bloqueios: 0, refinados: 0, pedidos: 0 },
        // Saúde da conversa: tamanho do contexto a cada resposta, modelos usados, trocas e resumos
        contexto: 0, serieContexto: [], modelos: {}, trocas: [], compactacoes: [], ttlCacheMin: 5,
        // Turno encerrado: o modelo respondeu e está esperando a próxima mensagem
        turnoEncerrado: false, fimTurno: null, pergunta: null,
        // Avisos <task-notification> por id de tarefa/agente (ex.: "stopped" = interrompido)
        tarefasNotificadas: {},
        // Antes e depois de cada mensagem reescrita pelo Haiku: { hora, original, reescrito }
        reescritas: [],
    };
}

// Primeiras linhas de um texto + total de linhas (para os cartões de código)
function trechoCodigo(texto, maxLinhas = LIMITE_LINHAS_CODIGO) {
    const linhas = String(texto || '').split('\n');
    return { total: linhas.length, texto: linhas.slice(0, maxLinhas).join('\n').slice(0, 12000), cortado: linhas.length > maxLinhas };
}

// Resumo curto de uma chamada de ferramenta, para a linha do tempo
function resumoFerramenta(nome, entrada) {
    entrada = entrada || {};
    const arquivo = entrada.file_path || entrada.notebook_path || entrada.path;
    switch (nome) {
        case 'Bash': case 'PowerShell':
            return { tipo: 'comando', texto: entrada.description || corta(entrada.command, 120), codigo: { tipo: 'comando', entrada: trechoCodigo(entrada.command) } };
        case 'Read': return { tipo: 'leitura', texto: arquivo };
        case 'Write':
            return { tipo: 'edicao', texto: arquivo, codigo: { tipo: 'arquivo', conteudo: trechoCodigo(entrada.content) } };
        case 'Edit':
            return { tipo: 'edicao', texto: arquivo, codigo: { tipo: 'diff', trocas: [{ antes: trechoCodigo(entrada.old_string, 40), depois: trechoCodigo(entrada.new_string, 40) }] } };
        case 'MultiEdit':
            return { tipo: 'edicao', texto: arquivo, codigo: { tipo: 'diff', trocas: (entrada.edits || []).slice(0, 10).map(e => ({ antes: trechoCodigo(e.old_string, 25), depois: trechoCodigo(e.new_string, 25) })) } };
        case 'NotebookEdit':
            return { tipo: 'edicao', texto: arquivo, codigo: { tipo: 'arquivo', conteudo: trechoCodigo(entrada.new_source) } };
        case 'Grep': return { tipo: 'busca', texto: `"${entrada.pattern}"` + (entrada.path ? ` em ${entrada.path}` : '') };
        case 'Glob': return { tipo: 'busca', texto: entrada.pattern };
        case 'Agent': case 'Task':
            return { tipo: 'agente', texto: `${entrada.subagent_type || 'agente'}: ${entrada.description || ''}`, detalhe: entrada.prompt };
        case 'Skill': return { tipo: 'skill', texto: entrada.skill + (entrada.args ? ' ' + entrada.args : '') };
        case 'AskUserQuestion':
            return { tipo: 'pergunta', texto: (entrada.questions || []).map(q => q.question).join(' / ') };
        case 'WebSearch': return { tipo: 'web', texto: entrada.query };
        case 'WebFetch': return { tipo: 'web', texto: entrada.url };
        case 'SendMessage': return { tipo: 'agente', texto: `mensagem para ${entrada.to}`, detalhe: entrada.message };
    }
    const curto = nome.replace(/^mcp__[^_]+(__)?/, '').replace(/^.*__/, '');
    const principal = entrada.url || entrada.query || entrada.text || entrada.command || '';
    return { tipo: 'ferramenta', texto: curto + (principal ? ': ' + principal : '') };
}

// Atualiza a lista de progresso a partir das ferramentas de plano/tarefas
function atualizaPlano(estado, nome, entrada) {
    if (nome === 'TodoWrite' && Array.isArray(entrada.todos)) {
        estado.plano = entrada.todos.map(t => ({ texto: t.content || t.activeForm, status: t.status }));
        return true;
    }
    // Fechamento do turno no app: conclui o que estava em andamento (o app faz o mesmo)
    if (/wrap_up$/.test(nome)) {
        estado.plano.forEach(i => { if (i.status === 'in_progress') i.status = 'completed'; });
        return true;
    }
    if (/update_plan$/.test(nome)) {
        if (Array.isArray(entrada.items)) {
            estado.plano = entrada.items.map(i => ({ texto: i.content, status: i.status }));
        } else {
            const p = estado.plano;
            if (entrada.advance) {
                const atual = p.findIndex(i => i.status === 'in_progress');
                if (atual >= 0) p[atual].status = 'completed';
                const proximo = p.findIndex(i => i.status === 'pending');
                if (proximo >= 0) p[proximo].status = 'in_progress';
            }
            (entrada.done || []).forEach(n => { if (p[n - 1]) p[n - 1].status = 'completed'; });
            if (entrada.start && p[entrada.start - 1]) {
                p.forEach(i => { if (i.status === 'in_progress') i.status = 'pending'; });
                p[entrada.start - 1].status = 'in_progress';
            }
        }
        return true;
    }
    if (nome === 'TaskCreate') {
        const id = String(Object.keys(estado.tarefas).length + 1);
        estado.tarefas[id] = { texto: entrada.subject || entrada.description, status: 'pending' };
        estado.plano = Object.values(estado.tarefas);
        return true;
    }
    if (nome === 'TaskUpdate' && estado.tarefas[entrada.taskId]) {
        if (entrada.status) estado.tarefas[entrada.taskId].status = entrada.status;
        estado.plano = Object.values(estado.tarefas);
        return true;
    }
    return false;
}

function somaTokens(estado, modelo, uso) {
    if (!modelo || !uso) return;
    const t = estado.tokens[modelo] || (estado.tokens[modelo] = { entrada: 0, cacheLido: 0, cacheGravado: 0, saida: 0, chamadas: 0 });
    t.entrada += uso.input_tokens || 0;
    t.cacheLido += uso.cache_read_input_tokens || 0;
    t.cacheGravado += uso.cache_creation_input_tokens || 0;
    t.saida += uso.output_tokens || 0;
    t.chamadas += 1;
}

function adicionaEvento(estado, evento) {
    // Liga a mensagem original à reescrita do Haiku (a mais próxima no tempo, até 2 min)
    if (evento.tipo === 'pedido' && estado.reescritas) {
        const pendente = [...estado.reescritas].reverse().find(x => !x.original && Math.abs(Date.parse(evento.hora) - Date.parse(x.hora)) <= 120000);
        if (pendente) pendente.original = evento.texto;
        estado.ultimoPedido = evento;
    }
    estado.eventos.push(evento);
    if (evento.id) estado.porId[evento.id] = evento;
    if (estado.eventos.length > LIMITE_EVENTOS * 1.5) {
        const removidos = estado.eventos.splice(0, estado.eventos.length - LIMITE_EVENTOS);
        removidos.forEach(e => { if (e.id) delete estado.porId[e.id]; });
    }
}

// Processa um registro do .jsonl (origem = arquivo e posição da linha, para achar imagens depois)
function processaRegistro(estado, r, origem) {
    if (r.timestamp) {
        estado.inicio = estado.inicio || r.timestamp;
        estado.ultimo = r.timestamp;
    }
    if (r.cwd && !r.isSidechain) estado.cwd = r.cwd;
    if (r.type === 'ai-title') { estado.titulo = r.aiTitle; return; }
    // Modo de permissão em uso: vem gravado nas suas mensagens
    if (r.type === 'user' && r.permissionMode && !r.isSidechain) estado.modo = r.permissionMode;
    if (r.type === 'cost-state') { estado.custo = r.totalCostUSD; return; }
    if (r.type === 'system' && r.subtype === 'stop_hook_summary' && !r.isSidechain) {
        estado.turnoEncerrado = true;
        estado.fimTurno = r.timestamp;
        return;
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
        const m = r.compactMetadata || {};
        estado.compactacoes.push({ hora: r.timestamp, automatico: m.trigger === 'auto', antes: m.preTokens || 0, depois: m.postTokens || 0 });
        adicionaEvento(estado, { tipo: 'compactacao', hora: r.timestamp, texto: `A conversa foi resumida${m.trigger === 'auto' ? ' automaticamente' : ''}: de ${m.preTokens || '?'} para ${m.postTokens || '?'} tokens` });
        return;
    }

    // Contexto extra de hook (prompt refinado pelo Haiku)
    if (r.type === 'attachment') {
        const anexo = r.attachment || {};
        // Mensagem sua enviada com o Claude trabalhando (painel ou VS Code): entra no próximo passo
        // O comentário pode vir como texto ou como lista de blocos (texto + imagens coladas)
        const blocosComentario = Array.isArray(anexo.prompt) ? anexo.prompt : null;
        const textoComentario = blocosComentario
            ? blocosComentario.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
            : String(anexo.prompt || '');
        if (anexo.type === 'queued_command' && anexo.prompt && !r.isSidechain && !textoComentario.trim().startsWith('<')) {
            estado.contagem.pedidos++;
            const coladas = blocosComentario ? guardaImagens(blocosComentario, origem, 'comentario') : [];
            adicionaEvento(estado, { tipo: 'pedido', hora: r.timestamp, texto: corta(limpaTextoUsuario(textoComentario), LIMITE_CONVERSA), comentario: true, imagens: coladas.length ? coladas : undefined });
            return;
        }
        if (anexo.type === 'hook_additional_context' && JSON.stringify(anexo.content || '').includes('PROMPT REFINADO')) {
            const conteudo = (r.attachment && (r.attachment.content || r.attachment.additionalContext)) || '';
            estado.contagem.refinados++;
            const textoRefinado = corta(Array.isArray(conteudo) ? conteudo.join('\n') : conteudo, LIMITE_CONVERSA);
            adicionaEvento(estado, { tipo: 'refinado', hora: r.timestamp, texto: textoRefinado });
            // Histórico completo do "antes e depois", fora do limite de eventos recentes.
            // O hook roda antes da mensagem ser gravada: a original é ligada quando ela chegar.
            estado.reescritas.push({ hora: r.timestamp, original: null, reescrito: textoRefinado.replace(/^PROMPT REFINADO[^\n]*\n/, '').trim() });
            // A mensagem é gravada antes e a reescrita chega uns 15 s depois (tempo do Haiku): liga agora
            const ultimo = estado.ultimoPedido;
            if (ultimo && Math.abs(Date.parse(r.timestamp) - Date.parse(ultimo.hora)) <= 120000 && !estado.reescritas.some(x => x.original === ultimo.texto)) {
                estado.reescritas[estado.reescritas.length - 1].original = ultimo.texto;
            }
            if (estado.reescritas.length > 300) estado.reescritas.shift();
        }
        return;
    }

    const msg = r.message;
    if (!msg) return;

    if (r.type === 'user') {
        // Aviso do sistema sobre tarefa/agente (<task-notification>): não é mensagem sua
        const textoBruto = typeof msg.content === 'string' ? msg.content : ((msg.content || []).find(b => b.type === 'text') || {}).text || '';
        if (!r.isSidechain && /^\s*<task-notification>/.test(textoBruto)) {
            const campo = (nome) => ((textoBruto.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`)) || [])[1] || '').trim();
            const situacao = campo('status');
            if (campo('task-id')) estado.tarefasNotificadas[campo('task-id')] = situacao;
            estado.turnoEncerrado = false;
            adicionaEvento(estado, {
                tipo: 'notificacao', hora: r.timestamp, situacao,
                texto: campo('summary') || 'Aviso do sistema sobre uma tarefa em segundo plano',
                detalhe: campo('note'),
            });
            return;
        }
        // Agente em segundo plano devolvendo o relatório: o Claude volta a trabalhar sozinho
        if (r.isMeta && r.origin && r.origin.kind === 'peer' && !r.isSidechain) {
            estado.turnoEncerrado = false;
            const corpo = String(r.origin.body || '').replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*/, '');
            adicionaEvento(estado, { tipo: 'retorno', hora: r.timestamp, texto: `O agente ${r.origin.name || 'em segundo plano'} terminou e devolveu o relatório`, detalhe: corta(corpo.replace(/^ {2}/gm, ''), 4000) });
            return;
        }
        // Você interrompeu (Esc / Parar): o Claude Code grava isso como mensagem do usuário.
        // Vira um aviso "Interrompido" e encerra o turno, em vez de parecer um pedido novo.
        const textosUsuario = typeof msg.content === 'string' ? [msg.content]
            : (msg.content || []).filter(b => b && b.type === 'text').map(b => b.text);
        if (!r.isSidechain && textosUsuario.some(t => /^\s*\[Request interrupted by user/.test(String(t)))) {
            estado.turnoEncerrado = true;
            estado.fimTurno = r.timestamp;
            adicionaEvento(estado, { tipo: 'interrompido', hora: r.timestamp, texto: 'Você interrompeu a resposta' });
            return;
        }
        if (typeof msg.content === 'string') {
            const texto = limpaTextoUsuario(msg.content);
            if (texto && !r.isMeta && !r.isCompactSummary) {
                if (!r.isSidechain) estado.turnoEncerrado = false;
                estado.contagem.pedidos++;
                adicionaEvento(estado, { tipo: 'pedido', hora: r.timestamp, uuid: r.isSidechain ? undefined : r.uuid, texto: corta(texto, LIMITE_CONVERSA) });
            }
            return;
        }
        for (const b of msg.content || []) {
            if (b.type === 'text' && !r.isMeta && !r.isCompactSummary) {
                const texto = limpaTextoUsuario(b.text);
                if (texto) {
                    if (!r.isSidechain) estado.turnoEncerrado = false;
                    estado.contagem.pedidos++;
                    // Imagens que você colou junto com a mensagem
                    const coladas = guardaImagens(msg.content, origem, 'mensagem');
                    adicionaEvento(estado, { tipo: 'pedido', hora: r.timestamp, uuid: r.isSidechain ? undefined : r.uuid, texto: corta(texto, LIMITE_CONVERSA), imagens: coladas.length ? coladas : undefined });
                }
            }
            if (b.type === 'tool_result') {
                if (estado.pergunta && estado.pergunta.id === b.tool_use_id) estado.pergunta = null;
                if (b.is_error && estado.planoAntes && estado.planoAntes.id === b.tool_use_id) {
                    estado.plano = estado.planoAntes.plano;
                    estado.tarefas = estado.planoAntes.tarefas;
                    estado.planoHora = estado.planoAntes.hora;
                    estado.planoAntes = null;
                }
                const alvo = estado.porId[b.tool_use_id];
                const idsImagens = guardaImagens(b.content, origem, b.tool_use_id);
                if (alvo && idsImagens.length) alvo.imagens = idsImagens;
                const conteudo = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : String(b.content || '');
                if (alvo) {
                    alvo.fim = r.timestamp;
                    alvo.erro = !!b.is_error;
                    if (b.is_error && /Bloqueado:/.test(conteudo)) { alvo.bloqueado = corta(conteudo, 400); estado.contagem.bloqueios++; }
                    else if (alvo.tipo === 'comando' && alvo.codigo) alvo.codigo.saida = trechoCodigo(conteudo, 40);
                    else if (b.is_error) alvo.saida = corta(conteudo, 400);
                    else if (alvo.tipo === 'agente') alvo.saida = corta(conteudo, 1200);
                }
                const agente = estado.agentes[b.tool_use_id];
                if (agente && r.toolUseResult && r.toolUseResult.status !== 'async_launched') {
                    agente.status = b.is_error ? 'erro' : 'concluido';
                    agente.fim = r.timestamp;
                }
                if (agente && r.toolUseResult && r.toolUseResult.resolvedModel) agente.modelo = r.toolUseResult.resolvedModel;
            }
        }
        return;
    }

    if (r.type === 'assistant') {
        const modeloValido = msg.model && msg.model !== '<synthetic>' && !r.isSidechain;
        if (modeloValido) {
            // Troca de modelo no meio da conversa: o cache do modelo novo começa do zero
            if (estado.modelo && estado.modelo !== msg.model) {
                estado.trocas.push({ hora: r.timestamp, de: estado.modelo, para: msg.model });
                adicionaEvento(estado, { tipo: 'troca', hora: r.timestamp, de: estado.modelo, para: msg.model, texto: `Modelo trocado de ${estado.modelo} para ${msg.model}` });
            }
            estado.modelo = msg.model;
            const uso = estado.modelos[msg.model] || (estado.modelos[msg.model] = { respostas: 0, primeiro: r.timestamp, ultimo: r.timestamp });
            uso.respostas++;
            uso.ultimo = r.timestamp;
        }
        if (r.effort) estado.esforco = r.effort;
        // Tamanho do contexto na última chamada, inclusive dentro de agentes (registros "sidechain")
        if (msg.usage) {
            const u = msg.usage;
            const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (total > 0) estado.ultimoContexto = total;
        }
        if (!r.isSidechain && msg.stop_reason) {
            estado.turnoEncerrado = msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence';
            if (estado.turnoEncerrado) estado.fimTurno = r.timestamp;
        }
        if (msg.model !== '<synthetic>') somaTokens(estado, msg.model, msg.usage);
        if (modeloValido && msg.usage) {
            const u = msg.usage;
            const tamanho = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (tamanho > 0) {
                estado.contexto = tamanho;
                const ultimoPonto = estado.serieContexto[estado.serieContexto.length - 1];
                if (!ultimoPonto || ultimoPonto.v !== tamanho) estado.serieContexto.push({ t: r.timestamp, v: tamanho });
                // Mantém a série leve: descarta pontos alternados quando cresce demais
                if (estado.serieContexto.length > 600) estado.serieContexto = estado.serieContexto.filter((p, i) => i % 2 === 0 || i === estado.serieContexto.length - 1);
            }
            if (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens > 0) estado.ttlCacheMin = 60;
        }
        let falou = false;
        for (const b of msg.content || []) {
            if (b.type === 'text' && b.text && b.text.trim()) {
                falou = true;
                // Resposta do Claude inteira (o limite só protege contra textos absurdos)
                const citados = arquivosCitados(b.text, estado.cwd);
                adicionaEvento(estado, { tipo: 'fala', hora: r.timestamp, modelo: msg.model === '<synthetic>' ? 'aviso do Claude Code' : msg.model, texto: corta(b.text, LIMITE_CONVERSA), arquivos: citados.length ? citados : undefined });
            } else if (b.type === 'thinking' && r.thinkingDurationMs > 1500 && !falou) {
                adicionaEvento(estado, { tipo: 'pensou', hora: r.timestamp, texto: `por ${(r.thinkingDurationMs / 1000).toFixed(0)} s`, conteudo: corta(b.thinking, 1500) });
            } else if (b.type === 'tool_use') {
                // Guarda o plano anterior: se a chamada falhar (ferramenta indisponível), volta atrás
                // Capítulo marcado no app: vira divisória e entrada do sumário
                if (/mark_chapter$/.test(b.name) && !r.isSidechain) {
                    const ent = b.input || {};
                    adicionaEvento(estado, { id: b.id, tipo: 'capitulo', hora: r.timestamp, texto: corta(ent.title, 120), detalhe: corta(ent.summary, 300), fim: r.timestamp });
                    continue;
                }
                // Caixa "próximo passo" do app (resumo, pergunta e botões de resposta)
                if (/wrap_up$/.test(b.name) && !r.isSidechain) {
                    const ent = b.input || {};
                    let acoes = ent.actions;
                    if (typeof acoes === 'string') { try { acoes = JSON.parse(acoes); } catch (e) { acoes = []; } }
                    adicionaEvento(estado, {
                        id: 'p:' + b.id, tipo: 'proximo', hora: r.timestamp, texto: corta(ent.recap, 600), pergunta: corta(ent.ask, 200),
                        botoes: (Array.isArray(acoes) ? acoes : []).filter(a => a && !a.action && (a.label || a.message)).slice(0, 3)
                            .map(a => ({ rotulo: corta(a.label || a.message, 40), mensagem: corta(a.message || a.label, 600) })),
                        fim: r.timestamp,
                    });
                }
                const planoAntes = { id: b.id, plano: JSON.parse(JSON.stringify(estado.plano)), tarefas: JSON.parse(JSON.stringify(estado.tarefas)), hora: estado.planoHora };
                if (atualizaPlano(estado, b.name, b.input || {})) {
                    estado.planoAntes = planoAntes;
                    if (!r.isSidechain) estado.planoHora = r.timestamp;
                    continue;
                }
                const resumo = resumoFerramenta(b.name, b.input);
                if (resumo.tipo === 'leitura' || resumo.tipo === 'busca') estado.contagem.leituras++;
                if (resumo.tipo === 'edicao') estado.contagem.edicoes++;
                if (resumo.tipo === 'comando') estado.contagem.comandos++;
                adicionaEvento(estado, {
                    id: b.id, tipo: resumo.tipo, ferramenta: b.name, hora: r.timestamp,
                    texto: corta(resumo.texto, 400), detalhe: corta(resumo.detalhe, 2000), codigo: resumo.codigo,
                    // Arquivo criado/editado com cara de relatório: ganha o botão "Abrir"
                    abrir: b.name === 'Write' ? registraArquivo(resumo.texto, estado.cwd) || undefined : undefined,
                });
                if (b.name === 'AskUserQuestion' && !r.isSidechain) {
                    estado.pergunta = { id: b.id, hora: r.timestamp, texto: corta(resumo.texto, 300) };
                }
                if (b.name === 'Agent' || b.name === 'Task') {
                    estado.agentes[b.id] = {
                        id: b.id, tipoAgente: (b.input || {}).subagent_type || 'general-purpose',
                        descricao: (b.input || {}).description || '', briefing: corta((b.input || {}).prompt, 3000),
                        status: 'rodando', inicio: r.timestamp, modelo: '',
                    };
                }
            }
        }
    }
}

// Lê só o que foi acrescentado ao arquivo desde a última leitura
function leIncremental(arquivo, criaEstado, processa) {
    let item = cache.get(arquivo);
    const stat = fs.statSync(arquivo);
    if (!item || stat.size < item.offset) {
        // sobra = pedaços (em bytes) da linha que ainda não terminou; inicioSobra = onde ela começa no arquivo
        item = { offset: 0, sobra: [], sobraBytes: 0, inicioSobra: 0, estado: criaEstado() };
        cache.set(arquivo, item);
    }
    if (stat.size > item.offset) {
        // Lê em blocos: há transcripts com centenas de MB (maior que uma string do Node)
        const fd = fs.openSync(arquivo, 'r');
        const buffer = Buffer.alloc(BLOCO);
        const prefixoIgnorado = Buffer.from('{"type":"api-request');
        try {
            while (item.offset < stat.size) {
                const inicioBloco = item.offset;
                const lidos = fs.readSync(fd, buffer, 0, Math.min(BLOCO, stat.size - item.offset), item.offset);
                if (lidos <= 0) break;
                item.offset += lidos;
                const indiceQuebra = buffer.lastIndexOf(0x0a, lidos - 1);
                if (indiceQuebra < 0) {
                    // Bloco sem fim de linha: pedaço de uma linha gigante
                    if (!item.sobraBytes) item.inicioSobra = inicioBloco;
                    item.sobraBytes += lidos;
                    if (item.sobraBytes < LIMITE_LINHA) item.sobra.push(Buffer.from(buffer.subarray(0, lidos)));
                    continue;
                }
                let dados, base;
                if (item.sobraBytes >= LIMITE_LINHA) {
                    // A linha gigante termina neste bloco: descarta e começa na próxima
                    const fimGigante = buffer.indexOf(0x0a);
                    dados = buffer.subarray(fimGigante + 1, indiceQuebra);
                    base = inicioBloco + fimGigante + 1;
                } else {
                    dados = Buffer.concat([...item.sobra, buffer.subarray(0, indiceQuebra)]);
                    base = item.sobraBytes ? item.inicioSobra : inicioBloco;
                }
                item.sobra = [Buffer.from(buffer.subarray(indiceQuebra + 1, lidos))];
                item.sobraBytes = lidos - indiceQuebra - 1;
                item.inicioSobra = inicioBloco + indiceQuebra + 1;

                let pos = 0;
                while (pos < dados.length) {
                    const quebra = dados.indexOf(0x0a, pos);
                    const fim = quebra < 0 ? dados.length : quebra;
                    const tamanho = fim - pos;
                    // Registros enormes de request da API e linhas gigantes não interessam ao painel
                    if (tamanho > 0 && tamanho <= LIMITE_LINHA && !dados.subarray(pos, pos + prefixoIgnorado.length).equals(prefixoIgnorado)) {
                        try {
                            processa(item.estado, JSON.parse(dados.toString('utf8', pos, fim)), { arquivo, offset: base + pos, tamanho });
                        } catch (e) { /* linha corrompida: ignora */ }
                    }
                    if (quebra < 0) break;
                    pos = quebra + 1;
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }
    item.mtime = stat.mtimeMs;
    return item.estado;
}

// Subagentes da sessão: pasta <sessao>/subagents com .jsonl + .meta.json
function leSubagentes(pastaSessao, estadoPai) {
    const pasta = path.join(pastaSessao, 'subagents');
    if (!fs.existsSync(pasta)) return;
    for (const nome of fs.readdirSync(pasta)) {
        if (!nome.endsWith('.meta.json')) continue;
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(pasta, nome), 'utf8')); } catch (e) { continue; }
        const arquivo = path.join(pasta, nome.replace('.meta.json', '.jsonl'));
        if (!fs.existsSync(arquivo)) continue;
        const sub = leIncremental(arquivo, estadoVazio, processaRegistro);
        const mtime = fs.statSync(arquivo).mtimeMs;
        const chave = meta.toolUseId || nome;
        const agente = estadoPai.agentes[chave] || (estadoPai.agentes[chave] = {
            id: chave, tipoAgente: meta.agentType, descricao: meta.description, inicio: sub.inicio, status: 'rodando',
        });
        agente.tipoAgente = meta.agentType || agente.tipoAgente;
        agente.modelo = sub.modelo || agente.modelo;
        agente.tokens = sub.tokens;
        agente.contexto = sub.ultimoContexto || 0;
        agente.ultimasAcoes = sub.eventos.filter(e => !['pedido', 'pensou'].includes(e.tipo)).slice(-8).map(e => ({ tipo: e.tipo, texto: e.texto }));
        agente.contagem = sub.contagem;
        const parado = Date.now() - mtime > 10 * 60 * 1000;
        // O aviso do sistema (<task-notification>) é a fonte mais confiável: diz se terminou ou parou
        const idAgente = nome.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        const aviso = estadoPai.tarefasNotificadas[idAgente];
        if (aviso && /stopped|failed|killed|error/i.test(aviso)) agente.status = 'interrompido';
        else if (aviso && /completed|finished|done|success/i.test(aviso)) agente.status = 'concluido';
        else if (meta.finished === true || (agente.status === 'rodando' && parado)) {
            agente.status = agente.status === 'erro' ? 'erro' : 'concluido';
        }
        // Fim = última atividade registrada do agente (vale também para os de segundo plano)
        if (agente.status !== 'rodando' && sub.ultimo) agente.fim = sub.ultimo;
        agente.inicio = agente.inicio || sub.inicio;
        if (agente.status === 'rodando' && !parado) agente.ativoHa = Math.round((Date.now() - mtime) / 1000);
        agente.arquivoVisto = true;
    }
    // Agente em segundo plano sem arquivo de registro e lançado há mais de 30 min: já terminou
    for (const agente of Object.values(estadoPai.agentes)) {
        if (agente.status === 'rodando' && !agente.arquivoVisto && Date.now() - Date.parse(agente.inicio || 0) > 30 * 60 * 1000) {
            agente.status = 'concluido';
        }
    }
}

// Trabalhando, esperando você, ou parada. Um agente em segundo plano conta como trabalho:
// quando ele termina, o Claude volta a responder sozinho.
function situacaoSessao(estado, mtime) {
    // Só conta agente com atividade recente ou lançado há menos de 30 min
    const agentesRodando = Object.values(estado.agentes).filter(a => a.status === 'rodando'
        && (a.ativoHa !== undefined || Date.now() - Date.parse(a.inicio || 0) < 30 * 60 * 1000)).length;
    const recente = Date.now() - mtime < SEGUNDOS_ATIVA * 1000;
    const ativa = (!estado.turnoEncerrado && !estado.pergunta && recente) || (agentesRodando > 0 && !estado.pergunta);
    return { ativa, esperando: !ativa && (estado.turnoEncerrado || !!estado.pergunta), agentesRodando };
}

function listaSessoes() {
    const limite = Date.now() - DIAS_LISTADOS * 24 * 3600 * 1000;
    const sessoes = [];
    if (!fs.existsSync(RAIZ_PROJETOS)) return sessoes;
    for (const pasta of fs.readdirSync(RAIZ_PROJETOS)) {
        const caminhoPasta = path.join(RAIZ_PROJETOS, pasta);
        if (!fs.statSync(caminhoPasta).isDirectory()) continue;
        for (const nome of fs.readdirSync(caminhoPasta)) {
            if (!nome.endsWith('.jsonl')) continue;
            const arquivo = path.join(caminhoPasta, nome);
            const stat = fs.statSync(arquivo);
            if (stat.mtimeMs < limite) continue;
            const estado = leIncremental(arquivo, estadoVazio, processaRegistro);
            // Agentes em segundo plano só importam em sessões mexidas na última hora
            if (Date.now() - stat.mtimeMs < 3600 * 1000) leSubagentes(path.join(caminhoPasta, nome.replace('.jsonl', '')), estado);
            const situacao = situacaoSessao(estado, stat.mtimeMs);
            const pedidos = estado.eventos.filter(e => e.tipo === 'pedido');
            sessoes.push({
                projeto: pasta, nomeProjeto: nomeProjeto(pasta), id: nome.replace('.jsonl', ''),
                titulo: estado.titulo || (pedidos[0] && corta(pedidos[0].texto, 80)) || '(sem título)',
                modelo: estado.modelo, atualizado: stat.mtimeMs, contexto: estado.contexto,
                compactacoes: estado.compactacoes.length, inicio: estado.inicio, cwd: estado.cwd,
                ativa: situacao.ativa, esperando: situacao.esperando, agentesRodando: situacao.agentesRodando,
                pergunta: !!estado.pergunta, fimTurno: estado.fimTurno,
                // O que ela está fazendo agora (ferramenta ainda sem resposta), para a lista lateral
                acaoAtual: situacao.ativa ? (() => {
                    const e = [...estado.eventos].reverse().find(x => x.id && !x.fim);
                    return e ? { tipo: e.tipo, texto: corta(e.tipo === 'edicao' || e.tipo === 'leitura' ? path.basename(String(e.texto)) : e.texto, 60) } : null;
                })() : null,
            });
        }
    }
    return sessoes.sort((a, b) => b.atualizado - a.atualizado);
}

function detalheSessao(projeto, id) {
    // Bloqueia caminho fora da pasta de projetos
    if (/[\\/]|\.\./.test(projeto + id)) return null;
    const arquivo = path.join(RAIZ_PROJETOS, projeto, id + '.jsonl');
    if (!fs.existsSync(arquivo)) return null;
    const estado = leIncremental(arquivo, estadoVazio, processaRegistro);
    leSubagentes(path.join(RAIZ_PROJETOS, projeto, id), estado);
    const stat = fs.statSync(arquivo);
    const situacao = situacaoSessao(estado, stat.mtimeMs);
    const primeiroPedido = estado.eventos.find(e => e.tipo === 'pedido');
    return {
        titulo: estado.titulo || (primeiroPedido && corta(primeiroPedido.texto, 80)), modelo: estado.modelo, esforco: estado.esforco, custo: estado.custo,
        inicio: estado.inicio, ultimo: estado.ultimo,
        ativa: situacao.ativa, esperando: situacao.esperando, agentesRodando: situacao.agentesRodando,
        fimTurno: estado.fimTurno, pergunta: estado.pergunta, planoHora: estado.planoHora || null, modo: estado.modo || 'default',
        reescritas: estado.reescritas,
        projeto: nomeProjeto(projeto), plano: estado.plano, tokens: estado.tokens, contagem: estado.contagem,
        contexto: estado.contexto, serieContexto: estado.serieContexto, modelos: estado.modelos,
        trocas: estado.trocas, compactacoes: estado.compactacoes, ttlCacheMin: estado.ttlCacheMin,
        atualizado: stat.mtimeMs, cwd: estado.cwd, arquivo,
        agentes: Object.values(estado.agentes).sort((a, b) => String(b.inicio).localeCompare(String(a.inicio))),
        eventos: estado.eventos.slice(-LIMITE_EVENTOS),
    };
}

// Abre um relatório numa aba nova. HTML gerado pela IA abre isolado (sandbox, sem a origem do
// painel), para um script dele não conseguir chamar a API do painel.
const TIPOS_ARQUIVO = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
    '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
function serveArquivo(res, id) {
    const caminho = arquivosAbriveis.get(id);
    if (!caminho || !fs.existsSync(caminho) || !fs.statSync(caminho).isFile()) return responde(res, 404, { erro: 'Arquivo não encontrado (pode ter sido movido ou apagado).' });
    const ext = path.extname(caminho).toLowerCase();
    const cabecalhos = {
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-modals allow-downloads',
    };
    if (ext === '.md') {
        // Markdown: página simples e legível
        const texto = fs.readFileSync(caminho, 'utf8').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        res.writeHead(200, { ...cabecalhos, 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>${path.basename(caminho)}</title>
            <style>body{font:15px/1.6 "Segoe UI",system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#1f2a37}
            pre{white-space:pre-wrap;font:inherit}@media(prefers-color-scheme:dark){body{background:#171c23;color:#e3e8ee}}</style>
            <pre>${texto}</pre>`);
    }
    const tipo = TIPOS_ARQUIVO[ext];
    // Planilhas, Word e afins: o navegador baixa e abre no programa do Windows
    if (!tipo) cabecalhos['Content-Disposition'] = `attachment; filename="${path.basename(caminho).replace(/"/g, '')}"`;
    res.writeHead(200, { ...cabecalhos, 'Content-Type': tipo || 'application/octet-stream' });
    fs.createReadStream(caminho).pipe(res);
}

// O chat pergunta se a sessão tem agente rodando antes de fechar um processo parado
chat.configura({
    temAgentesRodando: (projeto, sessionId) => {
        try { const d = detalheSessao(projeto, sessionId); return !!(d && d.agentesRodando); } catch (e) { return true; }
    },
});

function responde(res, status, corpo, tipo = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
    res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
}

function leCorpo(req, limite = 1e6) {
    return new Promise((resolve, reject) => {
        let texto = '';
        req.on('data', (pedaco) => {
            texto += pedaco;
            if (texto.length > limite) { reject(new Error('Mensagem grande demais (anexos acima de 25 MB no total).')); req.destroy(); }
        });
        req.on('end', () => { try { resolve(JSON.parse(texto || '{}')); } catch (e) { reject(new Error('JSON inválido')); } });
    });
}

// O chat executa ações: só aceita POST vindo da própria página do painel.
// O cabeçalho próprio obriga o navegador a fazer preflight CORS, que nunca é respondido,
// então outro site aberto no navegador não consegue disparar comandos aqui.
function requisicaoConfiavel(req) {
    if (req.headers['x-painel'] !== '1') return false;
    const origem = req.headers.origin;
    return !origem || origem === `http://localhost:${PORTA}` || origem === `http://127.0.0.1:${PORTA}`;
}

// Favoritas e vínculos entre conversas ("continuação de"), guardados num arquivo ao lado do servidor
// PAINEL_DADOS: no Red Code.exe, %APPDATA%\Red Code (a pasta do programa é trocada a cada versão)
const PASTA_DADOS = process.env.PAINEL_DADOS || __dirname;
const ARQUIVO_DADOS = path.join(PASTA_DADOS, 'dados.json');
function leDados() {
    const vazio = { favoritos: [], vinculos: {}, nomes: {}, arquivadas: [] };
    try { return { ...vazio, ...JSON.parse(fs.readFileSync(ARQUIVO_DADOS, 'utf8')) }; }
    catch (e) { return vazio; }
}
function gravaDados(dados) {
    fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(dados, null, 2));
}
function chaveValida(chave) {
    return typeof chave === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/.test(chave);
}

// Anexos da caixa de mensagem: imagens vão direto para o modelo; outros arquivos são salvos
// em anexos/ e o caminho entra no texto, para o Claude ler se precisar.
const PASTA_ANEXOS = path.join(PASTA_DADOS, 'anexos');
function preparaAnexos(anexos) {
    const imagens = [];
    const salvos = [];
    for (const a of (Array.isArray(anexos) ? anexos : []).slice(0, 10)) {
        const dados = String(a.dados || '');
        if (!dados || dados.length > 14e6) continue;
        if (/^image\/(png|jpeg|gif|webp)$/.test(a.tipo) && imagens.length < 5) {
            imagens.push({ tipo: a.tipo, dados });
            continue;
        }
        const nome = String(a.nome || 'anexo').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'anexo';
        const pasta = path.join(PASTA_ANEXOS, new Date().toISOString().slice(0, 10));
        fs.mkdirSync(pasta, { recursive: true });
        const destino = path.join(pasta, `${Date.now()}-${nome}`);
        fs.writeFileSync(destino, Buffer.from(dados, 'base64'));
        salvos.push(destino);
    }
    const textoExtra = salvos.length ? `\n\nArquivos que anexei (leia se precisar):\n${salvos.map(s => '- ' + s).join('\n')}` : '';
    return { imagens, textoExtra };
}

// Pastas que o painel aceita consultar (só as de conversas conhecidas)
function pastaConhecida(cwd) {
    if (!cwd) return false;
    const alvo = path.resolve(cwd).toLowerCase();
    return listaSessoes().some(s => s.cwd && path.resolve(s.cwd).toLowerCase() === alvo);
}

// Modelos configurados: agentes (seus e do projeto) e o hook do Haiku que reescreve o pedido.
// O painel compara com o que a conversa usou de fato, para ver se a configuração está valendo.
function configModelos(cwd) {
    const agentes = {};
    const raizes = [[path.join(os.homedir(), '.claude'), 'seu'], cwd ? [path.join(cwd, '.claude'), 'projeto'] : null].filter(Boolean);
    for (const [raiz, origem] of raizes) {
        const pasta = path.join(raiz, 'agents');
        if (!fs.existsSync(pasta)) continue;
        for (const f of fs.readdirSync(pasta)) {
            if (!f.endsWith('.md')) continue;
            try {
                const texto = fs.readFileSync(path.join(pasta, f), 'utf8').slice(0, 4000);
                const fm = (texto.match(/^\uFEFF?---\s*[\r\n]([\s\S]*?)[\r\n]---/) || [])[1] || '';
                const campo = (nome) => ((fm.match(new RegExp('^' + nome + ':\\s*["\']?([^\\r\\n"\']*)', 'm')) || [])[1] || '').trim();
                const nome = campo('name') || f.replace(/\.md$/, '');
                // O do projeto vale mais que o seu, como no Claude Code
                agentes[nome] = { modelo: campo('model') || 'inherit', esforco: campo('effort') || '', origem };
            } catch (e) { /* arquivo ilegível: ignora */ }
        }
    }
    // Hook que reescreve o pedido com o Haiku (procura nas configurações do usuário e do projeto)
    let hookHaiku = false;
    const configs = [path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), '.claude', 'settings.local.json')];
    if (cwd) configs.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
    for (const c of configs) {
        try { if (/refine-prompt/.test(JSON.stringify(JSON.parse(fs.readFileSync(c, 'utf8')).hooks || {}))) hookHaiku = true; } catch (e) { /* sem arquivo */ }
    }
    return { agentes, hookHaiku };
}

// Comandos e skills para o menu "/" da caixa de mensagem (do usuário e do projeto)
function listaComandos(cwd) {
    const lista = [
        { nome: 'compact', descricao: 'Resume a conversa para liberar contexto', origem: 'Claude Code' },
        { nome: 'context', descricao: 'Mostra o que está ocupando o contexto', origem: 'Claude Code' },
        { nome: 'cost', descricao: 'Mostra o custo da conversa', origem: 'Claude Code' },
    ];
    const descricaoDe = (arquivo) => {
        try {
            const texto = fs.readFileSync(arquivo, 'utf8').slice(0, 4000);
            const fm = texto.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
            const desc = fm && (fm[1].match(/description:\s*["']?([^\r\n]*)/) || [])[1];
            return corta(String(desc || '').replace(/["']$/, ''), 140);
        } catch (e) { return ''; }
    };
    const raizes = [[path.join(os.homedir(), '.claude'), 'seu'], cwd ? [path.join(cwd, '.claude'), 'projeto'] : null].filter(Boolean);
    for (const [raiz, origem] of raizes) {
        const pastaCmd = path.join(raiz, 'commands');
        if (fs.existsSync(pastaCmd)) for (const f of fs.readdirSync(pastaCmd)) if (f.endsWith('.md')) lista.push({ nome: f.replace(/\.md$/, ''), descricao: descricaoDe(path.join(pastaCmd, f)), origem: `comando ${origem}` });
        const pastaSkills = path.join(raiz, 'skills');
        if (fs.existsSync(pastaSkills)) for (const d of fs.readdirSync(pastaSkills)) {
            const skill = path.join(pastaSkills, d, 'SKILL.md');
            if (fs.existsSync(skill)) lista.push({ nome: d, descricao: descricaoDe(skill), origem: `skill ${origem}` });
        }
    }
    return lista;
}

// Busca de arquivos do projeto para o "@" da caixa de mensagem
const PASTAS_IGNORADAS = new Set(['node_modules', '.git', 'vendor', '.vs', '.idea', 'dist', 'build', '.next', '.playwright-mcp', 'anexos']);
const cacheArquivos = new Map();
function arquivosDoProjeto(cwd) {
    const item = cacheArquivos.get(cwd);
    if (item && Date.now() - item.quando < 60000) return item.lista;
    const lista = [];
    const anda = (dir, rel, nivel) => {
        if (nivel > 8 || lista.length > 20000) return;
        let entradas = [];
        try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entradas) {
            if (e.isDirectory()) { if (!PASTAS_IGNORADAS.has(e.name) && !e.name.startsWith('.')) anda(path.join(dir, e.name), rel + e.name + '/', nivel + 1); }
            else lista.push(rel + e.name);
        }
    };
    anda(cwd, '', 0);
    cacheArquivos.set(cwd, { quando: Date.now(), lista });
    return lista;
}
function buscaArquivos(cwd, termo) {
    const t = String(termo || '').toLowerCase().replace(/\\/g, '/');
    const lista = arquivosDoProjeto(cwd);
    if (!t) return lista.slice(0, 15);
    // Nome do arquivo que começa com o termo vem primeiro; depois, o caminho que contém
    const pontua = (p) => { const nome = p.toLowerCase().split('/').pop(); return nome.startsWith(t) ? 0 : nome.includes(t) ? 1 : p.toLowerCase().includes(t) ? 2 : 9; };
    return lista.map(p => ({ p, n: pontua(p) })).filter(x => x.n < 9).sort((a, b) => a.n - b.n || a.p.length - b.p.length).slice(0, 15).map(x => x.p);
}

// Conversa em Markdown (o que está carregado: pedidos, respostas, ações principais)
function exportaMarkdown(projeto, id) {
    const d = detalheSessao(projeto, id);
    if (!d) return null;
    const linhas = [`# ${d.titulo || 'Conversa'}`, '', `Projeto: ${d.projeto}. Modelo: ${d.modelo}. Exportado em ${new Date().toLocaleString('pt-BR')}.`, ''];
    for (const e of d.eventos) {
        const h = new Date(e.hora).toLocaleString('pt-BR');
        if (e.tipo === 'pedido') linhas.push(`## Você (${h})`, '', e.texto, '');
        else if (e.tipo === 'fala') linhas.push(`## Claude (${h})`, '', e.texto, '');
        else if (e.tipo === 'capitulo') linhas.push(`---`, '', `### ${e.texto}`, '');
        else if (['comando', 'edicao', 'agente'].includes(e.tipo)) linhas.push(`> ${e.tipo === 'comando' ? 'Rodou' : e.tipo === 'edicao' ? 'Editou' : 'Delegou'}: ${e.texto}`, '');
    }
    return linhas.join('\n');
}

// Projetos conhecidos (pastas onde já houve conversa), para iniciar conversa nova
function listaProjetos() {
    const vistos = new Map();
    for (const s of listaSessoes()) {
        if (s.cwd && !vistos.has(s.cwd.toLowerCase())) vistos.set(s.cwd.toLowerCase(), { cwd: s.cwd, nome: s.nomeProjeto, ultimo: s.atualizado });
    }
    const lista = [...vistos.values()].filter(p => p.nome !== 'rascunho do app' && fs.existsSync(p.cwd)).map(p => ({ ...p, grupo: 'Com conversas' }));
    // Outras pastas da raiz de projetos (ainda sem conversa)
    const raizProjetos = process.env.PAINEL_RAIZ_PROJETOS || 'C:\\ProjetosGit';
    try {
        for (const d of fs.readdirSync(raizProjetos, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const cwd = path.join(raizProjetos, d.name);
            if (!vistos.has(cwd.toLowerCase())) lista.push({ cwd, nome: d.name, grupo: 'Em ' + raizProjetos });
        }
    } catch (e) { /* raiz não existe */ }
    // Sem projeto: a pasta do usuário, sem as regras (CLAUDE.md) de nenhum projeto
    const casa = os.homedir();
    if (!lista.some(p => p.cwd.toLowerCase() === casa.toLowerCase())) lista.push({ cwd: casa, nome: 'Sem projeto', grupo: 'Fora de projeto', semProjeto: true });
    return lista;
}

// Código do servidor mudou depois que ele subiu? (a página avisa e oferece o reinício seguro)
const INICIO_SERVIDOR = Date.now();
let reinicioAgendado = null;
// encerrar = true: sai com código 0 (o lançador não sobe de novo; o app desktop assume a porta)
let encerrarEmVezDeReiniciar = false;
function agendaReinicio(encerrar = false) {
    if (encerrar) encerrarEmVezDeReiniciar = true;
    if (reinicioAgendado) return;
    reinicioAgendado = new Date().toISOString();
    const tenta = () => {
        chat.fechaOciosas(0);
        const vivas = chat.estado().filter(c => c.vivo || c.status === 'rodando' || c.status === 'parando');
        if (vivas.length || terminal.quantos()) return setTimeout(tenta, 5000);
        console.log('Reiniciando para carregar o código novo');
        servidor.close();
        setTimeout(() => process.exit(encerrarEmVezDeReiniciar ? 0 : 75), 300);
    };
    setTimeout(tenta, 1000);
}
function versaoServidor() {
    const alterado = Math.max(...['server.js', 'chat.js'].map(a => { try { return fs.statSync(path.join(__dirname, a)).mtimeMs; } catch (e) { return 0; } }));
    return { encerrar: encerrarEmVezDeReiniciar, terminais: terminal.quantos(), comLancador: !!process.env.PAINEL_LANCADOR, desatualizado: alterado > INICIO_SERVIDOR, iniciado: new Date(INICIO_SERVIDOR).toISOString(), alterado: new Date(alterado).toISOString(), reinicioAgendado };
}

// Mesma trava do enviar: não mexe numa conversa trabalhando em outro lugar
function travaDaSessao(detalhe, sessao) {
    const vivaNoPainel = chat.vivaNaSessao(sessao);
    if (vivaNoPainel && (vivaNoPainel.status === 'rodando' || vivaNoPainel.status === 'parando')) return 'A conversa está respondendo agora. Espere ela terminar (ou pare a resposta).';
    if (detalhe.pergunta) return 'A conversa tem uma pergunta esperando resposta.';
    if (detalhe.ativa || detalhe.agentesRodando) return 'A conversa está trabalhando (aqui, no VS Code ou com agente em segundo plano). Espere ela terminar.';
    return null;
}
function sessaoDoCorpo(corpo) {
    if (!corpo || /[\\/]|\.\./.test(String(corpo.projeto) + String(corpo.sessao))) return null;
    const detalhe = detalheSessao(String(corpo.projeto), String(corpo.sessao));
    return detalhe && detalhe.cwd ? detalhe : null;
}

// Edições de um arquivo feitas na conversa (Edit, MultiEdit, Write), lidas do transcript
function diffsDoArquivo(projeto, id, arquivoAlvo) {
    const arquivo = path.join(RAIZ_PROJETOS, projeto, id + '.jsonl');
    const alvo = path.resolve(arquivoAlvo).toLowerCase();
    const lista = [];
    let total = 0;
    for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
        if (!linha.includes('"tool_use"') || !linha.includes('file_path')) continue;
        let r;
        try { r = JSON.parse(linha); } catch (e) { continue; }
        if (r.type !== 'assistant' || r.isSidechain) continue;
        for (const b of (r.message && r.message.content) || []) {
            if (b.type !== 'tool_use' || !b.input || !b.input.file_path) continue;
            if (path.resolve(b.input.file_path).toLowerCase() !== alvo) continue;
            const junta = (tipo, antes, depois) => {
                total += antes.length + depois.length;
                if (total <= 300000) lista.push({ hora: r.timestamp, tipo, antes, depois });
                else if (!lista.cortado) lista.cortado = true;
            };
            if (b.name === 'Edit') junta('edicao', String(b.input.old_string || ''), String(b.input.new_string || ''));
            else if (b.name === 'MultiEdit') (b.input.edits || []).forEach(e => junta('edicao', String(e.old_string || ''), String(e.new_string || '')));
            else if (b.name === 'Write') junta('criacao', '', String(b.input.content || ''));
        }
    }
    return { edicoes: lista, cortado: !!lista.cortado };
}
// git diff atual do arquivo (só leitura). Arquivos Latin-1 (Royal) são lidos como tal.
function gitDiff(cwd, arquivo) {
    return new Promise((resolve) => {
        const rel = path.relative(cwd, arquivo);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return resolve(null);
        execFile('git', ['-C', cwd, 'diff', '--no-color', '--', rel], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer', windowsHide: true }, (erro, saida) => {
            if (erro || !saida) return resolve(null);
            const utf8 = saida.toString('utf8');
            resolve(utf8.includes('\uFFFD') ? saida.toString('latin1') : utf8);
        });
    });
}

// Plugins ligados/desligados no ~/.claude/settings.json (com backup antes de gravar)
const ARQ_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
function lePlugins() {
    const json = JSON.parse(fs.readFileSync(ARQ_SETTINGS, 'utf8'));
    return Object.entries(json.enabledPlugins || {}).map(([nome, ligado]) => ({ nome, ligado: !!ligado }));
}
function gravaPlugin(nome, ligado) {
    const bruto = fs.readFileSync(ARQ_SETTINGS, 'utf8');
    const json = JSON.parse(bruto);
    if (!json.enabledPlugins || !(nome in json.enabledPlugins)) throw new Error('Plugin não encontrado nas configurações.');
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const pasta = path.join(os.homedir(), '.claude', 'backups', `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`);
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, 'settings.json'), bruto);
    json.enabledPlugins[nome] = !!ligado;
    // Mantém o fim de linha e a quebra final do arquivo original
    const crlf = bruto.includes('\r\n');
    let novo = JSON.stringify(json, null, 2);
    if (/\r?\n$/.test(bruto)) novo += '\n';
    if (crlf) novo = novo.replace(/\n/g, '\r\n');
    fs.writeFileSync(ARQ_SETTINGS, novo);
    return pasta;
}

async function rotaChat(req, res, url) {
    if (url.pathname === '/api/versao' && req.method === 'GET') return responde(res, 200, versaoServidor());
    if (url.pathname === '/api/chat/estado' && req.method === 'GET') return responde(res, 200, chat.estado());
    if (url.pathname === '/api/projetos' && req.method === 'GET') return responde(res, 200, listaProjetos());
    if (url.pathname === '/api/dados' && req.method === 'GET') return responde(res, 200, leDados());
    if (url.pathname.startsWith('/api/git/')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = req.method === 'GET' ? url.searchParams.get('cwd') : null;
        try {
            if (req.method === 'GET') {
                if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
                const q = (k) => url.searchParams.get(k);
                if (url.pathname === '/api/git/estado') return responde(res, 200, await gitScm.estado(cwd));
                if (url.pathname === '/api/git/diff') return responde(res, 200, { diff: await gitScm.diff(cwd, q('arquivo'), q('staged') === '1') });
                if (url.pathname === '/api/git/log') return responde(res, 200, await gitScm.log(cwd, q('n')));
                if (url.pathname === '/api/git/commit') return responde(res, 200, q('arquivo') ? { diff: await gitScm.commit(cwd, q('hash'), q('arquivo')) } : await gitScm.commit(cwd, q('hash')));
                if (url.pathname === '/api/git/branches') return responde(res, 200, await gitScm.branches(cwd));
                if (url.pathname === '/api/git/a-subir') return responde(res, 200, { commits: await gitScm.aSubir(cwd), hooks: await gitScm.hooksComEfeito(cwd) });
                if (url.pathname === '/api/git/hooks') return responde(res, 200, { hooks: await gitScm.hooksComEfeito(cwd) });
                return responde(res, 404, { erro: 'não encontrado' });
            }
            if (req.method !== 'POST' || url.pathname !== '/api/git/acao') return responde(res, 405, { erro: 'use POST' });
            const corpo = await leCorpo(req, 1e6);
            if (!pastaConhecida(corpo.cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
            return responde(res, 200, await gitScm.acao(corpo.cwd, corpo));
        } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/automacao') {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const dados = leDados();
        const desde = Number(url.searchParams.get('desde')) || 0;
        return responde(res, 200, { agendamentos: dados.agendamentos || [], fila: dados.fila || [], filaPausada: !!dados.filaPausada, eventos: eventosAutomacao.filter(e => e.em > desde), agora: Date.now() });
    }
    if (req.method === 'GET' && (url.pathname === '/api/github' || url.pathname === '/api/hooks')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = url.searchParams.get('cwd');
        if (cwd && !pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/hooks') return responde(res, 200, integracoes.hooks(cwd));
            if (!cwd) return responde(res, 400, { erro: 'cwd?' });
            return responde(res, 200, await integracoes.github(cwd));
        } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (req.method === 'GET' && ['/api/busca', '/api/resumo-dia', '/api/modelos-pedido'].includes(url.pathname)) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        try {
            if (url.pathname === '/api/busca') return responde(res, 200, await alem.busca(listaSessoes(), RAIZ_PROJETOS, url.searchParams.get('q'), url.searchParams.get('tipo') === 'arquivo' ? 'arquivo' : 'texto'));
            if (url.pathname === '/api/resumo-dia') return responde(res, 200, alem.resumoDia(listaSessoes(), detalheSessao));
            return responde(res, 200, alem.modelos(leDados()));
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (req.method === 'GET' && (url.pathname === '/api/worktree/repo' || url.pathname === '/api/worktrees')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = url.searchParams.get('cwd');
        if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/worktree/repo') return responde(res, 200, { repo: await worktrees.repoDe(cwd) });
            return responde(res, 200, await worktrees.listar(cwd));
        } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/editor/')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = url.searchParams.get('cwd');
        if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/editor/arvore') return responde(res, 200, editorArquivos.arvore(cwd, url.searchParams.get('dir') || '.'));
            if (url.pathname === '/api/editor/arquivo') return responde(res, 200, editorArquivos.ler(cwd, url.searchParams.get('caminho')));
            if (url.pathname === '/api/editor/diagnosticos') return responde(res, 200, await editorArquivos.diagnosticos(cwd, url.searchParams.get('caminho')));
        } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
        return responde(res, 404, { erro: 'não encontrado' });
    }
    if (req.method === 'GET' && ['/api/diff', '/api/mcp', '/api/plugins'].includes(url.pathname)) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        if (url.pathname === '/api/plugins') {
            try { return responde(res, 200, lePlugins()); } catch (e) { return responde(res, 500, { erro: e.message }); }
        }
        const detalhe = sessaoDoCorpo({ projeto: url.searchParams.get('projeto'), sessao: url.searchParams.get('sessao') });
        if (!detalhe) return responde(res, 404, { erro: 'Sessão não encontrada.' });
        if (url.pathname === '/api/diff') {
            const arquivo = url.searchParams.get('arquivo') || '';
            if (!arquivo) return responde(res, 400, { erro: 'arquivo?' });
            const dados = diffsDoArquivo(url.searchParams.get('projeto'), url.searchParams.get('sessao'), arquivo);
            dados.git = await gitDiff(detalhe.cwd, path.resolve(detalhe.cwd, arquivo));
            return responde(res, 200, dados);
        }
        try { return responde(res, 200, await chat.statusMcp(url.searchParams.get('sessao'), detalhe.cwd)); } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (req.method !== 'POST') return responde(res, 405, { erro: 'use POST' });
    if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
    const corpo = await leCorpo(req, url.pathname === '/api/chat/enviar' ? 35e6 : url.pathname === '/api/editor/salvar' ? 8e6 : 1e6);

    if (url.pathname === '/api/agendamentos') {
        try {
            const dados = leDados();
            dados.agendamentos = automacao.validaAgendamentos(corpo.lista, pastaConhecida, dados.agendamentos || []);
            gravaDados(dados);
            return responde(res, 200, dados.agendamentos);
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/agendamentos/rodar') {
        try { return responde(res, 200, await automatico.rodaAgendada(String(corpo.id))); } catch (e) { return responde(res, 409, { erro: e.message }); }
    }
    if (url.pathname === '/api/fila') {
        try {
            const dados = leDados();
            dados.fila = dados.fila || [];
            if (corpo.acao === 'adicionar') {
                if (dados.fila.filter(i => i.status === 'esperando').length >= 50) throw new Error('A fila já tem 50 pedidos esperando.');
                const p = automacao.validaPedido(corpo.pedido || {}, pastaConhecida);
                dados.fila.push({ id: crypto.randomBytes(6).toString('hex'), ...p, status: 'esperando', criado: new Date().toISOString() });
            } else if (corpo.acao === 'remover') {
                dados.fila = dados.fila.filter(i => !(i.id === corpo.id && i.status !== 'rodando'));
            } else if (corpo.acao === 'limpar') {
                dados.fila = dados.fila.filter(i => i.status === 'esperando' || i.status === 'rodando');
            } else if (corpo.acao === 'pausar') {
                dados.filaPausada = !!corpo.pausada;
            } else throw new Error('ação inválida');
            gravaDados(dados);
            setTimeout(() => automatico.ciclo().catch(() => {}), 500);
            return responde(res, 200, { fila: dados.fila, filaPausada: !!dados.filaPausada });
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/trello') {
        if (!chaveValida(corpo.chave)) return responde(res, 400, { erro: 'conversa inválida' });
        try {
            const link = integracoes.validaTrello(corpo.url);
            const dados = leDados();
            dados.trello = dados.trello || {};
            if (link) dados.trello[corpo.chave] = link; else delete dados.trello[corpo.chave];
            gravaDados(dados);
            return responde(res, 200, { ok: true, url: link });
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/modelos-pedido') {
        try {
            const dados = leDados();
            dados.modelosPedido = alem.validaModelos(corpo.modelos);
            gravaDados(dados);
            return responde(res, 200, dados.modelosPedido);
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/worktree/criar' || url.pathname === '/api/worktree/remover') {
        if (!pastaConhecida(corpo.cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/worktree/criar') return responde(res, 200, await worktrees.criar(corpo.cwd, String(corpo.nome || 'conversa')));
            // Conversa aberta no painel usando o worktree segura a pasta: recusa com explicação
            const alvo = path.resolve(String(corpo.caminho || '')).toLowerCase();
            if (chat.estado().some(c => c.vivo && c.cwd && path.resolve(c.cwd).toLowerCase() === alvo)) {
                return responde(res, 409, { erro: 'Há uma conversa aberta no painel usando este worktree. Feche-a (ou espere ela ficar parada uns minutos) antes de remover.' });
            }
            const dentroDoAlvo = (p) => { const r = path.resolve(p).toLowerCase(); return r === alvo || r.startsWith(alvo + path.sep); };
            if (terminal.pastasAbertas().some(dentroDoAlvo)) {
                return responde(res, 409, { erro: 'Há um terminal do painel aberto dentro deste worktree. Feche-o (digite exit) antes de remover.' });
            }
            return responde(res, 200, await worktrees.remover(corpo.cwd, String(corpo.caminho || '')));
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/editor/salvar') {
        if (!pastaConhecida(corpo.cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        if (typeof corpo.conteudo !== 'string' || corpo.conteudo.length > 6e6) return responde(res, 400, { erro: 'Conteúdo inválido.' });
        try {
            const r = editorArquivos.salvar(corpo.cwd, corpo);
            r.diagnosticos = await editorArquivos.diagnosticos(corpo.cwd, corpo.caminho);
            return responde(res, 200, r);
        } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
    }
    if (url.pathname === '/api/plugins') {
        try {
            const backup = gravaPlugin(String(corpo.nome || ''), !!corpo.ligado);
            return responde(res, 200, { ok: true, backup, plugins: lePlugins(), aviso: 'Vale para as conversas abertas a partir de agora.' });
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (url.pathname === '/api/mcp/acao') {
        if (!['reconectar', 'ligar', 'desligar'].includes(corpo.acao)) return responde(res, 400, { erro: 'ação inválida' });
        try { return responde(res, 200, await chat.acaoMcp(String(corpo.sessao), String(corpo.servidor), corpo.acao)); } catch (e) { return responde(res, 409, { erro: e.message }); }
    }
    if (url.pathname === '/api/chat/voltar' || url.pathname === '/api/chat/ramificar') {
        const detalhe = sessaoDoCorpo(corpo);
        if (!detalhe) return responde(res, 404, { erro: 'Sessão não encontrada.' });
        if (!/^[0-9a-f-]{36}$/i.test(String(corpo.uuid))) return responde(res, 400, { erro: 'mensagem inválida' });
        if (url.pathname === '/api/chat/ramificar') {
            try {
                const r = await chat.ramificar(String(corpo.sessao), detalhe.cwd, corpo.uuid);
                const dados = leDados();
                dados.vinculos[`${corpo.projeto}/${r.sessionId}`] = `${corpo.projeto}/${corpo.sessao}`;
                gravaDados(dados);
                return responde(res, 200, { ok: true, chave: `${corpo.projeto}/${r.sessionId}` });
            } catch (e) { return responde(res, 500, { erro: e.message }); }
        }
        const trava = travaDaSessao(detalhe, String(corpo.sessao));
        if (trava && !corpo.simular) return responde(res, 409, { erro: trava });
        try { return responde(res, 200, await chat.voltarArquivos(String(corpo.sessao), detalhe.cwd, corpo.uuid, !!corpo.simular)); }
        catch (e) { return responde(res, 500, { erro: e.message }); }
    }

    if (url.pathname === '/api/chat/modo') {
        if (!chat.MODOS.includes(corpo.modo)) return responde(res, 400, { erro: 'modo inválido' });
        try {
            return (await chat.trocaModo(corpo.chave, corpo.modo)) ? responde(res, 200, { ok: true }) : responde(res, 200, { ok: true, proxima: true });
        } catch (e) {
            return responde(res, 409, { erro: e.message });
        }
    }

    if (url.pathname === '/api/chat/enviar') {
        const texto = String(corpo.texto || '').trim();
        if (!texto) return responde(res, 400, { erro: 'Escreva uma mensagem.' });
        let cwd = corpo.cwd;
        if (corpo.sessao) {
            if (/[\\/]|\.\./.test(corpo.projeto + corpo.sessao)) return responde(res, 400, { erro: 'sessão inválida' });
            const detalhe = detalheSessao(corpo.projeto, corpo.sessao);
            if (!detalhe) return responde(res, 404, { erro: 'Sessão não encontrada.' });
            // Trava: não escreve numa conversa que está trabalhando em outro lugar (VS Code).
            // Se o processo vivo é do próprio painel (mesmo com agente em segundo plano), a
            // mensagem entra na fila dele.
            // Respondendo pelo painel: a mensagem entra como comentário no meio do trabalho
            const vivaNoPainel = chat.vivaNaSessao(corpo.sessao);
            if (!vivaNoPainel && detalhe.pergunta) {
                return responde(res, 409, { erro: 'Esta conversa fez uma pergunta em outro lugar (provavelmente no VS Code). Responda lá antes de escrever aqui.' });
            }
            if (!vivaNoPainel && detalhe.ativa) {
                return responde(res, 409, { erro: detalhe.agentesRodando && detalhe.fimTurno
                    ? 'Esta conversa tem um agente rodando em segundo plano e vai continuar sozinha quando ele terminar. Espere para escrever aqui.'
                    : 'Esta conversa está trabalhando agora em outro lugar (provavelmente no VS Code). Espere ela terminar para escrever aqui.' });
            }
            cwd = detalhe.cwd;
        }
        if (!cwd || !fs.existsSync(cwd)) return responde(res, 400, { erro: 'Pasta do projeto não encontrada.' });
        // Conversa nova que continua outra: grava o vínculo assim que a sessão nascer
        const origem = !corpo.sessao && chaveValida(corpo.origem) ? corpo.origem : null;
        const aoCriarSessao = origem ? (projeto, sessionId) => {
            const dados = leDados();
            dados.vinculos[`${projeto}/${sessionId}`] = origem;
            gravaDados(dados);
        } : null;
        const { imagens: imagensAnexas, textoExtra } = preparaAnexos(corpo.anexos);
        const conversa = await chat.enviar({
            cwd, sessao: corpo.sessao, texto: texto + textoExtra, modelo: corpo.modelo, esforco: corpo.esforco,
            modo: corpo.modo, imagens: imagensAnexas, aoCriarSessao,
        });
        return responde(res, 200, { chave: conversa.chave, projeto: conversa.projeto });
    }
    if (url.pathname === '/api/reiniciar') {
        // Só funciona com o lançador (lancador.js), que sobe o servidor de novo quando ele sai
        // com o código 75. O servidor espera nada estar vivo; conversas paradas e sem agente
        // são fechadas, como no script seguro.
        if (!process.env.PAINEL_LANCADOR) return responde(res, 409, { erro: 'O painel não foi aberto pelo lançador. Rode o script de reinício uma vez.' });
        agendaReinicio(corpo.encerrar === true);
        return responde(res, 200, { ok: true, reinicioAgendado });
    }
    if (url.pathname === '/api/chat/fechar-ociosas') {
        // Usado pelo reinício seguro: fecha processos parados e sem agente
        const minutos = Number.isFinite(corpo.minutos) ? corpo.minutos : 20;
        return responde(res, 200, { fechadas: chat.fechaOciosas(minutos) });
    }
    if (url.pathname === '/api/renomear') {
        if (!chaveValida(corpo.chave)) return responde(res, 400, { erro: 'conversa inválida' });
        const dados = leDados();
        const nome = String(corpo.nome || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (nome) dados.nomes[corpo.chave] = nome; else delete dados.nomes[corpo.chave];
        gravaDados(dados);
        return responde(res, 200, { nome });
    }
    if (url.pathname === '/api/arquivar') {
        if (!chaveValida(corpo.chave)) return responde(res, 400, { erro: 'conversa inválida' });
        const dados = leDados();
        const ja = dados.arquivadas.includes(corpo.chave);
        dados.arquivadas = ja ? dados.arquivadas.filter(a => a !== corpo.chave) : [...dados.arquivadas, corpo.chave];
        gravaDados(dados);
        return responde(res, 200, { arquivada: !ja });
    }
    if (url.pathname === '/api/favorito') {
        if (!chaveValida(corpo.chave)) return responde(res, 400, { erro: 'conversa inválida' });
        const dados = leDados();
        const ja = dados.favoritos.includes(corpo.chave);
        dados.favoritos = ja ? dados.favoritos.filter(f => f !== corpo.chave) : [...dados.favoritos, corpo.chave];
        gravaDados(dados);
        return responde(res, 200, { favorita: !ja });
    }
    if (url.pathname === '/api/chat/responder') {
        return chat.responder(corpo.id, corpo) ? responde(res, 200, { ok: true }) : responde(res, 404, { erro: 'Este pedido já foi respondido ou expirou.' });
    }
    if (url.pathname === '/api/chat/parar') {
        return (await chat.parar(corpo.chave)) ? responde(res, 200, { ok: true }) : responde(res, 404, { erro: 'Nada rodando para parar.' });
    }
    return responde(res, 404, { erro: 'não encontrado' });
}

// Token secreto desta subida do servidor: vai no HTML da página e é exigido pelo terminal
const TOKEN = crypto.randomBytes(24).toString('hex');
// Arquivos do xterm (terminal na página), servidos de uma lista fechada
const VENDOR = {
    '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
function pastaDoTerminal(cwd) {
    if (!cwd) return false;
    const alvo = path.resolve(cwd).toLowerCase();
    return pastaConhecida(cwd) || alvo === path.resolve(os.homedir()).toLowerCase();
}

const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (![`127.0.0.1:${PORTA}`, `localhost:${PORTA}`].includes(req.headers.host)) {
        res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Host não permitido');
    }
    try {
        if (url.pathname === '/') {
            const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__PAINEL_TOKEN__', TOKEN);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(html);
        }
        if (url.pathname === '/editor.html') {
            const html = fs.readFileSync(path.join(__dirname, 'editor.html'), 'utf8').replace('__PAINEL_TOKEN__', TOKEN);
            // CSP: nenhum script embutido nem handler inline (onerror=...) roda nesta página.
            // Mitiga o DOMPurify vulnerável que vem embutido no build do Monaco.
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            });
            return res.end(html);
        }
        if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(path.join(__dirname, 'favicon.svg')));
        }
        if (url.pathname === '/editor.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(path.join(__dirname, 'editor.js')));
        }
        if (url.pathname.startsWith('/vendor/monaco/')) {
            const raiz = path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs');
            const alvo = path.resolve(raiz, decodeURIComponent(url.pathname.slice('/vendor/monaco/'.length)));
            const tipos = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json', '.map': 'application/json' };
            const tipo = tipos[path.extname(alvo).toLowerCase()];
            if (!tipo || !alvo.startsWith(raiz + path.sep) || !fs.existsSync(alvo)) return responde(res, 404, { erro: 'não encontrado' });
            res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(alvo));
        }
        if (VENDOR[url.pathname]) {
            const [rel, tipo] = VENDOR[url.pathname];
            res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            // Caminho direto em node_modules (o "exports" dos pacotes pode bloquear o require.resolve)
            return res.end(fs.readFileSync(path.join(__dirname, 'node_modules', rel)));
        }
        if (url.pathname.startsWith('/api/chat/') || url.pathname.startsWith('/api/git/') || ['/api/projetos', '/api/dados', '/api/favorito', '/api/renomear', '/api/arquivar', '/api/versao', '/api/reiniciar', '/api/diff', '/api/mcp', '/api/mcp/acao', '/api/plugins', '/api/editor/arvore', '/api/editor/arquivo', '/api/editor/salvar', '/api/editor/diagnosticos', '/api/worktree/repo', '/api/worktrees', '/api/worktree/criar', '/api/worktree/remover', '/api/busca', '/api/resumo-dia', '/api/modelos-pedido', '/api/github', '/api/hooks', '/api/trello', '/api/automacao', '/api/agendamentos', '/api/agendamentos/rodar', '/api/fila'].includes(url.pathname)) return await rotaChat(req, res, url);
        if (url.pathname === '/api/sessoes') return responde(res, 200, listaSessoes());
        if (url.pathname === '/api/uso') {
            const agora = Date.now();
            const vencido = !cacheUso.dados || agora - cacheUso.em > 55000 || (url.searchParams.has('atualizar') && agora - cacheUso.em > 10000);
            if (vencido) {
                if (!cacheUso.pedido) cacheUso.pedido = chat.usoDoPlano().then(d => { cacheUso.dados = d; cacheUso.em = Date.now(); })
                    .catch(e => { cacheUso.dados = { disponivel: false, erro: e.message }; cacheUso.em = Date.now() - 30000; })
                    .finally(() => { cacheUso.pedido = null; });
                await cacheUso.pedido;
            }
            return responde(res, 200, cacheUso.dados);
        }
        if (url.pathname === '/api/config-modelos') {
            const cwd = url.searchParams.get('cwd');
            return responde(res, 200, configModelos(pastaConhecida(cwd) ? cwd : null));
        }
        if (url.pathname === '/api/comandos') {
            const cwd = url.searchParams.get('cwd');
            const pasta = pastaConhecida(cwd) ? cwd : null;
            const doDisco = listaComandos(pasta);
            if (!pasta) return responde(res, 200, doDisco);
            // Lista real do Claude Code (cache de 10 min por pasta); se falhar, fica a lida do disco
            const chave = pasta.toLowerCase();
            const guardado = cacheComandos.get(chave);
            if (!guardado || Date.now() - guardado.em > 600000) {
                try {
                    const lista = await chat.comandosDisponiveis(pasta);
                    const origemDisco = new Map(doDisco.map(x => [x.nome, x.origem]));
                    cacheComandos.set(chave, { em: Date.now(), lista: lista.filter(x => !x.name.startsWith('__')).map(x => ({
                        nome: x.name, descricao: corta(x.description || '', 140), dica: x.argumentHint || '',
                        origem: x.builtin ? 'Claude Code' : (origemDisco.get(x.name) || (x.name.includes(':') ? 'plugin' : 'skill')),
                    })) });
                } catch (e) {
                    return responde(res, 200, doDisco);
                }
            }
            return responde(res, 200, cacheComandos.get(chave).lista);
        }
        if (url.pathname === '/api/arquivos') {
            const cwd = url.searchParams.get('cwd');
            if (!pastaConhecida(cwd)) return responde(res, 400, { erro: 'pasta desconhecida' });
            return responde(res, 200, buscaArquivos(cwd, url.searchParams.get('q')));
        }
        const exp = url.pathname.match(/^\/api\/exportar\/([^/]+)\/([^/]+)$/);
        if (exp) {
            const projeto = decodeURIComponent(exp[1]), id = decodeURIComponent(exp[2]);
            if (/[\\/]|\.\./.test(projeto + id)) return responde(res, 400, { erro: 'inválido' });
            const md = exportaMarkdown(projeto, id);
            if (!md) return responde(res, 404, { erro: 'sessão não encontrada' });
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="conversa-${id.slice(0, 8)}.md"` });
            return res.end(md);
        }
        const arq = url.pathname.match(/^\/api\/arquivo\/([a-f0-9]{24})(?:\/[^/]*)?$/);
        if (arq) return serveArquivo(res, arq[1]);
        const img = url.pathname.match(/^\/api\/imagem\/([a-f0-9]{20})$/);
        if (img) {
            const ponteiro = imagens.get(img[1]);
            if (!ponteiro || !/^image\/(png|jpeg|gif|webp)$/.test(ponteiro.tipo)) return responde(res, 404, { erro: 'imagem não encontrada' });
            const bytes = leImagem(ponteiro);
            if (!bytes) return responde(res, 404, { erro: 'imagem não encontrada' });
            res.writeHead(200, { 'Content-Type': ponteiro.tipo, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
            return res.end(bytes);
        }
        const m = url.pathname.match(/^\/api\/sessao\/([^/]+)\/([^/]+)$/);
        if (m) {
            const dados = detalheSessao(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
            return dados ? responde(res, 200, dados) : responde(res, 404, { erro: 'sessão não encontrada' });
        }
        responde(res, 404, { erro: 'não encontrado' });
    } catch (e) {
        responde(res, 500, { erro: e.message });
    }
});

// Automação (Fase 5): tarefas agendadas e fila. Avisos guardados para a página mostrar.
const eventosAutomacao = [];
const automatico = automacao.inicia({
    leDados, gravaDados, pastaConhecida, chat,
    // Renova o uso do plano sozinho (não depende da página aberta) se tiver mais de 5 min
    garanteUso: async () => {
        if (!cacheUso.dados || Date.now() - cacheUso.em > 5 * 60 * 1000) {
            if (!cacheUso.pedido) cacheUso.pedido = chat.usoDoPlano().then(d => { cacheUso.dados = d; cacheUso.em = Date.now(); })
                .catch(e => { cacheUso.dados = { disponivel: false, erro: e.message }; cacheUso.em = Date.now() - 30000; })
                .finally(() => { cacheUso.pedido = null; });
            await cacheUso.pedido;
        }
        return cacheUso.dados;
    },
    bloqueado: () => !!reinicioAgendado,
    avisa: (ev) => { eventosAutomacao.push({ ...ev, em: Date.now() }); if (eventosAutomacao.length > 50) eventosAutomacao.shift(); },
});

// Terminal por WebSocket (só da própria página, em pastas conhecidas)
terminal.liga(servidor, { porta: PORTA, token: TOKEN, pastaPermitida: pastaDoTerminal });

// Só aceita conexão da própria máquina
servidor.listen(PORTA, '127.0.0.1', () => {
    console.log(`Painel Claude em http://localhost:${PORTA}  (lendo ${RAIZ_PROJETOS})`);
});
