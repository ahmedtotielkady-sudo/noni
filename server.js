'use strict';
const express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const mongoose = require('mongoose'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const helmet = require('helmet'), rateLimit = require('express-rate-limit'), { Server } = require('socket.io');

const { PORT = 3000, MONGODB_URI, JWT_SECRET, OWNER_USERNAME = '' } = process.env;
if (!MONGODB_URI || !JWT_SECRET) { console.error('MONGODB_URI and JWT_SECRET are required'); process.exit(1); }

/* ---------- Models ---------- */
const OID = mongoose.Schema.Types.ObjectId;
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true }, name: String, pass: String,
  role: { type: String, enum: ['user', 'agent', 'owner'], default: 'user' },
  coins: { type: Number, default: 0 }, agentActive: { type: Boolean, default: false },
  banned: { type: Boolean, default: false }
}, { timestamps: true }));
const Room = mongoose.model('Room', new mongoose.Schema({
  name: String, owner: OID, ownerName: String, closed: { type: Boolean, default: false }
}, { timestamps: true }));
const Msg = mongoose.model('Msg', new mongoose.Schema({ room: { type: OID, index: true }, user: OID, name: String, text: String }, { timestamps: true }));
const Tx = mongoose.model('Tx', new mongoose.Schema({ from: String, to: String, amount: Number, type: String }, { timestamps: true }));
const Code = mongoose.model('Code', new mongoose.Schema({
  code: { type: String, unique: true }, coins: Number, usedBy: { type: String, default: null }, usedAt: Date
}, { timestamps: true }));

/* ---------- Helpers ---------- */
const wrap = f => (q, r, n) => Promise.resolve(f(q, r, n)).catch(n);
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const sign = u => jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: '30d' });
const pub = u => ({ id: String(u._id), username: u.username, name: u.name, role: u.role, coins: u.coins, agentActive: u.agentActive });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isOwnerName = n => OWNER_USERNAME && n === OWNER_USERNAME.trim().toLowerCase();

async function auth(req, res, next) {
  try {
    const { id } = jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET);
    const u = await User.findById(id);
    if (!u || u.banned) return bad(res, 'غير مسموح', 401);
    req.user = u; next();
  } catch (e) { bad(res, 'سجّل الدخول', 401); }
}
const owner = (req, res, next) => req.user.role === 'owner' ? next() : bad(res, 'للمالك فقط', 403);

/* ---------- App ---------- */
const app = express(), server = http.createServer(app);
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'connect-src': ["'self'", 'ws:', 'wss:'], 'upgrade-insecure-requests': null } } }));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (q, r) => r.json({ ok: true }));

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول لاحقًا' } });

app.post('/api/register', authLimit, wrap(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase(), name = clean(req.body.name, 30), pass = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return bad(res, 'اسم المستخدم: 3-20 حرفًا إنجليزيًا أو أرقام أو _');
  if (!name) return bad(res, 'اكتب الاسم الظاهر');
  if (pass.length < 6 || pass.length > 72) return bad(res, 'كلمة المرور 6 أحرف على الأقل');
  let u;
  try { u = await User.create({ username, name, pass: await bcrypt.hash(pass, 10), role: isOwnerName(username) ? 'owner' : 'user' }); }
  catch (e) { if (e.code === 11000) return bad(res, 'اسم المستخدم مستخدم، جرّب غيره', 409); throw e; }
  res.json({ token: sign(u), user: pub(u) });
}));

app.post('/api/login', authLimit, wrap(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase();
  const u = await User.findOne({ username });
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.pass))) return bad(res, 'بيانات الدخول غير صحيحة', 401);
  if (u.banned) return bad(res, 'هذا الحساب محظور', 403);
  if (isOwnerName(username) && u.role !== 'owner') { u.role = 'owner'; await u.save(); }
  res.json({ token: sign(u), user: pub(u) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: pub(req.user) }));

/* ---- Rooms ---- */
app.get('/api/rooms', auth, wrap(async (req, res) => {
  const rooms = await Room.find({ closed: false }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(rooms.map(x => ({ id: String(x._id), name: x.name, ownerName: x.ownerName, online: (io.sockets.adapter.rooms.get('r:' + x._id) || new Set()).size })));
}));
app.post('/api/rooms', auth, wrap(async (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) return bad(res, 'اكتب اسم الغرفة');
  if (await Room.countDocuments({ owner: req.user._id, closed: false }) >= 5) return bad(res, 'وصلت للحد الأقصى (5 غرف)');
  const r = await Room.create({ name, owner: req.user._id, ownerName: req.user.name });
  res.json({ room: { id: String(r._id), name: r.name, ownerName: r.ownerName, online: 0 } });
}));
app.get('/api/rooms/:id/messages', auth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, 'غرفة غير صالحة');
  const l = await Msg.find({ room: req.params.id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json(l.reverse().map(m => ({ id: String(m._id), uid: String(m.user), name: m.name, text: m.text })));
}));

