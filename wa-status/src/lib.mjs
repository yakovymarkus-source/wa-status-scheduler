// WA-LIB: הלוגיקה הטהורה של השליחה (בלי חיבור אמיתי), כדי שאפשר לבדוק אותה עם דמה.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ממיר מספר ישראלי לכל פורמט נפוץ ל-JID. מחזיר null אם לא תקין.
export function toJid(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('9720')) d = '972' + d.slice(4); // 972-050... -> 97250...
  else if (d.startsWith('0')) d = '972' + d.slice(1);
  else if (d.length === 9 && d.startsWith('5')) d = '972' + d; // 501234567 בלי אפס
  return d.length >= 11 && d.length <= 15 ? `${d}@s.whatsapp.net` : null;
}

// הופך איש קשר מבייליז לשורה לטבלה. תומך גם במזהי lid החדשים (עם phoneNumber) ומתעלם מקבוצות/ערוצים
export function contactRow(c) {
  const cand = [c?.phoneNumber, c?.id].map((x) => String(x || '')).find((x) => x.endsWith('@s.whatsapp.net'));
  if (!cand) return null;
  return { jid: cand.replace(/:\d+@/, '@'), name: c.name || c.notify || null, updated_at: new Date().toISOString() };
}

// בונה רשימת נמענים בלי כפילויות: אנשי קשר (jid) + לקוחות (טלפון)
export function buildAudience(clients, contacts) {
  const set = new Set();
  for (const c of contacts || []) {
    const jid = String(c?.jid || '');
    if (jid.endsWith('@s.whatsapp.net')) set.add(jid.replace(/:\d+@/, '@'));
  }
  for (const c of clients || []) {
    const j = toJid(c?.contact_phone) || toJid(c?.phone);
    if (j) set.add(j);
  }
  return [...set];
}

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export function buildContent(it) {
  if (it.kind === 'text') {
    if (!it.body) throw new Error('BAD_ITEM: טקסט ריק');
    return { content: { text: it.body }, extra: { backgroundColor: '#1a1033', font: 1 } };
  }
  if (it.kind === 'image' || it.kind === 'video') {
    if (!it.media_url) throw new Error('BAD_ITEM: חסר media_url');
    return { content: { [it.kind]: { url: it.media_url }, caption: it.body || undefined }, extra: {} };
  }
  throw new Error('BAD_ITEM: סוג לא מוכר ' + it.kind);
}

// שולח תוכן אחד לכל הנמענים (בקבוצות)
async function sendContent(sock, content, extra, list, chunkSize, pause) {
  const groups = chunk(list, chunkSize);
  let done = 0;
  for (let i = 0; i < groups.length; i++) {
    try {
      await sock.sendMessage('status@broadcast', content, { ...extra, statusJidList: groups[i], broadcast: true });
    } catch (e) { e.partial = done; throw e; }
    done += groups[i].length;
    console.log(`WA-STEP קבוצה ${i + 1}/${groups.length} נשלחה (${groups[i].length})`);
    if (i < groups.length - 1) await sleep(pause);
  }
  return done;
}

// שולח פריט. סרטון ארוך מהמותר מפוצל לחלקים ונשלח כסטטוסים עוקבים (חלק 1/3, 2/3...).
export async function sendItem(sock, it, list, chunkSize, pause = 3000, splitter = null) {
  const { content, extra } = buildContent(it);
  if (it.kind !== 'video' || !splitter) return sendContent(sock, content, extra, list, chunkSize, pause);
  const parts = await splitter(it.media_url);
  if (!parts) return sendContent(sock, content, extra, list, chunkSize, pause);
  try {
    let total = 0;
    for (let i = 0; i < parts.paths.length; i++) {
      const tag = `(${i + 1}/${parts.paths.length})`;
      const caption = it.body ? `${it.body} ${tag}` : tag;
      console.log('WA-STEP שולח חלק', tag);
      try { total = await sendContent(sock, { video: { url: parts.paths[i] }, caption }, {}, list, chunkSize, pause); }
      catch (e) { e.message = `${e.message} [נשלחו ${i} מתוך ${parts.paths.length} חלקים]`; throw e; }
      if (i < parts.paths.length - 1) await sleep(pause);
    }
    return total;
  } finally { await parts.cleanup?.(); }
}

// עובר על התור: claim -> שליחה -> עדכון תוצאה. כל פריט מבודד משגיאות של האחרים.
export async function processQueue({ api, sock, due, list, chunkSize = 1000, pause = 3000, deadline = Infinity, splitter = null }) {
  const res = { sent: 0, failed: 0, skipped: 0 };
  for (const it of due) {
    if (Date.now() > deadline) { console.log('WA-STEP נגמר הזמן, השאר ימתין לריצה הבאה'); break; }
    let claimed;
    try { ({ claimed } = await api('queue_claim', { id: it.id })); }
    catch (e) { console.log('WA-ERR claim', it.id, e.message); res.skipped++; continue; }
    if (!claimed) { console.log('WA-STEP כבר נתפס, מדלג', it.id); res.skipped++; continue; }
    console.log('WA-STEP שולח', it.id, it.kind);
    let patch;
    try {
      const n = await sendItem(sock, it, list, chunkSize, pause, splitter);
      patch = { status: 'sent', sent_at: new Date().toISOString(), error: null };
      console.log('WA-STEP נשלח', it.id, 'נמענים:', n);
      res.sent++;
    } catch (e) {
      const partial = e.partial ? ` [נשלח חלקית ל-${e.partial} נמענים]` : '';
      patch = { status: 'failed', error: (String(e.message || e) + partial).slice(0, 500) };
      console.log('WA-ERR שליחה', it.id, patch.error);
      res.failed++;
    }
    try { await api('queue_update', { id: it.id, patch }); }
    catch (e) { console.log('WA-ERR עדכון תוצאה נכשל', it.id, patch.status, e.message); }
    await sleep(pause);
  }
  return res;
}
