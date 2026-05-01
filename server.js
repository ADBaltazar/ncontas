// server.js - VERSÃO CORRIGIDA PARA VERCEL COM EJS
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const moment = require('moment');
const cors = require('cors');
const multer = require('multer');

// Configuração do Multer para upload em memória
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado'));
        }
    }
});

const app = express();

// Middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(cors());

// Configuração de sessão para Vercel
app.use(session({
    secret: process.env.SESSION_SECRET || 'sistema-gestao-secret-vercel',
    resave: false,
    saveUninitialized: false, // MUDADO: false para evitar sessões vazias
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Configuração do EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Configuração do MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ ERRO: Variável de ambiente MONGODB_URI não configurada!');
}

// Cache da conexão
let cachedDb = null;
let modelsInitialized = false;
let Solicitacao, Usuario, Atendimento;
let adminCreationInProgress = false; // Prevenir criação múltipla

// Função para conectar ao MongoDB
async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        return cachedDb;
    }
    
    if (!MONGODB_URI) {
        throw new Error('MONGODB_URI não configurada');
    }
    
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        cachedDb = mongoose.connection;
        
        if (!modelsInitialized) {
            initializeModels();
            modelsInitialized = true;
        }
        
        return cachedDb;
    } catch (error) {
        console.error('❌ Erro ao conectar MongoDB:', error);
        throw error;
    }
}

// Inicialização dos modelos
function initializeModels() {
    const solicitacaoSchema = new mongoose.Schema({
        codigo: { type: String, unique: true, sparse: true },
        cliente_nome: { type: String, required: true },
        cliente_email: { type: String, required: true, match: [/^\S+@\S+\.\S+$/, 'Email inválido'] },
        cliente_telefone: { type: String },
        titulo: { type: String, required: true },
        descricao: { type: String, required: true },
        tipo: { type: String, enum: ['reclamacao', 'sugestao', 'elogio', 'duvida'], required: true },
        categoria: { type: String, enum: ['faturacao', 'servico', 'tecnico', 'outro'] },
        prioridade: { type: String, enum: ['baixa', 'media', 'alta', 'urgente'], default: 'media' },
        status: { type: String, enum: ['pendente', 'em_analise', 'em_andamento', 'resolvido', 'cancelado'], default: 'pendente' },
        usuario_responsavel: { type: String },
        data_abertura: { type: Date, default: Date.now },
        data_limite: { type: Date },
        data_conclusao: { type: Date },
        avaliacao_cliente: { type: Number, min: 1, max: 5 },
        feedback_cliente: { type: String },
        anexos: { type: [mongoose.Schema.Types.Mixed], default: [] },
        historico: { type: [mongoose.Schema.Types.Mixed], default: [] },
        tags: mongoose.Schema.Types.Mixed
    }, { collection: 'solicitacoes', timestamps: true });

    solicitacaoSchema.pre('save', async function(next) {
        if (!this.codigo) {
            const ano = moment().format('YYYY');
            const random = Math.floor(1000 + Math.random() * 9000);
            this.codigo = `SOL-${ano}-${random}`;
            
            const existing = await this.constructor.findOne({ codigo: this.codigo });
            if (existing) {
                const newRandom = Math.floor(1000 + Math.random() * 9000);
                this.codigo = `SOL-${ano}-${newRandom}`;
            }
        }
        next();
    });

    const usuarioSchema = new mongoose.Schema({
        nome: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        senha: { type: String, required: true },
        tipo: { type: String, enum: ['admin', 'gerente', 'atendente', 'tecnico'], default: 'atendente' },
        ativo: { type: Boolean, default: true }
    }, { collection: 'usuarios', timestamps: true });

    const atendimentoSchema = new mongoose.Schema({
        Cliente: { type: String, required: true },
        Reposnavel: { type: String, required: true },
        DataAtendimento: { type: Date, default: Date.now },
        Hora: { type: String, default: () => moment().format('HH:mm:ss') },
        Observacao: { type: String }
    }, { collection: 'atendimento', timestamps: true });

    Solicitacao = mongoose.model('Solicitacao', solicitacaoSchema);
    Usuario = mongoose.model('Usuario', usuarioSchema);
    Atendimento = mongoose.model('Atendimento', atendimentoSchema);
}

