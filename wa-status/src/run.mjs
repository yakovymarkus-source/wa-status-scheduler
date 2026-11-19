// WA-RUN: מצב send = שולח סטטוסים שהגיע זמנם. מצב pair = חיבור ראשון עם קוד.
import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import { useSupabaseAuthState } from './auth.mjs';
import { api } from './api.mjs';
import { splitVideo } from './split.mjs';
import { sleep, buildAudience, processQueue } from './lib.mjs';

const mode = process.argv[2] || 'send';
if (!process.env.SUPABASE_URL || !process.env.WA_API_TOKEN) { console.log('WA-SKIP: הסודות עדיין לא הוגדרו ב-GitHub'); process.exit(0); }
const log = pino({ level: 'silent' });

async function connect() {
  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: log, browser: Browsers.macOS('Chrome'), printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('contacts.upsert', async (cs) => {
    const rows = cs.filter((c) => c.id?.endsWith('@s.whatsapp.net')).map((c) => ({ jid: c.id, name: c.name || c.notify || null, updated_at: new Date().toISOString() }));
    if (rows.length) await api('contacts_upsert', { rows }).catch((e) => console.log('WA-ERR contacts_upsert', e.message));
  });
  return sock;
}

function waitOpen(sock, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT_CONNECT')), ms);
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') { clearTimeout(t); resolve(); }
      if (u.connection === 'close') {
        clearTimeout(t);
        const code = u.lastDisconnect?.error?.output?.statusCode;
        reject(new Error(code === DisconnectReason.loggedOut ? 'LOGGED_OUT: צריך חיבור מחדש (pair)' : `DISCONNECTED_${code ?? 'unknown'}`));
      }
    });
  });
}

// ממתין לפתיחה או לסגירה של חיבור; מחזיר {open:true} או {code,msg}
function waitEvent(sock, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), ms);
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') { clearTimeout(t); resolve({ open: true }); }
      if (u.connection === 'close') {
        clearTimeout(t);
        const e = u.lastDisconnect?.error;
        console.log('WA-CLOSE', e?.output?.statusCode, e?.message);
        resolve({ code: e?.output?.statusCode, msg: e?.message });
      }
    });
  });
}

async function pair() {
  const phone = String(process.env.WA_PHONE || '').replace(/\D/g, '');
  if (!phone) throw new Error('WA_PHONE חסר');
  await api('auth_clear'); // התחלה נקייה, פעם אחת בלבד
  const end = Date.now() + 9 * 60 * 1000;
  let sock = null, opened = false;
  while (Date.now() < end && !opened) {
    try { sock?.end(undefined); } catch {}
    sock = await connect();
    const registered = !!sock.authState.creds.registered;
    console.log('WA-STEP connect, registered =', registered);
    const waiting = waitEvent(sock, 3 * 60 * 1000);
    if (!registered) {
      await sleep(4000);
      try {
        const code = await sock.requestPairingCode(phone);
        await api('auth_set', { items: [{ key: 'pairing_code', value: JSON.stringify({ code, at: new Date().toISOString() }) }] }).catch(() => {});
        console.log('==================================================');
        console.log('WA-STEP קוד חיבור נוצר ונשמר בטבלה (לא מודפס כי הלוגים ציבוריים)');
        console.log('==================================================');
      } catch (e) { console.log('WA-ERR requestPairingCode', e.message); await sleep(5000); continue; }
    }
    const r = await waiting;
    if (r.open) { opened = true; break; }
    // אחרי הכנסת הקוד וואטסאפ מנתק וצריך להתחבר מחדש עם אותם פרטים (בלי למחוק כלום)
    if (sock.authState.creds.registered) { console.log('WA-STEP נרשם, מתחבר מחדש'); await sleep(2000); continue; }
    throw new Error('הקוד פג או נדחה (' + (r.code || r.msg || 'timeout') + '). מריצים שוב, קוד אחד בכל הרצה כדי לא להיחסם.');
  }
  if (!opened) throw new Error('לא הצליח לחבר. להריץ שוב.');
  console.log('מחובר. אוסף אנשי קשר 90 שניות...');
  await sleep(90000);
  console.log('סיום חיבור. אפשר לסגור.');
  sock.end(undefined);
}

async function send() {
  const started = Date.now();
  // התאוששות: בגלל concurrency אין ריצה מקבילה, לכן כל מה שנשאר ב-sending הוא תקוע מקריסה. לא שולחים שוב (מניעת כפילות)
  try {
    const r = await api('queue_recover', {});
    if (r?.recovered) console.log('WA-STEP שוחזרו תקועים:', r.recovered);
  } catch (e) { console.log('WA-WARN queue_recover לא זמין בגשר:', e.message); }

  const { rows: due } = await api('queue_due');
  if (!due?.length) { console.log('WA-STEP אין סטטוסים לשליחה'); return; }
  console.log('WA-STEP בתור לשליחה:', due.length);

  const { clients, contacts } = await api('audience');
  const list = buildAudience(clients, contacts);
  console.log('WA-STEP קהל:', list.length);
  if (!list.length) throw new Error('NO_AUDIENCE: אין נמענים, לא נשלח כלום (הפריטים נשארים בתור)');

  const sock = await connect();
  if (!sock.authState.creds.registered) throw new Error('NOT_PAIRED: וואטסאפ לא מחובר, להריץ pair');
  await waitOpen(sock, 60000);
  console.log('WA-STEP מחובר');
  await sleep(4000);
  const res = await processQueue({ api, sock, due, list, chunkSize: Number(process.env.WA_CHUNK) || 1000, deadline: started + 8 * 60 * 1000, splitter: splitVideo });
  console.log('WA-STEP סיכום', JSON.stringify(res));
  await sleep(3000);
  sock.end(undefined);
  if (res.failed) process.exitCode = 1;
}

try { await (mode === 'pair' ? pair() : send()); process.exit(process.exitCode || 0); }
catch (e) { console.error('WA-ERR', e.message); process.exit(1); }