/* ---- Wallet ---- */
app.get('/api/tx', auth, wrap(async (req, res) => {
  res.json(await Tx.find({ $or: [{ from: req.user.username }, { to: req.user.username }] }).sort({ createdAt: -1 }).limit(20).lean());
}));
app.post('/api/redeem', auth, wrap(async (req, res) => {
  const c = await Code.findOneAndUpdate({ code: clean(req.body.code, 40).toUpperCase(), usedBy: null }, { usedBy: req.user.username, usedAt: new Date() });
  if (!c) return bad(res, 'الكود غير صالح أو مستخدم من قبل');
  const u = await User.findByIdAndUpdate(req.user._id, { $inc: { coins: c.coins } }, { new: true });
  await Tx.create({ from: 'code', to: u.username, amount: c.coins, type: 'redeem' });
  res.json({ user: pub(u) });
}));

/* ---- Agent ---- */
app.post('/api/agent/transfer', auth, wrap(async (req, res) => {
  const a = req.user;
  if (a.role !== 'agent' || !a.agentActive) return bad(res, 'حساب الوكيل غير مفعّل', 403);
  const amount = int(req.body.amount, 1, 1e7), to = clean(req.body.username, 20).toLowerCase();
  if (!amount) return bad(res, 'مبلغ غير صالح');
  if (to === a.username) return bad(res, 'لا يمكنك التحويل لنفسك');
  const t = await User.findOne({ username: to, banned: false });
  if (!t) return bad(res, 'المستخدم غير موجود', 404);
  const d = await User.findOneAndUpdate({ _id: a._id, role: 'agent', agentActive: true, coins: { $gte: amount } }, { $inc: { coins: -amount } }, { new: true });
  if (!d) return bad(res, 'رصيدك غير كافٍ');
  await User.updateOne({ _id: t._id }, { $inc: { coins: amount } });
  await Tx.create({ from: a.username, to, amount, type: 'agent' });
  notify(t._id);
  res.json({ user: pub(d) });
}));

/* ---- Owner panel ---- */
const ACT = { ban: { banned: true }, unban: { banned: false }, makeAgent: { role: 'agent', agentActive: true }, removeAgent: { role: 'user', agentActive: false }, activate: { agentActive: true }, deactivate: { agentActive: false } };
const A = [auth, owner];
app.get('/api/admin/stats', A, wrap(async (req, res) => {
  const [users, agents, rooms, tx, sum] = await Promise.all([User.countDocuments(), User.countDocuments({ role: 'agent' }), Room.countDocuments({ closed: false }), Tx.countDocuments(), User.aggregate([{ $group: { _id: null, t: { $sum: '$coins' } } }])]);
  res.json({ users, agents, rooms, tx, coins: sum[0] ? sum[0].t : 0, online: io.engine.clientsCount });
}));
app.get('/api/admin/users', A, wrap(async (req, res) => {
  const q = clean(req.query.q, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const f = q ? { $or: [{ username: new RegExp(q, 'i') }, { name: new RegExp(q, 'i') }] } : {};
  const l = await User.find(f).sort({ createdAt: -1 }).limit(50).lean();
  res.json(l.map(u => ({ id: String(u._id), username: u.username, name: u.name, role: u.role, coins: u.coins, agentActive: u.agentActive, banned: u.banned })));
}));
app.post('/api/admin/users/:id', A, wrap(async (req, res) => {
  const set = ACT[req.body.action];
  if (!set || !mongoose.isValidObjectId(req.params.id)) return bad(res, 'طلب غير صالح');
  const f = { _id: req.params.id, role: { $ne: 'owner' } };
  if (req.body.action === 'activate' || req.body.action === 'deactivate') f.role = 'agent';
  const u = await User.findOneAndUpdate(f, set, { new: true });
  if (!u) return bad(res, 'غير ممكن لهذا الحساب', 404);
  if (set.banned) io.in('u:' + u.id).disconnectSockets(true);
  notify(u._id);
  res.json({ ok: true });
}));
app.post('/api/admin/coins', A, wrap(async (req, res) => {
  const amount = int(req.body.amount, -1e9, 1e9), username = clean(req.body.username, 20).toLowerCase();
  if (!amount) return bad(res, 'مبلغ غير صالح');
  const f = { username }; if (amount < 0) f.coins = { $gte: -amount };
  const u = await User.findOneAndUpdate(f, { $inc: { coins: amount } }, { new: true });
  if (!u) return bad(res, 'المستخدم غير موجود أو رصيده لا يكفي للخصم', 404);
  await Tx.create({ from: 'owner', to: username, amount, type: 'grant' });
  notify(u._id);
  res.json({ ok: true });
}));
app.get('/api/admin/codes', A, wrap(async (req, res) => res.json(await Code.find().sort({ createdAt: -1 }).limit(100).lean())));
app.post('/api/admin/codes', A, wrap(async (req, res) => {
  const coins = int(req.body.coins, 1, 1e7), count = int(req.body.count, 1, 50);
  if (!coins || !count) return bad(res, 'أدخل قيمة وعددًا صحيحين (العدد حتى 50)');
  const docs = Array.from({ length: count }, () => ({ code: crypto.randomBytes(5).toString('hex').toUpperCase(), coins }));
  await Code.insertMany(docs);
  res.json({ ok: true });
}));
app.get('/api/admin/rooms', A, wrap(async (req, res) => res.json((await Room.find({ closed: false }).sort({ createdAt: -1 }).limit(100).lean()).map(r => ({ id: String(r._id), name: r.name, ownerName: r.ownerName })))));
app.delete('/api/admin/rooms/:id', A, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, 'غرفة غير صالحة');
  await Room.updateOne({ _id: req.params.id }, { closed: true });
  io.to('r:' + req.params.id).emit('room:closed', req.params.id);
  res.json({ ok: true });
}));