// Middleware de autenticação
const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) {
        next();
    } else {
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            res.status(401).json({ error: 'Não autorizado', redirect: '/login' });
        } else {
            res.redirect('/login');
        }
    }
};

app.get('/painel',(req,res)=>{

    res.render("dashboard")
})

// ==================== ROTAS DE AUTENTICAÇÃO ====================
app.get('/login', async (req, res) => {
    try {
        await connectToDatabase();
        res.render('login', { error: null });
    } catch (error) {
        res.render('login', { error: 'Erro ao conectar ao banco de dados' });
    }
});

app.post('/login', async (req, res) => {
    const { email, senha } = req.body;
    
    try {
        await connectToDatabase();
        
        const usuario = await Usuario.findOne({ email });
        
        if (usuario && bcrypt.compareSync(senha, usuario.senha)) {
            // Salvar usuário na sessão
            req.session.user = {
                id: usuario._id.toString(),
                nome: usuario.nome,
                email: usuario.email,
                tipo: usuario.tipo
            };
            
            // Salvar sessão explicitamente
            req.session.save((err) => {
                if (err) {
                    console.error('Erro ao salvar sessão:', err);
                    return res.status(500).json({ tipo: "Falha", error: "Erro na sessão" });
                }
                
                // SEMPRE retornar JSON para requisições AJAX
                if (req.xhr || req.headers['content-type'] === 'application/json') {
                    return res.json({ 
                        tipo: "sucesso", 
                        redirect: '/dashboard',
                        user: req.session.user
                    });
                }
                
                // Para requisições normais de formulário
                return res.redirect('/dashboard');
            });
        } else {
            if (req.xhr || req.headers['content-type'] === 'application/json') {
                return res.status(401).json({ tipo: "Falha", error: "Email ou senha inválidos" });
            }
            res.render('login', { error: 'Email ou senha inválidos' });
        }
    } catch (error) {
        console.error('Erro no login:', error);
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.status(500).json({ tipo: "Falha", error: "Erro interno" });
        }
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/login');
    });
});

// ==================== ROTAS PRINCIPAIS ====================
app.get('/', async (req, res) => {
    if (req.session && req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        const totalSolicitacoes = await Solicitacao.countDocuments();
        const pendentes = await Solicitacao.countDocuments({ status: 'pendente' });
        const emAndamento = await Solicitacao.countDocuments({ status: 'em_andamento' });
        const resolvidas = await Solicitacao.countDocuments({ status: 'resolvido' });

        const solicitacoesRecentes = await Solicitacao.find()
            .sort({ createdAt: -1 })
            .limit(5);

        res.render('dashboard', {
            user: req.session.user,
            stats: {
                total: totalSolicitacoes,
                pendentes,
                emAndamento,
                resolvidas
            },
            solicitacoesRecentes
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar dashboard' });
    }
});

// ==================== ROTAS DE SOLICITAÇÕES ====================
app.get('/solicitacoes', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        const { status, tipo, prioridade, page = 1 } = req.query;
        const limit = 10;
        const offset = (page - 1) * limit;

        let filter = {};
        if (status && status !== 'todos') filter.status = status;
        if (tipo && tipo !== 'todos') filter.tipo = tipo;
        if (prioridade && prioridade !== 'todos') filter.prioridade = prioridade;

        const totalCount = await Solicitacao.countDocuments(filter);
        const solicitacoes = await Solicitacao.find(filter)
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit);

        const totalPages = Math.ceil(totalCount / limit);

        res.render('solicitacoes', {
            user: req.session.user,
            solicitacoes,
            currentPage: parseInt(page),
            totalPages,
            filters: { status, tipo, prioridade },
            totalCount
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar solicitações' });
    }
});

app.get('/solicitacoes/nova', requireAuth, (req, res) => {
    res.render('nova-solicitacao', { 
        user: req.session.user,
        error: null 
    });
});

app.post('/solicitacoes/nova', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        const {
            cliente_nome,
            cliente_email,
            cliente_telefone,
            titulo,
            descricao,
            categoria
        } = req.body;

        // Validações
        if (!cliente_nome || !cliente_email || !titulo || !descricao) {
            return res.status(400).json({ 
                success: false, 
                error: 'Todos os campos obrigatórios devem ser preenchidos' 
            });
        }

        const tipo = 'reclamacao';

        const novaSolicitacao = new Solicitacao({ 
            cliente_nome,
            cliente_email,
            cliente_telefone: cliente_telefone || '',
            titulo,
            descricao,
            tipo: tipo,
            categoria: categoria || 'outro'
        });

        novaSolicitacao.historico.push({
            data: new Date(),
            autor: req.session.user?.nome || 'Sistema',
            mensagem: 'Solicitação criada'
        });
        
        await novaSolicitacao.save();

        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.json({ 
                success: true, 
                message: 'Solicitação criada com sucesso!',
                id: novaSolicitacao._id,
                codigo: novaSolicitacao.codigo
            });
        }
        
        res.redirect('/solicitacoes');

    } catch (error) {
        console.error(error);
        
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            return res.status(500).json({ 
                success: false, 
                error: 'Erro ao criar solicitação: ' + error.message 
            });
        }
        
        res.render('nova-solicitacao', { 
            user: req.session.user,
            error: 'Erro ao criar solicitação: ' + error.message 
        });
    }
});

