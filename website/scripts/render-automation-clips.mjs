// Turns the raw recordings from capture-automation-video.mjs into the site's clips.
// For each <clip>.webm and <clip>.json in <rawDir> it trims to the clip, applies the recorded zoom beats as an
// eased zoom and pan (smoothstep between beats, so it eases in and out), encodes H.264 and VP9 at 1600x900,
// and takes a poster frame from the end, when the view is back to full. Needs ffmpeg.
//
//   node website/scripts/render-automation-clips.mjs <rawDir> [build,live,lab,flows]
// Outputs <rawDir>/video-automation-<clip>.mp4 / .webm / -poster.jpg, which `pnpm media <rawDir>` picks up.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const dir = process.argv[2];
const clips = (process.argv[3] || 'build,live,lab,flows').split(',');
const W = 1600, H = 900;

// value(t) = start + sum of (to - from) * smoothstep over each beat
const track = (beats, key, start, t0) => {
  const terms = beats.map((b) => {
    const a = (b.t0 - t0).toFixed(3), d = Math.max(0.05, b.t1 - b.t0).toFixed(3);
    const p = `clip((t-${a})/${d},0,1)`;
    return `(${(b.to[key] - b.from[key]).toFixed(5)})*(${p}*${p}*(3-2*${p}))`;
  });
  return `(${start}${terms.length ? '+' + terms.join('+') : ''})`;
};

for (const name of clips) {
  const m = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  const z = track(m.beats, 'z', 1, m.start);
  const cx = track(m.beats, 'cx', 0.5, m.start);
  const cy = track(m.beats, 'cy', 0.5, m.start);
  const vf = [
    'fps=30',
    'format=yuv444p',
    `scale=w='${W}*${z}':h='${H}*${z}':eval=frame:flags=lanczos`,
    `crop=w=${W}:h=${H}:x='clip(${cx}*${W}*${z}-${W / 2},0,${W}*${z}-${W})':y='clip(${cy}*${H}*${z}-${H / 2},0,${H}*${z}-${H})'`,
    'format=yuv420p',
  ].join(',');
  const script = join(dir, `${name}.filter`);
  writeFileSync(script, vf);
  const dur = (m.end - m.start).toFixed(2);
  // the screencast frames, each shown until the next one arrives
  const list = m.frames.map(([f, ts], i) => `file '${f}'\nduration ${(i + 1 < m.frames.length ? m.frames[i + 1][1] - ts : Math.max(0.05, m.end - ts)).toFixed(4)}`);
  list.push(`file '${m.frames.at(-1)[0]}'`);
  writeFileSync(join(dir, `${name}.txt`), list.join('\n'));
  const skip = Math.max(0, m.start - m.frames[0][1]).toFixed(3);
  const common = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-ss', skip, '-t', dur, '-i', join(dir, `${name}.txt`), '-an', '-/filter:v', script];
  const base = join(dir, `video-automation-${name}`);
  execFileSync(FFMPEG, [...common, '-c:v', 'libx264', '-profile:v', 'high', '-crf', process.env.CRF || '27', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${base}.mp4`]);
  execFileSync(FFMPEG, [...common, '-c:v', 'libvpx-vp9', '-crf', process.env.CRFW || '37', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', `${base}.webm`]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(Math.max(0, Number(dur) - 0.3)), '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '3', `${base}-poster.jpg`]);
  console.log(name, `${dur} s`);
}
