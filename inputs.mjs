import { SarvamAIClient } from "sarvamai";

const client = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Visiting card / brochure (image or PDF) -> text, via Sarvam Document Intelligence.
export async function readCard(buf, name = "card", type = "application/octet-stream") {
  const file = new File([buf], name, { type });
  const job = await client.docAi.digitise({ file: [file], language: "en-IN", output_format: "md", content_type: "mixed" });
  const id = job.job_id;
  let st;
  for (let i = 0; i < 40; i++) {
    st = await client.docAi.getStatus(id);
    if (["completed", "partially_completed", "failed", "rejected"].includes(st.status)) break;
    await sleep(1500);
  }
  if (!st || !["completed", "partially_completed"].includes(st.status)) throw new Error(`document job ${st?.status || "timed out"}`);
  const res = await client.docAi.getResults(id, { format: "json" });
  return collectText(res).join("\n").slice(0, 8000);
}

// documents[].pages[].blocks[].text, in reading order
function collectText(res) {
  const lines = [];
  for (const d of res?.documents || []) for (const p of d.pages || []) {
    const blocks = [...(p.blocks || [])].sort((x, y) => (x.reading_order || 0) - (y.reading_order || 0));
    for (const b of blocks) if (b.text && b.text.trim()) lines.push(b.text.trim());
  }
  return lines;
}

// Voice -> transcript (Hindi / English / Hinglish) via Sarvam Saaras.
export async function transcribe(buf, type = "audio/webm", mode = "codemix") {
  type = type.split(";")[0].trim(); // browsers send "audio/webm;codecs=opus"; the API wants the bare type
  const file = new File([buf], "speech." + (type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm"), { type });
  const r = await client.speechToText.transcribe({ file, model: "saaras:v3", mode, language_code: "unknown" });
  return { transcript: r.transcript || "", language_probability: r.language_probability ?? null };
}

// Assistant voice: Sarvam Bulbul text-to-speech (returns base64 WAV).
const audioCache = new Map(); // same line -> same audio (greeting, consent, fixed questions)

// Roman Hinglish is read stiffly by a Hindi voice; Devanagari spoken-form text sounds natural (English words stay Indian-accented, digits read one by one).
async function toSpokenHindi(text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await client.text.transliterate({ input: text, source_language_code: "en-IN", target_language_code: "hi-IN", spoken_form: true, numerals_format: "native" });
      if (r.transliterated_text) return r.transliterated_text;
    } catch { await sleep(300); }
  }
  return text; // fall back to the original text rather than failing the call
}

export async function speak(text, opts = {}) {
  const { speaker = "priya", lang = "hi-IN", pace = 1.0 } = opts;
  const key = `${speaker}|${lang}|${pace}|${String(text).slice(0, 1400)}`;
  if (audioCache.has(key)) return audioCache.get(key);
  const t = String(text).slice(0, 1400);
  const spoken = lang !== "hi-IN" || /[ऀ-ॿ]/.test(t) ? t : await toSpokenHindi(t);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) { // Sarvam TTS occasionally fails with a transient network error
    try {
      const r = await client.textToSpeech.convert({
        text: spoken, target_language_code: lang, model: "bulbul:v3", speaker,
        pace, temperature: 0.5, speech_sample_rate: 24000, enable_preprocessing: true,
      });
      audioCache.set(key, r.audios[0]);
      return r.audios[0];
    } catch (e) { last = e; await sleep(500 * 2 ** attempt); }
  }
  throw last;
}