app.get('/solicitacoes/:id', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).render('error', { error: 'Solicitação não encontrada' });
        }

        res.render('detalhes-solicitacao', {
            user: req.session.user,
            solicitacao: solicitacao.toObject()
        });
    } catch (error) {
        console.error(error);
        res.status(500).render('error', { error: 'Erro ao carregar solicitação' });
    }
});

// Outras rotas (status, responsavel, agendamento, etc.) - manter iguais
app.put('/solicitacoes/:id/status', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { status } = req.body;
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        const statusAnterior = solicitacao.status;
        solicitacao.status = status;
        solicitacao.data_conclusao = status === 'resolvido' ? new Date() : null;
        
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Status alterado de ${statusAnterior} para ${status}`
        });
        
        await solicitacao.save();
        res.json({ success: true, solicitacao });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar status' });
    }
});

app.post('/solicitacoes/:id/responsavel', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { responsavel } = req.body;
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        const responsavelAnterior = solicitacao.usuario_responsavel;
        solicitacao.usuario_responsavel = responsavel;
        
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Responsável alterado de ${responsavelAnterior || 'ninguém'} para ${responsavel}`
        });
        
        await solicitacao.save();
        res.json({ success: true, solicitacao });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar responsável' });
    }
});

app.post('/solicitacoes/agendamento', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { responsavel } = req.body;
        const id = responsavel.Cliente;
        const solicitacao = await Solicitacao.findById(id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        await Atendimento.create({
            Cliente: responsavel.Cliente,
            Reposnavel: responsavel.Responsavel, 
            DataAtendimento: responsavel.data,
            Hora: responsavel.Hora,
            Observacao: responsavel.Observacao
        });

        res.json({ success: true, solicitacao });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao agendar atendimento' });
    }
});

// ==================== ROTAS PARA DETALHES ====================
app.get('/solicitacoes/:id/historico', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const solicitacao = await Solicitacao.findById(req.params.id);
        res.json(solicitacao.historico || []);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar histórico' });
    }
});

app.get('/solicitacoes/:id/anexos', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const solicitacao = await Solicitacao.findById(req.params.id);
        res.json(solicitacao.anexos || []);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar anexos' });
    }
});

app.post('/solicitacoes/:id/nota', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { nota, autor } = req.body;
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        solicitacao.historico.push({
            data: new Date(),
            autor: autor,
            mensagem: `Nota adicionada: ${nota}`
        });
        
        await solicitacao.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar nota' });
    }
});

