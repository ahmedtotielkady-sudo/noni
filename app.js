'use strict';
const store = { get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} } };
const S = { token: store.get('t'), me: null, tab: 'rooms', at: 'stats', nav: 0, room: null, socket: null, peers: {}, voice: {}, stream: null, muted: false, inVoice: false };
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const ROLE = { owner: 'المالك', agent: 'وكيل', user: 'مستخدم' };
const app = document.getElementById('app'), $ = s => document.querySelector(s), main = () => $('#main');

function h(tag, a, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const btn = (t, f, c = '') => h('button', { class: 'btn ' + c, type: 'button', onclick: f }, t);
function toast(m) { const t = h('div', { class: 'toast' }, m); document.body.append(t); setTimeout(() => t.remove(), 2600); }
async function act(fn) { try { await fn(); } catch (e) { toast(e.message); } }
async function api(p, m = 'GET', b) {
  const r = await fetch('/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let d = {}; try { d = await r.json(); } catch (e) {}
  if (r.status === 401 && S.me) logout();
  if (!r.ok) throw new Error(d.error || 'حدث خطأ، حاول مرة أخرى');
  return d;
}
const show = (id, x) => { if (id === S.nav && !S.room && main()) main().replaceChildren(x); };

/* ---------- Auth ---------- */
function authView() {
  let reg = false;
  const draw = () => {
    const n = h('input', { placeholder: 'الاسم الظاهر', maxlength: 30 });
    const u = h('input', { placeholder: 'اسم المستخدم (إنجليزي)', autocapitalize: 'none', autocomplete: 'username', maxlength: 20 });
    const p = h('input', { type: 'password', placeholder: 'كلمة المرور (6 أحرف على الأقل)', autocomplete: reg ? 'new-password' : 'current-password' });
    app.replaceChildren(h('form', { class: 'auth card stack', onsubmit: e => { e.preventDefault(); act(async () => {
      const d = await api(reg ? '/register' : '/login', 'POST', { name: n.value, username: u.value, password: p.value });
      S.token = d.token; store.set('t', d.token); S.me = d.user; S.tab = 'rooms'; connectSocket(); shell();
    }); } },
      h('div', { class: 'logo' }, '🎙️ نوني'), h('p', { class: 'muted center' }, 'غرف صوتية ودردشة حقيقية'),
      reg && n, u, p, h('button', { class: 'btn', type: 'submit' }, reg ? 'إنشاء حساب' : 'دخول'),
      h('button', { class: 'ghost', type: 'button', onclick: () => { reg = !reg; draw(); } }, reg ? 'عندي حساب بالفعل' : 'مستخدم جديد؟ سجّل حساب')));
  };
  draw();
}
function logout() {
  voiceLeave(); if (S.socket) S.socket.disconnect();
  S.socket = null; S.me = null; S.token = ''; S.room = null; store.set('t', '');
  document.body.classList.remove('inroom'); authView();
}

/* ---------- Socket ---------- */
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  const s = S.socket = io({ auth: { token: S.token } });
  s.on('connect_error', e => { if (e.message === 'x') logout(); });
  s.on('disconnect', () => { if (S.room) { toast('انقطع الاتصال'); leaveRoom(); } });
  s.on('msg', m => { if (S.room) addMsg(m); });
  s.on('coins', () => act(refreshMe));
  s.on('room:closed', id => { if (S.room && S.room.id === id) { toast('تم إغلاق الغرفة'); leaveRoom(); } });
  s.on('voice:joined', v => { S.voice[v.sid] = v; drawVoice(); });
  s.on('voice:left', sid => { closePeer(sid); delete S.voice[sid]; drawVoice(); });
  s.on('voice:mute', ({ sid, muted }) => { if (S.voice[sid]) { S.voice[sid].muted = muted; drawVoice(); } });
  s.on('voice:signal', onSignal);
}
async function refreshMe() {
  S.me = (await api('/me')).user;
  document.querySelectorAll('.bal').forEach(e => e.textContent = S.me.coins);
}

/* ---------- Shell & router ---------- */
function shell() {
  const nav = [['rooms', '🏠', 'الغرف'], ['wallet', '👛', 'المحفظة'], ...(S.me.role === 'owner' ? [['admin', '🛠️', 'المالك']] : []), ['me', '👤', 'حسابي']];
  app.replaceChildren(
    h('header', {}, h('b', {}, '🎙️ نوني'), h('span', { class: 'coins' }, '🪙 ', h('span', { class: 'bal' }, String(S.me.coins)))),
    h('main', { id: 'main' }),
    h('nav', {}, nav.map(([k, i, l]) => h('button', { class: 'nv', 'data-k': k, type: 'button', onclick: () => go(k) }, h('span', {}, i), h('small', {}, l)))));
  go(S.tab);
}
async function go(t) {
  S.tab = t; S.nav++;
  document.querySelectorAll('.nv').forEach(b => b.classList.toggle('on', b.dataset.k === t));
  main().replaceChildren(h('p', { class: 'muted center' }, 'جارٍ التحميل...'));
  try { await V[t](); } catch (e) { toast(e.message); }
}

/* ---------- Rooms ---------- */
async function viewRooms() {
  const id = S.nav, inp = h('input', { placeholder: 'اسم غرفة جديدة', maxlength: 40 });
  const rooms = await api('/rooms');
  show(id, h('div', { class: 'stack' },
    h('div', { class: 'card row' }, inp, btn('➕ إنشاء', () => act(async () => { const d = await api('/rooms', 'POST', { name: inp.value }); openRoom(d.room); }))),
    ...(rooms.length ? rooms.map(r => h('div', { class: 'card room-card', onclick: () => openRoom(r) }, h('div', {}, h('b', {}, r.name), h('div', { class: 'muted' }, 'بواسطة ' + r.ownerName)), h('span', { class: 'badge' }, '👥 ' + r.online))) : [h('p', { class: 'muted center' }, 'لا توجد غرف بعد، أنشئ أول غرفة!')]),
    h('button', { class: 'ghost', type: 'button', onclick: () => go('rooms') }, '🔄 تحديث')));
}
function openRoom(r) {
  S.room = r; S.voice = {}; document.body.classList.add('inroom');
  const inp = h('input', { placeholder: 'اكتب رسالة...', maxlength: 500, autocomplete: 'off' });
  main().replaceChildren(h('div', { class: 'room' },
    h('div', { class: 'rtop' }, h('button', { class: 'ghost', type: 'button', onclick: leaveRoom }, '→ رجوع'), h('b', {}, r.name)),
    h('div', { class: 'vs', id: 'vs' }), h('div', { class: 'vbtns', id: 'vb' }), h('div', { class: 'msgs', id: 'ms' }),
    h('form', { class: 'row composer', onsubmit: e => { e.preventDefault(); const t = inp.value.trim(); if (t) { S.socket.emit('msg', t); inp.value = ''; } } }, inp, h('button', { class: 'btn', type: 'submit' }, 'إرسال'))));
  drawVoice();
  api('/rooms/' + r.id + '/messages').then(l => {
    l.forEach(addMsg);
    S.socket.emit('join', r.id, res => {
      if (!res || res.error) { toast((res && res.error) || 'تعذر الدخول'); return leaveRoom(); }
      res.voice.forEach(v => S.voice[v.sid] = v); drawVoice();
    });
  }).catch(e => { toast(e.message); leaveRoom(); });
}
function addMsg(m) {
  const ms = $('#ms'); if (!ms) return;
  const mine = m.uid === S.me.id;
  ms.append(h('div', { class: 'bub' + (mine ? ' me' : '') }, !mine && h('small', {}, m.name), m.text));
  ms.scrollTop = ms.scrollHeight;
}
function leaveRoom() {
  voiceLeave(); if (S.socket) S.socket.emit('leave');
  S.room = null; S.voice = {}; document.body.classList.remove('inroom'); go('rooms');
}

/* ---------- Voice (WebRTC mesh) ---------- */
function drawVoice() {
  const vs = $('#vs'), vb = $('#vb'); if (!vs || !vb) return;
  const mem = Object.values(S.voice);
  vs.replaceChildren(...(mem.length ? mem.map(v => h('div', { class: 'chip' }, (v.muted ? '🔇 ' : '🎤 ') + v.name)) : [h('span', { class: 'muted' }, 'لا أحد في الصوت الآن')]));
  vb.replaceChildren(...(S.inVoice ? [btn(S.muted ? '🔇 إلغاء الكتم' : '🎙️ كتم', toggleMute), btn('📴 خروج من الصوت', voiceLeave, 'danger')] : [btn('🎧 انضم للصوت', voiceJoin)]));
}
async function voiceJoin() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('الصوت يحتاج متصفحًا حديثًا واتصال HTTPS');
  try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { return toast('اسمح باستخدام الميكروفون من إعدادات المتصفح'); }
  S.socket.emit('voice:join', res => {
    if (!res || res.error) { stopStream(); return toast((res && res.error) || 'تعذر الانضمام للصوت'); }
    S.inVoice = true; S.muted = false;
    S.voice[S.socket.id] = { sid: S.socket.id, name: S.me.name, muted: false };
    res.members.forEach(m => { S.voice[m.sid] = m; makePeer(m.sid, true); });
    drawVoice();
  });
}
function stopStream() { if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
function voiceLeave() {
  if (!S.inVoice) return;
  S.inVoice = false;
  if (S.socket) { S.socket.emit('voice:leave'); delete S.voice[S.socket.id]; }
  Object.keys(S.peers).forEach(closePeer); stopStream(); drawVoice();
}
function toggleMute() {
  S.muted = !S.muted;
  if (S.stream) S.stream.getAudioTracks().forEach(t => t.enabled = !S.muted);
  S.socket.emit('voice:mute', S.muted); drawVoice();
}
function makePeer(sid, init) {
  const pc = new RTCPeerConnection(ICE); S.peers[sid] = pc; pc.q = Promise.resolve();
  S.stream.getTracks().forEach(t => pc.addTrack(t, S.stream));
  pc.onicecandidate = e => { if (e.candidate) S.socket.emit('voice:signal', { to: sid, data: { c: e.candidate } }); };
  pc.ontrack = e => {
    let a = document.getElementById('a' + sid);
    if (!a) { a = h('audio', { id: 'a' + sid, autoplay: 'true', playsinline: 'true' }); document.body.append(a); }
    a.srcObject = e.streams[0]; a.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') closePeer(sid); };
  if (init) pc.q = pc.q.then(async () => { await pc.setLocalDescription(await pc.createOffer()); S.socket.emit('voice:signal', { to: sid, data: { sdp: pc.localDescription } }); }).catch(() => {});
  return pc;
}
function onSignal({ from, data }) {
  if (!S.inVoice || !data) return;
  const pc = S.peers[from] || makePeer(from, false);
  pc.q = pc.q.then(async () => {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); S.socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } }); }
    } else if (data.c) await pc.addIceCandidate(data.c);
  }).catch(() => {});
}
function closePeer(sid) {
  if (S.peers[sid]) { S.peers[sid].close(); delete S.peers[sid]; }
  const a = document.getElementById('a' + sid); if (a) a.remove();
}

