import { readFileSync } from "node:fs";
import { llmJson, mapCategories, loadFeedback } from "./lib.mjs";
import { addressText } from "./db.mjs";

const GEO = JSON.parse(readFileSync(new URL("./data/geo.json", import.meta.url), "utf8"));
const LEADS = Object.fromEntries(JSON.parse(readFileSync(new URL("./data/leads.json", import.meta.url), "utf8")).map((l) => [l.glid, l]));

export const CLASSES = ["confirmed", "corrected", "newly_provided", "unconfirmed", "ambiguous", "not_answered"];

// ---------------------------------------------------------------- scoring constants (documented; shown in the audit UI)
export const SCORING = {
  note: "Estimated confidence measures, NOT calibrated probabilities.",
  extraction_base: { confirmed: 0.90, corrected: 0.85, newly_provided: 0.80, unconfirmed: 0.35, ambiguous: 0.30, not_answered: 0 },
  clarity: { explicit: 1.0, hedged: 0.8, unclear: 0.6 },
  asr: { noisy: 0.85, low_language_probability: 0.9 },
  consistency: { high: 1.0, medium: 0.9, low: 0.75 },
  contradiction: 0.75,
  source_prior: { csv: 0.70, demo: 0.70, enrichment: 0.65, seller: 0.70 },
  audit_thresholds: { min_extraction: 0.75, min_reliability: 0.70, auto_approve_website_extraction: 0.85 },
  audit_rules: [
    "ambiguous or unconfirmed response",
    "contradictory statements about the same field",
    "validation failed (format, pincode/state mismatch, ...)",
    "extraction confidence < 0.75",
    "estimated value reliability < 0.70 for a new or corrected value",
    "any corrected value is a material change (auto-approved only for a reachable website with extraction >= 0.85)",
  ],
};

// ---------------------------------------------------------------- 1. classify the seller's utterance
const FACTS = `Facts you may use when replying: you are a voice assistant calling on behalf of IndiaMART to verify the seller's business profile so buyers can find correct details. Nothing is sold or paid for on this call. You never ask for OTP, bank details, passwords or card numbers. Answers are recorded and IndiaMART's team checks them before a profile is changed. The seller may refuse any question or ask you to stop. Do not promise anything about leads, pricing or rankings. You are a woman: use feminine Hindi verb forms (bol rahi hoon, karti hoon, samajh gayi).`;
const PROMPT = `You are the language-understanding layer of an OUTBOUND seller verification call (Hindi / English / Hinglish, romanised transcript, may contain recognition errors). Real sellers say anything: they ask questions, get busy, get annoyed, change topic, mumble or stay silent. Be ready for all of it.
The bot asked about one focus field, but the seller may answer several fields at once (partial confirmation) or volunteer extra details.
PART 1: for every field in the list that the seller actually addressed, output one result. Do not output fields the seller did not address.
classification:
- confirmed: seller agrees the stored value is correct (or agrees there is no value, e.g. "no website")
- corrected: seller gives a replacement value (for products: adds to or replaces the stored list)
- newly_provided: seller gives a value where nothing was stored
- unconfirmed: seller cannot verify or does not know ("pata nahi", "not sure")
- ambiguous: unclear or needs clarification
PART 2: "meta" = what the reply means conversationally:
- answer: seller responded to the question (yes / correct / gave a value / "don't know")
- no_value: seller rejects or disagrees ("no", "galat hai") but gives NO replacement value
- repeat: asks to repeat, did not hear or understand
- who: asks who is calling / which company
- why: asks why this is needed, whether it is safe, what happens to the data
- question: any other question (IndiaMART services, pricing, leads, complaints)
- hold: asks you to wait ("ruko", "ek minute")
- busy: busy / driving / in a meeting, wants a call later
- not_interested: politely or curtly says not interested / no need / no time for this, but does NOT ask you to stop calling and is not abusive
- refuse: HARD refusal only: says do not call again / stop calling, is angry or abusive
- wrong_person: wrong number, or is not that person / business
- proxy: someone else (employee, family) is answering and is willing to help
- off_topic: unrelated chatter
- noise: unintelligible, too short or garbled to understand
"reply": for who / why / question / hold / busy / not_interested / refuse / wrong_person / proxy / off_topic / repeat write 1-2 SHORT, warm, human sentences in the seller's own language and style (Hinglish in Roman letters, or English if they spoke English). Answer their question honestly using only the facts; for refuse apologise and respect it; for busy ask nothing more; do not ask any question and do not re-ask the verification question (the bot does that); never address the seller as sir or madam (use "aap" or "ji"). Leave "reply" empty for answer / no_value / noise.
${FACTS}
Return ONLY JSON:
{"results":[{"field":string,"classification":"confirmed"|"corrected"|"newly_provided"|"unconfirmed"|"ambiguous","value":...,"clarity":"explicit"|"hedged"|"unclear","evidence":string,"asr_noise":"clean"|"noisy"}],"contradiction":boolean,"meta":{"type":string,"reply":string}}
value formats: person_name / company_name: string in Roman letters. address: {"street":string,"city":string,"state":string,"pincode":string} with only the parts the seller said. website: string. products: array of short English product phrases (full list after merging with the stored list when the seller adds items). Omit value for confirmed (or null when confirming "none").
evidence = a short verbatim excerpt of what the seller said. contradiction = true only if the seller gave conflicting values for the same field. Never invent values.`;