app.post('/solicitacoes/:id/anexos', requireAuth, upload.single('anexo'), async (req, res) => {
    try {
        await connectToDatabase();
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }
        
        const anexoItem = {
            nome: req.file.originalname,
            caminho: `anexo_${Date.now()}_${req.file.originalname}`,
            tipo: req.file.mimetype,
            tamanho: req.file.size,
            data: new Date()
        };
        
        solicitacao.anexos.push(anexoItem);
        
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Anexo adicionado: ${req.file.originalname}`
        });
        
        await solicitacao.save();
        res.json({ success: true, anexo: anexoItem });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar anexo' });
    }
});

app.post('/solicitacoes/:id/notificar', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { metodo, mensagem, email, telefone } = req.body;
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Notificação enviada ao cliente via ${metodo}`
        });
        
        await solicitacao.save();
        res.json({ success: true, message: `Notificação enviada com sucesso via ${metodo}` });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar notificação' });
    }
});

app.put('/solicitacoes/:id/editar', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        const { cliente_nome, cliente_email, cliente_telefone, titulo, categoria, prioridade, status, descricao } = req.body;
        const solicitacao = await Solicitacao.findById(req.params.id);
        
        if (!solicitacao) {
            return res.status(404).json({ error: 'Solicitação não encontrada' });
        }

        solicitacao.cliente_nome = cliente_nome;
        solicitacao.cliente_email = cliente_email;
        solicitacao.cliente_telefone = cliente_telefone;
        solicitacao.titulo = titulo;
        solicitacao.categoria = categoria;
        solicitacao.prioridade = prioridade;
        solicitacao.status = status;
        solicitacao.descricao = descricao;
        
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Solicitação atualizada por ${req.session.user.nome}`
        });
        
        await solicitacao.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar solicitação' });
    }
});

app.delete('/solicitacoes/:id/excluir', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        await Solicitacao.deleteOne({ _id: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir solicitação' });
    }
});

// ==================== API ROUTES ====================
app.get('/api/estatisticas', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const solicitacoes = await Solicitacao.find();
        
        const stats = {
            pendente: solicitacoes.filter(s => s.status === 'pendente').length,
            em_andamento: solicitacoes.filter(s => s.status === 'em_andamento').length,
            resolvido: solicitacoes.filter(s => s.status === 'resolvido').length,
            cancelado: solicitacoes.filter(s => s.status === 'cancelado').length,
            baixa: solicitacoes.filter(s => s.prioridade === 'baixa').length,
            media: solicitacoes.filter(s => s.prioridade === 'media').length,
            alta: solicitacoes.filter(s => s.prioridade === 'alta').length,
            urgente: solicitacoes.filter(s => s.prioridade === 'urgente').length,
            faturacao: solicitacoes.filter(s => s.categoria === 'faturacao').length,
            servico: solicitacoes.filter(s => s.categoria === 'servico').length,
            tecnico: solicitacoes.filter(s => s.categoria === 'tecnico').length,
            outro: solicitacoes.filter(s => s.categoria === 'outro').length,
            meses: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
            quantidades: new Array(12).fill(0)
        };
        
        solicitacoes.forEach(s => {
            const mes = new Date(s.data_abertura).getMonth();
            stats.quantidades[mes]++;
        });
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar estatísticas' });
    }
});

app.get('/api/relatorio', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        
        let filter = {};
        if (req.query.inicio) filter.data_abertura = { $gte: new Date(req.query.inicio) };
        if (req.query.fim) filter.data_abertura = { ...filter.data_abertura, $lte: new Date(req.query.fim) };
        if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
        
        const solicitacoes = await Solicitacao.find(filter).sort({ data_abertura: -1 });
        res.json(solicitacoes);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao gerar relatório' });
    }
});

app.get('/api/usuarios', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const usuarios = await Usuario.find().select('-senha');
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários' });
    }
});

app.get('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const usuario = await Usuario.findById(req.params.id).select('-senha');
        res.json(usuario);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuário' });
    }
});

app.post('/api/usuarios', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { nome, email, senha, tipo } = req.body;
        const hashedPassword = bcrypt.hashSync(senha, 10);
        
        const usuario = await Usuario.create({
            nome,
            email,
            senha: hashedPassword,
            tipo,
            ativo: true
        });
        
        res.json({ success: true, usuario: { ...usuario.toObject(), senha: undefined } });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao criar usuário' });
    }
});

app.put('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        const { nome, email, tipo, ativo, senha } = req.body;
        const updateData = { nome, email, tipo, ativo };
        
        if (senha && senha.trim()) {
            updateData.senha = bcrypt.hashSync(senha, 10);
        }
        
        const usuario = await Usuario.findByIdAndUpdate(req.params.id, updateData, { new: true });
        res.json({ success: true, usuario: { ...usuario.toObject(), senha: undefined } });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar usuário' });
    }
});

app.delete('/api/usuarios/:id', requireAuth, async (req, res) => {
    try {
        await connectToDatabase();
        await Usuario.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao excluir usuário' });
    }
});

// ==================== HEALTH CHECK ====================
app.get('/health', async (req, res) => {
    const dbState = mongoose.connection.readyState;
    const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    
    res.json({
        status: 'ok',
        database: states[dbState],
        mongodb_uri_configured: !!process.env.MONGODB_URI,
        timestamp: new Date().toISOString()
    });
});

// ==================== CRIAÇÃO DO ADMIN (APENAS UMA VEZ) ====================
let adminCreated = false;

async function createAdminUser() {
    // Evitar criação múltipla
    if (adminCreated || adminCreationInProgress) {
        return;
    }
    
    adminCreationInProgress = true;
    
    try {
        // Verificar se já existe algum usuário admin
        const adminExists = await Usuario.findOne({ tipo: 'admin' });
        
        if (!adminExists) {
            const hashedPassword = bcrypt.hashSync('admin123', 10);
            await Usuario.create({
                nome: 'Administrador Ncontas',
                email: 'admin@ncontas.com',
                senha: hashedPassword,
                tipo: 'admin',
                ativo: true
            });
            console.log('✅ Usuário admin criado: admin@ncontas.com / admin123');
            adminCreated = true;
        } else {
            console.log('ℹ️ Usuário admin já existe');
            adminCreated = true;
        }
    } catch (error) {
        console.error('Erro ao criar admin:', error);
    } finally {
        adminCreationInProgress = false;
    }
}



// ==================== EXPORTAÇÃO PARA VERCEL ====================
// Adicione este middleware de debug ANTES da exportação
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log('Session user:', req.session?.user?.email || 'none');
    next();
});

module.exports = async (req, res) => {
    try {
        await connectToDatabase();
        
        if (modelsInitialized && !adminCreated) {
            await createAdminUser();
        }
        
        return app(req, res);
    } catch (error) {
        console.error('Erro na função Vercel:', error);
        
        if (!req.xhr && req.headers.accept && req.headers.accept.includes('text/html')) {
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Erro - Ncontas</title><style>body{font-family:Arial;text-align:center;padding:50px}</style></head>
                <body><h1>⚠️ Erro no Servidor</h1><p>${error.message}</p><button onclick="location.reload()">Tentar novamente</button></body>
                </html>
            `);
        } else {
            res.status(500).json({ error: 'Erro interno do servidor', message: error.message });
        }
    }
};
// ==================== EXPORTAÇÃO PARA VERCEL ====================
module.exports = async (req, res) => {
    try {
        // Conectar ao banco de dados
        await connectToDatabase();
        
        // Criar admin apenas uma vez (se necessário)
        if (modelsInitialized && !adminCreated) {
            await createAdminUser();
        }
        
        // Processar a requisição
        return app(req, res);
    } catch (error) {
        console.error('Erro na função Vercel:', error);
        
        if (!req.xhr && req.headers.accept && req.headers.accept.includes('text/html')) {
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Erro - Ncontas</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .error-container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
                        h1 { color: #721c24; }
                        button { background: #0046B8; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="error-container">
                        <h1>⚠️ Erro de Configuração</h1>
                        <p>Configure a variável de ambiente MONGODB_URI no Vercel.</p>
                        <button onclick="location.reload()">Tentar novamente</button>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.status(500).json({ error: 'Erro interno do servidor', message: error.message });
        }
    }
};