/* ---------- Wallet & agent ---------- */
async function viewWallet() {
  const id = S.nav; await refreshMe(); const m = S.me;
  const code = h('input', { placeholder: 'كود الشحن', autocapitalize: 'characters' });
  const box = h('div', { class: 'stack' },
    h('div', { class: 'card center' }, h('div', { class: 'muted' }, 'رصيدك'), h('div', { class: 'big' }, '🪙 ', h('span', { class: 'bal' }, String(m.coins)))),
    h('div', { class: 'card stack' }, h('b', {}, 'شحن بكود'), h('div', { class: 'row' }, code, btn('شحن', () => act(async () => { await api('/redeem', 'POST', { code: code.value }); toast('تم الشحن ✅'); viewWallet(); })))));
  if (m.role === 'agent') {
    if (m.agentActive) {
      const u = h('input', { placeholder: 'اسم المستخدم', autocapitalize: 'none' }), a = h('input', { type: 'number', min: 1, inputmode: 'numeric', placeholder: 'عدد العملات' });
      box.append(h('div', { class: 'card stack' }, h('b', {}, '🧾 لوحة الوكيل'), h('div', { class: 'muted' }, 'حوّل عملات من رصيدك إلى أي مستخدم'), u, a,
        btn('تحويل', () => act(async () => { await api('/agent/transfer', 'POST', { username: u.value, amount: Number(a.value) }); toast('تم التحويل ✅'); viewWallet(); }))));
    } else box.append(h('div', { class: 'card center' }, '⛔ حساب الوكيل موقوف حاليًا، تواصل مع المالك'));
  }
  const tx = await api('/tx');
  box.append(h('div', { class: 'card stack' }, h('b', {}, 'آخر العمليات'), ...(tx.length ? tx.map(t => {
    const v = t.to === m.username ? t.amount : -t.amount, lbl = { redeem: 'شحن بكود', agent: 'تحويل وكيل', grant: 'من المالك' }[t.type] || t.type;
    return h('div', { class: 'row' }, h('span', { style: 'flex:1' }, lbl), h('b', { style: 'color:' + (v > 0 ? 'var(--ok)' : 'var(--red)') }, (v > 0 ? '+' : '') + v));
  }) : [h('span', { class: 'muted' }, 'لا توجد عمليات بعد')])));
  show(id, box);
}

