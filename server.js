const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── ПУТИ К ДАННЫМ ─────────────────────────────────────────────────────────────
// На Render используем /opt/render/project/data (persistent disk)
// Локально — папка рядом с сервером
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE     = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

console.log('📁 Data dir:', DATA_DIR);
console.log('📁 Uploads:', UPLOADS_DIR);
console.log('📁 DB:', DB_FILE);

// Отдаём аудио с правильными MIME-типами
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  const mime = {
    '.webm': 'audio/webm; codecs=opus',
    '.ogg':  'audio/ogg',
    '.mp4':  'audio/mp4',
    '.m4a':  'audio/mp4'
  };
  if (mime[ext]) res.setHeader('Content-Type', mime[ext]);
  next();
}, express.static(UPLOADS_DIR));

// ── MULTER ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) ||
      (file.mimetype.includes('ogg') ? '.ogg' :
       file.mimetype.includes('mp4') ? '.mp4' : '.webm');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// ── БД ────────────────────────────────────────────────────────────────────────
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return { users: {}, chats: {}, messages: {} };
    const p = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      users:    p.users    || {},
      chats:    p.chats    || {},
      messages: p.messages || {}
    };
  } catch { return { users: {}, chats: {}, messages: {} }; }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

if (!fs.existsSync(DB_FILE)) saveDb({ users: {}, chats: {}, messages: {} });

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Имя слишком короткое (мин. 3)' });
  if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(username.trim()))
    return res.status(400).json({ error: 'Только буквы, цифры и _' });

  const db = loadDb();
  const u = username.trim();
  if (db.users[u]) return res.status(409).json({ error: 'Пользователь уже существует' });

  db.users[u] = { username: u, password, displayName: displayName?.trim() || u, createdAt: Date.now() };
  saveDb(db);
  res.json({ username: u, displayName: db.users[u].displayName });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const db = loadDb();
  const user = db.users[username];
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.password !== password) return res.status(401).json({ error: 'Неверный пароль' });
  res.json({ username: user.username, displayName: user.displayName });
});

app.get('/api/users/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const db = loadDb();
  res.json(
    Object.values(db.users)
      .filter(u => u.username.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 10)
      .map(u => ({ username: u.username, displayName: u.displayName }))
  );
});

// ── CHATS ─────────────────────────────────────────────────────────────────────
app.get('/api/chats/:username', (req, res) => {
  const db = loadDb();
  const list = Object.values(db.chats)
    .filter(c => c.members.includes(req.params.username))
    .map(c => {
      const msgs = (db.messages[c.id] || []).filter(m => !m.deleted);
      return { ...c, lastMsg: msgs.length ? msgs[msgs.length - 1] : null };
    })
    .sort((a, b) => (b.lastMsg?.ts || b.createdAt) - (a.lastMsg?.ts || a.createdAt));
  res.json(list);
});

app.post('/api/chats', (req, res) => {
  const { id, name, isGroup, members } = req.body;
  if (!members || members.length < 2)
    return res.status(400).json({ error: 'Нужно минимум 2 участника' });

  const db = loadDb();
  if (!isGroup && members.length === 2) {
    const [a, b] = members;
    const ex = Object.values(db.chats).find(c =>
      !c.isGroup && c.members.includes(a) && c.members.includes(b)
    );
    if (ex) return res.json(ex);
  }

  const chat = { id, name: name || null, isGroup: !!isGroup, members, createdAt: Date.now() };
  db.chats[id] = chat;
  db.messages[id] = [];
  saveDb(db);
  res.json(chat);
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:chatId', (req, res) => {
  const db = loadDb();
  res.json(db.messages[req.params.chatId] || []);
});

app.post('/api/messages', (req, res) => {
  const { chatId, sender, text } = req.body;
  if (!chatId || !sender || !text?.trim())
    return res.status(400).json({ error: 'Неверные данные' });

  const db = loadDb();
  if (!db.messages[chatId]) db.messages[chatId] = [];

  const msg = {
    id:         `${Date.now()}${Math.random().toString(36).slice(2)}`,
    chatId, sender, text: text.trim(), type: 'text',
    ts:         Date.now(), deleted: false, deletedFor: []
  };
  db.messages[chatId].push(msg);
  saveDb(db);
  res.json(msg);
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  const { chatId, sender, type } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

  const db = loadDb();
  if (!db.messages[chatId]) db.messages[chatId] = [];

  const msg = {
    id:         `${Date.now()}${Math.random().toString(36).slice(2)}`,
    chatId, sender, type: type || 'image',
    fileUrl:    '/uploads/' + req.file.filename,
    ts:         Date.now(), deleted: false, deletedFor: []
  };
  db.messages[chatId].push(msg);
  saveDb(db);
  res.json(msg);
});

app.delete('/api/messages/:msgId', (req, res) => {
  const { msgId } = req.params;
  const { username, forAll } = req.body;
  const db = loadDb();

  for (const chatId of Object.keys(db.messages)) {
    const idx = db.messages[chatId].findIndex(m => m.id === msgId);
    if (idx === -1) continue;

    const msg = db.messages[chatId][idx];
    if (msg.sender !== username) return res.status(403).json({ error: 'Нет прав' });

    db.messages[chatId][idx] = forAll
      ? { ...msg, deleted: true, text: null, fileUrl: null, deletedAt: Date.now() }
      : { ...msg, deletedFor: [...(msg.deletedFor || []), username] };

    saveDb(db);
    return res.json(db.messages[chatId][idx]);
  }

  res.status(404).json({ error: 'Сообщение не найдено' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✦ БЕЗДНА запущена → http://localhost:${PORT}\n`);
});
