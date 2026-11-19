// בדיקות מקומיות עם דמה (בלי רשת ובלי וואטסאפ אמיתי): node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { toJid, buildAudience, chunk, processQueue } from '../src/lib.mjs';

// דמה של הגשר: תור בזיכרון עם אותה סמנטיקה של ה-edge function
function fakeApi(rows, { failUpdate = false } = {}) {
  const calls = [];
  const fn = async (op, p = {}) => {
    calls.push(op);
    if (op === 'queue_due') return { rows: rows.filter((r) => r.status === 'pending' && new Date(r.scheduled_at) <= new Date()) };
    if (op === 'queue_claim') { const r = rows.find((x) => x.id === p.id && x.status === 'pending'); if (r) r.status = 'sending'; return { claimed: !!r }; }
    if (op === 'queue_update') { if (failUpdate) throw new Error('API_500'); Object.assign(rows.find((x) => x.id === p.id), p.patch); return { ok: true }; }
    throw new Error('op?' + op);
  };
  fn.calls = calls; return fn;
}
const fakeSock = (impl) => { const sent = []; return { sent, sendMessage: async (jid, c, o) => { if (impl) await impl(c, o, sent.length); sent.push({ jid, c, o }); } }; };
const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3600000).toISOString();
const run = (api, sock, due, extra = {}) => processQueue({ api, sock, due, list: ['a@s.whatsapp.net'], pause: 0, ...extra });

test('toJid: פורמטים', () => {
  assert.equal(toJid('050-123-4567'), '972501234567@s.whatsapp.net');
  assert.equal(toJid('+972 50 123 4567'), '972501234567@s.whatsapp.net');
  assert.equal(toJid('00972501234567'), '972501234567@s.whatsapp.net');
  assert.equal(toJid('972-0501234567'), '972501234567@s.whatsapp.net');
  assert.equal(toJid('501234567'), '972501234567@s.whatsapp.net');
  assert.equal(toJid(''), null); assert.equal(toJid(null), null); assert.equal(toJid('123'), null);
});
test('buildAudience: ניקוי כפילויות ושילוב', () => {
  const l = buildAudience(
    [{ phone: '0501234567' }, { phone: '', contact_phone: '+972501234567' }, { phone: 'abc' }, { phone: '0527654321' }],
    [{ jid: '972501234567@s.whatsapp.net' }, { jid: '972521111111:12@s.whatsapp.net' }, { jid: 'x@g.us' }, {}]);
  assert.deepEqual(l.sort(), ['972501234567@s.whatsapp.net', '972521111111@s.whatsapp.net', '972527654321@s.whatsapp.net']);
  assert.deepEqual(buildAudience(null, null), []);
});
test('chunk', () => { assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); });

test('תור ריק', async () => {
  const api = fakeApi([]); const sock = fakeSock();
  const r = await run(api, sock, []);
  assert.deepEqual(r, { sent: 0, failed: 0, skipped: 0 }); assert.equal(sock.sent.length, 0);
});
test('טקסט/תמונה/וידאו', async () => {
  const rows = [
    { id: '1', kind: 'text', body: 'שלום', status: 'pending', scheduled_at: past },
    { id: '2', kind: 'image', body: 'כיתוב', media_url: 'http://x/i.jpg', status: 'pending', scheduled_at: past },
    { id: '3', kind: 'video', body: null, media_url: 'http://x/v.mp4', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const sock = fakeSock();
  const r = await run(api, sock, (await api('queue_due')).rows);
  assert.equal(r.sent, 3);
  assert.deepEqual(sock.sent[0].c, { text: 'שלום' }); assert.equal(sock.sent[0].o.backgroundColor, '#1a1033');
  assert.deepEqual(sock.sent[1].c, { image: { url: 'http://x/i.jpg' }, caption: 'כיתוב' });
  assert.deepEqual(sock.sent[2].c, { video: { url: 'http://x/v.mp4' }, caption: undefined });
  assert.ok(sock.sent.every((s) => s.jid === 'status@broadcast' && s.o.broadcast && s.o.statusJidList.length === 1));
  assert.ok(rows.every((x) => x.status === 'sent' && x.sent_at && x.error === null));
});
test('תזמון עתידי לא נשלח', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: future }];
  const api = fakeApi(rows); const sock = fakeSock();
  assert.equal((await api('queue_due')).rows.length, 0);
  assert.equal(rows[0].status, 'pending');
});
test('claim כפול: אין שליחה כפולה', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const s1 = fakeSock(), s2 = fakeSock();
  const due = (await api('queue_due')).rows;
  const [a, b] = await Promise.all([run(api, s1, due), run(api, s2, due)]);
  assert.equal(s1.sent.length + s2.sent.length, 1);
  assert.equal(a.sent + b.sent, 1); assert.equal(a.skipped + b.skipped, 1);
});
test('שגיאת שליחה: failed עם error, לא נתקע ב-sending, והבא ממשיך', async () => {
  const rows = [
    { id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past },
    { id: '2', kind: 'text', body: 'y', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows);
  const sock = fakeSock(async (c) => { if (c.text === 'x') throw new Error('boom'); });
  const r = await run(api, sock, (await api('queue_due')).rows);
  assert.deepEqual([r.sent, r.failed], [1, 1]);
  assert.equal(rows[0].status, 'failed'); assert.match(rows[0].error, /boom/); assert.equal(rows[1].status, 'sent');
});
test('פריט לא תקין (סוג לא מוכר / חסר media) נרשם failed', async () => {
  const rows = [{ id: '1', kind: 'audio', status: 'pending', scheduled_at: past }, { id: '2', kind: 'image', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const sock = fakeSock();
  await run(api, sock, (await api('queue_due')).rows);
  assert.ok(rows.every((r) => r.status === 'failed' && /BAD_ITEM/.test(r.error))); assert.equal(sock.sent.length, 0);
});
test('שליחה בקבוצות', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const sock = fakeSock();
  const list = Array.from({ length: 25 }, (_, i) => `${i}@s.whatsapp.net`);
  await processQueue({ api, sock, due: rows, list, chunkSize: 10, pause: 0 });
  assert.deepEqual(sock.sent.map((s) => s.o.statusJidList.length), [10, 10, 5]);
  assert.equal(rows[0].status, 'sent');
});
test('כשל באמצע קבוצות: failed עם ציון חלקי', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const sock = fakeSock(async (c, o, n) => { if (n === 1) throw new Error('net'); });
  await processQueue({ api, sock, due: rows, list: Array.from({ length: 25 }, (_, i) => `${i}@s.whatsapp.net`), chunkSize: 10, pause: 0 });
  assert.equal(rows[0].status, 'failed'); assert.match(rows[0].error, /חלקית ל-10/);
});
test('עדכון תוצאה נכשל: לא קורס, ממשיך', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows, { failUpdate: true }); const sock = fakeSock();
  const r = await run(api, sock, (await api('queue_due')).rows);
  assert.equal(r.sent, 1);
});
test('deadline: לא מתחיל פריטים אחרי הזמן', async () => {
  const rows = [{ id: '1', kind: 'text', body: 'x', status: 'pending', scheduled_at: past }];
  const api = fakeApi(rows); const sock = fakeSock();
  await run(api, sock, rows, { deadline: Date.now() - 1 });
  assert.equal(sock.sent.length, 0); assert.equal(rows[0].status, 'pending');
});
