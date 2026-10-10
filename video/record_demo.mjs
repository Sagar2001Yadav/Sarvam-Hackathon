// Records the demo: the real page runs the real call logic; the seller is a scripted male Sarvam voice whose audio goes through
// the real speech-to-text. Every sound is logged with its timing so the soundtrack can be assembled exactly (see assemble.mjs).
// Usage (server running on :3000):  node record_demo.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const B = "http://localhost:3000";
const OUT = path.resolve("out");
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wavMs = (b64) => { const b = Buffer.from(b64, "base64"); let p = 12; while (b.toString("ascii", p, p + 4) !== "data") p += 8 + b.readUInt32LE(p + 4); return Math.round((b.readUInt32LE(p + 4) / b.readUInt32LE(28)) * 1000); };
const post = (p, b) => fetch(B + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
const tts = async (text, o = {}) => { const r = await post("/api/tts", { text, ...o }); if (!r.audio) throw new Error("tts failed: " + JSON.stringify(r)); return r.audio; };

// ------------------------------------------------------------------ script
const NARR = {
  intro: "This is IndiaMART's seller verification voice agent. It phones a seller, confirms the details we hold, field by field, and records every answer with evidence, a confidence score and an audit trail.",
  record: "Here is the stored record for Raghav Enterprises, loaded from a CSV and treated as unverified. The seller is played by a second voice, heard through real speech recognition.",
  afterCall: "Every field was classified, scored and stored. The corrected address and the new product list are flagged for human review.",
  audit: "The reviewer sees the previous value, the proposed value, the seller's own words and why it was flagged. Nothing is overwritten until approved. Here, the new address is approved.",
  outro: "Twenty eight conversation scenarios and thirteen of thirteen field classifications passed. On one hundred dataset sellers, about ninety three percent of fields were filled automatically. Built on Sarvam voice, speech and language models, with the agent also created through the Sarvam MCP.",
};
const SELLER = [
  { text: "Hello?", cap: "The seller picks up and speaks first, like a real call" },
  { text: "Haan ji, boliye.", cap: "The bot introduces itself and confirms who it is speaking to" },
  { text: "Nahi.", cap: "A first 'no' never ends the call: the bot reassures and asks again" },
  { text: "Haan theek hai, bolo.", cap: "Agreed. The bot moves on to verifying each stored field" },
  { text: "Haan, bilkul sahi hai.", cap: "Company name confirmed: no audit needed" },
  { text: "Nahi nahi, ab hamara address Sector 62 Noida hai.", cap: "The seller interrupts mid-sentence: the bot stops and listens", interrupt: { startsWith: "Aur address", afterMs: 2700 } },
  { text: "Pehle ye bataiye, aap kaun bol rahi hain aur ye sab kyun chahiye?", cap: "The seller asks questions: the bot answers, then returns to its question" },
  { text: "Website raghav enterprises dot in hai.", cap: "A new value: validated (live domain check) and scored" },
  { text: "Hum LED lights aur panel lights banate hain.", cap: "Products are mapped to the IndiaMART category taxonomy" },
  { text: "Nahi, bas.", cap: "Closing like a person: summary, questions, goodbye" },
  { text: "Namaste.", cap: "" },
];

// ------------------------------------------------------------------ prepare audio
console.log("synthesising seller lines…");
for (const s of SELLER) { s.wav = await tts(s.text, { speaker: "aditya" }); s.ms = wavMs(s.wav); }
await post("/api/reset", {});

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const events = []; let nClip = 0;
const t0 = Date.now();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const addEvent = (e) => {
  const ev = { type: e.type, t: e.at - t0, text: e.text };
  if (e.audio) { ev.file = path.join(OUT, `clip${String(++nClip).padStart(3, "0")}.wav`); fs.writeFileSync(ev.file, Buffer.from(e.audio, "base64")); }
  events.push(ev); return ev;
};
await page.exposeFunction("__evt", addEvent);
page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

const caption = (t) => page.evaluate((t) => window.__cap && window.__cap(t), t);
async function narrate(key, cap) {
  await caption(cap || "");
  const b64 = await tts(NARR[key], { speaker: "ritu", lang: "en-IN", pace: 1.02 });
  addEvent({ type: "narr", at: Date.now(), audio: b64, text: NARR[key] });
  await sleep(wavMs(b64) + 500);
}

await page.goto(B + "/");
await page.addStyleTag({ content: "body{zoom:.8}.cols{grid-template-columns:1fr!important}.cols .card:nth-child(2){display:none}#dlog{max-height:200px!important}#cap{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:1000px;background:rgba(6,36,92,.94);color:#fff;font:600 22px system-ui;padding:10px 22px;border-radius:12px;z-index:9;text-align:center;display:none}#slide{position:fixed;inset:0;background:linear-gradient(135deg,#06245c,#0b3a8a);color:#fff;z-index:20;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px;font-family:system-ui}#slide h1{font-size:54px;margin:0 0 14px}#slide p{font-size:26px;max-width:980px;line-height:1.4;margin:6px 0;opacity:.95}#slide .row{display:flex;gap:26px;margin-top:26px}#slide .box{background:rgba(255,255,255,.12);border-radius:14px;padding:16px 26px}#slide .box b{display:block;font-size:42px}" });
await page.evaluate(() => {
  const cap = document.createElement("div"); cap.id = "cap"; document.body.append(cap);
  window.__cap = (t) => { cap.textContent = t || ""; cap.style.display = t ? "block" : "none"; };
  const sl = document.createElement("div"); sl.id = "slide"; document.body.append(sl);
  window.__slide = (html) => { sl.innerHTML = html || ""; sl.style.display = html ? "flex" : "none"; };
});

// demo hooks: scripted seller + event logging; the bot's own say()/dialog()/steps run unchanged
await page.evaluate((script) => {
  window.__q = script;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  tts("Koi baat nahi ji. Bas kuch cheezein confirm karni hain, aapko koi form nahi bharna padega. Kya abhi do minute de sakte hain?");
  window.openMic = async () => { eng.ctx = new AudioContext(); await eng.ctx.resume(); eng.sr = eng.ctx.sampleRate; eng.gain = eng.ctx.createGain(); eng.gain.gain.value = 2.5; eng.comp = eng.ctx.createDynamicsCompressor(); eng.gain.connect(eng.comp); eng.comp.connect(eng.ctx.destination); eng.mode = "idle"; };
  window.ring = async (ms) => { $("dstat").textContent = "📞 ringing…"; window.__evt({ type: "ring", at: Date.now() }); await sleep(ms); };
  const origSay = window.say;
  window.say = async (t) => {
    const a = await tts(t);
    window.__evt({ type: "bot", at: Date.now(), text: t, audio: a });
    const next = window.__q[0];
    if (next && next.interrupt && t.startsWith(next.interrupt.startsWith)) {
      setTimeout(() => { window.__evt({ type: "cut", at: Date.now() }); window.__barge = true; eng.onStart && eng.onStart(); }, next.interrupt.afterMs);
    }
    await origSay(t);
  };
  window.ask = async (t, pat) => { asking++; if (t) await say(t); return listen(); };
  window.listen = async () => {
    const item = window.__q.shift();
    if (!item) return { transcript: "", language_probability: null };
    const barged = !!window.__barge; window.__barge = false;
    if (item.cap) window.__cap(item.cap);
    if (!barged) await sleep(850);
    $("dstat").textContent = "🎤 listening…";
    window.__evt({ type: "seller", at: Date.now(), audio: item.wav, text: item.text });
    await sleep(item.ms);
    $("dstat").textContent = "understanding…";
    const bytes = Uint8Array.from(atob(item.wav), (c) => c.charCodeAt(0));
    const d = await (await fetch("/api/voice?mode=translit&seed=0", { method: "POST", body: bytes })).json();
    log("Seller", d.transcript || "(no speech)"); $("dstat").textContent = "";
    return { ...d, barged };
  };
}, SELLER.map((s) => ({ wav: s.wav, ms: s.ms, cap: s.cap, text: s.text, interrupt: s.interrupt })));

// ------------------------------------------------------------------ scenes
console.log("scene: intro");
await page.evaluate(() => window.__slide(`<h1>Seller Verification Voice Agent</h1><p>Outbound calls that confirm a seller's profile field by field, with evidence, confidence scores and a manual audit trail</p><p style="opacity:.7;margin-top:30px">IndiaMART × Sarvam AI</p>`));
await narrate("intro");
await page.evaluate(() => window.__slide(""));

console.log("scene: stored record");
await page.selectOption("#sel", "D001");
await page.evaluate(() => { document.getElementById("ref").textContent = "Reference record: Contact person: Raghav · Company name: Raghav Enterprises · Address: ABC, Noida, Uttar Pradesh · Website: — · Products: —"; });
await narrate("record", "Stored record (CSV) → unverified");

console.log("scene: the call");
await caption("");
await page.click("#call");
const callStart = Date.now();
await page.waitForFunction(() => document.getElementById("dlog").textContent.includes("ended:"), null, { timeout: 420000 });
console.log(`call finished in ${Math.round((Date.now() - callStart) / 1000)}s`);
await sleep(1500);
await caption("");
await narrate("afterCall", "Every field: classification · extraction confidence · value reliability · audit status");
await sleep(500);

console.log("scene: audit");
await page.goto(B + "/audit");
await page.addStyleTag({ content: "body{zoom:.9}#cap{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:1000px;background:rgba(6,36,92,.94);color:#fff;font:600 22px system-ui;padding:10px 22px;border-radius:12px;z-index:9;text-align:center}" });
await page.evaluate(() => { const c = document.createElement("div"); c.id = "cap"; document.body.append(c); window.__cap = (t) => { c.textContent = t || ""; c.style.display = t ? "block" : "none"; }; });
await sleep(800);
const narrP = narrate("audit", "Manual audit: approve, reject or edit. Previous values are always kept");
await sleep(6500);
// approve the corrected address
const card = page.locator(".ev", { hasText: "address" }).first();
await card.locator("input[placeholder='note']").fill("Verified with the seller on the call");
await sleep(1200);
await card.locator("button.ok").click();
await narrP;
await sleep(800);
await page.click("button[data-k='approved']");
await caption("Approved by reviewer: the stored address now changes, history is kept");
await sleep(3500);
await page.click("button[data-k='']");
await sleep(3000);

console.log("scene: outro");
await page.evaluate(() => { const sl = document.createElement("div"); sl.id = "slide"; sl.style.cssText = "position:fixed;inset:0;background:linear-gradient(135deg,#06245c,#0b3a8a);color:#fff;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px;font-family:system-ui"; sl.innerHTML = `<h1 style="font-size:50px;margin:0 0 10px">What was shown, and the results</h1><p style="font-size:24px;max-width:1000px;line-height:1.45">Outbound call · wait for hello · interruptions · handles any reply · field-level classification · confidence scores · audit trail · manual review</p><div style="display:flex;gap:24px;margin-top:28px">${[["28/28", "conversation scenarios"], ["13/13", "field classifications"], ["93.5%", "fields auto-filled (100 sellers)"], ["97.9%", "people found (GST partners)"]].map(([a, b]) => `<div style="background:rgba(255,255,255,.12);border-radius:14px;padding:16px 26px"><b style="display:block;font-size:42px">${a}</b>${b}</div>`).join("")}</div><p style="opacity:.75;margin-top:30px;font-size:22px">Sarvam speech-to-text · text-to-speech · LLM · Voice Agents MCP</p>`; document.body.append(sl); });
await narrate("outro");
await sleep(1500);

const videoPath = await page.video().path();
await ctx.close(); await browser.close();
const finalVideo = path.join(OUT, "screen.webm");
fs.renameSync(videoPath, finalVideo);
fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify({ events, total: Date.now() - t0 }, null, 1));
console.log("recorded:", finalVideo, "events:", events.length, "total s:", Math.round((Date.now() - t0) / 1000));