const META = ["answer", "no_value", "repeat", "who", "why", "question", "hold", "busy", "not_interested", "refuse", "wrong_person", "proxy", "off_topic", "noise"];

export async function classify({ pending, focus, question, utterance }) {
  if (/^((h+m+|u+h+m*|u+m+|a+h*|o+h+|e+r+|m+)\s*)+$/i.test(String(utterance).trim())) return { results: [], contradiction: false, meta: { type: "noise", reply: "" } }; // fillers like "hmm uh"
  const list = pending.length ? pending.map((p) => `${p.field}: ${p.previous ? JSON.stringify(p.previous) : "(nothing stored)"}`).join("\n") : "(none: the question was not about a stored field)";
  const out = await llmJson(PROMPT, `Bot asked (focus = ${focus}): ${question}\nFields still being verified:\n${list}\nSeller said: ${utterance}`);
  const results = (out.results || []).filter((r) => pending.some((p) => p.field === r.field) && CLASSES.includes(r.classification));
  let type = META.includes(out.meta?.type) ? out.meta.type : results.length ? "answer" : "noise";
  if (results.length && ["no_value", "noise", "off_topic", "question", "why", "who", "repeat", "hold"].includes(type)) type = "answer"; // they also answered
  // the bot re-asks the question itself, so keep only the statement sentences of a generated reply
  const reply = String(out.meta?.reply || "").split(/(?<=[.!?।])\s+/).filter((s) => s && !s.includes("?")).join(" ").slice(0, 400);
  return { results, contradiction: !!out.contradiction, meta: { type, reply } };
}

// "Do you want to update this at all?" -> update | skip | later | unclear
export async function chooseUpdate(utterance) {
  const o = await llmJson(`A seller was asked: "Do you want to update this information, or should we leave it as it is for now?" (Hindi/English/Hinglish). Return ONLY JSON {"choice":"update"|"skip"|"later"|"unclear"}. update = wants to change/provide it ("haan", "update karo", gives a value). skip = leave it ("rehne do", "nahi", "chhodo", "no need"). later = will do later / call back. unclear = anything else.`, `Seller said: ${utterance}`).catch(() => ({}));
  return { choice: ["update", "skip", "later"].includes(o.choice) ? o.choice : "unclear" };
}

