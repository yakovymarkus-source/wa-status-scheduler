// WA-SPLIT: מפצל סרטון ארוך לחלקים בגודל המותר לסטטוס. ffmpeg מותקן מראש ב-GitHub Actions.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
export const MAX_SEC = Number(process.env.WA_VIDEO_MAX_SEC) || 60;

// מחזיר null אם אין צורך בפיצול; אחרת { paths:[...], cleanup() }
export async function splitVideo(url, maxSec = MAX_SEC) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-split-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('SPLIT_DOWNLOAD_' + res.status);
    const src = join(dir, 'src.mp4');
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src]);
    const dur = parseFloat(stdout);
    if (!(dur > 0)) throw new Error('SPLIT_NO_DURATION');
    if (dur <= maxSec + 1) { await cleanup(); return null; }
    console.log(`WA-STEP סרטון ארוך (${Math.round(dur)} שניות), מפצל לחלקים של ${maxSec} שניות`);
    await run('ffmpeg', ['-y', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac',
      '-force_key_frames', `expr:gte(t,n_forced*${maxSec})`, '-f', 'segment', '-segment_time', String(maxSec),
      '-reset_timestamps', '1', join(dir, 'part%03d.mp4')]);
    const files = (await readdir(dir)).filter((f) => /^part\d+\.mp4$/.test(f)).sort().map((f) => join(dir, f));
    if (files.length < 2) throw new Error('SPLIT_FAILED');
    return { paths: files, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
