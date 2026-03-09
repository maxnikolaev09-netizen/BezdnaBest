const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── UPLOADS ───────────────────────────────────────────────────────────────────
const fs = require('fs');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use('/uploads', (req, res, next) => {
  const ext  = path.extname(req.path).toLowerCase();
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
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname) ||
      (file.mimetype.includes('ogg') ? '.ogg' :
       file.mimetype.includes('mp4') ? '.mp4' : '.webm');
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } });

// ── MONGODB SCHEMAS ───────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true },
  password:    String,
  displayName: String,
  createdAt:   { type: Number, default: Date.now }
});

const chatSchema = new mongoose.Schema({
  id:        { type: String, unique: true },
  name:      String,
  isGroup:   Boolean,
  members:   [String],
  createdAt: { type: Number, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  id:         { type: String, unique: true },
  chatId:     String,
  sender:     String,
  text:       String,
  type:       { type: String, default: 'text' },
  fileUrl:    String,
  ts:         { type: Number, default: Date.now },
  deleted:    { type: Boolean, default: false },
  deletedFor: [String],
  deletedAt:  Number
});

const User    = mongoose.model('User',    userSchema);
const Chat    = mongoose.model('Chat',    chatSchema);
const Message = mongoose.model('Message', messageSchema);

// ── CONNECT TO MONGODB ────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI не задан! Добавь переменную окружения MONGO_URI');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB подключена'))
  .catch(err => { console.error('MongoDB ошибка:', err); process.exit(1); });

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Имя слишком короткое (мин. 3)' });
  if (!/^[a-zA-Z0-9_а-яА-ЯёЁ]+$/.test(username.trim()))
    return res.status(400).json({ error: 'Только буквы, цифры и _' });

  const u = username.trim();
  if (await User.findOne({ username: u }))
    return res.status(409).json({ error: 'Пользователь уже существует' });

  const user = await User.create({
    username: u, password,
    displayName: displayName?.trim() || u
  });
  res.json({ username: user.username, displayName: user.displayName });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Заполните все поля' });

  const user = await User.findOne({ username });
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.password !== password) return res.status(401).json({ error: 'Неверный пароль' });

  res.json({ username: user.username, displayName: user.displayName });
});

app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  const users = await User.find({
    username: { $regex: q, $options: 'i' }
  }).limit(10).select('username displayName');
  res.json(users.map(u => ({ username: u.username, displayName: u.displayName })));
});

// ── CHATS ─────────────────────────────────────────────────────────────────────
app.get('/api/chats/:username', async (req, res) => {
  const chats = await Chat.find({ members: req.params.username });
  const result = await Promise.all(chats.map(async c => {
    const msgs = await Message.find({ chatId: c.id, deleted: false })
      .sort({ ts: -1 }).limit(1);
    return { ...c.toObject(), lastMsg: msgs[0] || null };
  }));
  result.sort((a, b) => (b.lastMsg?.ts || b.createdAt) - (a.lastMsg?.ts || a.createdAt));
  res.json(result);
});

app.post('/api/chats', async (req, res) => {
  const { id, name, isGroup, members } = req.body;
  if (!members || members.length < 2)
    return res.status(400).json({ error: 'Нужно минимум 2 участника' });

  if (!isGroup && members.length === 2) {
    const [a, b] = members;
    const ex = await Chat.findOne({
      isGroup: false,
      members: { $all: [a, b], $size: 2 }
    });
    if (ex) return res.json(ex);
  }

  const chat = await Chat.create({
    id, name: name || null, isGroup: !!isGroup, members
  });
  res.json(chat);
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────
app.get('/api/messages/:chatId', async (req, res) => {
  const msgs = await Message.find({ chatId: req.params.chatId }).sort({ ts: 1 });
  res.json(msgs);
});

app.post('/api/messages', async (req, res) => {
  const { chatId, sender, text } = req.body;
  if (!chatId || !sender || !text?.trim())
    return res.status(400).json({ error: 'Неверные данные' });

  const msg = await Message.create({
    id:     `${Date.now()}${Math.random().toString(36).slice(2)}`,
    chatId, sender, text: text.trim(), type: 'text'
  });
  res.json(msg);
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { chatId, sender, type } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

  const msg = await Message.create({
    id:      `${Date.now()}${Math.random().toString(36).slice(2)}`,
    chatId,  sender, type: type || 'image',
    fileUrl: '/uploads/' + req.file.filename
  });
  res.json(msg);
});

app.delete('/api/messages/:msgId', async (req, res) => {
  const { username, forAll } = req.body;
  const msg = await Message.findOne({ id: req.params.msgId });
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  if (msg.sender !== username) return res.status(403).json({ error: 'Нет прав' });

  if (forAll) {
    msg.deleted   = true;
    msg.text      = null;
    msg.fileUrl   = null;
    msg.deletedAt = Date.now();
  } else {
    msg.deletedFor = [...(msg.deletedFor || []), username];
  }
  await msg.save();
  res.json(msg);
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nБЕЗДНА запущена → http://localhost:${PORT}\n`);
});
