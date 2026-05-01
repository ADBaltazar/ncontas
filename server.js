// server.js - VERSÃO OTIMIZADA PARA VERCEL COM EJS
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const moment = require('moment');
const cors = require('cors');
const multer = require('multer');

// Configuração do Multer para upload em memória (Vercel não tem disco permanente)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
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

// Configuração de sessão (compatible with Vercel)
app.use(session({
    secret: process.env.SESSION_SECRET || 'sistema-gestao-secret-vercel',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
    }
}));

// Configuração do EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Configuração do MongoDB
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ ERRO: Variável de ambiente MONGODB_URI não configurada no Vercel!');
}

// Conexão global com cache
let cachedDb = null;
let Solicitacao, Usuario, Atendimento;

async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        console.log('📦 Usando conexão existente');
        return cachedDb;
    }
    
    console.log('🔌 Conectando ao MongoDB Atlas...');
    
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        
        cachedDb = mongoose.connection;
        console.log('✅ Conectado ao MongoDB Atlas com sucesso!');
        
        // Inicializar schemas após conexão
        await initializeModels();
        
        return cachedDb;
    } catch (error) {
        console.error('❌ Erro ao conectar MongoDB:', error);
        throw error;
    }
}

async function initializeModels() {
    // Schema da Solicitação
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

    // Schema do Usuário
    const usuarioSchema = new mongoose.Schema({
        nome: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        senha: { type: String, required: true },
        tipo: { type: String, enum: ['admin', 'gerente', 'atendente', 'tecnico'], default: 'atendente' },
        ativo: { type: Boolean, default: true }
    }, { collection: 'usuarios', timestamps: true });

    // Schema do Atendimento
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

    // Criar usuário admin padrão se não existir
    try {
        const adminExists = await Usuario.findOne({ email: 'admin@sistema.com' });
        if (!adminExists) {
            const hashedPassword = bcrypt.hashSync('admin123', 10);
            await Usuario.create({
                nome: 'Administrador',
                email: 'admin@sistema.com',
                senha: hashedPassword,
                tipo: 'admin'
            });
            console.log('✅ Usuário admin criado: admin@sistema.com / admin123');
        }
    } catch (error) {
        console.error('Erro ao criar admin:', error);
    }
}

// Middleware de autenticação
const requireAuth = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        if (req.xhr || req.headers['content-type'] === 'application/json') {
            res.status(401).json({ error: 'Não autorizado' });
        } else {
            res.redirect('/login');
        }
    }
};

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
            req.session.user = {
                id: usuario._id,
                nome: usuario.nome,
                email: usuario.email,
                tipo: usuario.tipo
            };
            
            if (req.xhr || req.headers['content-type'] === 'application/json') {
                return res.json({ tipo: "sucesso" });
            }
            return res.redirect('/dashboard');
        } else {
            if (req.xhr || req.headers['content-type'] === 'application/json') {
                return res.json({ tipo: "Falha", error: "Credenciais inválidas" });
            }
            res.render('login', { error: 'Email ou senha inválidos' });
        }
    } catch (error) {
        console.error('Erro no login:', error);
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ==================== ROTAS PRINCIPAIS ====================
app.get('/', async (req, res) => {
    if (req.session.user) {
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

        // Adicionar ao histórico
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
        
        // Adicionar ao histórico
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Status alterado de ${statusAnterior} para ${status}`
        });
        
        await solicitacao.save();

        res.json({ success: true, solicitacao });
    } catch (error) {
        console.error(error);
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
        
        // Adicionar ao histórico
        solicitacao.historico.push({
            data: new Date(),
            autor: req.session.user.nome,
            mensagem: `Responsável alterado de ${responsavelAnterior || 'ninguém'} para ${responsavel}`
        });
        
        await solicitacao.save();
        
        res.json({ success: true, solicitacao });
    } catch (error) {
        console.error(error);
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
        console.error(error);
        res.status(500).json({ error: 'Erro ao agendar atendimento presencial' });
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

app.get('/health', async (req, res) => {
    const dbState = mongoose.connection.readyState;
    const states = {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting'
    };
    
    res.json({
        status: 'ok',
        database: states[dbState],
        timestamp: new Date().toISOString()
    });
});

// ==================== EXPORTAÇÃO PARA VERCEL ====================
// Esta é a parte mais importante - NÃO usar app.listen()
// O Vercel espera uma função exportada

// Middleware para garantir conexão com banco antes de cada requisição
const withDb = (handler) => {
    return async (req, res) => {
        try {
            await connectToDatabase();
            return handler(req, res);
        } catch (error) {
            console.error('Erro de conexão com banco:', error);
            res.status(500).json({ 
                error: 'Erro de conexão com o banco de dados',
                details: error.message 
            });
        }
    };
};

// Aplicar middleware de banco em todas as rotas importantes
const originalRender = app.render.bind(app);
app.render = function(view, options, callback) {
    originalRender(view, options, callback);
};

// Exportar para Vercel (NÃO usar app.listen)
module.exports = async (req, res) => {
    try {
        // Conectar ao banco se necessário
        if (mongoose.connection.readyState !== 1) {
            await connectToDatabase();
        }
        
        // Processar a requisição
        return app(req, res);
    } catch (error) {
        console.error('Erro na função Vercel:', error);
        
        // Tentar renderizar página de erro se for uma requisição HTML
        if (!req.xhr && req.headers.accept && req.headers.accept.includes('text/html')) {
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Erro - Ncontas</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        .error { color: #721c24; background: #f8d7da; padding: 20px; border-radius: 5px; }
                    </style>
                </head>
                <body>
                    <div class="error">
                        <h1>Erro interno do servidor</h1>
                        <p>${error.message}</p>
                        <p>Por favor, tente novamente mais tarde.</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.status(500).json({ 
                error: 'Erro interno do servidor',
                message: error.message 
            });
        }
    }
};