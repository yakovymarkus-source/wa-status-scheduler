// WA-API: לקוח קטן מול הגשר המאובטח בסופאבייס (פונקציית wa-status-api). אין כאן מפתח סופאבייס, רק טוקן.
const base = () => `${process.env.SUPABASE_URL}/functions/v1/wa-status-api`;

export async function api(op, payload = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(base(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WA_API_TOKEN}` },
        body: JSON.stringify({ op, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      if (res.status < 500) throw new Error(`API_${res.status}: ${body.error || ''}`);
      throw new Error(`API_${res.status}`);
    } catch (e) {
      if (attempt === 3 || String(e.message).startsWith('API_4')) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}
