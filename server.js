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
const perfis = require('./perfis');
const midia = require('./midia');
const login = require('./login');
const plugins = require('./plugins');
const videoNavegador = require('./video-navegador');
const videoNativo = require('./video-nativo');
const playersExternos = require('./players-externos');
// Nome da pasta de transcripts das conversas Chat (o SDK grava pelo cwd sanitizado)
const PASTA_CHAT = chat.pastaDoProjeto(chat.CHAT_DIR).toLowerCase();
// Primeiro nome do usuário do Windows (henrique.freitas -> Henrique), para a saudação do Chat
function nomeUsuario() {
    const nome = String(os.userInfo().username || '').split(/[._\s-]/)[0];
    return nome ? nome[0].toUpperCase() + nome.slice(1) : '';
}
const cacheComandos = new Map();
const cacheUso = { dados: null, em: 0, pedido: null };
const cacheModelos = { dados: null, em: 0, pedido: null };
// Lista do supportedModels() -> { modelos: [{ id, nome, descricao, familia, esforcos, principal }] }
// id = o nome completo (claude-fable-5-2), que é o que a conversa grava; "default" (o padrão da conta) fica de fora
function organizaModelos(lista) {
    const versao = (id) => { const m = String(id).match(/^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-|$)/); return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0; };
    const vistos = new Set(), modelos = [];
    for (const m of lista || []) {
        const id = m.resolvedModel || m.value;
        if (m.value === 'default' || !/^claude-[a-z]+-\d/.test(id) || vistos.has(id)) continue;
        vistos.add(id);
        modelos.push({ id, nome: m.displayName || id, descricao: m.description || '', familia: id.split('-')[1], versao: versao(id), esforcos: m.supportedEffortLevels || [] });
    }
    const maisNova = {};
    for (const m of modelos) if (!maisNova[m.familia] || m.versao > maisNova[m.familia]) maisNova[m.familia] = m.versao;
    for (const m of modelos) { m.principal = m.versao === maisNova[m.familia]; delete m.versao; }
    return { modelos, lidoEm: new Date().toISOString() };
}

const PORTA = Number(process.env.PAINEL_PORTA || 4317);
// Pasta do Claude do perfil ativo (CLAUDE_CONFIG_DIR vem do perfil; no padrão é ~/.claude)
const PASTA_CLAUDE = perfis.pastaClaude();
const RAIZ_PROJETOS = path.join(PASTA_CLAUDE, 'projects');
const DIAS_LISTADOS = 7;
const SEGUNDOS_ATIVA = 90;
const LIMITE_PULSOS = 40;
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
    // Imagem citada com caminho absoluto solto no texto ("salvei em C:\...\exemplo1.png")
    for (const m of String(texto).matchAll(/(?:^|[\s(:"'])([A-Za-z]:[\\/][^\s`"'<>|*?()]+\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s),.;:!?"'])/gim)) candidatos.push({ nome: null, caminho: m[1] });
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
    // Comando "/" (skill, /login...): fica só como você digitou, "/nome argumentos" (sem o nome repetido)
    const comando = String(texto || '').match(/<command-name>([\s\S]*?)<\/command-name>/);
    if (comando) {
        const args = (String(texto).match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
        const nome = comando[1].trim();
        return ((nome.startsWith('/') ? nome : '/' + nome) + ' ' + args.trim()).trim();
    }
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
        // Custo em US$ por dia local ("AAAA-MM-DD"), somado resposta a resposta
        custoPorDia: {}, ultimoIdCusto: null, ultimoCustoId: 0, ultimoDiaCusto: null,
    };
}

// Preço por milhão de tokens: entrada, saída, leitura de cache, gravação de cache 5 min e 1 h
// (tabela da extensão Claude Code Usage; a primeira chave que o id do modelo contém vence)
const PRECOS_MODELO = [
    ['fable-5-1', [10, 50, 0.25, 12.5, 20]], ['fable', [10, 50, 1, 12.5, 20]],
    ['opus-5-5', [4, 20, 0.2, 5, 8]], ['opus-4-1', [15, 75, 1.5, 18.75, 30]], ['opus-4-2025', [15, 75, 1.5, 18.75, 30]], ['opus', [5, 25, 0.5, 6.25, 10]],
    ['sonnet-5-5', [2, 10, 0.2, 2.5, 4]], ['sonnet', [3, 15, 0.3, 3.75, 6]],
    ['haiku', [1, 5, 0.1, 1.25, 2]],
];

function custoDaResposta(modelo, u) {
    const achado = PRECOS_MODELO.find(([chave]) => String(modelo).includes(chave));
    if (!achado) return 0;
    const [entrada, saida, leitura, grava5, grava1h] = achado[1];
    const cc = u.cache_creation || {};
    const uma = cc.ephemeral_1h_input_tokens || 0;
    const cinco = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - uma);
    return ((u.input_tokens || 0) * entrada + (u.output_tokens || 0) * saida + (u.cache_read_input_tokens || 0) * leitura + cinco * grava5 + uma * grava1h) / 1e6;
}

