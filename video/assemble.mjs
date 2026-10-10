// Builds the soundtrack from the logged events, removes dead air inside the call, and muxes with the screen recording -> out/demo.mp4
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("out");
const LEAD = +(process.env.LEAD_MS ?? 300) / 1000;   // the video starts slightly after the clock the events use
const GAP_MAX = +(process.env.GAP_MAX ?? 1.5);        // silent gaps inside the call longer than this are shortened ...
const GAP_KEEP = +(process.env.GAP_KEEP ?? 0.8);      // ... to this
const FF = execFileSync("python", ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"]).toString().trim();
const { events } = JSON.parse(fs.readFileSync(path.join(OUT, "events.json"), "utf8"));
const wavSec = (f) => { const b = fs.readFileSync(f); let p = 12; while (b.toString("ascii", p, p + 4) !== "data") p += 8 + b.readUInt32LE(p + 4); return b.readUInt32LE(p + 4) / b.readUInt32LE(28); };

// ringing phone
const SR = 24000, ringFile = path.join(OUT, "ring.wav");
{
  const n = Math.floor(3.4 * SR), pcm = Buffer.alloc(n * 2);
  for (const t0 of [0, 0.6, 2.2, 2.8]) for (let i = 0; i < 0.4 * SR; i++) { const k = Math.floor(t0 * SR) + i; if (k < n) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 425 * i) / SR) * 0.3 * 32767), k * 2); }
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(ringFile, Buffer.concat([h, pcm]));
}

// ---- clips in video time
const clips = []; let lastBot = null;
for (const e of events) {
  if (e.type === "cut" && lastBot) { lastBot.cut = (e.t / 1000 - LEAD) - lastBot.v; continue; }
  if (e.type === "ring") { clips.push({ file: ringFile, v: e.t / 1000 - LEAD, vol: 0.5, type: "ring" }); continue; }
  if (!e.file) continue;
  const c = { file: e.file, v: e.t / 1000 - LEAD, vol: { bot: 1.0, seller: 0.95, narr: 1.15 }[e.type] ?? 1, cut: null, type: e.type };
  clips.push(c); if (e.type === "bot") lastBot = c;
}
for (const c of clips) { c.dur = Math.min(wavSec(c.file), c.cut ?? 1e9); c.end = c.v + c.dur; }

// ---- find dead air inside the call (between the ring and the last bot line)
const callStart = clips.find((c) => c.type === "ring").v - 0.3;
const callEnd = Math.max(...clips.filter((c) => c.type === "bot" || c.type === "seller").map((c) => c.end)) + 1.2;
const spans = clips.filter((c) => c.end > callStart && c.v < callEnd).map((c) => [Math.max(c.v, callStart), Math.min(c.end, callEnd)]).sort((a, b) => a[0] - b[0]);
const removed = []; let cursor = callStart;
for (const [a, b] of spans) { if (a - cursor > GAP_MAX) removed.push([cursor + GAP_KEEP * 0.45, a - GAP_KEEP * 0.55]); cursor = Math.max(cursor, b); }
const shift = (t) => t - removed.reduce((s, [a, b]) => s + (t >= b ? b - a : t > a ? t - a : 0), 0);
const total = JSON.parse(fs.readFileSync(path.join(OUT, "events.json"), "utf8")).total / 1000;
const keep = []; let from = 0;
for (const [a, b] of removed) { keep.push([from, a]); from = b; }
keep.push([from, total + 2]);

// ---- ffmpeg graph
const inputs = ["-i", path.join(OUT, "screen.webm"), ...clips.flatMap((c) => ["-i", c.file])];
const vparts = keep.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
const vcat = `${keep.map((_, i) => `[v${i}]`).join("")}concat=n=${keep.length}:v=1:a=0[vout]`;
const achains = clips.map((c, i) => {
  const d = Math.max(0, Math.round(shift(c.v) * 1000));
  const trim = c.cut ? `,atrim=0:${c.cut.toFixed(2)},afade=t=out:st=${Math.max(0, c.cut - 0.1).toFixed(2)}:d=0.1` : "";
  return `[${i + 1}:a]aresample=24000,aformat=channel_layouts=mono${trim},volume=${c.vol},adelay=${d}|${d}[a${i}]`;
});
const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95[aout]`;
fs.writeFileSync(path.join(OUT, "filter.txt"), [...vparts, vcat, ...achains, mix].join(";\n"));
const out = path.join(OUT, "demo.mp4");
execFileSync(FF, ["-y", ...inputs, "-filter_complex_script", path.join(OUT, "filter.txt"), "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "160k", "-shortest", out], { stdio: ["ignore", "ignore", "pipe"] });
const removedSec = removed.reduce((s, [a, b]) => s + (b - a), 0);
console.log(`written ${out} ${(fs.statSync(out).size / 1e6).toFixed(1)} MB | clips ${clips.length} | dead air removed ${removedSec.toFixed(0)}s in ${removed.length} gaps`);
