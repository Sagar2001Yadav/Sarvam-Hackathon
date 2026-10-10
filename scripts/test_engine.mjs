// Offline test of the page's audio engine (VAD, barge-in, WAV encoder) with synthetic + real audio. Server must be running.
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
const code = js.slice(js.indexOf("const eng={"), js.indexOf("async function openMic")).replace(/\r/g, "");
const make = () => new Function(`${code}\nreturn {eng,onFrame,toWav16k};`)();

const SR = 48000, N = 2048;
const frame = (amp) => Float32Array.from({ length: N }, (_, i) => amp * Math.sin(i / 5) + (Math.random() - 0.5) * 0.002);
const run = (E, amps) => amps.forEach((a) => E.onFrame(frame(a)));
const fr = (ms) => Math.round(ms / (N / SR * 1000));
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); ok ? pass++ : fail++; };

// 1. listen mode: quiet, then speech, then quiet -> one utterance
{
  const { eng, onFrame } = make(); eng.sr = SR; eng.mode = "listen";
  let got = null; eng.waiter = (u) => (got = u);
  const quiet = Array(fr(600)).fill(0.003), speech = Array(fr(1500)).fill(0.12), tail = Array(fr(1200)).fill(0.003);
  [...quiet, ...speech, ...tail].forEach((a) => onFrame(frame(a)));
  check("1. speech after quiet is captured as one utterance", !!got && got.barged === false && got.ms > 1200, got ? `(${got.ms} ms, wav ${got.wav.size} bytes)` : "");
}
// 2. bot speaking: quiet echo does NOT interrupt
{
  const { eng, onFrame } = make(); eng.sr = SR; eng.mode = "bot"; let started = false; eng.onStart = () => (started = true);
  [...Array(fr(800)).fill(0.02)].forEach((a) => onFrame(frame(a)));
  check("2. bot's own echo (low level) does not trigger an interruption", !started && !eng.inSpeech);
}
// 3. bot speaking: real speech interrupts and is captured including pre-roll
{
  const { eng, onFrame } = make(); eng.sr = SR; eng.mode = "bot"; let started = 0; let got = null;
  eng.onStart = () => { started++; eng.mode = "listen"; }; eng.waiter = (u) => (got = u);
  [...Array(fr(500)).fill(0.015), ...Array(fr(1400)).fill(0.14), ...Array(fr(1200)).fill(0.003)].forEach((a) => onFrame(frame(a)));
  check("3. user speaking over the bot interrupts it once and is captured (barged=true)", started === 1 && !!got && got.barged === true, got ? `(${got.ms} ms)` : "");
}
// 4. short click ignored
{
  const { eng, onFrame } = make(); eng.sr = SR; eng.mode = "listen"; let got = null; eng.waiter = (u) => (got = u);
  [...Array(fr(400)).fill(0.003), ...Array(fr(120)).fill(0.2), ...Array(fr(1500)).fill(0.003)].forEach((a) => onFrame(frame(a)));
  check("4. a 120 ms click is ignored", got === null && !eng.pending);
}
// 5. utterance with nobody waiting is kept as pending (seller spoke over an acknowledgement)
{
  const { eng, onFrame } = make(); eng.sr = SR; eng.mode = "listen";
  [...Array(fr(300)).fill(0.003), ...Array(fr(1200)).fill(0.12), ...Array(fr(1200)).fill(0.003)].forEach((a) => onFrame(frame(a)));
  check("5. speech with no listener waiting is kept as pending", !!eng.pending);
}
// 6. real speech: TTS wav -> frames -> engine -> WAV encoder -> Sarvam speech-to-text
{
  const tts = await (await fetch("http://localhost:3000/api/tts", { method: "POST", body: JSON.stringify({ text: "haan address sahi hai" }) })).json();
  const b = Buffer.from(tts.audio, "base64");
  const sr = b.readUInt32LE(24); let p = 12; while (b.toString("ascii", p, p + 4) !== "data") p += 8 + b.readUInt32LE(p + 4);
  const n = b.readUInt32LE(p + 4) / 2, pcm = new Float32Array(n); for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
  const { eng, onFrame } = make(); eng.sr = sr; eng.mode = "listen"; let got = null; eng.waiter = (u) => (got = u);
  const pad = new Float32Array(2048).fill(0);
  for (let i = 0; i < 8; i++) onFrame(pad);
  for (let i = 0; i + 2048 <= pcm.length; i += 2048) onFrame(pcm.slice(i, i + 2048));
  for (let i = 0; i < Math.ceil(sr * 1.4 / 2048); i++) onFrame(pad);
  const wav = got ? Buffer.from(await got.wav.arrayBuffer()) : null;
  const res = wav && (await (await fetch("http://localhost:3000/api/voice?mode=translit&seed=0", { method: "POST", body: wav })).json());
  check("6. engine's WAV is accepted by Sarvam speech-to-text and understood", !!res?.transcript, res ? `-> "${res.transcript}"` : "(no utterance)");
}
console.log(`\n${pass} passed, ${fail} failed`);