function diaLocal(quando) {
    const d = quando ? new Date(quando) : new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function somaCusto(estado, r, msg) {
    if (!msg.usage || !msg.model || msg.model === '<synthetic>' || !r.timestamp) return;
    const valor = custoDaResposta(msg.model, msg.usage);
    // A mesma resposta vem em várias linhas (uma por bloco): conta só a última versão dela
    if (msg.id && msg.id === estado.ultimoIdCusto) {
        estado.custoPorDia[estado.ultimoDiaCusto] += valor - estado.ultimoCustoId;
    } else {
        const dia = diaLocal(r.timestamp);
        estado.custoPorDia[dia] = (estado.custoPorDia[dia] || 0) + valor;
        estado.ultimoIdCusto = msg.id || null;
        estado.ultimoDiaCusto = dia;
    }
    estado.ultimoCustoId = valor;
}

// Custo de hoje da conversa somado ao dos agentes dela (transcripts em <sessão>/subagents)
function custoHojeSessao(pastaSessao, estado) {
    const hoje = diaLocal();
    let total = estado.custoPorDia[hoje] || 0;
    const pasta = path.join(pastaSessao, 'subagents');
    if (fs.existsSync(pasta)) {
        for (const nome of fs.readdirSync(pasta)) {
            if (!nome.endsWith('.jsonl')) continue;
            const arquivo = path.join(pasta, nome);
            if (fs.statSync(arquivo).mtimeMs < new Date(hoje + 'T00:00:00').getTime()) continue;
            total += leIncremental(arquivo, estadoVazio, processaRegistro).custoPorDia[hoje] || 0;
        }
    }
    return total;
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

// TaskCreate ganha id sequencial na hora; o resultado ("Task #N created") traz o id real que o TaskUpdate usa
function acertaIdTarefa(estado, b) {
    const provisorio = estado.tarefasCriadas && estado.tarefasCriadas[b.tool_use_id];
    if (!provisorio) return;
    delete estado.tarefasCriadas[b.tool_use_id];
    const texto = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : String(b.content || '');
    const real = (texto.match(/Task #(\d+) created/) || [])[1];
    if (!real && !b.is_error) console.warn('TaskCreate sem "Task #N created" no resultado; fica o id sequencial:', texto.slice(0, 80));
    if (b.is_error || !real || real === provisorio || !estado.tarefas[provisorio] || estado.tarefas[real]) return;
    const reordenadas = {};
    for (const [id, t] of Object.entries(estado.tarefas)) reordenadas[id === provisorio ? real : id] = t;
    estado.tarefas = reordenadas;
    estado.plano = Object.values(estado.tarefas);
    estado.ultimaTarefa = Math.max(estado.ultimaTarefa, Number(real));
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
        estado.ultimaTarefa = (estado.ultimaTarefa || 0) + 1;
        const id = String(estado.ultimaTarefa);
        estado.tarefas[id] = { texto: entrada.subject || entrada.description, status: 'pending' };
        estado.plano = Object.values(estado.tarefas);
        return true;
    }
    if (nome === 'TaskUpdate' && estado.tarefas[entrada.taskId]) {
        const tarefa = estado.tarefas[entrada.taskId];
        if (entrada.subject) tarefa.texto = entrada.subject;
        if (entrada.status === 'deleted') delete estado.tarefas[entrada.taskId];
        else if (entrada.status) tarefa.status = entrada.status;
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

// Fluxo com o Claude para os sinais da visão Tasks: "in" = ele recebe, "out" = ele produz
let seqPulso = Date.now();
function registraPulso(estado, hora, dir) {
    if (!hora) return;
    const pulsos = estado.pulsos || (estado.pulsos = []);
    pulsos.push({ hora, dir, seq: ++seqPulso });
    if (pulsos.length > LIMITE_PULSOS) pulsos.splice(0, pulsos.length - LIMITE_PULSOS);
}

function adicionaEvento(estado, evento) {
    // Liga a mensagem original à reescrita do Haiku (a mais próxima no tempo, até 2 min)
    if (evento.tipo === 'pedido' && estado.reescritas) {
        const pendente = [...estado.reescritas].reverse().find(x => !x.original && Math.abs(Date.parse(evento.hora) - Date.parse(x.hora)) <= 120000);
        if (pendente) pendente.original = evento.texto;
        estado.ultimoPedido = evento;
    }
    const dir = evento.tipo === 'pedido' || evento.tipo === 'retorno' ? 'in'
        : ['notificacao', 'interrompido', 'compactacao', 'troca', 'capitulo', 'proximo', 'refinado'].includes(evento.tipo) ? '' : 'out';
    if (dir) registraPulso(estado, evento.hora, dir);
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
    if (r.cwd && !r.isSidechain) {
        estado.cwd = r.cwd;
        // Um "cd" no meio da conversa muda o cwd gravado; o resume precisa do que bate com a pasta do .jsonl
        (estado.cwds = estado.cwds || {})[chat.pastaDoProjeto(r.cwd).toLowerCase()] = r.cwd;
    }
    if (r.type === 'ai-title') { estado.titulo = r.aiTitle; return; }
    if (r.type === 'queue-operation' && r.operation === 'enqueue' && /^\s*<task-notification>/.test(String(r.content || ''))) {
        const campo = (nome) => ((String(r.content).match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`)) || [])[1] || '').trim();
        const id = campo('task-id');
        if (id) { estado.tarefasNotificadas[id] = campo('status'); (estado.horaNotificacao = estado.horaNotificacao || {})[id] = r.timestamp; }
        return;
    }
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
        if (/^\s*<task-notification>/.test(textoBruto)) {
            const campo = (nome) => ((textoBruto.match(new RegExp(`<${nome}>([\\s\\S]*?)</${nome}>`)) || [])[1] || '').trim();
            const situacao = campo('status');
            if (campo('task-id')) { estado.tarefasNotificadas[campo('task-id')] = situacao; (estado.horaNotificacao = estado.horaNotificacao || {})[campo('task-id')] = r.timestamp; }
            if (r.isSidechain) return;
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
                registraPulso(estado, r.timestamp, 'in');
                if (estado.pergunta && estado.pergunta.id === b.tool_use_id) estado.pergunta = null;
                acertaIdTarefa(estado, b);
                if (b.is_error && estado.planoAntes && estado.planoAntes.id === b.tool_use_id) {
                    estado.plano = estado.planoAntes.plano;
                    estado.tarefas = estado.planoAntes.tarefas;
                    estado.planoHora = estado.planoAntes.hora;
                    estado.ultimaTarefa = estado.planoAntes.ultimaTarefa;
                    estado.planoAntes = null;
                }
                const alvo = estado.porId[b.tool_use_id];
                const idsImagens = guardaImagens(b.content, origem, b.tool_use_id);
                if (alvo && idsImagens.length) alvo.imagens = idsImagens;
                const conteudo = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : String(b.content || '');
                // Processo solto (Start-Process) que o Claude mandou acompanhar: a lista mostra a conversa em
                // segundo plano enquanto o arquivo de andamento continuar sendo escrito (arquivosAcompanhados)
                const acompanhar = conteudo.match(/ACOMPANHAR:\s*([A-Za-z]:\\[^'"`$;&|<>\r\n*?]+?\.[A-Za-z0-9]{1,8})(?=["'\s]|$)/);
                if (acompanhar && !r.isSidechain) {
                    estado.acompanhados = estado.acompanhados || {};
                    estado.acompanhados[acompanhar[1]] = r.timestamp;
                    const nomes = Object.keys(estado.acompanhados);
                    if (nomes.length > 5) delete estado.acompanhados[nomes[0]];
                }
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
        somaCusto(estado, r, msg);
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
                const planoAntes = { id: b.id, plano: JSON.parse(JSON.stringify(estado.plano)), tarefas: JSON.parse(JSON.stringify(estado.tarefas)), hora: estado.planoHora, ultimaTarefa: estado.ultimaTarefa };
                if (atualizaPlano(estado, b.name, b.input || {})) {
                    registraPulso(estado, r.timestamp, 'out');
                    if (b.name === 'TaskCreate') {
                        (estado.tarefasCriadas = estado.tarefasCriadas || {})[b.id] = String(estado.ultimaTarefa);
                        estado.tarefas[estado.ultimaTarefa].criada = r.timestamp;
                    }
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
                        tarefaPai: estado.plano.findIndex(i => i.status === 'in_progress'),
                        tarefaPaiId: (Object.entries(estado.tarefas).find(([, t]) => t.status === 'in_progress') || [null])[0],
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
// O que um estado (conversa ou subagente) faz agora: a ferramenta ainda sem resposta; senão o tipo do último evento
function acaoAtualDoEstado(estado) {
    const aberta = [...estado.eventos].reverse().find(x => x.id && !x.fim);
    if (aberta) return { tipo: aberta.tipo, texto: corta(aberta.tipo === 'edicao' || aberta.tipo === 'leitura' ? path.basename(String(aberta.texto)) : aberta.texto, 60) };
    const ultimo = estado.eventos[estado.eventos.length - 1];
    return ultimo ? { tipo: ultimo.tipo, texto: '' } : null;
}
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
        agente.modelo = sub.modelo || agente.modelo || meta.model || '';
        // AGENTE ANINHADO (LANCADO POR OUTRO SUBAGENTE): O AVISO DE TERMINO FICA NO TRANSCRIPT DO AGENTE PAI, NAO NO DA CONVERSA
        const fontes = [estadoPai];
        if (meta.parentAgentId) { const arqPai = path.join(pasta, `agent-${meta.parentAgentId}.jsonl`); if (fs.existsSync(arqPai)) fontes.push(leIncremental(arqPai, estadoVazio, processaRegistro)); }
        agente.tokens = sub.tokens;
        agente.contexto = sub.ultimoContexto || 0;
        agente.ultimasAcoes = sub.eventos.filter(e => !['pedido', 'pensou'].includes(e.tipo)).slice(-8).map(e => ({ tipo: e.tipo, texto: e.texto }));
        agente.contagem = sub.contagem;
        agente.plano = sub.plano;
        agente.pulsos = sub.pulsos || [];
        agente.acaoAtual = acaoAtualDoEstado(sub);
        const parado = Date.now() - mtime > 10 * 60 * 1000;
        // O aviso do sistema (<task-notification>) é a fonte mais confiável: diz se terminou ou parou
        const idAgente = nome.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
        const horaDe = (e) => (e.horaNotificacao && e.horaNotificacao[idAgente]) || '';
        const dono = fontes.sort((a, b) => Date.parse(horaDe(b) || 0) - Date.parse(horaDe(a) || 0))[0];
        const aviso = dono.tarefasNotificadas[idAgente];
        if (aviso && /stopped|failed|killed|error/i.test(aviso)) agente.status = 'interrompido';
        else if (aviso && /completed|finished|done|success/i.test(aviso)) agente.status = 'concluido';
        else if (meta.finished === true || (agente.status === 'rodando' && parado)) {
            agente.status = agente.status === 'erro' ? 'erro' : 'concluido';
        }
        // Retomado por SendMessage: atividade no transcript depois da última notificação de término e arquivo mexido
        // há pouco = rodando de novo (vale mais que o aviso antigo e o meta.finished).
        // SO AGENTE EM SEGUNDO PLANO EMITE task-notification (CONFERIDO NO .jsonl: 15 AGENTES, 5 NOTIFICADOS, TODOS BG);
        // O DE PRIMEIRO PLANO TERMINA PELO tool_result, ENTAO SEM AVISO SO VALE O STATUS QUE ELE JA TEM
        const horaAviso = horaDe(dono) || null;
        const recente = Date.now() - mtime < SEGUNDOS_ATIVA * 1000;
        const retomado = !!sub.ultimo && recente && !!horaAviso && Date.parse(sub.ultimo) > Date.parse(horaAviso);
        if (retomado) { agente.status = 'rodando'; agente.fim = null; }
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
function situacaoSessao(estado, mtime, id) {
    // Estava rodando no painel quando ele fechou e ninguém mexeu desde então: processo morto, conversa livre
    if (id && orfas.has(id)) {
        if (mtime <= INICIO_PAINEL) return { ativa: false, esperando: false, agentesRodando: 0 };
        orfas.delete(id);
    }
    // Só conta agente com atividade recente ou lançado há menos de 30 min
    const agentesRodando = Object.values(estado.agentes).filter(a => a.status === 'rodando'
        && (a.ativoHa !== undefined || Date.now() - Date.parse(a.inicio || 0) < 30 * 60 * 1000)).length;
    // Ferramenta começada e sem resultado (ex.: comando longo): o transcript fica parado enquanto
    // ela roda, então conta como ativa até 15 min do início (o limite de um comando é 10 min)
    const ultimoEvento = estado.eventos[estado.eventos.length - 1];
    const ferramentaAberta = ultimoEvento && ultimoEvento.id && !ultimoEvento.fim && ultimoEvento.tipo !== 'agente'
        && Date.now() - Date.parse(ultimoEvento.hora || 0) < 15 * 60 * 1000;
    const recente = Date.now() - mtime < SEGUNDOS_ATIVA * 1000 || ferramentaAberta;
    const ativa = (!estado.turnoEncerrado && !estado.pergunta && recente) || (agentesRodando > 0 && !estado.pergunta);
    return { ativa, esperando: !ativa && (estado.turnoEncerrado || !!estado.pergunta), agentesRodando };
}

// Arquivos de andamento (ACOMPANHAR) ainda sendo escritos: mexido nos últimos 2 min, pedido nas últimas 24 h
function arquivosAcompanhados(estado) {
    const lista = [];
    for (const [arquivo, hora] of Object.entries(estado.acompanhados || {})) {
        if (Date.now() - Date.parse(hora || 0) > 24 * 3600 * 1000) continue;
        try { if (Date.now() - fs.statSync(arquivo).mtimeMs < 120 * 1000) lista.push({ arquivo, nome: path.basename(arquivo) }); } catch (e) { /* apagado */ }
    }
    return lista;
}

// ---------- Conta e Git por conversa ----------
// dados.porConversa["projeto/sessao" minúsculo] = { claude, git, projeto, sessao } (escolha absoluta feita na tela)
const chaveConversa = (projeto, sessao) => (String(projeto) + '/' + String(sessao)).toLowerCase();
function entradaDaConversa(projeto, sessao) { return (leDados().porConversa || {})[chaveConversa(projeto, sessao)] || null; }
const resolveMin = (p) => path.resolve(p).toLowerCase();
// Pastas projects/ das contas citadas por conversa (sem a do perfil, sem repetir)
function raizesExtras() {
    const principal = resolveMin(RAIZ_PROJETOS), vistas = new Set([principal]), lista = [];
    for (const e of Object.values(leDados().porConversa || {})) {
        if (!e || !e.claude || !perfis.existeConta(e.claude)) continue;
        const r = perfis.raizDaConta(e.claude);
        if (vistas.has(resolveMin(r))) continue;
        vistas.add(resolveMin(r)); lista.push({ raiz: r, conta: e.claude });
    }
    return lista;
}
// Onde está o transcript: primeiro na conta escolhida para a conversa, depois na do perfil e nas outras
function arquivoDaSessao(projeto, id) {
    const e = entradaDaConversa(projeto, id);
    const ordem = [];
    if (e && e.claude && perfis.existeConta(e.claude)) ordem.push(perfis.raizDaConta(e.claude));
    ordem.push(RAIZ_PROJETOS, ...raizesExtras().map(x => x.raiz));
    const vistas = new Set();
    for (const raiz of ordem) {
        if (vistas.has(resolveMin(raiz))) continue;
        vistas.add(resolveMin(raiz));
        const arquivo = path.join(raiz, projeto, id + '.jsonl');
        if (fs.existsSync(arquivo)) return { arquivo, raiz };
    }
    return null;
}
// env completo da conversa (o do servidor quando ela não tem escolha própria)
function envDeConversa(projeto, id) { return perfis.envDaConversa(entradaDaConversa(projeto, id)); }
function assinaturaDe(entrada) { return entrada ? (entrada.claude || '') + '|' + (entrada.git || '') : ''; }

function listaSessoes(opcoes = {}) {
    registraVivas();
    const limite = Date.now() - DIAS_LISTADOS * 24 * 3600 * 1000;
    const sessoes = [];
    const porConversaLista = leDados().porConversa || {};
    const raizesLista = [{ raiz: RAIZ_PROJETOS, conta: null }, ...raizesExtras()];
    for (const { raiz: raizLista, conta: contaLista } of raizesLista) {
    if (!fs.existsSync(raizLista)) continue;
    for (const pasta of fs.readdirSync(raizLista)) {
        const caminhoPasta = path.join(raizLista, pasta);
        if (!fs.statSync(caminhoPasta).isDirectory()) continue;
        for (const nome of fs.readdirSync(caminhoPasta)) {
            if (!nome.endsWith('.jsonl')) continue;
            // Outra conta: só as conversas que foram criadas nela pela tela (as demais continuam escondidas)
            if (contaLista) { const en = porConversaLista[chaveConversa(pasta, nome.replace('.jsonl', ''))]; if (!en || en.claude !== contaLista) continue; }
            const arquivo = path.join(caminhoPasta, nome);
            const stat = fs.statSync(arquivo);
            if (stat.mtimeMs < limite) continue;
            const estado = leIncremental(arquivo, estadoVazio, processaRegistro);
            // Agentes em segundo plano só importam em sessões mexidas na última hora
            if (Date.now() - stat.mtimeMs < 3600 * 1000) leSubagentes(path.join(caminhoPasta, nome.replace('.jsonl', '')), estado);
            const situacao = situacaoSessao(estado, stat.mtimeMs, nome.replace('.jsonl', ''));
            // Conversa trabalhando (aberta ou não): vigia os repositórios dela, para cada comando ser comparado com a versão certa
            if (situacao.ativa && !opcoes.semVigia) reposDaSessao(estado, cwdDaPasta(estado, pasta)).forEach(r => vigiaRepo(r));
            const pedidos = estado.eventos.filter(e => e.tipo === 'pedido');
            // Conversa criada só por digitar "/mcp" (comando do terminal, não conversa de verdade): fica fora da lista
            if (pedidos.length && pedidos.every(p => String(p.texto).trim().toLowerCase() === '/mcp')) continue;
            sessoes.push({
                projeto: pasta, nomeProjeto: nomeProjeto(pasta), id: nome.replace('.jsonl', ''), chat: pasta.toLowerCase() === PASTA_CHAT,
                titulo: estado.titulo || (pedidos[0] && corta(pedidos[0].texto, 80)) || '(sem título)',
                modelo: estado.modelo, atualizado: stat.mtimeMs, contexto: estado.contexto,
                compactacoes: estado.compactacoes.length, inicio: estado.inicio, cwd: cwdDaPasta(estado, pasta), custo: estado.custo,
                custoHoje: stat.mtimeMs >= new Date(diaLocal() + 'T00:00:00').getTime() ? custoHojeSessao(path.join(caminhoPasta, nome.replace('.jsonl', '')), estado) : 0,
                ativa: situacao.ativa, esperando: situacao.esperando, agentesRodando: situacao.agentesRodando,
                pergunta: !!estado.pergunta, fimTurno: estado.fimTurno, acompanhando: arquivosAcompanhados(estado),
                // Selo do botão Tasks na lista (conta sem chamar /api/tasks)
                tarefasAndamento: (() => { const pd = planoDoPedido(estado); return pd.planoAtual ? pd.tarefas.filter(i => i.status === 'in_progress').length : 0; })(),
                // O que ela está fazendo agora (ferramenta ainda sem resposta), para a lista lateral
                acaoAtual: situacao.ativa ? (() => {
                    const e = [...estado.eventos].reverse().find(x => x.id && !x.fim);
                    return e ? { tipo: e.tipo, texto: corta(e.tipo === 'edicao' || e.tipo === 'leitura' ? path.basename(String(e.texto)) : e.texto, 60) } : null;
                })() : null,
                // Conta e Git escolhidos para esta conversa (null = os do perfil)
                porConversa: porConversaLista[chaveConversa(pasta, nome.replace('.jsonl', ''))] || null, contaOutra: contaLista,
            });
        }
    }
    }
    return sessoes.sort((a, b) => b.atualizado - a.atualizado);
}

// Visão Tasks: conversas das últimas 24 h com lista de tarefas ou subagente, montadas do cache já lido.
// A lista de sessões (e o dados.json) é reaproveitada por ~4,5 s, então a maioria dos polls de 2 s não varre o
// disco; o corpo só é remontado quando a "versão" (mtime, situação, status dos agentes, seq dos pulsos) muda,
// e o 304 não serializa nada.
const HORAS_TASKS = 24;
const SEGUNDOS_PULSOS = 30;
const LIMITE_PULSOS_NO = 60;
const CACHE_SESSOES_TASKS_MS = 4500;
let sessoesTasks = { hora: 0, lista: [], arquivadas: new Set() };
let corpoTasks = { versao: null, corpo: null };
function pulsosRecentes(pulsos) {
    const desde = Date.now() - SEGUNDOS_PULSOS * 1000;
    return (pulsos || []).filter(p => Date.parse(p.hora) >= desde).slice(-LIMITE_PULSOS_NO);
}
function tarefasDoPlano(plano) {
    return (plano || []).map(t => ({ texto: corta(t.texto, 120), status: t.status || 'pending' }));
}
function sessoesParaTasks() {
    if (Date.now() - sessoesTasks.hora > CACHE_SESSOES_TASKS_MS) sessoesTasks = { hora: Date.now(), lista: listaSessoes({ semVigia: true }), arquivadas: new Set(leDados().arquivadas || []) };
    return sessoesTasks.lista;
}
// PLANO DO ULTIMO PEDIDO: TASKCREATE ACUMULA NA CONVERSA, ENTAO SAI O QUE FOI CRIADO E CONCLUIDO ANTES DELE;
// PLANO FEITO ANTES DO ULTIMO PEDIDO (COMO NO CARTAO PLANO DO APP) E ANTIGO
function planoDoPedido(estado) {
    const principais = estado.eventos.filter(e => e.tipo === 'pedido' && !e.comentario && e.uuid);
    const atual = principais[principais.length - 1] || null;
    const inicio = atual ? Date.parse(atual.hora) : 0;
    const antigo = !!(estado.planoHora && atual && Date.parse(estado.planoHora) < inicio);
    const doPedido = (t) => !(t.criada && Date.parse(t.criada) < inicio && t.status === 'completed');
    const tarefas = estado.plano.filter(doPedido);
    return { pedidoAtual: atual, planoAtual: !antigo && tarefas.length > 0, doPedido, tarefas };
}
// TaskUpdate deleted desloca os índices do plano: o id da tarefa (chave de estado.tarefas) é o que vale
function indiceTarefaPai(estado, a) {
    if (a.tarefaPaiId != null) return estado.tarefas[a.tarefaPaiId] ? Object.keys(estado.tarefas).indexOf(a.tarefaPaiId) : -1;
    return a.tarefaPai;
}
// Solicitações da conversa: o pedido que abriu o turno, os comentários entregues no meio dele e o que ainda está na fila
const normalizaTexto = (s) => limpaTextoUsuario(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, 60);
function solicitacoes(s, estado) {
    const pedidos = estado.eventos.filter(e => e.tipo === 'pedido');
    const principais = pedidos.filter(e => !e.comentario && e.uuid);
    const atual = principais[principais.length - 1] || null;
    const complementos = atual ? pedidos.filter(e => e.comentario && Date.parse(e.hora) >= Date.parse(atual.hora)).map(e => ({ texto: corta(e.texto, 200), hora: e.hora })) : [];
    // Fila: mensagens enviadas pelo painel que ainda não apareceram no transcript (poda as que já chegaram)
    const info = chat.enfileiradas().find(x => x.sessionId === s.id);
    let fila = [];
    if (info) {
        for (let i = info.itens.length - 1; i >= 0; i--) {
            const item = info.itens[i];
            const chegou = pedidos.some(e => Date.parse(e.hora) >= Date.parse(item.hora) - 1000 && normalizaTexto(e.texto) === normalizaTexto(item.texto));
            if (chegou) info.itens.splice(i, 1);
        }
        fila = info.itens.map(i => ({ texto: corta(i.texto, 200), hora: i.hora }));
    }
    // Plano "antigo" como no cartão Plano do app: feito antes do último pedido do usuário
    const planoAtual = !(estado.planoHora && atual && Date.parse(estado.planoHora) < Date.parse(atual.hora));
    return { pedidoAtual: atual ? { texto: corta(atual.texto, 200), hora: atual.hora } : null, complementos, fila, planoAtual, planoHora: estado.planoHora || null };
}
function montaTasks(itens) {
    const conversas = itens.map(({ s, estado, fundo = [] }) => {
        const sol = solicitacoes(s, estado);
        const tarefasTodas = tarefasDoPlano(estado.plano).map((t, i) => ({ ...t, subagentes: [], criada: estado.plano[i].criada }));
        const subagentesSoltos = [];
        const agentes = Object.values(estado.agentes), rodando = agentes.filter(a => a.status === 'rodando');
        const concluidos = agentes.filter(a => a.status !== 'rodando').sort((a, b) => Date.parse(b.fim || b.inicio || 0) - Date.parse(a.fim || a.inicio || 0)).slice(0, 5);
        for (const a of [...rodando, ...concluidos]) {
            const ativo = a.status === 'rodando', recemTerminado = !ativo && a.fim && Date.now() - Date.parse(a.fim) < SEGUNDOS_PULSOS * 1000;
            const sub = {
                id: a.id, tipo: a.tipoAgente || 'agente', descricao: corta(a.descricao, 80), status: a.status, modelo: a.modelo || null,
                inicio: a.inicio || null, fim: a.fim || null, pulsos: ativo || recemTerminado ? pulsosRecentes(a.pulsos) : [], tarefas: ativo ? tarefasDoPlano(a.plano) : [],
                acaoAtual: ativo ? a.acaoAtual || null : null,
            };
            const pai = tarefasTodas[indiceTarefaPai(estado, a)];
            if (pai) pai.subagentes.push(sub);
            else subagentesSoltos.push(sub);
        }
        const { doPedido } = planoDoPedido(estado);
        let tarefas = tarefasTodas.filter(doPedido);
        if (!tarefas.length) { sol.planoAtual = false; tarefas = tarefasTodas; }
        else tarefasTodas.filter(t => !doPedido(t)).forEach(t => subagentesSoltos.push(...t.subagentes.filter(x => x.status === 'rodando')));
        tarefas = tarefas.map(({ criada, ...t }) => t);
        return {
            id: s.id, projeto: s.projeto, nomeProjeto: s.nomeProjeto, titulo: s.titulo, modelo: s.modelo,
            // Em segundo plano conta como trabalhando (cartão, chip e filtro Trabalhando)
            vivo: s.ativa || fundo.length > 0, esperando: !s.ativa && !!estado.pergunta, ultimo: s.atualizado, segundoPlano: fundo,
            pergunta: estado.pergunta ? corta(estado.pergunta.texto, 140) : null, acaoAtual: s.acaoAtual || null,
            ...sol,
            pulsos: pulsosRecentes(estado.pulsos), tarefas, subagentesSoltos,
        };
    });
    return { conversas };
}
function listaTasks() {
    const limite = Date.now() - HORAS_TASKS * 3600 * 1000;
    const itens = [];
    const sessoes = sessoesParaTasks(), arquivadas = sessoesTasks.arquivadas;
    // Trabalho em segundo plano: tarefa do processo do painel (comando em segundo plano) ou processo solto acompanhado
    const vivasPainel = chat.estado().filter(c => c.vivo && c.sessionId && (c.tarefasBg || []).length);
    const fundoDe = (s) => [
        ...((vivasPainel.find(c => c.sessionId === s.id) || {}).tarefasBg || []).map(t => corta(t.descricao || 'tarefa', 80)),
        ...(s.acompanhando || []).map(a => a.nome),
    ];
    for (const s of sessoes) {
        // SO CONVERSA PROCESSANDO (TAMBEM EM SEGUNDO PLANO) OU COM PERGUNTA SEM RESPOSTA: TURNO ENCERRADO NAO PEDE NADA AO USUARIO
        const fundo = fundoDe(s);
        if (s.atualizado < limite || arquivadas.has(s.projeto + '/' + s.id) || !(s.ativa || s.pergunta || fundo.length)) continue;
        const achado = arquivoDaSessao(s.projeto, s.id);
        const item = achado && cache.get(achado.arquivo);
        if (!item) continue;
        const estado = item.estado;
        // Sem plano nem agente o cartão ainda mostra o pedido e o que ela está fazendo (antes a conversa sumia da visão)
        itens.push({ s, estado, fundo });
    }
    const versao = itens.map(({ s, estado, fundo }) => [
        s.id, s.atualizado, s.ativa, s.esperando, fundo.join(';'), s.titulo, s.modelo, estado.pergunta && estado.pergunta.texto, s.acaoAtual && s.acaoAtual.texto,
        JSON.stringify(solicitacoes(s, estado)),
        estado.plano.map(t => t.status + t.texto).join(','),
        Object.values(estado.agentes).map(a => [a.id, a.status, a.modelo, a.fim, (a.plano || []).map(t => t.status + t.texto).join(';'), a.acaoAtual && a.acaoAtual.tipo + ':' + a.acaoAtual.texto].join('|')).join(','),
    ].join('|')).join('\n') + '|' + seqPulso;
    if (corpoTasks.versao !== versao) {
        const corpo = montaTasks(itens);
        corpo.hash = crypto.createHash('md5').update(versao).digest('hex').slice(0, 16);
        corpo.seq = seqPulso;
        corpoTasks = { versao, corpo };
    }
    return { ...corpoTasks.corpo, agora: new Date().toISOString() };
}

// cwd que gera o nome da pasta onde está o .jsonl (é nele que o SDK procura ao retomar)
function cwdDaPasta(estado, projeto) {
    return (estado.cwds && estado.cwds[String(projeto).toLowerCase()]) || estado.cwd;
}

// A conversa editou este arquivo (Edit/Write no transcript)? Libera o editor ao vivo a mostrar o arquivo inteiro
function editadoNaSessao(projeto, id, abs) {
    if (!projeto || !id) return false;
    const d = detalheSessao(String(projeto), String(id));
    const alvo = String(abs).toLowerCase();
    if ((arquivosPorComando.get(String(id)) || new Set()).has(alvo)) return true;
    return !!(d && d.eventos.some(e => e.tipo === 'edicao' && e.texto && path.resolve(String(e.texto)).toLowerCase() === alvo));
}

// ---------- Arquivos alterados por comando (PowerShell/Bash) ----------
// No Royal o Edit é bloqueado em PHP/HTML (Latin-1) e o Claude altera por script: o editor ao vivo
// descobre pelo git e pela hora de modificação o que o comando mudou. Só leitura.
const retratos = new Map();             // arquivo (minúsculo) -> último conteúdo visto (normalizado como o editor)
const devolvidosPorSessao = new Map();  // sessao -> Map(arquivo minúsculo -> mtime já devolvido)
const arquivosPorComando = new Map();   // sessao -> Set(arquivo minúsculo): libera o editor a abrir fora da pasta
// Pasta dos perfis (agentes/memória de uma conta do Claude): também é bastidor
const PERFIS_BASTIDOR = perfis.PASTA_PERFIS.toLowerCase() + path.sep;
const ARQ_BASTIDOR = /[\\/](AppData[\\/]Local[\\/]Temp|scratchpad|\.claude|node_modules|\.git)([\\/]|$)/i;
const EXT_TEXTO = /\.(php|html?|tpl|inc|js|mjs|cjs|ts|css|scss|less|sql|json|md|txt|xml|ini|ps1|py|bat|cmd)$/i;
// ---------- Vigia de arquivos: versões reais de cada arquivo, no momento em que mudam no disco ----------
// Repositórios da conversa aberta ficam vigiados (fs.watch recursivo). Ao começar a vigiar, os arquivos já alterados
// ganham a primeira versão (o "antes" da próxima mudança); arquivo limpo não precisa: o antes dele é o último commit.
const historicoArquivos = new Map();   // arquivo (minúsculo) -> { abs, versoes: [{ t, conteudo }] } (últimas 6)
const vigias = new Map();              // raiz (minúscula) -> { w, uso }
const LIMITE_VERSAO = 1024 * 1024;
const ignoraNaVigia = (abs) => ARQ_BASTIDOR.test(abs) || abs.toLowerCase().startsWith(PERFIS_BASTIDOR) || !EXT_TEXTO.test(abs);
function leVersao(abs) {
    try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > LIMITE_VERSAO) return null;
        return editorArquivos.ler(path.dirname(abs), path.basename(abs)).conteudo;
    } catch (e) { return null; }
}
function anotaVersao(abs, t, conteudo) {
    const k = abs.toLowerCase();
    const reg = historicoArquivos.get(k) || { abs, versoes: [] };
    const ult = reg.versoes[reg.versoes.length - 1];
    if (ult && ult.conteudo === conteudo) return;
    reg.versoes.push({ t, conteudo });
    if (reg.versoes.length > 6) reg.versoes.shift();
    historicoArquivos.delete(k); historicoArquivos.set(k, reg);
    if (historicoArquivos.size > 400) historicoArquivos.delete(historicoArquivos.keys().next().value);
}
async function vigiaRepo(raiz) {
    if (!raiz) return;
    const k = raiz.toLowerCase();
    const ja = vigias.get(k);
    if (ja) { ja.uso = Date.now(); return; }
    if (vigias.size >= 6) {
        const [kVelho, velho] = [...vigias].sort((a, b) => a[1].uso - b[1].uso)[0];
        try { velho.w.close(); } catch (e) { /* já fechado */ }
        vigias.delete(kVelho);
    }
    const pendentes = new Map();
    let w;
    try {
        w = fs.watch(raiz, { recursive: true }, (tipo, nome) => {
            if (!nome) return;
            const abs = path.join(raiz, String(nome));
            if (ignoraNaVigia(abs)) return;
            // Várias gravações seguidas do mesmo arquivo: guarda só a última (120 ms depois)
            clearTimeout(pendentes.get(abs));
            pendentes.set(abs, setTimeout(() => {
                pendentes.delete(abs);
                const c = leVersao(abs);
                if (c !== null) anotaVersao(abs, Date.now(), c);
            }, 120));
        });
    } catch (e) { return; }
    w.on('error', () => { try { w.close(); } catch (x) { /* já fechado */ } vigias.delete(k); });
    vigias.set(k, { w, uso: Date.now() });
    // Foto dos arquivos já alterados agora (t = 0: versão de antes de qualquer comando daqui para a frente)
    const st = await rodaGit(['-C', raiz, 'status', '--porcelain', '-z', '-uall']);
    const itens = st ? st.split('\0') : [];
    for (let i = 0; i < itens.length; i++) {
        const item = itens[i];
        if (item.length < 4) continue;
        if (item[0] === 'R' || item[0] === 'C') i++;
        if (item[0] === 'D' || item[1] === 'D') continue;
        const abs = path.resolve(raiz, item.slice(3));
        if (ignoraNaVigia(abs) || historicoArquivos.has(abs.toLowerCase())) continue;
        const c = leVersao(abs);
        if (c !== null) anotaVersao(abs, 0, c);
    }
}
// Repositório sem uso há 30 min: para de vigiar
setInterval(() => { for (const [k, v] of vigias) if (Date.now() - v.uso > 1800000) { try { v.w.close(); } catch (e) { /* já fechado */ } vigias.delete(k); } }, 60000).unref();
// Versão do arquivo de logo antes de um instante (undefined = não se sabe)
function versaoAntesDe(abs, instante) {
    const reg = historicoArquivos.get(abs.toLowerCase());
    if (!reg) return undefined;
    for (let i = reg.versoes.length - 1; i >= 0; i--) if (reg.versoes[i].t < instante) return reg.versoes[i].conteudo;
    return undefined;
}
function guardaRetrato(abs, conteudo) {
    const k = String(abs).toLowerCase();
    retratos.delete(k); retratos.set(k, conteudo);
    if (retratos.size > 300) retratos.delete(retratos.keys().next().value);
}
function rodaGit(args, buffer) {
    return new Promise((resolve) => {
        execFile('git', args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', windowsHide: true }, (erro, saida) => resolve(erro ? null : saida));
    });
}
// Mesma regra do editor: sem BOM, UTF-8 se for válido, senão Windows-1252; CRLF vira LF
function textoDoBuffer(buf) {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
    const t = editorArquivos.utf8Valido(buf) ? buf.toString('utf8') : editorArquivos.decodifica1252(buf);
    return t.replace(/\r\n/g, '\n');
}
// O que mudou: o bloco entre o começo e o fim iguais
function trocaDoMeio(antes, depois) {
    const a = antes.split('\n'), d = depois.split('\n');
    let i = 0;
    while (i < a.length && i < d.length && a[i] === d[i]) i++;
    let j = 0;
    while (j < a.length - i && j < d.length - i && a[a.length - 1 - j] === d[d.length - 1 - j]) j++;
    return { antes: a.slice(i, a.length - j).join('\n'), depois: d.slice(i, d.length - j).join('\n') };
}
// Diff de linhas (Myers): cada trecho alterado separado, como o git diff. Com o arquivo comparado a uma base antiga
// (último commit, várias mudanças espalhadas), o bloco único juntava o começo de uma mudança com o fim de outra.
function trechosDiferentes(antes, depois) {
    const a = antes.split('\n'), b = depois.split('\n');
    // Corta o começo e o fim iguais (deixa o diff barato mesmo em arquivo grande)
    let ini = 0;
    while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
    let fa = a.length, fb = b.length;
    while (fa > ini && fb > ini && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
    const A = a.slice(ini, fa), B = b.slice(ini, fb), n = A.length, m = B.length, max = n + m;
    if (!max) return [];
    // Diferença grande demais para calcular: volta ao bloco único
    if (max > 20000) return [{ antes: A.join('\n'), depois: B.join('\n') }];
    const v = new Map([[1, 0]]), rastro = [];
    let fimD = -1;
    for (let dd = 0; dd <= max && fimD < 0; dd++) {
        rastro.push(new Map(v));
        for (let k = -dd; k <= dd; k += 2) {
            let x = (k === -dd || (k !== dd && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
            let y = x - k;
            while (x < n && y < m && A[x] === B[y]) { x++; y++; }
            v.set(k, x);
            if (x >= n && y >= m) { fimD = dd; break; }
        }
        if (dd > 4000) return [{ antes: A.join('\n'), depois: B.join('\n') }];
    }
    // Refaz o caminho: lista de operações (= igual, - sai, + entra)
    const ops = [];
    let x = n, y = m;
    for (let dd = fimD; dd > 0; dd--) {
        const vv = rastro[dd], k = x - y;
        const kAnt = (k === -dd || (k !== dd && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) ? k + 1 : k - 1;
        const xAnt = vv.get(kAnt) ?? 0, yAnt = xAnt - kAnt;
        while (x > xAnt && y > yAnt) { ops.push('='); x--; y--; }
        ops.push(x === xAnt ? '+' : '-');
        if (x === xAnt) y--; else x--;
    }
    while (x > 0 && y > 0) { ops.push('='); x--; y--; }
    ops.reverse();
    // Junta em trechos; trechos separados por até 2 linhas iguais viram um só
    const trechos = [];
    let ia = 0, ib = 0, atual = null, iguais = 0;
    for (const op of ops) {
        if (op === '=') {
            if (atual) { iguais++; atual.antes.push(A[ia]); atual.depois.push(B[ib]); if (iguais > 2) { atual.antes.splice(-iguais); atual.depois.splice(-iguais); trechos.push(atual); atual = null; } }
            ia++; ib++;
            continue;
        }
        if (!atual) atual = { antes: [], depois: [] };
        iguais = 0;
        if (op === '-') atual.antes.push(A[ia++]); else atual.depois.push(B[ib++]);
    }
    if (atual) { if (iguais) { atual.antes.splice(-iguais); atual.depois.splice(-iguais); } trechos.push(atual); }
    return trechos.map(t => ({ antes: t.antes.join('\n'), depois: t.depois.join('\n') }));
}
async function raizGit(dir) {
    const s = await rodaGit(['-C', dir, 'rev-parse', '--show-toplevel']);
    return s ? path.resolve(s.trim()) : null;
}
// Ao vivo: o que mudou nos arquivos da conversa desde o começo do comando, versão a versão.
// visto = { arquivo minúsculo: t da última versão já mostrada }: cada resposta traz só o que veio depois dela.
// Duas conversas na mesma pasta (ex.: duas na royal): o vigia vê tudo o que muda no repositório. Arquivo que outra
// conversa ativa mexeu perto daquele momento (edição direta, ou comando dela rodando que cita o arquivo) não é
// atribuído a esta, a não ser que o comando desta também cite o arquivo.
let cacheOutrasAtivas = { em: 0, lista: [] };
function outrasConversasAtivas(sessao) {
    if (Date.now() - cacheOutrasAtivas.em > 20000) {
        const limite = Date.now() - 30 * 60e3;
        let lista = [];
        try { lista = listaSessoes().filter(s => (s.atualizado || 0) >= limite); } catch (e) { /* sem lista: não filtra */ }
        cacheOutrasAtivas = { em: Date.now(), lista };
    }
    return cacheOutrasAtivas.lista.filter(s => s.id !== sessao);
}
function textoDoComando(e) { return String((e.codigo && e.codigo.entrada && e.codigo.entrada.texto) || e.texto || ''); }
function citaArquivo(texto, abs) {
    const t = String(texto).toLowerCase(), nome = path.basename(abs).toLowerCase();
    return nome.length > 2 && t.includes(nome);
}
function deOutraConversa(sessao, abs, t, meuComando) {
    if (meuComando && citaArquivo(textoDoComando(meuComando), abs)) return false;
    const alvo = abs.toLowerCase();
    for (const s of outrasConversasAtivas(sessao)) {
        let d;
        try { d = detalheSessao(s.projeto, s.id); } catch (e) { continue; }
        if (!d) continue;
        for (const e of d.eventos) {
            const ini = Date.parse(e.hora || 0), fim = e.fim ? Date.parse(e.fim) + 5000 : Date.now();
            if (!(t >= ini - 5000 && t <= fim)) continue;
            if (e.tipo === 'edicao' && String(e.texto || '').toLowerCase() === alvo) return true;
            if (e.tipo === 'comando' && citaArquivo(textoDoComando(e), abs)) return true;
        }
    }
    return false;
}
async function alteracoesAoVivo(projeto, sessao, id, visto) {
    const d = detalheSessao(projeto, sessao);
    if (!d) return null;
    const e = d.eventos.find(x => x.id === id && x.tipo === 'comando');
    if (!e || e.bloqueado) return { mudancas: [], terminou: true };
    const ini = Date.parse(e.hora);
    const raizes = (d.repos || []).map(r => r.toLowerCase());
    const mudancas = [];
    for (const [k, reg] of historicoArquivos) {
        if (!raizes.some(r => k.startsWith(r + path.sep) || k.startsWith(r + '/'))) continue;
        const ult = reg.versoes[reg.versoes.length - 1];
        if (!ult || ult.t < ini || (visto[k] && ult.t <= visto[k])) continue;
        if (deOutraConversa(sessao, reg.abs, ult.t, e)) continue;
        // Base: a última versão já mostrada; na primeira vez, a de logo antes do comando; sem ela, o commit
        let antes;
        if (visto[k]) { const v = [...reg.versoes].reverse().find(x => x.t <= visto[k]); if (v) antes = v.conteudo; }
        if (antes === undefined) antes = versaoAntesDe(reg.abs, ini);
        if (antes === undefined) {
            const r = await raizGit(path.dirname(reg.abs));
            const buf = r ? await rodaGit(['-C', r, 'show', 'HEAD:' + path.relative(r, reg.abs).replace(/\\/g, '/')], true) : null;
            antes = buf ? textoDoBuffer(buf) : '';
        }
        if (antes === ult.conteudo) continue;
        if (!arquivosPorComando.has(sessao)) arquivosPorComando.set(sessao, new Set());
        arquivosPorComando.get(sessao).add(k);
        if (!antes) { mudancas.push({ arquivo: reg.abs, t: ult.t, codigo: { tipo: 'arquivo', conteudo: trechoCodigo(ult.conteudo) } }); continue; }
        const trechos = trechosDiferentes(antes, ult.conteudo).filter(t => t.antes !== t.depois).slice(-8);
        if (trechos.length) mudancas.push({ arquivo: reg.abs, t: ult.t, codigo: { tipo: 'diff', trocas: trechos.map(t => ({ antes: trechoCodigo(t.antes, 40), depois: trechoCodigo(t.depois, 40) })) } });
    }
    return { mudancas, terminou: !!e.fim };
}
async function alteracoesDoComando(projeto, sessao, id) {
    const d = detalheSessao(projeto, sessao);
    if (!d) return null;
    const e = d.eventos.find(x => x.id === id && x.tipo === 'comando');
    if (!e || !e.fim || e.bloqueado) return [];
    const ini = Date.parse(e.hora), fim = Date.parse(e.fim) + 5000;
    const candidatos = new Set();
    // a) o que o vigia viu mudar durante o comando (qualquer repositório da conversa)
    for (const reg of historicoArquivos.values()) if (reg.versoes.some(v => v.t >= ini && v.t <= fim)) candidatos.add(reg.abs);
    // b) o que o git vê como alterado ou novo, na pasta da conversa e nos repositórios em que ela trabalha
    const raizes = [...new Set([d.cwd ? await raizGit(d.cwd) : null, ...(d.repos || [])].filter(Boolean).map(r => path.resolve(r)))];
    for (const raiz of raizes) {
        const st = await rodaGit(['-C', raiz, 'status', '--porcelain', '-z', '-uall']);
        const itens = st ? st.split('\0') : [];
        for (let k = 0; k < itens.length; k++) {
            const item = itens[k];
            if (item.length < 4) continue;
            if (item[0] === 'R' || item[0] === 'C') k++;   // renomeado: o próximo é o nome antigo
            if (item[0] === 'D' || item[1] === 'D') continue;
            candidatos.add(path.resolve(raiz, item.slice(3)));
        }
    }
    // c) caminhos absolutos citados no próprio comando (ex.: arquivo de outro clone)
    const texto = (e.codigo && e.codigo.entrada && e.codigo.entrada.texto) || '';
    for (const m of texto.matchAll(/[A-Za-z]:[\\/][^'"`\s<>|*?]+?\.[A-Za-z0-9]{1,5}(?=['"`\s;,)]|$)/g)) candidatos.add(path.resolve(m[0]));
    const achados = [];
    for (const abs of candidatos) {
        if (ARQ_BASTIDOR.test(abs) || abs.toLowerCase().startsWith(PERFIS_BASTIDOR) || !EXT_TEXTO.test(abs)) continue;
        let st;
        try { st = fs.statSync(abs); } catch (x) { continue; }
        if (!st.isFile() || st.size > 3 * 1024 * 1024 || st.mtimeMs < ini || st.mtimeMs > fim) continue;
        if (deOutraConversa(sessao, abs, st.mtimeMs, e)) continue;
        achados.push({ abs, mtime: st.mtimeMs });
    }
    achados.sort((a, b) => a.mtime - b.mtime);
    if (!devolvidosPorSessao.has(sessao)) devolvidosPorSessao.set(sessao, new Map());
    if (!arquivosPorComando.has(sessao)) arquivosPorComando.set(sessao, new Set());
    const devolvidos = devolvidosPorSessao.get(sessao);
    const saida = [];
    for (const { abs, mtime } of achados.slice(-8)) {
        const k = abs.toLowerCase();
        if (devolvidos.get(k) === mtime) continue;   // já mostrado (ex.: php -l chamado junto com o script)
        devolvidos.set(k, mtime);   // marca antes de qualquer await: dois pedidos juntos não repetem o arquivo
        let atual;
        try { atual = editorArquivos.ler(path.dirname(abs), path.basename(abs)).conteudo; } catch (x) { continue; }
        // Antes = como o arquivo estava logo antes de o comando começar (vigia); sem isso, a última foto; sem foto, o commit
        let antes = versaoAntesDe(abs, ini);
        if (antes === undefined) antes = retratos.get(k);
        if (antes === undefined) {
            // Sem retrato: compara com o último commit (arquivo novo: base vazia)
            const r = await raizGit(path.dirname(abs));
            const buf = r ? await rodaGit(['-C', r, 'show', 'HEAD:' + path.relative(r, abs).replace(/\\/g, '/')], true) : null;
            antes = buf ? textoDoBuffer(buf) : '';
        }
        guardaRetrato(abs, atual);
        if (antes === atual) continue;
        arquivosPorComando.get(sessao).add(k);
        if (!antes) { saida.push({ arquivo: abs, codigo: { tipo: 'arquivo', conteudo: trechoCodigo(atual) } }); continue; }
        // Cada trecho alterado separado (até 8), cada um no seu lugar do arquivo
        const trechos = trechosDiferentes(antes, atual).filter(t => t.antes !== t.depois).slice(-8);
        if (!trechos.length) continue;
        saida.push({ arquivo: abs, codigo: { tipo: 'diff', trocas: trechos.map(t => ({ antes: trechoCodigo(t.antes, 40), depois: trechoCodigo(t.depois, 40) })) } });
    }
    return saida;
}

// ---------- Ícones de arquivo: Catppuccin Perfect Icons (extensão MIT do VS Code), Mocha no escuro e Latte no claro ----------
let iconesTema = { em: 0 };
function temaIcones(tema) {
    if (Date.now() - iconesTema.em > 600000) {
        iconesTema = { em: Date.now(), dir: null, temas: {} };
        try {
            const pasta = path.join(os.homedir(), '.vscode', 'extensions');
            const dirs = fs.readdirSync(pasta).filter(n => /^thang-nm\.catppuccin-perfect-icons-/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            if (dirs.length) iconesTema.dir = path.join(pasta, dirs[dirs.length - 1]);
        } catch (e) { /* extensão não instalada: o painel usa as etiquetas */ }
    }
    if (!iconesTema.dir) return null;
    const nomeTema = tema === 'claro' ? 'latte' : 'mocha';
    if (!iconesTema.temas[nomeTema]) {
        try {
            const arq = path.join(iconesTema.dir, 'themes', nomeTema, 'theme.json');
            iconesTema.temas[nomeTema] = { pasta: path.dirname(arq), j: JSON.parse(fs.readFileSync(arq, 'utf8')) };
        } catch (e) { return null; }
    }
    return iconesTema.temas[nomeTema];
}
const LINGUAGEM_EXT = { html: 'html', htm: 'html', tpl: 'html', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', php: 'php', sql: 'sql', css: 'css', json: 'json', md: 'markdown', ps1: 'powershell', py: 'python', xml: 'xml', yml: 'yaml', yaml: 'yaml', bat: 'bat', sh: 'shellscript' };
// Mesma ordem do VS Code: nome exato, extensão (da mais longa, ex.: blade.php, para a mais curta), linguagem, genérico
function iconeDoArquivo(nome, tema, pasta, aberta) {
    const t = temaIcones(tema);
    if (!t) return null;
    const j = t.j, n = String(nome || '').toLowerCase().split(/[\\/]/).pop();
    let id;
    if (pasta) id = (aberta ? (j.folderNamesExpanded || {})[n] : (j.folderNames || {})[n]) || (aberta ? j.folderExpanded : j.folder);
    else {
        id = (j.fileNames || {})[n];
        const partes = n.split('.');
        for (let i = 1; !id && i < partes.length; i++) id = (j.fileExtensions || {})[partes.slice(i).join('.')];
        if (!id && partes.length > 1) id = (j.languageIds || {})[LINGUAGEM_EXT[partes[partes.length - 1]]];
        id = id || j.file;
    }
    const def = id && j.iconDefinitions && j.iconDefinitions[id];
    if (!def || !def.iconPath) return null;
    const arq = path.resolve(t.pasta, def.iconPath);
    // Só SVG de dentro da pasta da extensão
    if (!arq.toLowerCase().startsWith(iconesTema.dir.toLowerCase() + path.sep) || !/\.svg$/i.test(arq)) return null;
    return arq;
}

// Repositórios em que a conversa trabalhou de fato: raiz git dos arquivos editados e dos caminhos citados nos
// comandos (no Royal, PHP/HTML só mudam por comando), do mais recente para o mais antigo; o cwd entra por último.
const raizesGitCache = new Map();
const reposVistos = new Set();
function raizGitSync(caminho) {
    let d = path.resolve(caminho);
    try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch (e) { d = path.dirname(d); }
    const chave = d.toLowerCase();
    if (raizesGitCache.has(chave)) return raizesGitCache.get(chave);
    let raiz = null;
    for (let x = d, i = 0; i < 40; i++) {
        if (fs.existsSync(path.join(x, '.git'))) { raiz = x; break; }
        const pai = path.dirname(x);
        if (pai === x) break;
        x = pai;
    }
    raizesGitCache.set(chave, raiz);
    return raiz;
}
const CAMINHO_EM_COMANDO = /[A-Za-z]:[\\/](?:[^\s"'`<>|*?;&]+)/g;
function reposDaSessao(estado, cwd) {
    const vistos = new Map();
    const anota = (caminho, hora) => {
        if (!caminho || !path.isAbsolute(caminho) || ARQ_BASTIDOR.test(caminho) || caminho.toLowerCase().startsWith(PERFIS_BASTIDOR)) return;
        const raiz = raizGitSync(caminho);
        if (!raiz) return;
        const k = raiz.toLowerCase();
        const t = Date.parse(hora) || 0;
        if (!vistos.has(k) || vistos.get(k).t < t) vistos.set(k, { raiz, t });
    };
    for (const e of estado.eventos.slice(-1500)) {
        if (e.tipo === 'edicao') anota(String(e.texto || ''), e.hora);
        else if (e.tipo === 'comando') {
            const c = e.codigo || {};
            const txt = [c.entrada && c.entrada.texto, e.texto].filter(Boolean).join('\n').slice(0, 4000);
            for (const m of txt.match(CAMINHO_EM_COMANDO) || []) anota(m.replace(/[),.:]+$/, ''), e.hora);
        }
    }
    const lista = [...vistos.values()].sort((a, b) => b.t - a.t).map(x => x.raiz);
    const raizCwd = cwd && raizGitSync(cwd);
    if (raizCwd && !lista.some(r => r.toLowerCase() === raizCwd.toLowerCase())) lista.push(raizCwd);
    lista.forEach(r => reposVistos.add(r.toLowerCase()));
    return lista.slice(0, 6);
}
function detalheSessao(projeto, id) {
    // Bloqueia caminho fora da pasta de projetos
    if (/[\\/]|\.\./.test(projeto + id)) return null;
    const achado = arquivoDaSessao(projeto, id);
    if (!achado) return null;
    const arquivo = achado.arquivo;
    const estado = leIncremental(arquivo, estadoVazio, processaRegistro);
    leSubagentes(path.join(achado.raiz, projeto, id), estado);
    const stat = fs.statSync(arquivo);
    const situacao = situacaoSessao(estado, stat.mtimeMs, id);
    const primeiroPedido = estado.eventos.find(e => e.tipo === 'pedido');
    return {
        titulo: estado.titulo || (primeiroPedido && corta(primeiroPedido.texto, 80)), modelo: estado.modelo, esforco: estado.esforco, custo: estado.custo,
        custoHoje: custoHojeSessao(path.join(achado.raiz, projeto, id), estado),
        porConversa: entradaDaConversa(projeto, id),
        inicio: estado.inicio, ultimo: estado.ultimo, repos: (() => { const r = reposDaSessao(estado, cwdDaPasta(estado, projeto)); r.forEach(x => vigiaRepo(x)); return r; })(),
        ativa: situacao.ativa, esperando: situacao.esperando, agentesRodando: situacao.agentesRodando,
        fimTurno: estado.fimTurno, pergunta: estado.pergunta, planoHora: estado.planoHora || null, modo: estado.modo || 'default',
        reescritas: estado.reescritas,
        projeto: nomeProjeto(projeto), plano: estado.plano, tokens: estado.tokens, contagem: estado.contagem,
        contexto: estado.contexto, serieContexto: estado.serieContexto, modelos: estado.modelos,
        trocas: estado.trocas, compactacoes: estado.compactacoes, ttlCacheMin: estado.ttlCacheMin,
        atualizado: stat.mtimeMs, cwd: cwdDaPasta(estado, projeto), arquivo,
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
videoNavegador.configura(PASTA_DADOS);
// Extensões do VS Code (.vsix) instaladas no Red Code: cada uma num processo próprio, encerrado junto com o servidor
const extensoes = require('./extensoes');
const credenciaisConversas = require('./credenciais-conversas');
extensoes.configura({ pasta: __dirname, pastaDados: PASTA_DADOS, porta: PORTA });
process.on('exit', () => extensoes.encerraTodas());
// Corpo binário (o .vsix), com limite
function leBinario(req, limite) {
    return new Promise((ok, falha) => {
        const partes = []; let total = 0;
        req.on('data', (d) => { total += d.length; if (total > limite) { falha(new Error('Arquivo grande demais (máximo 50 MB).')); req.destroy(); } else partes.push(d); });
        req.on('end', () => ok(Buffer.concat(partes)));
        req.on('error', falha);
    });
}
// Webview e arquivos das extensões: sem o cabeçalho do painel (quem pede é o iframe em sandbox), mas só pelo
// endereço local certo (contra DNS rebinding) e sempre em sandbox, mesmo se abertos direto numa aba
const CABECALHOS_SANDBOX = { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
const hostLocal = (req) => [`127.0.0.1:${PORTA}`, `localhost:${PORTA}`].includes(String(req.headers.host || ''));
async function rotaExtensoes(req, res, url) {
    const p = url.pathname;
    const webview = p.match(/^\/api\/extensoes\/webview\/([^/]+)\/([^/]+)$/);
    const arquivoExt = p.match(/^\/api\/extensoes\/arquivo\/([^/]+)\/(.+)$/);
    if (webview || arquivoExt) {
        if (req.method !== 'GET' || !hostLocal(req)) return responde(res, 403, { erro: 'pedido recusado' });
        if (webview) {
            res.writeHead(200, { ...CABECALHOS_SANDBOX, 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(extensoes.htmlWebview(decodeURIComponent(webview[1]), decodeURIComponent(webview[2])));
        }
        const a = extensoes.arquivo(decodeURIComponent(arquivoExt[1]), arquivoExt[2]);
        if (!a) return responde(res, 404, { erro: 'não encontrado' });
        res.writeHead(200, { ...CABECALHOS_SANDBOX, 'Content-Type': a.tipo });
        return fs.createReadStream(a.caminho).pipe(res);
    }
    if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
    try {
        if (req.method === 'GET') {
            if (url.searchParams.has('id') && !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(url.searchParams.get('id'))) throw new Error('Extensão inválida.');
            if (p === '/api/extensoes/estado') return responde(res, 200, extensoes.estado());
            if (p === '/api/extensoes/eventos') return responde(res, 200, await extensoes.espera(url.searchParams.get('desde'), 20000));
            if (p === '/api/extensoes/arvore') return responde(res, 200, await extensoes.arvore(url.searchParams.get('id'), url.searchParams.get('viewId'), url.searchParams.get('handle')));
            if (p === '/api/extensoes/config') return responde(res, 200, extensoes.configDe(url.searchParams.get('id')));
            if (p === '/api/extensoes/log') return responde(res, 200, extensoes.logsDe(url.searchParams.get('id')));
            return responde(res, 404, { erro: 'não encontrado' });
        }
        if (req.method !== 'POST') return responde(res, 405, { erro: 'método não permitido' });
        if (p === '/api/extensoes/instalar') return responde(res, 200, extensoes.preparaInstalacao(await leBinario(req, 50 * 1024 * 1024)));
        const corpo = await leCorpo(req, 2e6);
        const id = String(corpo.id || '');
        if (corpo.id !== undefined && !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Extensão inválida.');
        switch (p) {
            case '/api/extensoes/confirmar': return responde(res, 200, await extensoes.confirmaInstalacao(corpo.token));
            case '/api/extensoes/acao': {
                if (corpo.acao === 'ligar' || corpo.acao === 'desligar') await extensoes.liga(id, corpo.acao === 'ligar');
                else if (corpo.acao === 'reiniciar') await extensoes.reinicia(id);
                else if (corpo.acao === 'remover') await extensoes.remove(id);
                else if (corpo.acao === 'apagar-dados') extensoes.apagaDados(id);
                else throw new Error('Ação desconhecida.');
                return responde(res, 200, extensoes.estado());
            }
            case '/api/extensoes/visibilidade': await extensoes.visibilidade(id, corpo.viewId, corpo.visivel); return responde(res, 200, { ok: true });
            case '/api/extensoes/mensagem': await extensoes.mensagem(id, corpo.viewId, corpo.msg); return responde(res, 200, { ok: true });
            case '/api/extensoes/clique': extensoes.clique(id, corpo.viewId, corpo.handle); return responde(res, 200, { ok: true });
            case '/api/extensoes/comando': extensoes.comando(id, String(corpo.comando || '')); return responde(res, 200, { ok: true });
            case '/api/extensoes/config': await extensoes.mudaConfig(id, String(corpo.chave || ''), corpo.valor === undefined ? null : corpo.valor, false); return responde(res, 200, extensoes.configDe(id));
            case '/api/extensoes/resposta': return responde(res, 200, { ok: extensoes.responde(corpo.pendente, corpo.valor) });
        }
        return responde(res, 404, { erro: 'não encontrado' });
    } catch (e) { return responde(res, 400, { erro: e.message }); }
}
let PASTA_EXTENSAO = null;
try { PASTA_EXTENSAO = videoNavegador.copiaExtensao(__dirname, PASTA_DADOS); } catch (e) { console.log('extensão do navegador: ' + e.message); }
videoNativo.configura(videoNavegador.recebe);
try { playersExternos.configura(PASTA_DADOS, videoNavegador.recebe); } catch (e) { console.log('players externos: ' + e.message); }
const ARQUIVO_DADOS = path.join(PASTA_DADOS, 'dados.json');
function leDados() {
    const vazio = { favoritos: [], vinculos: {}, nomes: {}, arquivadas: [], pastasExtras: [], navegador: 'padrao' };
    try { return { ...vazio, ...JSON.parse(fs.readFileSync(ARQUIVO_DADOS, 'utf8')) }; }
    catch (e) { return vazio; }
}
function gravaDados(dados) {
    fs.writeFileSync(ARQUIVO_DADOS, JSON.stringify(dados, null, 2));
}
// Conversas que o painel estava tocando quando foi fechado: o processo morreu junto, então ficam livres
// na hora (sem esperar o transcript "esfriar"). Vale enquanto o arquivo não for mexido por outro lugar.
const INICIO_PAINEL = Date.now();
const ARQUIVO_VIVAS = path.join(PASTA_DADOS, 'vivas.json');
let orfas = new Set();
try { orfas = new Set(JSON.parse(fs.readFileSync(ARQUIVO_VIVAS, 'utf8'))); } catch (e) { /* primeira vez */ }
let vivasGravadas = '[]';
function registraVivas() {
    const ids = chat.estado().filter(c => c.vivo && c.sessionId && (c.status === 'rodando' || c.status === 'parando')).map(c => c.sessionId).sort();
    const json = JSON.stringify(ids);
    if (json === vivasGravadas) return;
    vivasGravadas = json;
    try { fs.writeFileSync(ARQUIVO_VIVAS, json); } catch (e) { /* só otimização */ }
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
    // A pasta das conversas Chat não é projeto: git, editor, terminal, fila e agendadas não valem nela
    if (chat.ehChat(cwd)) return false;
    const alvo = path.resolve(cwd).toLowerCase();
    if (reposVistos.has(alvo)) return true;
    return listaSessoes().some(s => s.cwd && path.resolve(s.cwd).toLowerCase() === alvo);
}

// Modelos configurados: agentes (seus e do projeto) e o hook do Haiku que reescreve o pedido.
// O painel compara com o que a conversa usou de fato, para ver se a configuração está valendo.
function configModelos(cwd) {
    const agentes = {};
    const raizes = [[path.join(PASTA_CLAUDE), 'seu'], cwd ? [path.join(cwd, '.claude'), 'projeto'] : null].filter(Boolean);
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
    const configs = [path.join(PASTA_CLAUDE, 'settings.json'), path.join(PASTA_CLAUDE, 'settings.local.json')];
    if (cwd) configs.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
    for (const c of configs) {
        try { if (/refine-prompt/.test(JSON.stringify(JSON.parse(fs.readFileSync(c, 'utf8')).hooks || {}))) hookHaiku = true; } catch (e) { /* sem arquivo */ }
    }
    return { agentes, hookHaiku };
}

// ---------- Agentes (Configurações › Regras e agentes): ler, editar, ativar/desativar, criar e apagar ----------
// Os .md ficam em ~/.claude/agents (seus) e <projeto>/.claude/agents. Desativar um seu = renomear para .md.desativado
// (Claude Code só lê *.md). Desativar um do projeto = só para você: "Agent(nome)" no permissions.deny do
// <projeto>/.claude/settings.local.json, que é pessoal e fica fora do git (renomear mexeria no repositório de todos).
// Toda gravação faz backup antes em ~/.claude/backups/<data>/ (apagar = mover para o backup).
const PASTA_AGENTES_SUA = path.join(PASTA_CLAUDE, 'agents');
const NOME_AGENTE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARQ_AGENTE = /^[a-z0-9][a-z0-9-]{0,63}\.md(\.desativado)?$/;
const LIMITE_AGENTE = 200000;
// Frontmatter em entradas { chave, linhas }: linha sem recuo com "chave:" abre uma entrada; o resto (recuo, linha
// em branco) é continuação dela. Assim blocos com parágrafo e chaves desconhecidas são preservados como estão.
function separaFrontmatter(texto) {
    const m = String(texto).match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return { entradas: [], corpo: String(texto) };
    const entradas = [];
    for (const l of m[1].split(/\r?\n/)) {
        if (/^[A-Za-z_][\w-]*:/.test(l)) entradas.push({ chave: l.split(':')[0], linhas: [l] });
        else if (entradas.length) entradas[entradas.length - 1].linhas.push(l);
        else entradas.push({ chave: '', linhas: [l] });
    }
    return { entradas, corpo: String(texto).slice(m[0].length) };
}
// Valor de uma entrada: escalar simples (com continuação recuada) ou bloco | / > (com +/-)
function valorEntrada(e) {
    const primeira = e.linhas[0], resto = e.linhas.slice(1);
    let v = primeira.slice(primeira.indexOf(':') + 1).trim();
    const bloco = v.match(/^([|>])([+-]?)$/);
    if (!bloco) {
        if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
        const extra = resto.map(l => l.trim()).filter(Boolean);
        return extra.length ? [v, ...extra].join(' ') : v;
    }
    const naoVazias = resto.filter(l => l.trim());
    const recuo = naoVazias.length ? naoVazias[0].match(/^\s*/)[0].length : 0;
    const ls = resto.map(l => (l.trim() ? l.slice(Math.min(recuo, l.match(/^\s*/)[0].length)) : ''));
    while (ls.length && !ls[ls.length - 1]) ls.pop();
    if (bloco[1] === '|') return ls.join('\n');
    // ">": linhas seguidas viram uma (com espaço); linha vazia vira quebra
    let out = '';
    for (const l of ls) { if (!l) { out += '\n'; continue; } out += (out && !out.endsWith('\n') ? ' ' : '') + l; }
    return out;
}
// Descrição: linha simples só se for segura em YAML; senão bloco |- (as quebras ficam)
function linhasDescricao(desc) {
    const d = String(desc).replace(/\r\n/g, '\n').trim();
    const segura = !d.includes('\n') && !/: | #/.test(d) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(d) && !/:$/.test(d);
    return segura ? ['description: ' + d] : ['description: |-', ...d.split('\n').map(l => (l ? '  ' + l : ''))];
}
function leAgente(arquivo, escopo, pasta) {
    const st = fs.statSync(arquivo);
    const texto = fs.readFileSync(arquivo, 'utf8');
    const { entradas, corpo } = separaFrontmatter(texto);
    const val = (k) => { const e = entradas.find(x => x.chave === k); return e ? valorEntrada(e) : ''; };
    const base = path.basename(arquivo), ferramentas = val('tools');
    return {
        arquivo, escopo, pasta, ativo: !base.endsWith('.desativado'), editavel: ARQ_AGENTE.test(base) && st.size <= LIMITE_AGENTE,
        nome: val('name') || base.replace(/\.md(\.desativado)?$/, ''), descricao: val('description'), modelo: val('model') || 'inherit',
        esforco: val('effort'), ferramentas: ferramentas ? ferramentas.split(/\s*,\s*/).filter(Boolean) : [],
        corpo: st.size > LIMITE_AGENTE ? corpo.slice(0, LIMITE_AGENTE) : corpo, cortado: st.size > LIMITE_AGENTE,
    };
}
// Pastas de agentes que o painel aceita: a sua e a de cada projeto conhecido (listaProjetos, sem "Sem projeto")
function pastasDeAgentes() {
    const lista = [{ dir: PASTA_AGENTES_SUA, escopo: 'seu', pasta: null, titulo: 'Seus (valem em todos os projetos)' }];
    const vistos = new Set([PASTA_AGENTES_SUA.toLowerCase()]);
    for (const p of listaProjetos()) {
        if (p.semProjeto || !p.cwd) continue;
        const dir = path.join(p.cwd, '.claude', 'agents');
        if (vistos.has(dir.toLowerCase())) continue;
        vistos.add(dir.toLowerCase());
        lista.push({ dir, escopo: 'projeto', pasta: p.cwd, titulo: 'Projeto ' + (p.nome || path.basename(p.cwd)) });
    }
    return lista;
}
// Agentes bloqueados só para você neste projeto (permissions.deny do settings.local.json)
function arquivoLocalProjeto(pastaProjeto) { return path.join(pastaProjeto, '.claude', 'settings.local.json'); }
function bloqueadosNoProjeto(pastaProjeto) {
    try {
        const j = JSON.parse(fs.readFileSync(arquivoLocalProjeto(pastaProjeto), 'utf8'));
        const deny = (j.permissions && Array.isArray(j.permissions.deny)) ? j.permissions.deny : [];
        return new Set(deny.map(r => (String(r).match(/^(?:Agent|Task)\(([^()]+)\)$/) || [])[1]).filter(Boolean));
    } catch (e) { return new Set(); }
}
function bloqueiaNoProjeto(pastaProjeto, nome, bloquear) {
    const arq = arquivoLocalProjeto(pastaProjeto);
    let j = {};
    if (fs.existsSync(arq)) {
        // JSON com erro: não sobrescreve (perderia o que você tem lá)
        try { j = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) { throw erroAgente('O .claude/settings.local.json deste projeto está com erro de JSON; corrija antes.'); }
        backupArquivoAgente(arq);
    }
    j.permissions = j.permissions || {};
    const regra = 'Agent(' + nome + ')';
    const deny = (Array.isArray(j.permissions.deny) ? j.permissions.deny : []).filter(r => r !== regra && r !== 'Task(' + nome + ')');
    if (bloquear) deny.push(regra);
    if (deny.length) j.permissions.deny = deny; else delete j.permissions.deny;
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    fs.writeFileSync(arq, JSON.stringify(j, null, 2) + '\n');
}
function listaAgentes() {
    const grupos = [];
    for (const g of pastasDeAgentes()) {
        let nomes;
        try { nomes = fs.readdirSync(g.dir).filter(n => /\.md(\.desativado)?$/i.test(n)); } catch (e) { continue; }
        const agentes = [];
        for (const n of nomes.sort()) { try { agentes.push(leAgente(path.join(g.dir, n), g.escopo, g.pasta)); } catch (e) { /* ilegível */ } }
        if (g.escopo === 'projeto') {
            const bloqueados = bloqueadosNoProjeto(g.pasta);
            agentes.forEach(a => { if (bloqueados.has(a.nome)) { a.ativo = false; a.soParaVoce = true; } });
        }
        if (agentes.length) grupos.push({ ...g, agentes });
    }
    // Agente ativo de projeto com o mesmo nome de um seu ativo: o do projeto vale (como no Claude Code)
    const seus = new Set((grupos.find(g => g.escopo === 'seu') || { agentes: [] }).agentes.filter(a => a.ativo).map(a => a.nome));
    grupos.forEach(g => g.agentes.forEach(a => { a.sobrepoe = g.escopo === 'projeto' && a.ativo && seus.has(a.nome); }));
    return grupos;
}
function erroAgente(msg) { const e = new Error(msg); e.status = 400; return e; }
function validaArquivoAgente(arq) {
    const abs = path.resolve(String(arq || ''));
    const dir = path.dirname(abs).toLowerCase();
    if (!pastasDeAgentes().some(g => g.dir.toLowerCase() === dir)) throw erroAgente('Pasta de agentes desconhecida.');
    if (!ARQ_AGENTE.test(path.basename(abs))) throw erroAgente('Nome de arquivo de agente inválido.');
    return abs;
}
function pastaDoEscopo(escopo) {
    if (escopo === 'seu') return PASTA_AGENTES_SUA;
    const alvo = path.resolve(String(escopo || '')).toLowerCase();
    const p = listaProjetos().find(x => !x.semProjeto && x.cwd && path.resolve(x.cwd).toLowerCase() === alvo);
    if (!p) throw erroAgente('Projeto desconhecido.');
    return path.join(p.cwd, '.claude', 'agents');
}
function validaCamposAgente(c) {
    const nome = String(c.nome || '').trim();
    if (!NOME_AGENTE.test(nome)) throw erroAgente('Nome: só letras minúsculas, números e hífen (até 64).');
    const descricao = String(c.descricao || '').replace(/\r\n/g, '\n').trim();
    if (!descricao) throw erroAgente('A descrição não pode ficar vazia: é ela que diz ao Claude quando chamar o agente.');
    if (descricao.length > 4000) throw erroAgente('Descrição longa demais (até 4000 letras).');
    const modelo = String(c.modelo || 'inherit').trim();
    if (!/^[A-Za-z0-9._[\]-]+$/.test(modelo)) throw erroAgente('Modelo inválido.');
    const esforco = String(c.esforco || '').trim();
    if (esforco && !/^[A-Za-z0-9_-]+$/.test(esforco)) throw erroAgente('Esforço inválido.');
    const ferramentas = String(c.ferramentas || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const f of ferramentas) if (!/^[A-Za-z0-9_.*/:-]+(\([^()\r\n,]*\))?$/.test(f)) throw erroAgente('Ferramenta inválida: ' + f);
    const corpo = String(c.corpo == null ? '' : c.corpo).replace(/\r\n/g, '\n');
    if (corpo.length > 100000) throw erroAgente('Instruções longas demais (até 100 mil letras).');
    return { nome, descricao, modelo, esforco, ferramentas, corpo };
}
function montaAgente(original, c) {
    const { entradas } = original ? separaFrontmatter(original) : { entradas: [] };
    const tem = (k) => entradas.some(e => e.chave === k);
    const linhas = ['---', 'name: ' + c.nome, ...linhasDescricao(c.descricao)];
    // Sem linha "model" no original e continua "igual à conversa": não cria a linha (não gera diff à toa)
    if (!(c.modelo === 'inherit' && !tem('model'))) linhas.push('model: ' + c.modelo);
    if (c.esforco) linhas.push('effort: ' + c.esforco);
    if (c.ferramentas.length) linhas.push('tools: ' + c.ferramentas.join(', '));
    for (const e of entradas) if (!['name', 'description', 'model', 'effort', 'tools'].includes(e.chave)) linhas.push(...e.linhas);
    linhas.push('---');
    const texto = linhas.join('\n') + '\n' + c.corpo;
    return original && original.includes('\r\n') ? texto.replace(/\n/g, '\r\n') : texto;
}
function backupArquivoAgente(abs) {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const pastaBk = path.join(PASTA_CLAUDE, 'backups', `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`);
    const claude = path.join(PASTA_CLAUDE);
    const rel = abs.toLowerCase().startsWith(claude.toLowerCase() + path.sep) ? path.relative(claude, abs) : path.join('projetos', abs.replace(/^([A-Za-z]):[\\/]/, '$1' + path.sep));
    const destino = path.join(pastaBk, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(abs, destino);
    return destino;
}
// Esforço máximo de cada um dos seus agentes (~/.claude/agents) neste computador: para plano menor (ex.: em casa,
// Haiku livre e Opus no baixo). Quem passa do limite tem o "effort:" do arquivo baixado (com backup); o original fica
// nos dados do Red Code deste PC e volta quando o limite sobe ou sai. Mudou à mão depois? A mudança vira o novo original.
const ORDEM_ESFORCO = ['low', 'medium', 'high', 'xhigh', 'max'];
function aplicaLimiteEsforco() {
    const dados = leDados();
    const limites = dados.limiteEsforcoPorAgente || {};
    const guardados = dados.esforcoOriginalAgentes || {};
    const novos = {};
    let nomes = [];
    try { nomes = fs.readdirSync(PASTA_AGENTES_SUA).filter(n => ARQ_AGENTE.test(n)); } catch (e) { /* sem pasta */ }
    for (const n of nomes) {
        const abs = path.join(PASTA_AGENTES_SUA, n), chave = abs.toLowerCase();
        const limite = ORDEM_ESFORCO.includes(limites[chave]) ? limites[chave] : '';
        let texto;
        try { if (fs.statSync(abs).size > LIMITE_AGENTE) continue; texto = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
        const fm = texto.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        if (!fm) continue;
        const linha = fm[1].match(/^effort:[ \t]*["']?([A-Za-z]+)["']?[ \t]*$/m);
        const atual = linha ? linha[1].toLowerCase() : '';
        const g = guardados[chave];
        // O que o arquivo "quer": o original guardado (se ainda está com o valor que o limite pôs) ou o que está lá
        const desejado = g && atual === g.posto ? g.original : atual;
        if (!desejado || !ORDEM_ESFORCO.includes(desejado)) continue;
        const alvo = limite && ORDEM_ESFORCO.indexOf(desejado) > ORDEM_ESFORCO.indexOf(limite) ? limite : desejado;
        if (alvo !== atual && linha) {
            backupArquivoAgente(abs);
            const novoFm = fm[1].replace(/^effort:.*$/m, 'effort: ' + alvo);
            fs.writeFileSync(abs, texto.slice(0, fm.index) + fm[0].replace(fm[1], () => novoFm) + texto.slice(fm.index + fm[0].length));
        }
        if (alvo !== desejado) novos[chave] = { original: desejado, posto: alvo };
    }
    if (JSON.stringify(novos) !== JSON.stringify(guardados)) { const d = leDados(); d.esforcoOriginalAgentes = novos; gravaDados(d); }
    return { limites, originais: novos };
}
setTimeout(() => { try { aplicaLimiteEsforco(); } catch (e) { console.error('limite de esforço dos agentes:', e.message); } }, 3000);
function acaoAgente(corpo) {
    const acao = corpo.acao;
    if (acao === 'limite-esforco') {
        const limite = String(corpo.limite || '');
        if (limite && !ORDEM_ESFORCO.includes(limite)) throw erroAgente('Esforço inválido.');
        const alvo = validaArquivoAgente(corpo.arquivo);
        if (path.dirname(alvo).toLowerCase() !== PASTA_AGENTES_SUA.toLowerCase()) throw erroAgente('O limite de esforço vale só para os seus agentes.');
        const d = leDados();
        d.limiteEsforcoPorAgente = d.limiteEsforcoPorAgente || {};
        if (limite) d.limiteEsforcoPorAgente[alvo.toLowerCase()] = limite; else delete d.limiteEsforcoPorAgente[alvo.toLowerCase()];
        delete d.limiteEsforcoAgentes;
        gravaDados(d);
        return;
    }
    if (acao === 'criar') {
        const dir = pastaDoEscopo(corpo.escopo);
        const c = validaCamposAgente(corpo);
        const abs = path.join(dir, c.nome + '.md');
        if (fs.existsSync(abs) || fs.existsSync(abs + '.desativado')) throw erroAgente('Já existe um agente com esse nome nesta pasta.');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, montaAgente('', c));
        return;
    }
    const abs = validaArquivoAgente(corpo.arquivo);
    if (!fs.existsSync(abs)) throw erroAgente('Arquivo do agente não encontrado.');
    const grupo = pastasDeAgentes().find(g => g.dir.toLowerCase() === path.dirname(abs).toLowerCase());
    if ((acao === 'ativar' || acao === 'desativar') && grupo && grupo.escopo === 'projeto') {
        const nome = leAgente(abs, grupo.escopo, grupo.pasta).nome;
        if (!NOME_AGENTE.test(nome)) throw erroAgente('Nome de agente inválido.');
        bloqueiaNoProjeto(grupo.pasta, nome, acao === 'desativar');
        // Desativado do jeito antigo (renomeado): volta o arquivo, para o repositório ficar como estava
        if (acao === 'ativar' && abs.endsWith('.desativado') && !fs.existsSync(abs.replace(/\.desativado$/, ''))) {
            backupArquivoAgente(abs);
            fs.renameSync(abs, abs.replace(/\.desativado$/, ''));
        }
        return;
    }
    if (acao === 'ativar' || acao === 'desativar') {
        const destino = acao === 'ativar' ? abs.replace(/\.desativado$/, '') : (abs.endsWith('.desativado') ? abs : abs + '.desativado');
        if (destino === abs) return;
        if (fs.existsSync(destino)) throw erroAgente('Já existe outro arquivo com esse nome.');
        backupArquivoAgente(abs);
        fs.renameSync(abs, destino);
        return;
    }
    if (acao === 'apagar') { backupArquivoAgente(abs); fs.unlinkSync(abs); return; }
    if (acao === 'salvar') {
        if (fs.statSync(abs).size > LIMITE_AGENTE) throw erroAgente('Arquivo grande demais para editar aqui: use o VS Code.');
        const original = fs.readFileSync(abs, 'utf8');
        const c = validaCamposAgente(corpo);
        const sufixo = abs.endsWith('.desativado') ? '.md.desativado' : '.md';
        const novo = path.join(path.dirname(abs), c.nome + sufixo);
        const trocouNome = novo.toLowerCase() !== abs.toLowerCase();
        if (trocouNome) {
            const b = path.join(path.dirname(abs), c.nome);
            if (fs.existsSync(b + '.md') || fs.existsSync(b + '.md.desativado')) throw erroAgente('Já existe um agente com esse nome nesta pasta.');
        }
        backupArquivoAgente(abs);
        fs.writeFileSync(novo, montaAgente(original, c));
        if (trocouNome) {
            fs.unlinkSync(abs);
            const d = leDados(), de = abs.toLowerCase(), para = novo.toLowerCase();
            for (const k of ['limiteEsforcoPorAgente', 'esforcoOriginalAgentes']) if (d[k] && d[k][de]) { d[k][para] = d[k][de]; delete d[k][de]; }
            gravaDados(d);
        }
        return;
    }
    throw erroAgente('Ação inválida.');
}
// Regras e agentes (Configurações): como o Claude trabalha ao rodar as coisas.
function regrasEAgentes(cwd) {
    // Instruções que entram nas conversas: a sua (global) e as do projeto
    const instrucoes = [];
    const lerInstrucao = (titulo, arquivo, origem) => {
        try {
            const st = fs.statSync(arquivo);
            if (!st.isFile()) return;
            instrucoes.push({ titulo, arquivo, origem, texto: fs.readFileSync(arquivo, 'utf8').slice(0, 80000), cortado: st.size > 80000 });
        } catch (e) { /* não existe */ }
    };
    lerInstrucao('Suas instruções (todas as conversas)', path.join(PASTA_CLAUDE, 'CLAUDE.md'), 'seu');
    if (cwd) {
        lerInstrucao('Instruções do projeto', path.join(cwd, 'CLAUDE.md'), 'projeto');
        lerInstrucao('Instruções do projeto (.claude)', path.join(cwd, '.claude', 'CLAUDE.md'), 'projeto');
        lerInstrucao('Instruções locais do projeto', path.join(cwd, 'CLAUDE.local.md'), 'projeto');
        const pastaRegras = path.join(cwd, '.claude', 'rules');
        try { for (const f of fs.readdirSync(pastaRegras).filter(f => f.endsWith('.md')).sort()) lerInstrucao('Regra: ' + f.replace(/\.md$/, ''), path.join(pastaRegras, f), 'projeto'); } catch (e) { /* sem regras */ }
    }
    let limiteEsforco = { limites: {}, originais: {} };
    try { limiteEsforco = aplicaLimiteEsforco(); } catch (e) { /* segue sem limite */ }
    const grupos = listaAgentes();
    grupos.forEach(g => g.agentes.forEach(a => {
        const chave = String(a.arquivo).toLowerCase(), o = limiteEsforco.originais[chave];
        if (o) a.esforcoOriginal = o.original;
        if (g.escopo === 'seu') a.limiteEsforco = limiteEsforco.limites[chave] || '';
    }));
    return { grupos, instrucoes };
}

// Comandos e skills para o menu "/" da caixa de mensagem (do usuário e do projeto)
function listaComandos(cwd) {
    const lista = [
        { nome: 'compact', descricao: 'Resume a conversa para liberar contexto', origem: 'Claude Code' },
        { nome: 'context', descricao: 'Mostra o que está ocupando o contexto', origem: 'Claude Code' },
        { nome: 'cost', descricao: 'Mostra o custo da conversa', origem: 'Claude Code' },
        { nome: 'mcp', descricao: 'Servidores MCP desta conversa: estado, reconectar, ligar e desligar', origem: 'Red Code' },
    ];
    const descricaoDe = (arquivo) => {
        try {
            const texto = fs.readFileSync(arquivo, 'utf8').slice(0, 4000);
            const fm = texto.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
            const desc = fm && (fm[1].match(/description:\s*["']?([^\r\n]*)/) || [])[1];
            return corta(String(desc || '').replace(/["']$/, ''), 140);
        } catch (e) { return ''; }
    };
    const raizes = [[path.join(PASTA_CLAUDE), 'seu'], cwd ? [path.join(cwd, '.claude'), 'projeto'] : null].filter(Boolean);
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
    const lista = [...vistos.values()].filter(p => p.nome !== 'rascunho do app' && !chat.ehChat(p.cwd) && fs.existsSync(p.cwd)).map(p => ({ ...p, grupo: 'Com conversas' }));
    // Outras pastas da raiz de projetos (ainda sem conversa)
    const raizProjetos = process.env.PAINEL_RAIZ_PROJETOS || 'C:\\ProjetosGit';
    try {
        for (const d of fs.readdirSync(raizProjetos, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const cwd = path.join(raizProjetos, d.name);
            if (!vistos.has(cwd.toLowerCase())) lista.push({ cwd, nome: d.name, grupo: 'Em ' + raizProjetos });
        }
    } catch (e) { /* raiz não existe */ }
    // Pastas extras (Configurações › Claude Code): entram na lista, sem liberar editor/git (pastaConhecida não muda)
    for (const p of leDados().pastasExtras || []) {
        const k = String(p).toLowerCase();
        if (vistos.has(k) || lista.some(x => x.cwd.toLowerCase() === k) || chat.ehChat(p) || !fs.existsSync(p)) continue;
        lista.push({ cwd: p, nome: path.basename(p) || p, grupo: 'Suas pastas' });
    }
    // Sem projeto: a pasta do usuário, sem as regras (CLAUDE.md) de nenhum projeto
    const casa = os.homedir();
    // Sempre oferecida, mesmo que a pasta do usuário já tenha conversas (aí ela sai de "Com conversas")
    const semCasa = lista.filter(p => p.cwd.toLowerCase() !== casa.toLowerCase());
    semCasa.push({ cwd: casa, nome: 'Sem projeto', grupo: 'Fora de projeto', semProjeto: true });
    return semCasa;
}

// Código do servidor mudou depois que ele subiu? (a página avisa e oferece o reinício seguro)
const INICIO_SERVIDOR = Date.now();
let reinicioAgendado = null;
// Troca de perfil pendente: gravada no perfis.json só logo antes de sair (queda no meio = sobe com o perfil antigo)
let perfilPendente = null, agendouPorPerfil = false, timerReinicio = null;
// encerrar = true: sai com código 0 (o lançador não sobe de novo; o app desktop assume a porta)
let encerrarEmVezDeReiniciar = false;
function agendaReinicio(encerrar = false) {
    if (encerrar) encerrarEmVezDeReiniciar = true;
    if (reinicioAgendado) return;
    reinicioAgendado = new Date().toISOString();
    const tenta = () => {
        if (!reinicioAgendado) return;
        chat.fechaOciosas(0);
        const vivas = chat.estado().filter(c => c.vivo || c.status === 'rodando' || c.status === 'parando');
        if (vivas.length || terminal.quantos()) { timerReinicio = setTimeout(tenta, 5000); return; }
        if (perfilPendente) {
            console.log('Trocando para o perfil ' + perfilPendente);
            if (!perfis.gravaAtivo(perfilPendente)) console.log('Perfil pendente sumiu; continua o atual');
        } else console.log('Reiniciando para carregar o código novo');
        servidor.close();
        setTimeout(() => process.exit(encerrarEmVezDeReiniciar ? 0 : 75), 300);
    };
    timerReinicio = setTimeout(tenta, 1000);
}
// Cancela a troca de perfil; o reinício só é cancelado se foi a troca que o pediu (reinício de código continua)
function cancelaTrocaPerfil() {
    perfilPendente = null;
    if (agendouPorPerfil && !encerrarEmVezDeReiniciar) { reinicioAgendado = null; clearTimeout(timerReinicio); }
    agendouPorPerfil = false;
}
function versaoServidor() {
    const alterado = Math.max(...['server.js', 'chat.js'].map(a => { try { return fs.statSync(path.join(__dirname, a)).mtimeMs; } catch (e) { return 0; } }));
    let versaoApp = '';
    try { versaoApp = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || ''; } catch (e) { /* sem package.json */ }
    return { versaoApp, vigiados: [...vigias.keys()], perfil: perfis.perfilInfo(), perfilPendente: perfilPendente ? perfis.perfilInfo(perfilPendente) : null, encerrar: encerrarEmVezDeReiniciar, terminais: terminal.quantos(), comLancador: !!process.env.PAINEL_LANCADOR, pastaDados: PASTA_DADOS, desatualizado: alterado > INICIO_SERVIDOR, iniciado: new Date(INICIO_SERVIDOR).toISOString(), alterado: new Date(alterado).toISOString(), reinicioAgendado };
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
    const achado = arquivoDaSessao(projeto, id);
    const arquivo = achado ? achado.arquivo : path.join(RAIZ_PROJETOS, projeto, id + '.jsonl');
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
const ARQ_SETTINGS = path.join(PASTA_CLAUDE, 'settings.json');
function lePlugins() {
    // Conta nova, sem settings.json ainda: começa sem plugins (é quando mais se precisa do instalador)
    if (!fs.existsSync(ARQ_SETTINGS)) return [];
    const json = JSON.parse(fs.readFileSync(ARQ_SETTINGS, 'utf8'));
    return Object.entries(json.enabledPlugins || {}).map(([nome, ligado]) => ({ nome, ligado: !!ligado }));
}
function gravaPlugin(nome, ligado) {
    const bruto = fs.readFileSync(ARQ_SETTINGS, 'utf8');
    const json = JSON.parse(bruto);
    if (!json.enabledPlugins || !(nome in json.enabledPlugins)) throw new Error('Plugin não encontrado nas configurações.');
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const pasta = path.join(PASTA_CLAUDE, 'backups', `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`);
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

// Economia de tokens: compactação automática da conversa (autoCompactWindow no settings.json)
const JANELA_ECONOMIA = 150000;
function leEconomia() {
    try { return Number(JSON.parse(fs.readFileSync(ARQ_SETTINGS, 'utf8')).autoCompactWindow) > 0; } catch (e) { return false; }
}
function gravaEconomia(ligada) {
    const existe = fs.existsSync(ARQ_SETTINGS);
    const bruto = existe ? fs.readFileSync(ARQ_SETTINGS, 'utf8') : '{}';
    const json = JSON.parse(bruto);
    if (existe) {
        const d = new Date(), z = (n) => String(n).padStart(2, '0');
        const pasta = path.join(PASTA_CLAUDE, 'backups', `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`);
        fs.mkdirSync(pasta, { recursive: true });
        fs.writeFileSync(path.join(pasta, 'settings.json'), bruto);
    }
    if (ligada) json.autoCompactWindow = JANELA_ECONOMIA; else delete json.autoCompactWindow;
    const crlf = bruto.includes('\r\n');
    let novo = JSON.stringify(json, null, 2);
    if (!existe || /\r?\n$/.test(bruto)) novo += '\n';
    if (crlf) novo = novo.replace(/\n/g, '\r\n');
    fs.mkdirSync(PASTA_CLAUDE, { recursive: true });
    fs.writeFileSync(ARQ_SETTINGS, novo);
}

async function rotaChat(req, res, url) {
    if (url.pathname === '/api/versao' && req.method === 'GET') return responde(res, 200, versaoServidor());
    if (url.pathname === '/api/chat/estado' && req.method === 'GET') return responde(res, 200, chat.estado());
    if (url.pathname === '/api/projetos' && req.method === 'GET') return responde(res, 200, listaProjetos());
    if (url.pathname === '/api/dados' && req.method === 'GET') return responde(res, 200, { ...leDados(), chatProjeto: chat.pastaDoProjeto(chat.CHAT_DIR), usuario: nomeUsuario(), economia: leEconomia() });
    if (url.pathname.startsWith('/api/git/')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = req.method === 'GET' ? url.searchParams.get('cwd') : null;
        const sessGit = String(url.searchParams.get('sessao') || '');
        let ctxGit = null;
        if (/^[^\\/]+\/[0-9a-f-]{36}$/i.test(sessGit)) {
            const [pj, ss] = sessGit.split('/');
            const ent = entradaDaConversa(pj, ss);
            if (ent) { try { ctxGit = { env: perfis.envDaConversa(ent), idIdentidade: ent.git || null }; } catch (e) { return responde(res, 409, { erro: e.message }); } }
        }
        return gitScm.contextoGit.run(ctxGit, async () => {
        try {
            if (req.method === 'GET') {
                if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
                const q = (k) => url.searchParams.get(k);
                if (url.pathname === '/api/git/estado') return responde(res, 200, await gitScm.estado(cwd));
                if (url.pathname === '/api/git/diff') return responde(res, 200, { diff: await gitScm.diff(cwd, q('arquivo'), q('staged') === '1', q('inteiro') === '1') });
                if (url.pathname === '/api/git/log') return responde(res, 200, await gitScm.log(cwd, q('n')));
                if (url.pathname === '/api/git/commit') return responde(res, 200, q('arquivo') ? { diff: await gitScm.commit(cwd, q('hash'), q('arquivo'), q('inteiro') === '1') } : await gitScm.commit(cwd, q('hash')));
                if (url.pathname === '/api/git/branches') return responde(res, 200, await gitScm.branches(cwd));
                if (url.pathname === '/api/git/a-subir') return responde(res, 200, { commits: await gitScm.aSubir(cwd), hooks: await gitScm.hooksComEfeito(cwd) });
                if (url.pathname === '/api/git/hooks') return responde(res, 200, { hooks: await gitScm.hooksComEfeito(cwd) });
                if (url.pathname === '/api/git/avatar') return responde(res, 200, { dataUrl: await gitScm.avatar(cwd, q('email'), q('hash')) });
                return responde(res, 404, { erro: 'não encontrado' });
            }
            if (req.method !== 'POST' || url.pathname !== '/api/git/acao') return responde(res, 405, { erro: 'use POST' });
            const corpo = await leCorpo(req, 1e6);
            if (!pastaConhecida(corpo.cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
            return responde(res, 200, await gitScm.acao(corpo.cwd, corpo));
        } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
        });
    }
    if (req.method === 'GET' && url.pathname === '/api/automacao') {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const dados = leDados();
        const desde = Number(url.searchParams.get('desde')) || 0;
        const ag = dados.agendamentos || [], fi = dados.fila || [];
        return responde(res, 200, { agendamentos: ag.filter(automacao.doPerfil), fila: fi.filter(automacao.doPerfil), outrosPerfis: ag.filter(a => !automacao.doPerfil(a)).length + fi.filter(i => !automacao.doPerfil(i)).length, filaPausada: !!dados.filaPausada, eventos: eventosAutomacao.filter(e => e.em > desde), agora: Date.now() });
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
            if (url.pathname === '/api/busca') return responde(res, 200, await alem.busca(listaSessoes(), (s) => (arquivoDaSessao(s.projeto, s.id) || {}).arquivo, url.searchParams.get('q'), url.searchParams.get('tipo') === 'arquivo' ? 'arquivo' : 'texto'));
            if (url.pathname === '/api/resumo-dia') return responde(res, 200, alem.resumoDia(listaSessoes(), detalheSessao));
            return responde(res, 200, alem.modelos(leDados()));
        } catch (e) { return responde(res, 400, { erro: e.message }); }
    }
    if (req.method === 'GET' && (url.pathname === '/api/worktree/repo' || url.pathname === '/api/worktrees' || url.pathname === '/api/resolver-arquivo')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = url.searchParams.get('cwd');
        if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/worktree/repo') return responde(res, 200, { repo: await worktrees.repoDe(cwd) });
            if (url.pathname === '/api/resolver-arquivo') return responde(res, 200, await worktrees.resolverArquivo(cwd, url.searchParams.get('caminho')));
            return responde(res, 200, await worktrees.listar(cwd));
        } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/por-comando/vivo') {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const projeto = String(url.searchParams.get('projeto') || ''), sessao = String(url.searchParams.get('sessao') || '');
        if (!projeto || !sessao || /[\\/]|\.\./.test(projeto + sessao)) return responde(res, 400, { erro: 'sessão inválida' });
        let visto = {};
        try { visto = JSON.parse(url.searchParams.get('visto') || '{}') || {}; } catch (e) { visto = {}; }
        try {
            const r = await alteracoesAoVivo(projeto, sessao, String(url.searchParams.get('id') || ''), visto);
            return r === null ? responde(res, 404, { erro: 'Sessão não encontrada.' }) : responde(res, 200, r);
        } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/por-comando') {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const projeto = String(url.searchParams.get('projeto') || ''), sessao = String(url.searchParams.get('sessao') || '');
        if (!projeto || !sessao || /[\\/]|\.\./.test(projeto + sessao)) return responde(res, 400, { erro: 'sessão inválida' });
        try {
            const lista = await alteracoesDoComando(projeto, sessao, String(url.searchParams.get('id') || ''));
            return lista === null ? responde(res, 404, { erro: 'Sessão não encontrada.' }) : responde(res, 200, lista);
        } catch (e) { return responde(res, 500, { erro: 'Não deu para ler as alterações do comando.' }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/editor/')) {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const cwd = url.searchParams.get('cwd');
        if (!pastaConhecida(cwd)) return responde(res, 403, { erro: 'Pasta de projeto desconhecida.' });
        try {
            if (url.pathname === '/api/editor/arvore') return responde(res, 200, editorArquivos.arvore(cwd, url.searchParams.get('dir') || '.'));
            if (url.pathname === '/api/editor/arquivo') {
                const caminho = url.searchParams.get('caminho') || '';
                const abs = path.resolve(cwd, caminho);
                const dentro = abs.toLowerCase().startsWith(path.resolve(cwd).toLowerCase() + path.sep);
                // Fora da pasta da conversa: só abre se a própria conversa editou esse arquivo
                const lido = !dentro && editadoNaSessao(url.searchParams.get('projeto'), url.searchParams.get('sessao'), abs)
                    ? editorArquivos.ler(path.dirname(abs), path.basename(abs)) : editorArquivos.ler(cwd, caminho);
                // Retrato: base para descobrir o que um comando mudar depois neste arquivo
                guardaRetrato(lido.caminho, lido.conteudo);
                return responde(res, 200, lido);
            }
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
        try { const entM = entradaDaConversa(url.searchParams.get('projeto'), url.searchParams.get('sessao')); return responde(res, 200, await chat.statusMcp(url.searchParams.get('sessao'), detalhe.cwd, entM ? perfis.envDaConversa(entM) : undefined)); } catch (e) { return responde(res, 500, { erro: e.message }); }
    }
    if (url.pathname === '/api/perfis' && req.method === 'GET') {
        if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
        const vivas = chat.estado().filter(c => c.vivo || c.status === 'rodando' || c.status === 'parando');
        const r = await perfis.lista();
        return responde(res, 200, { ...r, home: os.homedir(), env: Object.fromEntries(r.perfis.map(p => [p.id, perfis.envVisivel(p.id)])), pendente: perfilPendente, segurando: { conversas: vivas.length, terminais: terminal.quantos() }, comLancador: !!process.env.PAINEL_LANCADOR });
    }
    if (req.method !== 'POST') return responde(res, 405, { erro: 'use POST' });
    if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
    const corpo = await leCorpo(req, url.pathname === '/api/chat/enviar' ? 35e6 : url.pathname === '/api/editor/salvar' ? 8e6 : 1e6);

    if (url.pathname === '/api/agendamentos') {
        try {
            const dados = leDados();
            const outros = (dados.agendamentos || []).filter(a => !automacao.doPerfil(a));
            const meus = automacao.validaAgendamentos(corpo.lista, pastaConhecida, (dados.agendamentos || []).filter(automacao.doPerfil));
            dados.agendamentos = [...outros, ...meus];
            gravaDados(dados);
            return responde(res, 200, meus);
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
                dados.fila.push({ id: crypto.randomBytes(6).toString('hex'), ...p, status: 'esperando', criado: new Date().toISOString(), perfil: perfis.perfilEmUso() });
            } else if (corpo.acao === 'remover') {
                dados.fila = dados.fila.filter(i => !(i.id === corpo.id && i.status !== 'rodando' && automacao.doPerfil(i)));
            } else if (corpo.acao === 'limpar') {
                dados.fila = dados.fila.filter(i => i.status === 'esperando' || i.status === 'rodando' || !automacao.doPerfil(i));
            } else if (corpo.acao === 'pausar') {
                dados.filaPausada = !!corpo.pausada;
            } else throw new Error('ação inválida');
            gravaDados(dados);
            setTimeout(() => automatico.ciclo().catch(() => {}), 500);
            return responde(res, 200, { fila: dados.fila.filter(automacao.doPerfil), filaPausada: !!dados.filaPausada });
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
            if (plugins.emAndamento()) return responde(res, 409, { erro: 'Há uma operação de plugin em andamento. Espere terminar.' });
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
            const ent = entradaDaConversa(corpo.projeto, corpo.sessao);
            const achadoR = arquivoDaSessao(String(corpo.projeto), String(corpo.sessao));
            if (achadoR && resolveMin(achadoR.raiz) !== resolveMin(RAIZ_PROJETOS)) return responde(res, 409, { erro: 'Ramificar só funciona em conversas da conta do Claude do perfil atual.' });
            try {
                const r = await chat.ramificar(String(corpo.sessao), detalhe.cwd, corpo.uuid);
                const dados = leDados();
                dados.vinculos[`${corpo.projeto}/${r.sessionId}`] = `${corpo.projeto}/${corpo.sessao}`;
                if (ent) { dados.porConversa = dados.porConversa || {}; dados.porConversa[chaveConversa(corpo.projeto, r.sessionId)] = { ...ent, projeto: corpo.projeto, sessao: r.sessionId }; }
                gravaDados(dados);
                return responde(res, 200, { ok: true, chave: `${corpo.projeto}/${r.sessionId}` });
            } catch (e) { return responde(res, 500, { erro: e.message }); }
        }
        const trava = travaDaSessao(detalhe, String(corpo.sessao));
        if (trava && !corpo.simular) return responde(res, 409, { erro: trava });
        let envV = null;
        try { envV = entradaDaConversa(corpo.projeto, corpo.sessao) ? envDeConversa(corpo.projeto, corpo.sessao) : null; } catch (e) { return responde(res, 409, { erro: e.message }); }
        try { return responde(res, 200, await chat.voltarArquivos(String(corpo.sessao), detalhe.cwd, corpo.uuid, !!corpo.simular, envV || undefined)); }
        catch (e) { return responde(res, 500, { erro: e.message }); }
    }

    if (url.pathname === '/api/agentes') {
        try { acaoAgente(corpo); }
        catch (e) { return responde(res, e.status || 500, { erro: e.status ? e.message : 'Não deu para mudar o agente: ' + e.message }); }
        return responde(res, 200, regrasEAgentes(corpo.cwd && pastaConhecida(corpo.cwd) ? corpo.cwd : null));
    }
    if (url.pathname === '/api/pastas') {
        const dados = leDados();
        const lista = Array.isArray(dados.pastasExtras) ? dados.pastasExtras : [];
        const pasta = path.resolve(String(corpo.pasta || '').trim().replace(/^"|"$/g, '') || '.');
        if (corpo.acao === 'remover') {
            dados.pastasExtras = lista.filter(p => p.toLowerCase() !== pasta.toLowerCase());
            gravaDados(dados);
            return responde(res, 200, { ok: true, pastasExtras: dados.pastasExtras });
        }
        if (corpo.acao !== 'adicionar' || !String(corpo.pasta || '').trim()) return responde(res, 400, { erro: 'Pedido inválido.' });
        let st;
        try { st = fs.statSync(pasta); } catch (e) { return responde(res, 400, { erro: 'Pasta não encontrada.' }); }
        if (!st.isDirectory()) return responde(res, 400, { erro: 'Isso não é uma pasta.' });
        if (chat.ehChat(pasta)) return responde(res, 400, { erro: 'A pasta das conversas de Chat não entra na lista.' });
        if (!lista.some(p => p.toLowerCase() === pasta.toLowerCase())) lista.push(pasta);
        dados.pastasExtras = lista;
        gravaDados(dados);
        return responde(res, 200, { ok: true, pastasExtras: lista });
    }
    if (url.pathname === '/api/navegador') {
        if (!['padrao', 'edge', 'chrome', 'firefox'].includes(corpo.navegador)) return responde(res, 400, { erro: 'Navegador inválido.' });
        const dados = leDados();
        dados.navegador = corpo.navegador;
        gravaDados(dados);
        return responde(res, 200, { ok: true });
    }
    if (url.pathname === '/api/economia') {
        try { gravaEconomia(!!corpo.ligada); return responde(res, 200, { ok: true, economia: leEconomia() }); }
        catch (e) { return responde(res, 500, { erro: 'Não deu para gravar o settings.json: ' + e.message }); }
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
        // Conversa Chat nova: o servidor escolhe a pasta; numa sessão existente vale só o cwd do transcript
        if (!corpo.sessao && corpo.tipo === 'chat') { fs.mkdirSync(chat.CHAT_DIR, { recursive: true }); cwd = chat.CHAT_DIR; }
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
        // Conta/identidade: conversa existente usa a escolha dela; nova usa o que veio da tela (ids conferidos)
        let entrada = null;
        if (corpo.sessao) entrada = entradaDaConversa(corpo.projeto, corpo.sessao);
        else if (corpo.claude || corpo.git) {
            const dadosPerfis = perfis.le();
            const perfilUso = [{ id: 'padrao', claude: dadosPerfis.padraoClaude, git: dadosPerfis.padraoGit }, ...(dadosPerfis.perfis || [])].find(p => p.id === perfis.perfilEmUso()) || {};
            const claudeNova = String(corpo.claude || perfilUso.claude || 'padrao'), gitNova = String(corpo.git || perfilUso.git || 'padrao');
            if (!perfis.ID.test(claudeNova) || !perfis.existeConta(claudeNova)) return responde(res, 400, { erro: 'Conta do Claude inválida.' });
            if (!perfis.ID.test(gitNova) || !perfis.existeIdentidade(gitNova)) return responde(res, 400, { erro: 'Identidade do Git inválida.' });
            entrada = { claude: claudeNova, git: gitNova };
        }
        let envConversa = null;
        try { envConversa = entrada ? perfis.envDaConversa(entrada) : null; } catch (e) { return responde(res, 409, { erro: e.message }); }
        // Sempre existe: grava o vínculo (continuação) e a conta/identidade escolhidas, quando a sessão nasce
        const aoCriarSessao = (origem || (entrada && !corpo.sessao)) ? (projeto, sessionId) => {
            const dados = leDados();
            if (origem) dados.vinculos[`${projeto}/${sessionId}`] = origem;
            if (entrada && !corpo.sessao) { dados.porConversa = dados.porConversa || {}; dados.porConversa[chaveConversa(projeto, sessionId)] = { ...entrada, projeto, sessao: sessionId }; }
            gravaDados(dados);
        } : null;
        // Chat não tem como ler arquivos: só imagens
        if (chat.ehChat(cwd) && (Array.isArray(corpo.anexos) ? corpo.anexos : []).some(a => !/^image\/(png|jpeg|gif|webp)$/.test(a.tipo))) {
            return responde(res, 400, { erro: 'Na conversa de Chat só dá para anexar imagens. Cole o texto do arquivo na mensagem ou use o modo Código.' });
        }
        const { imagens: imagensAnexas, textoExtra } = preparaAnexos(corpo.anexos);
        const conversa = await chat.enviar({
            cwd, sessao: corpo.sessao, texto: texto + textoExtra, modelo: corpo.modelo, esforco: corpo.esforco,
            modo: corpo.modo, imagens: imagensAnexas, aoCriarSessao, env: envConversa, assinatura: assinaturaDe(entrada),
        });
        return responde(res, 200, { chave: conversa.chave, projeto: conversa.projeto });
    }
    if (url.pathname === '/api/conversa/conta') {
        if (!corpo.projeto || !corpo.sessao || /[\\/]|\.\./.test(String(corpo.projeto) + String(corpo.sessao))) return responde(res, 400, { erro: 'sessão inválida' });
        const achadoC = arquivoDaSessao(String(corpo.projeto), String(corpo.sessao));
        if (!achadoC) return responde(res, 404, { erro: 'Conversa não encontrada.' });
        const git = String(corpo.git || '');
        if (!perfis.ID.test(git) || !perfis.existeIdentidade(git)) return responde(res, 400, { erro: 'Identidade do Git inválida.' });
        const dados = leDados();
        dados.porConversa = dados.porConversa || {};
        const k = chaveConversa(corpo.projeto, corpo.sessao);
        // A conta do Claude fica a de onde o transcript está (fixa); grava as duas em valor absoluto
        const atual = dados.porConversa[k] || {};
        // Conta = a pasta onde o transcript está (procura a conta cuja projects/ é essa raiz)
        const contaAtual = atual.claude || ['padrao', ...perfis.le().contasClaude.map(c => c.id)].find(id => resolveMin(perfis.raizDaConta(id)) === resolveMin(achadoC.raiz)) || 'padrao';
        dados.porConversa[k] = { claude: contaAtual, git, projeto: String(corpo.projeto), sessao: String(corpo.sessao) };
        gravaDados(dados);
        const viva = chat.vivaNaSessao(String(corpo.sessao));
        return responde(res, 200, { ok: true, aplicaDepois: !!(viva && (viva.status === 'rodando' || viva.status === 'parando' || (viva.tarefasBg || []).length)) });
    }
    if (url.pathname === '/api/perfis') {
        try {
            if (corpo.acao === 'ativar') {
                if (!process.env.PAINEL_LANCADOR) return responde(res, 409, { erro: 'Trocar de perfil precisa do Red Code aberto pelo app (ou pelo lançador).' });
                const id = String(corpo.id || '');
                if (!perfis.ID.test(id)) throw Object.assign(new Error('Perfil inválido.'), { status: 400 });
                if (!perfis.existePerfil(id)) throw Object.assign(new Error('Perfil não encontrado.'), { status: 400 });
                if (id === perfis.perfilEmUso()) { cancelaTrocaPerfil(); return responde(res, 200, { ok: true, pendente: null }); }
                perfilPendente = id;
                if (!reinicioAgendado) { agendouPorPerfil = true; agendaReinicio(); }
                return responde(res, 200, { ok: true, pendente: perfilPendente });
            }
            if (corpo.acao === 'cancelar') { cancelaTrocaPerfil(); return responde(res, 200, { ok: true }); }
            if (corpo.acao === 'apagar-conta' || corpo.acao === 'apagar-identidade') {
                const parte = corpo.acao === 'apagar-conta' ? 'claude' : 'git';
                const dados = leDados();
                const pc = dados.porConversa || {};
                let mudou = false;
                const usando = [];
                for (const [k, e] of Object.entries(pc)) {
                    if (!e || e[parte] !== corpo.id) continue;
                    // Entrada órfã (conversa apagada): limpa
                    if (!arquivoDaSessao(e.projeto, e.sessao)) { delete pc[k]; mudou = true; continue; }
                    usando.push(k);
                }
                if (usando.length && corpo.liberar === true) {
                    for (const k of usando) { const e = { ...pc[k] }; delete e[parte]; if (e.claude || e.git) pc[k] = e; else delete pc[k]; }
                    mudou = true; usando.length = 0;
                }
                if (mudou) { dados.porConversa = pc; gravaDados(dados); }
                if (usando.length) return responde(res, 409, { erro: `${usando.length === 1 ? '1 conversa usa' : usando.length + ' conversas usam'} isto.`, usos: usando.length, parte });
            }
            const r = await perfis.acao(corpo, perfilPendente);
            return responde(res, 200, { ok: true, ...r });
        } catch (e) { return responde(res, e.status || 500, { erro: e.status ? e.message : 'Não deu para mudar os perfis: ' + e.message }); }
    }
    if (url.pathname === '/api/reiniciar') {
        // Só funciona com o lançador (lancador.js), que sobe o servidor de novo quando ele sai
        // com o código 75. O servidor espera nada estar vivo; conversas paradas e sem agente
        // são fechadas, como no script seguro.
        if (!process.env.PAINEL_LANCADOR) return responde(res, 409, { erro: 'O painel não foi aberto pelo lançador. Rode o script de reinício uma vez.' });
        // Já agendado pela troca de perfil: passa a ser também um reinício de código (cancelar a troca não o desfaz)
        agendouPorPerfil = false;
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
    // Login: o servidor só aciona o fluxo oficial do Claude Code (abre o navegador); nunca recebe senha nem token
    if (url.pathname === '/api/auth/entrar') {
        try { return responde(res, 200, await login.entrar(corpo.tipo)); } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
    }
    if (url.pathname === '/api/auth/codigo') {
        try { return responde(res, 200, await login.codigo(corpo.codigo)); } catch (e) { return responde(res, e.status || 500, { erro: e.message }); }
    }
    // Plugins: instalar, atualizar, desinstalar e marketplaces, sempre pelo executável oficial e com a confirmação da tela
    if (url.pathname === '/api/plugins/acao') {
        try {
            const alvo = corpo.alvo;
            const r = corpo.acao === 'instalar' ? await plugins.instalar(alvo, corpo.aceitarComando)
                : corpo.acao === 'atualizar' ? await plugins.atualizar(alvo, corpo.aceitarComando)
                : corpo.acao === 'desinstalar' ? await plugins.desinstalar(alvo)
                : corpo.acao === 'mercado-adicionar' ? await plugins.mercadoAdicionar(alvo)
                : corpo.acao === 'mercado-remover' ? await plugins.mercadoRemover(alvo) : null;
            if (!r) return responde(res, 400, { erro: 'ação inválida' });
            return responde(res, 200, r);
        } catch (e) { return responde(res, e.status || 500, { erro: e.status ? e.message : 'Não foi possível concluir.' }); }
    }
    if (url.pathname === '/api/auth/cancelar') return responde(res, 200, { cancelado: login.cancelar() });
    if (url.pathname === '/api/chat/parar-tarefa') {
        return (await chat.pararTarefa(corpo.chave, corpo.id)) ? responde(res, 200, { ok: true }) : responde(res, 404, { erro: 'Esta tarefa já terminou.' });
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
    '/vendor/popper.js': ['@popperjs/core/dist/umd/popper.min.js', 'text/javascript; charset=utf-8'],
    '/vendor/tippy.js': ['tippy.js/dist/tippy-bundle.umd.min.js', 'text/javascript; charset=utf-8'],
    // Visualização de Markdown do Editor: os mesmos pacotes que o Monaco já usa (DOMPurify na versão corrigida do overrides)
    '/vendor/marked.js': ['marked/lib/marked.umd.js', 'text/javascript; charset=utf-8'],
    '/vendor/purify.js': ['dompurify/dist/purify.js', 'text/javascript; charset=utf-8'],
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
            // Pode ser embutido só pela própria origem (o editor dentro da janela principal).
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
            });
            return res.end(html);
        }
        if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(path.join(__dirname, 'favicon.svg')));
        }
        // Formatador invisível (iframe da página principal): formata como o Alt+Shift+F do VS Code.
        // Mesma CSP do editor (o Monaco traz um DOMPurify vulnerável), mas pode ser embutido pela própria origem.
        if (url.pathname === '/formatador.html') {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
            });
            return res.end(fs.readFileSync(path.join(__dirname, 'formatador.html')));
        }
        if (url.pathname === '/formatador.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(path.join(__dirname, 'formatador.js')));
        }
        if (url.pathname === '/editor-md.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(fs.readFileSync(path.join(__dirname, 'editor-md.js')));
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
        // Ícone de arquivo (imagem estática da extensão; o <img> não manda o cabeçalho do painel)
        // Imagem citada num .md (visualização do Editor): só imagem, só dentro de pasta conhecida, só com o token da página
        if (req.method === 'GET' && url.pathname === '/api/editor/imagem') {
            const TIPOS_IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
            const cwdImg = url.searchParams.get('cwd') || '';
            if (url.searchParams.get('t') !== TOKEN || !pastaConhecida(cwdImg)) { res.writeHead(403); return res.end(); }
            const raizImg = path.resolve(cwdImg);
            const abs = path.resolve(raizImg, url.searchParams.get('caminho') || '');
            const tipo = TIPOS_IMG[path.extname(abs).toLowerCase()];
            if (!tipo || !abs.toLowerCase().startsWith(raizImg.toLowerCase() + path.sep)) { res.writeHead(404); return res.end(); }
            let st;
            try { st = fs.statSync(abs); } catch (e) { res.writeHead(404); return res.end(); }
            if (!st.isFile() || st.size > 10 * 1024 * 1024) { res.writeHead(404); return res.end(); }
            // SVG não roda script nem carrega nada de fora
            res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
            return fs.createReadStream(abs).pipe(res);
        }
        if (req.method === 'GET' && url.pathname === '/icone-arquivo') {
            const arq = iconeDoArquivo(url.searchParams.get('nome'), url.searchParams.get('tema'), url.searchParams.get('pasta') === '1', url.searchParams.get('aberta') === '1');
            if (!arq || !fs.existsSync(arq)) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(arq));
        }
        if (url.pathname.startsWith('/api/chat/') || url.pathname === '/api/auth/entrar' || url.pathname === '/api/auth/cancelar' || url.pathname === '/api/auth/codigo' || url.pathname === '/api/plugins/acao' || url.pathname.startsWith('/api/git/') || ['/api/projetos', '/api/dados', '/api/favorito', '/api/renomear', '/api/arquivar', '/api/versao', '/api/reiniciar', '/api/diff', '/api/mcp', '/api/mcp/acao', '/api/plugins', '/api/editor/arvore', '/api/editor/arquivo', '/api/editor/salvar', '/api/editor/diagnosticos', '/api/por-comando', '/api/por-comando/vivo', '/api/worktree/repo', '/api/worktrees', '/api/resolver-arquivo', '/api/worktree/criar', '/api/worktree/remover', '/api/busca', '/api/resumo-dia', '/api/modelos-pedido', '/api/github', '/api/hooks', '/api/trello', '/api/automacao', '/api/agendamentos', '/api/agendamentos/rodar', '/api/fila', '/api/pastas', '/api/navegador', '/api/agentes', '/api/perfis', '/api/conversa/conta', '/api/economia'].includes(url.pathname)) return await rotaChat(req, res, url);
        if (url.pathname === '/api/auth/estado') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            return responde(res, 200, await login.estado());
        }
        if (url.pathname === '/api/plugins/estado') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            return responde(res, 200, await plugins.estado());
        }
        if (url.pathname === '/api/sessoes') return responde(res, 200, listaSessoes());
        if (url.pathname === '/api/tasks') {
            const tasks = listaTasks();
            if (url.searchParams.get('desde') === tasks.hash) { res.writeHead(304); return res.end(); }
            return responde(res, 200, tasks);
        }
        // Player do rodapé: o que está tocando no Windows, a capa e os botões (tocar/pausar, próxima)
        if (url.pathname === '/api/midia/capa' && req.method === 'GET') {
            const capa = midia.capaAtual();
            if (url.searchParams.get('t') !== TOKEN || !capa) { res.writeHead(capa ? 403 : 404); return res.end(); }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
            return res.end(capa);
        }
        // Vídeo no canto: a extensão do navegador manda o estado (só ela: cabeçalho próprio e origem de extensão,
        // que página de site não consegue mandar sem a pré-checagem que este servidor não aprova)
        if (url.pathname === '/api/midia/video' && req.method === 'POST') {
            const origem = String(req.headers.origin || '');
            if (req.headers['x-redcode-extensao'] !== '1' || (origem && !/^chrome-extension:\/\/[a-p]{32}$/.test(origem))) return responde(res, 403, { erro: 'só a extensão do Red Code' });
            try { videoNavegador.recebe({ ...(await leCorpo(req, 1e4)), fonte: 'extensao' }); return responde(res, 200, { ok: true }); }
            catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        // Instalar a extensão (a pessoa aceitou em Integrações): atalhos do navegador com --load-extension e reinicia ele
        if (url.pathname === '/api/midia/extensao' && req.method === 'POST') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            try {
                const corpo = await leCorpo(req, 1e4);
                return responde(res, 200, await videoNavegador.instalaExtensao(String(corpo.navegador || ''), PASTA_EXTENSAO, PASTA_DADOS, !!corpo.reiniciar));
            } catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        // Vídeo no canto: a extensão (se houver), a aba do YouTube selecionada em algum navegador (video-nativo) ou um player externo ligado
        if (url.pathname === '/api/midia/video' && req.method === 'GET') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            if (!videoNavegador.extensaoAtiva()) videoNativo.usado();
            return responde(res, 200, { ...videoNavegador.atual(), ytdlp: !!videoNavegador.caminhoYtdlp(), avisosPlayers: playersExternos.avisos(), pastaExtensao: PASTA_EXTENSAO, navegadores: videoNavegador.navegadores() });
        }
        if (url.pathname === '/api/players-externos') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            if (req.method === 'GET') return responde(res, 200, playersExternos.lista());
            try { const corpo = await leCorpo(req, 1e4); return responde(res, 200, playersExternos.executa(String(corpo.id || ''), String(corpo.acao || ''))); }
            catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        // Opção B: endereço direto só do vídeo (yt-dlp), para vídeo que não deixa incorporar
        if (url.pathname === '/api/midia/video-url' && req.method === 'GET') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            try { return responde(res, 200, { url: await videoNavegador.urlDoVideo(url.searchParams.get('id')) }); }
            catch (e) { return responde(res, e.codigo === 'sem-ytdlp' ? 404 : 502, { erro: e.message, codigo: e.codigo || 'falhou' }); }
        }
        if (url.pathname === '/api/midia/ytdlp' && req.method === 'POST') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            try { return responde(res, 200, { ok: true, caminho: await videoNavegador.instalaYtdlp() }); }
            catch (e) { return responde(res, 502, { erro: e.message }); }
        }
        if (url.pathname === '/clipe.html' || url.pathname === '/clipe.js' || url.pathname === '/tasks.js') {
            res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(fs.readFileSync(path.join(__dirname, url.pathname.slice(1))));
        }
        // Mascotes dos agentes: o visual de cada um (Configurações › Regras e agentes › Personalizar)
        if (url.pathname === '/api/visual-pets') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            if (req.method === 'GET') return responde(res, 200, leDados().visualPets || {});
            try {
                const corpo = await leCorpo(req, 1e4);
                const nome = String(corpo.nome || '').toLowerCase();
                if (!/^[a-z0-9:_-]{1,64}$/.test(nome)) return responde(res, 400, { erro: 'Mascote inválido.' });
                const dados = leDados();
                dados.visualPets = dados.visualPets || {};
                if (!corpo.visual) delete dados.visualPets[nome];
                else {
                    // Só partes conhecidas, com valores curtos e cor em hexadecimal
                    const v = {};
                    for (const k of ['forma', 'olhos', 'boca', 'chapeu', 'cara', 'bochechas', 'item', 'jeito']) {
                        const val = String(corpo.visual[k] == null ? '' : corpo.visual[k]);
                        if (!/^[a-z]{0,20}$/.test(val)) return responde(res, 400, { erro: 'Visual inválido.' });
                        v[k] = val;
                    }
                    const cor = String(corpo.visual.cor || '');
                    if (!/^#[0-9a-f]{6}$/i.test(cor)) return responde(res, 400, { erro: 'Cor inválida.' });
                    v.cor = cor.toLowerCase();
                    dados.visualPets[nome] = v;
                }
                gravaDados(dados);
                return responde(res, 200, dados.visualPets);
            } catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        if (url.pathname.startsWith('/api/extensoes/')) return await rotaExtensoes(req, res, url);
        // Credenciais já usadas nas conversas (a caixa de digitar de uma extensão pede a chave ou o token do Trello):
        // a lista vai mascarada; o valor inteiro só pelo id, quando a pessoa clica
        if (url.pathname === '/api/credenciais-conversas' || url.pathname === '/api/credenciais-conversas/valor') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            try {
                if (url.pathname === '/api/credenciais-conversas/valor') {
                    if (req.method !== 'POST') return responde(res, 405, { erro: 'método não permitido' });
                    const v = credenciaisConversas.valor((await leCorpo(req, 1e3)).id);
                    return v ? responde(res, 200, { valor: v }) : responde(res, 404, { erro: 'Não achei mais essa credencial: procure de novo.' });
                }
                const tipo = credenciaisConversas.tipoDoPedido(url.searchParams.get('titulo'), url.searchParams.get('prompt'));
                if (!tipo) return responde(res, 200, { tipo: null, itens: [] });
                const titulos = new Map(listaSessoes().map(s => [s.id, s.titulo]));
                const raizes = [RAIZ_PROJETOS, ...raizesExtras().map(r => r.raiz)];
                return responde(res, 200, { tipo, itens: credenciaisConversas.procura(tipo, raizes, (id) => titulos.get(id)) });
            } catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        if (url.pathname === '/api/novidades' && req.method === 'GET') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            let versoes = [], versaoApp = '';
            try { delete require.cache[require.resolve('./novidades')]; versoes = require('./novidades'); } catch (e) { /* sem arquivo */ }
            try { versaoApp = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || ''; } catch (e) { /* sem package.json */ }
            return responde(res, 200, { versaoApp, versoes });
        }
        if (url.pathname === '/api/midia') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            // Com ?versao=: segura a resposta até o estado mudar (play/pausa de fora aparece na hora, sem esperar a próxima pergunta)
            if (req.method === 'GET') {
                const estado = url.searchParams.has('versao') ? await midia.espera(url.searchParams.get('versao'), 20000) : midia.le();
                // Navegador tocando: liga o leitor antes de abrir o vídeo, para o vídeo e o yt-dlp já estarem prontos
                if (videoNativo.ehNavegador(estado.app) && !videoNavegador.extensaoAtiva()) videoNativo.usado();
                return responde(res, 200, estado);
            }
            try { const corpo = await leCorpo(req, 1e4); midia.comando(String(corpo.acao || '')); return responde(res, 200, { ok: true }); }
            catch (e) { return responde(res, 400, { erro: e.message }); }
        }
        // Modelos que a conta pode usar (lista do Claude Code, atualiza quando a Anthropic lança um modelo).
        // principal = a versão mais nova de cada família (Opus, Fable, Sonnet, Haiku); o resto é "versões anteriores"
        if (url.pathname === '/api/modelos-claude') {
            if (!requisicaoConfiavel(req)) return responde(res, 403, { erro: 'pedido recusado: origem não é o painel' });
            const vencido = !cacheModelos.dados || Date.now() - cacheModelos.em > 6 * 3600e3 || (url.searchParams.has('atualizar') && Date.now() - cacheModelos.em > 60000);
            if (vencido) {
                if (!cacheModelos.pedido) cacheModelos.pedido = chat.modelosDisponiveis().then((lista) => { cacheModelos.dados = organizaModelos(lista); cacheModelos.em = Date.now(); })
                    .catch((e) => { if (!cacheModelos.dados) cacheModelos.dados = { erro: e.message, modelos: [] }; cacheModelos.em = Date.now() - 6 * 3600e3 + 120000; })
                    .finally(() => { cacheModelos.pedido = null; });
                await cacheModelos.pedido;
            }
            return responde(res, 200, cacheModelos.dados);
        }
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
        if (url.pathname === '/api/regras') {
            const cwd = url.searchParams.get('cwd');
            return responde(res, 200, regrasEAgentes(pastaConhecida(cwd) ? cwd : null));
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
        // Erro depois de a resposta já ter começado: não dá para mandar um 500 (derrubaria o servidor); só encerra e registra
        if (res.headersSent) { console.log(`Erro depois de responder ${req.method} ${req.url}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); return res.end(); }
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
terminal.liga(servidor, { porta: PORTA, token: TOKEN, pastaPermitida: pastaDoTerminal, envDaConversa: (chave) => { const [pj, ss] = chave.split('/'); return entradaDaConversa(pj, ss) ? envDeConversa(pj, ss) : null; } });

// Só aceita conexão da própria máquina
servidor.listen(PORTA, '127.0.0.1', () => {
    console.log(`Painel Claude em http://localhost:${PORTA}  (lendo ${RAIZ_PROJETOS})`);
});
