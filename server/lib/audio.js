// Audio conversion with ffmpeg (bundled by ffmpeg-static, no install needed).
// Voice memories are stored as .m4a, which every browser and iMessage can play.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let ffmpegPath;
async function ffmpeg() {
  if (ffmpegPath === undefined) {
    try {
      ffmpegPath = (await import('ffmpeg-static')).default ?? 'ffmpeg';
    } catch {
      ffmpegPath = 'ffmpeg';
    }
  }
  return ffmpegPath;
}

export async function transcode(buffer, ext, args) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'td-audio-'));
  const input = path.join(dir, 'in');
  const output = path.join(dir, `out.${ext}`);
  try {
    await fs.writeFile(input, buffer);
    const bin = await ffmpeg();
    await new Promise((resolve, reject) => {
      const p = spawn(bin, ['-y', '-i', input, ...args, output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop()}`))));
    });
    return await fs.readFile(output);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const toM4a = (buffer) => transcode(buffer, 'm4a', ['-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-t', '60']);
export const toMp3 = (buffer) => transcode(buffer, 'mp3', ['-vn', '-ac', '1', '-b:a', '64k', '-t', '60']);
