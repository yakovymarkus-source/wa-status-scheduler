import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'http://x'; process.env.WA_API_TOKEN = 't';
const { api } = await import('../src/api.mjs');
const mk = (...rs) => { let i = 0; globalThis.fetch = async () => { const r = rs[Math.min(i++, rs.length - 1)]; if (r instanceof Error) throw r; return { ok: r < 400, status: r, json: async () => ({ v: r }) }; }; return () => i; };
test('api: 500 ואז הצלחה (retry)', async () => { const n = mk(500, 200); assert.equal((await api('x')).v, 200); assert.equal(n(), 2); });
test('api: 401 לא מנסה שוב', async () => { const n = mk(401); await assert.rejects(api('x'), /API_401/); assert.equal(n(), 1); });
test('api: שגיאת רשת 3 פעמים נכשל', async () => { const n = mk(new Error('net')); await assert.rejects(api('x'), /net/); assert.equal(n(), 3); });