// ---------------------------------------------------------------- 2. normalise + validate
const titleCase = (s) => s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const normWebsite = (s) => String(s || "").toLowerCase().replace(/\s+dot\s+/g, ".").replace(/\s+/g, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

export async function normalise(field, value, previous) {
  if (field === "person_name" || field === "company_name") return { value: titleCase(String(value || "")), data: null };
  if (field === "website") return { value: normWebsite(value), data: null };
  if (field === "address") {
    const p = previous?.data || {};
    const v = value || {};
    const sameCity = !v.city || (p.city || "").toLowerCase() === v.city.toLowerCase();
    const a = {
      street: v.street ? titleCase(v.street) : p.street || "",
      city: v.city ? titleCase(v.city) : p.city || "",
      state: v.state ? titleCase(v.state) : sameCity ? p.state || "" : "",
      pincode: String(v.pincode || "").replace(/\D/g, "") || (sameCity && !v.street ? p.pincode || "" : ""),
    };
    if (!a.state && a.city) a.state = GEO.cityState[a.city.toLowerCase()] || "";
    return { value: addressText(a), data: a, note: !a.pincode ? "pincode not provided" : null };
  }
  if (field === "products") {
    const items = (Array.isArray(value) ? value : [value]).map((x) => String(x).trim()).filter(Boolean);
    const cats = await mapCategories(new Map(items.map((t) => [t, new Set(["seller-voice"])])), await loadFeedback());
    const mapped = items.map((t) => cats.find((c) => c.sourceText === t) || { sourceText: t, mcat: null, confidence: 0 });
    return { value: mapped.map((m) => m.mcat || m.sourceText).join(", "), data: { items: mapped } };
  }
  return { value, data: null };
}

async function reachable(domain) {
  for (const scheme of ["https://", "http://"]) {
    try { const r = await fetch(scheme + domain, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(4000) }); if (r.status < 500) return true; } catch { /* try next */ }
  }
  return false;
}

export async function validate(field, norm) {
  const notes = [];
  let ok = true, reach = null;
  if (field === "website") {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(norm.value)) { ok = false; notes.push("not a valid domain"); }
    else { reach = await reachable(norm.value); if (!reach) notes.push("website did not respond (may be down or mis-heard)"); }
  } else if (field === "address") {
    const a = norm.data || {};
    if (!a.city) { ok = false; notes.push("city missing"); }
    if (a.pincode && !/^[1-9]\d{5}$/.test(a.pincode)) { ok = false; notes.push("invalid pincode format"); }
    const ps = a.pincode && GEO.pinPrefixState[a.pincode.slice(0, 3)];
    if (ps && a.state && ps !== a.state) { ok = false; notes.push(`pincode ${a.pincode} belongs to ${ps}, not ${a.state}`); }
    if (norm.note) notes.push(norm.note);
  } else if (field === "person_name" || field === "company_name") {
    if (!/[a-z]{2}/i.test(norm.value)) { ok = false; notes.push("does not look like a name"); }
  } else if (field === "products") {
    const un = (norm.data?.items || []).filter((i) => !i.mcat);
    if (un.length) notes.push(`${un.length} item(s) not mapped to the IM taxonomy`);
    if (!(norm.data?.items || []).length) ok = false;
  }
  return { ok, notes, reachable: reach };
}

// Corroboration against non-IM sources on file (GST record, invoice, sign board). Only available for sellers that have them.
export function corroborate(seller_id, field, norm) {
  const text = (LEADS[seller_id]?.sources || []).map((s) => s.text).join("\n").toLowerCase();
  if (!text) return "none";
  const toks = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (field === "address") {
    const a = norm.data || {};
    const pins = text.match(/\b[1-9]\d{5}\b/g) || [];
    if (a.pincode && pins.includes(a.pincode)) return "supported";
    if (a.pincode && pins.length && !pins.includes(a.pincode)) return "contradicted";
    if (a.city && text.includes(a.city.toLowerCase())) return "supported";
    return "none";
  }
  if (field === "company_name" || field === "person_name") {
    const t = toks(norm.value);
    return t.length && t.filter((x) => text.includes(x)).length / t.length >= 0.6 ? "supported" : "none";
  }
  return "none";
}