/* ---------- Owner panel ---------- */
async function viewAdmin() {
  const id = S.nav, body = h('div', { class: 'stack' });
  const tabs = [['stats', '📊 إحصائيات'], ['users', '👥 المستخدمون'], ['codes', '🎟️ أكواد الشحن'], ['rooms', '🚪 الغرف']];
  show(id, h('div', { class: 'stack' }, h('div', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { class: 'tab' + (S.at === k ? ' on' : ''), type: 'button', onclick: () => { S.at = k; viewAdmin(); } }, l))), body));
  await AD[S.at](body);
}
async function adStats(b) {
  const s = await api('/admin/stats');
  b.append(h('div', { class: 'grid' }, [['المستخدمون', s.users], ['الوكلاء', s.agents], ['الغرف المفتوحة', s.rooms], ['متصلون الآن', s.online], ['إجمالي العملات', s.coins], ['العمليات', s.tx]].map(([l, v]) => h('div', { class: 'card' }, h('b', {}, String(v)), h('span', { class: 'muted' }, l)))));
}
async function adUsers(b) {
  const q = h('input', { placeholder: 'ابحث بالاسم أو اسم المستخدم', type: 'search' }), list = h('div', { class: 'stack' });
  const call = (p, bd) => act(async () => { await api(p, 'POST', bd); toast('تم ✅'); load(); });
  const load = () => act(async () => {
    const us = await api('/admin/users?q=' + encodeURIComponent(q.value));
    list.replaceChildren(...us.map(u => h('div', { class: 'card' },
      h('div', {}, h('b', {}, u.name), ' @' + u.username, h('span', { class: 'badge' }, ROLE[u.role]), u.banned && h('span', { class: 'badge red' }, 'محظور'), u.role === 'agent' && h('span', { class: 'badge ' + (u.agentActive ? '' : 'red') }, u.agentActive ? 'مفعّل' : 'موقوف'), h('span', { class: 'badge gold' }, '🪙 ' + u.coins)),
      u.role !== 'owner' && h('div', { class: 'acts' },
        btn('🪙 منح/خصم', () => { const v = prompt('عدد العملات (سالب للخصم)'); if (v !== null && v.trim()) call('/admin/coins', { username: u.username, amount: Number(v) }); }, 'sm'),
        btn(u.banned ? 'فك الحظر' : 'حظر', () => call('/admin/users/' + u.id, { action: u.banned ? 'unban' : 'ban' }), 'sm ' + (u.banned ? 'ok' : 'danger')),
        u.role === 'user' && btn('تعيين وكيل', () => call('/admin/users/' + u.id, { action: 'makeAgent' }), 'sm ok'),
        u.role === 'agent' && btn(u.agentActive ? '⏸ إيقاف الوكيل' : '▶ تفعيل الوكيل', () => call('/admin/users/' + u.id, { action: u.agentActive ? 'deactivate' : 'activate' }), 'sm'),
        u.role === 'agent' && btn('إلغاء الوكالة', () => call('/admin/users/' + u.id, { action: 'removeAgent' }), 'sm danger')))));
    if (!us.length) list.replaceChildren(h('p', { class: 'muted center' }, 'لا نتائج'));
  });
  q.addEventListener('input', () => { clearTimeout(q.t); q.t = setTimeout(load, 300); });
  b.append(q, list); await load();
}
async function adCodes(b) {
  const c = h('input', { type: 'number', min: 1, inputmode: 'numeric', placeholder: 'قيمة الكود (عملات)' }), n = h('input', { type: 'number', min: 1, max: 50, inputmode: 'numeric', placeholder: 'العدد (حتى 50)', value: '1' });
  const list = h('div', { class: 'stack' });
  const load = () => act(async () => {
    const cs = await api('/admin/codes');
    list.replaceChildren(...cs.map(x => h('div', { class: 'card row' }, h('b', { style: 'flex:1;direction:ltr;text-align:right' }, x.code), h('span', { class: 'badge gold' }, '🪙 ' + x.coins), x.usedBy ? h('span', { class: 'badge red' }, 'استُخدم: ' + x.usedBy) : btn('نسخ', () => { if (navigator.clipboard) navigator.clipboard.writeText(x.code).then(() => toast('تم النسخ'), () => toast(x.code)); else toast(x.code); }, 'sm'))));
  });
  b.append(h('div', { class: 'card stack' }, h('b', {}, 'توليد أكواد شحن'), c, n, btn('توليد', () => act(async () => { await api('/admin/codes', 'POST', { coins: Number(c.value), count: Number(n.value) }); toast('تم التوليد ✅'); load(); }))), list);
  await load();
}
async function adRooms(b) {
  const rs = await api('/admin/rooms');
  b.append(...(rs.length ? rs.map(r => h('div', { class: 'card row' }, h('span', { style: 'flex:1' }, h('b', {}, r.name), h('div', { class: 'muted' }, r.ownerName)), btn('إغلاق', () => { if (confirm('إغلاق الغرفة؟')) act(async () => { await api('/admin/rooms/' + r.id, 'DELETE'); viewAdmin(); }); }, 'sm danger'))) : [h('p', { class: 'muted center' }, 'لا توجد غرف')]));
}
const AD = { stats: adStats, users: adUsers, codes: adCodes, rooms: adRooms };

/* ---------- Profile ---------- */
async function viewMe() {
  const id = S.nav, m = S.me;
  show(id, h('div', { class: 'stack' }, h('div', { class: 'card center stack' }, h('div', { class: 'logo' }, '👤'), h('b', {}, m.name), h('span', { class: 'muted' }, '@' + m.username), h('div', {}, h('span', { class: 'badge' }, ROLE[m.role]))), btn('تسجيل الخروج', logout, 'danger')));
}
const V = { rooms: viewRooms, wallet: viewWallet, admin: viewAdmin, me: viewMe };

/* ---------- Boot ---------- */
(async function boot() {
  if (S.token) { try { S.me = (await api('/me')).user; connectSocket(); return shell(); } catch (e) { S.token = ''; store.set('t', ''); } }
  authView();
})();