app.use('/api', (q, r) => bad(r, 'غير موجود', 404));
app.use((e, q, r, n) => { console.error(e.message); r.status(500).json({ error: 'خطأ في الخادم' }); });

/* ---------- Realtime (chat + WebRTC signaling) ---------- */
const io = new Server(server);
const notify = id => io.to('u:' + id).emit('coins');
const voice = new Map(); // roomId -> Map(socketId -> {uid,name,muted})
const members = r => [...(voice.get(r) || new Map()).entries()].map(([sid, v]) => ({ sid, ...v }));

io.use(async (s, next) => {
  try {
    const { id } = jwt.verify(String((s.handshake.auth || {}).token || ''), JWT_SECRET);
    const u = await User.findById(id);
    if (!u || u.banned) return next(new Error('x'));
    s.user = u; next();
  } catch (e) { next(new Error('x')); }
});

io.on('connection', s => {
  const u = s.user; let room = null, last = 0;
  s.join('u:' + u.id);

  const leaveVoice = () => {
    const m = room && voice.get(room);
    if (m && m.delete(s.id)) { io.to('r:' + room).emit('voice:left', s.id); if (!m.size) voice.delete(room); }
  };
  const leave = () => { if (!room) return; leaveVoice(); s.leave('r:' + room); room = null; };

  s.on('join', async (rid, ack) => {
    if (typeof ack !== 'function') return;
    try {
      if (!mongoose.isValidObjectId(rid)) return ack({ error: 'غرفة غير صالحة' });
      const r = await Room.findById(rid);
      if (!r || r.closed) return ack({ error: 'الغرفة غير متاحة' });
      leave(); room = String(rid); s.join('r:' + room);
      ack({ ok: true, voice: members(room) });
    } catch (e) { ack({ error: 'تعذر الدخول' }); }
  });
  s.on('leave', leave);

  s.on('msg', async text => {
    text = clean(text, 500);
    if (!room || !text || Date.now() - last < 400) return;
    last = Date.now();
    try {
      await Msg.create({ room, user: u._id, name: u.name, text });
      io.to('r:' + room).emit('msg', { uid: String(u._id), name: u.name, text });
    } catch (e) { console.error(e.message); }
  });

  s.on('voice:join', ack => {
    if (!room || typeof ack !== 'function') return;
    const m = voice.get(room) || new Map();
    if (m.size >= 8 && !m.has(s.id)) return ack({ error: 'الغرفة الصوتية ممتلئة (8 أشخاص)' });
    const others = members(room);
    m.set(s.id, { uid: String(u._id), name: u.name, muted: false }); voice.set(room, m);
    s.to('r:' + room).emit('voice:joined', { sid: s.id, name: u.name, muted: false });
    ack({ members: others });
  });
  s.on('voice:leave', leaveVoice);
  s.on('voice:mute', muted => {
    const v = room && voice.get(room) && voice.get(room).get(s.id);
    if (v) { v.muted = !!muted; io.to('r:' + room).emit('voice:mute', { sid: s.id, muted: v.muted }); }
  });
  s.on('voice:signal', (p = {}) => {
    const m = room && voice.get(room);
    if (m && m.has(s.id) && m.has(p.to)) io.to(p.to).emit('voice:signal', { from: s.id, data: p.data });
  });
  s.on('disconnect', leave);
});

mongoose.connect(MONGODB_URI)
  .then(() => server.listen(PORT, () => console.log('Noni running on ' + PORT)))
  .catch(e => { console.error('DB error:', e.message); process.exit(1); });
