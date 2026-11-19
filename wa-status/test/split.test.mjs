import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendItem } from '../src/lib.mjs';
import { splitVideo } from '../src/split.mjs';

const mkSock = () => { const sent = []; return { sent, sendMessage: async (jid, content, opts) => { sent.push({ content, opts }); } }; };

test('סרטון ארוך נשלח כחלקים עם כיתוב (1/3)', async () => {
  const sock = mkSock(); let cleaned = false;
  const splitter = async () => ({ paths: ['/a', '/b', '/c'], cleanup: async () => { cleaned = true; } });
  await sendItem(sock, { kind: 'video', media_url: 'http://x', body: 'שלום' }, ['1@s.whatsapp.net'], 1000, 0, splitter);
  assert.deepEqual(sock.sent.map((s) => s.content.caption), ['שלום (1/3)', 'שלום (2/3)', 'שלום (3/3)']);
  assert.equal(cleaned, true);
});

test('סרטון קצר נשלח כמו שהוא', async () => {
  const sock = mkSock();
  await sendItem(sock, { kind: 'video', media_url: 'http://x', body: 'a' }, ['1@s.whatsapp.net'], 1000, 0, async () => null);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].content.caption, 'a');
});

test('פיצול אמיתי עם ffmpeg: סרטון של 25 שניות ל-3 חלקים של 10', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t-'));
  const f = join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=25:size=160x120:rate=15', '-f', 'lavfi', '-i', 'sine=duration=25', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', f], { stdio: 'ignore' });
  const data = readFileSync(f);
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'video/mp4' }); r.end(data); });
  await new Promise((r) => srv.listen(0, r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/v.mp4`;
    assert.equal(await splitVideo(url, 60), null); // קצר מהמגבלה
    const parts = await splitVideo(url, 10);
    assert.equal(parts.paths.length, 3);
    for (const p of parts.paths) assert.ok(existsSync(p));
    await parts.cleanup();
    assert.ok(!existsSync(parts.paths[0]));
  } finally { srv.close(); }
});