// ---------------------------------------------------------------- 3. consistency of the extracted value with what was said
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
export function consistency(valueText, utterance) {
  const said = String(utterance || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const want = String(valueText || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (!want.length) return 1;
  const hit = want.filter((w) => said.some((s) => s === w || (w.length >= 5 && lev(s, w) <= 1) || s.includes(w) || w.includes(s) && s.length >= 4)).length;
  return hit / want.length;
}

// ---------------------------------------------------------------- 4. score + audit decision for one field outcome
export async function scoreOutcome({ seller_id, field, classification, previous, normalised, evidence, utterance, clarity = "explicit", asr_noise = "clean", language_probability, contradiction = false, origin = "csv", attempts = 1 }) {
  const f = {};
  let ext = SCORING.extraction_base[classification] ?? 0;
  f.base = ext;
  const cl = SCORING.clarity[clarity] ?? 0.8; f.clarity = cl; ext *= cl;
  let asr = 1; if (asr_noise === "noisy") asr = SCORING.asr.noisy; if (language_probability != null && language_probability < 0.3) asr = Math.min(asr, SCORING.asr.low_language_probability);
  f.asr = asr; ext *= asr;
  let val = { ok: true, notes: [], reachable: null }, corr = "none", cons = 1;
  const changed = classification === "corrected" || classification === "newly_provided";
  if (changed && normalised) {
    val = await validate(field, normalised);
    corr = corroborate(seller_id, field, normalised);
    const raw = consistency(normalised.value, utterance);
    cons = raw >= 0.8 ? SCORING.consistency.high : raw >= 0.5 ? SCORING.consistency.medium : SCORING.consistency.low;
    f.value_in_speech = +raw.toFixed(2);
  }
  f.consistency = cons; ext *= cons;
  if (contradiction) { f.contradiction = SCORING.contradiction; ext *= SCORING.contradiction; }
  if (attempts > 1) { f.clarification_rounds = attempts - 1; ext *= 0.95; }
  ext = Math.min(0.98, Math.max(0, ext));

  // estimated reliability of the stored/proposed value itself (distinct from how well we captured what was said)
  const prior = SCORING.source_prior[String(origin).includes("demo") ? "demo" : String(origin).startsWith("enrichment") ? "enrichment" : "csv"];
  let rel;
  if (classification === "confirmed") rel = Math.min(0.97, prior + 0.25 * ext);
  else if (changed) {
    rel = 0.70 + (corr === "supported" ? 0.15 : corr === "contradicted" ? -0.2 : 0) + (val.ok ? 0.05 : -0.15) + (val.reachable ? 0.10 : 0);
    rel *= 0.6 + 0.4 * ext;
  } else if (classification === "unconfirmed") rel = prior * 0.8;
  else if (classification === "ambiguous") rel = prior * 0.7;
  else rel = prior;
  rel = Math.max(0, Math.min(0.98, rel));
  f.corroboration = corr; f.validation = val.ok ? "passed" : "failed"; if (val.reachable != null) f.website_reachable = val.reachable;

  // audit decision
  const T = SCORING.audit_thresholds, reasons = [];
  if (classification === "ambiguous") reasons.push("ambiguous response");
  if (classification === "unconfirmed") reasons.push("seller could not verify this value");
  if (contradiction) reasons.push("contradictory statements about the same field");
  if (!val.ok) reasons.push("validation failed: " + val.notes.join("; "));
  if (["confirmed", "corrected", "newly_provided"].includes(classification) && ext < T.min_extraction) reasons.push(`low extraction confidence (${ext.toFixed(2)} < ${T.min_extraction})`);
  if (changed && rel < T.min_reliability) reasons.push(`low estimated reliability (${rel.toFixed(2)} < ${T.min_reliability})`);
  if (classification === "corrected" && !(field === "website" && val.reachable && ext >= T.auto_approve_website_extraction)) reasons.push("material change to a stored value");
  if (corr === "contradicted") reasons.push("conflicts with a non-IM source on file");

  const verification = { confirmed: "seller_confirmed", corrected: "seller_corrected", newly_provided: "seller_provided", unconfirmed: "unverified", ambiguous: "ambiguous", not_answered: "not_verified" }[classification];
  let audit_status = reasons.length ? "pending" : changed ? "auto_approved" : "not_required";
  const applied = audit_status !== "pending" && ["confirmed", "corrected", "newly_provided"].includes(classification);
  return { extraction_confidence: +ext.toFixed(2), value_reliability: +rel.toFixed(2), confidence_factors: f, audit_status, audit_reasons: reasons, verification_status: verification, applied, validation_notes: val.notes };
}
