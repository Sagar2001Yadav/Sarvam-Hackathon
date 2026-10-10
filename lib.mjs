import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { SarvamAIClient } from "sarvamai";
import { search, getMcat, tokens } from "./taxonomy.mjs";

const client = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
const MODEL = "sarvam-105b-conversations";
export const FEEDBACK_FILE = new URL("./data/feedback.json", import.meta.url);

const GEO = JSON.parse(readFileSync(new URL("./data/geo.json", import.meta.url), "utf8"));
const STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana","Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Delhi","Jammu and Kashmir","Ladakh","Chandigarh","Puducherry","Andaman and Nicobar Islands","Dadra and Nagar Haveli and Daman and Diu","Lakshadweep"];
const stateFix = (s) => {
  if (!s) return "";
  const k = s.toLowerCase().replace(/[^a-z]/g, "");
  return STATES.find((x) => x.toLowerCase().replace(/[^a-z]/g, "") === k) || (k === "nctofdelhi" ? "Delhi" : k === "orissa" ? "Odisha" : s);
};

// ---------- source collection (public pages the seller pointed us to, or text they gave us) ----------
const htmlToText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
const jsonLd = (html) =>
  [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).join("\n");

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 IMEnrichBot/0.1 (+seller-consented)" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status}`);
  const html = await res.text();
  return { text: htmlToText(html).slice(0, 6000), ld: jsonLd(html).slice(0, 3000) };
}

export async function collectSources({ website, googleLink, rawText, cardText, rawLabel, extra }) {
  const sources = [], notes = [];
  for (const e of extra || []) sources.push({ name: e.name, type: e.type, text: e.text }); // consented non-IM sources (GST record, documents)
  if (website) {
    const base = website.startsWith("http") ? website : `https://${website}`;
    for (const path of ["", "/about", "/about-us", "/contact", "/contact-us"]) {
      try {
        const { text, ld } = await fetchText(new URL(path, base).href);
        sources.push({ name: `website${path || "/"}`, type: "website", text: (ld ? `[structured-data]\n${ld}\n` : "") + text });
      } catch { /* page may not exist */ }
    }
    if (!sources.length) notes.push(`Could not fetch website ${base}`);
  }
  if (googleLink) {
    try { sources.push({ name: "google-listing", type: "google", text: (await fetchText(googleLink)).text }); }
    catch { notes.push("Google listing could not be read (Google restricts automated access). Paste its text instead."); }
  }
  if (cardText?.trim()) sources.push({ name: "uploaded-card", type: "card", text: cardText.slice(0, 8000) });
  if (rawText?.trim()) sources.push({ name: rawLabel || "pasted-text", type: rawLabel === "call-transcript" ? "call" : "text", text: rawText.slice(0, 8000) });
  return { sources, notes };
}

// ---------- learning store ----------
const emptyFb = () => ({ categoryFixes: {}, sourceStats: {}, fieldStats: { accepted: 0, edited: 0, removed: 0 }, log: [] });
export async function loadFeedback() {
  try { return { ...emptyFb(), ...JSON.parse(await readFile(FEEDBACK_FILE, "utf8")) }; } catch { return emptyFb(); }
}
const termKey = (s) => [...new Set(tokens(s))].sort().join(" ");

const sameLoc = (a, b) => (a.pincode || "") === (b.pincode || "") && (a.city || "").toLowerCase() === (b.city || "").toLowerCase() && termKey(a.street) === termKey(b.street);
const samePerson = (a, b) => termKey(a.name) === termKey(b.name) && (a.role || "") === (b.role || "");

// Compare what we showed with what the seller confirmed. Corrections update category mappings and source reliability.
export function applyFeedback(fb, { original, corrected }) {
  const tick = (kind, sources) => {
    fb.fieldStats[kind]++;
    for (const s of sources || []) {
      const st = (fb.sourceStats[s.split("/")[0]] ||= { accepted: 0, edited: 0 });
      if (kind === "accepted") st.accepted++; else st.edited++;
    }
  };
  for (const o of original.locations || []) tick((corrected.locations || []).some((c) => sameLoc(o, c)) ? "accepted" : "edited", o.sources);
  for (const o of original.people || []) tick((corrected.people || []).some((c) => samePerson(o, c)) ? "accepted" : "edited", o.sources);
  for (const o of original.categories || []) {
    const kept = (corrected.categories || []).some((c) => c.sourceText === o.sourceText && c.mcatId === o.mcatId);
    tick(kept ? "accepted" : "edited", o.sources);
    if (!kept) {
      const repl = (corrected.categories || []).find((c) => c.sourceText === o.sourceText);
      fb.categoryFixes[termKey(o.sourceText)] = repl ? repl.mcatId : "REJECTED";
    }
  }
  for (const c of corrected.categories || []) {
    if (!(original.categories || []).some((o) => o.sourceText === c.sourceText && o.mcatId === c.mcatId) && c.sourceText) fb.categoryFixes[termKey(c.sourceText)] = c.mcatId;
  }
  fb.log.push({ at: new Date().toISOString(), business: corrected.businessName?.value });
  return fb;
}
export async function saveFeedback(payload) {
  const fb = applyFeedback(await loadFeedback(), payload);
  await writeFile(FEEDBACK_FILE, JSON.stringify(fb, null, 2));
  return fb;
}
const sourceTrust = (fb, type) => {
  const s = fb.sourceStats[type];
  if (!s || s.accepted + s.edited < 3) return 1;
  return 0.8 + 0.2 * (s.accepted / (s.accepted + s.edited)); // sources the seller keeps editing get down-weighted
};

// ---------- LLM ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function llmJson(system, user) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await client.chat.completions({ model: MODEL, temperature: 0.1, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
      const m = (r.choices[0].message.content || "").match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      last = new Error("LLM returned no JSON");
    } catch (e) { last = e; }
    await sleep(600 * 2 ** attempt); // backoff for rate limits / transient failures
  }
  throw last;
}

const EXTRACT_PROMPT = `You extract seller business facts for an Indian B2B marketplace (IndiaMART) from ONE source text.
The text may be Hindi (Devanagari), English or Hinglish (Hindi in Roman script) and may contain OCR noise. Output everything in English / Roman script (transliterate names).
Return ONLY JSON:
{
 "businessName": string|null,
 "locations": [{"type":"registered|factory|branch|showroom|warehouse|office|other","street":string,"locality":string,"city":string,"state":string,"pincode":string,"evidence":string}],
 "people": [{"name":string,"role":"Owner|Director|Partner|Manager|Sales|Contact|Other","evidence":string}],
 "products": [string],
 "gst": string|null
}
Rules: use only facts in the text, never invent. street = building/plot/road; locality = area/sector/colony. "evidence" = short verbatim snippet. Products are what the business sells/makes, as short English noun phrases (e.g. "corrugated boxes"); skip tax codes, services of the buyer, and generic words. Use null / [] when absent. Do not include phone numbers or emails.`;

const extractCache = new Map(); // extraction does not depend on feedback, so identical source text is reused
async function extractOne(src) {
  const k = src.text;
  if (!extractCache.has(k)) {
    extractCache.set(k, llmJson(EXTRACT_PROMPT, `=== SOURCE: ${src.name} ===
${src.text}`.slice(0, 14000)).catch((e) => { extractCache.delete(k); return null; }));
  }
  return { src, data: await extractCache.get(k) };
}

// ---------- merge across sources, keep provenance ----------
const digits = (s) => (s || "").replace(/\D/g, "");
const inText = (needle, hay) => needle && hay.toLowerCase().includes(String(needle).toLowerCase().slice(0, 80));

function mergeLocations(results, fb) {
  const merged = [];
  for (const { src, data } of results) {
    for (const l of data?.locations || []) {
      const nice = (x) => { x = (x || "").trim(); return x && x === x.toUpperCase() ? x.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : x; };
      const loc = { type: l.type || "other", street: (l.street || "").trim(), locality: (l.locality || "").trim(), city: nice(l.city), state: stateFix(l.state), pincode: (l.pincode || "").replace(/\D/g, "").slice(0, 6) };
      if (!loc.city && !loc.pincode && !loc.street) continue;
      const hit = merged.find((m) => (loc.pincode && m.pincode === loc.pincode) || (!loc.pincode && m.city && m.city.toLowerCase() === loc.city.toLowerCase() && termKey(m.street) === termKey(loc.street)));
      const ev = inText(l.evidence, src.text);
      const entry = { src: src.name, type: src.type, ev };
      if (hit) {
        hit.sources.push(entry.src); hit.types.add(src.type); hit.evCount += ev ? 1 : 0;
        for (const k of ["street", "locality", "city", "state"]) {
          if (loc[k] && hit[k] && termKey(loc[k]) !== termKey(hit[k])) (hit.alternatives[k] ||= []).push({ value: loc[k], source: src.name });
          else if (loc[k] && !hit[k]) hit[k] = loc[k];
        }
      } else merged.push({ ...loc, sources: [src.name], types: new Set([src.type]), evCount: ev ? 1 : 0, alternatives: {} });
    }
  }
  return merged.map((m) => {
    const trust = Math.min(...[...m.types].map((t) => sourceTrust(fb, t)));
    const pinOk = /^[1-9]\d{5}$/.test(m.pincode);
    const inferred = [];
    const pinState = pinOk ? GEO.pinPrefixState[m.pincode.slice(0, 3)] : null;
    if (!m.state) {
      const st = GEO.cityState[m.city.toLowerCase()] || pinState;
      if (st) { m.state = st; inferred.push("state"); }
    } else if (pinState && pinState !== m.state) m.alternatives.state = [...(m.alternatives.state || []), { value: pinState, source: "pincode-lookup" }];
    let c = 0.35 + (pinOk ? 0.2 : 0) + (m.city ? 0.1 : 0) + (m.state && STATES.includes(m.state) ? 0.08 : 0) + (m.evCount ? 0.12 : 0) + (m.street ? 0.05 : 0) + (m.sources.length > 1 ? 0.12 : 0);
    if (inferred.length) c -= 0.05;
    if (Object.keys(m.alternatives).length) c -= 0.12; // sources disagree: lower confidence, offer options
    return { type: m.type, inferred, street: m.street, locality: m.locality, city: m.city, state: m.state, pincode: m.pincode, sources: m.sources, alternatives: m.alternatives, confidence: +Math.max(0.1, Math.min(0.97, c * trust)).toFixed(2) };
  });
}

const nameKey = (n) => [...new Set(tokens((n || "").replace(/\b(kr|kumar)\b/gi, "kumar").replace(/\b(mr|mrs|shri|sh|smt|ji)\b\.?/gi, "")))];
function mergePeople(results, input, fb) {
  const merged = [];
  for (const { src, data } of results) {
    for (const p of data?.people || []) {
      const t = nameKey(p.name);
      if (!t.length) continue;
      const hit = merged.find((m) => { const small = t.length <= m.t.length ? t : m.t, big = t.length <= m.t.length ? m.t : t; return small.every((x) => big.includes(x)); });
      const ev = inText(p.evidence, src.text);
      if (hit) {
        hit.sources.push(src.name); hit.types.add(src.type); hit.evCount += ev ? 1 : 0;
        if (p.name.length > hit.name.length) hit.name = p.name;
        if (hit.role === "Other" || hit.role === "Contact") hit.role = p.role || hit.role;
        else if (p.role && p.role !== hit.role && p.role !== "Other" && p.role !== "Contact") (hit.alternatives.role ||= []).push({ value: p.role, source: src.name });
      } else merged.push({ name: p.name.trim(), t, role: p.role || "Contact", sources: [src.name], types: new Set([src.type]), evCount: ev ? 1 : 0, alternatives: {} });
    }
  }
  return merged.map((m) => {
    const trust = Math.min(...[...m.types].map((t) => sourceTrust(fb, t)));
    let c = 0.35 + (m.evCount ? 0.2 : 0) + (m.role !== "Other" && m.role !== "Contact" ? 0.15 : 0) + (m.sources.length > 1 ? 0.15 : 0) + (m.name.split(/\s+/).length > 1 ? 0.07 : 0);
    if (m.alternatives.role) c -= 0.1;
    return { name: m.name, role: m.role, sources: m.sources, alternatives: m.alternatives, confidence: +Math.max(0.1, Math.min(0.96, c * trust)).toFixed(2) };
  });
}

// ---------- category mapping against the real IM taxonomy ----------
export async function mapCategories(productSources, fb) {
  // productSources: Map(product text -> Set(source names))
  const out = [], pending = [];
  for (const [text, srcs] of productSources) {
    const key = termKey(text);
    if (!key) continue;
    const fix = fb.categoryFixes[key];
    if (fix === "REJECTED") continue;
    if (fix) {
      const m = getMcat(fix);
      if (m) { out.push(toCat(text, m, 0.95, "learned-from-seller", [...srcs])); continue; }
    }
    const cands = search(text, 10);
    // generalise earlier seller corrections: similar learned products contribute their MCAT as a candidate and a hint
    const qt = new Set(key.split(" "));
    const hints = [];
    for (const [k, id] of Object.entries(fb.categoryFixes)) {
      if (id === "REJECTED") continue;
      const kt = k.split(" "), inter = kt.filter((t) => qt.has(t)).length;
      if (inter && inter / new Set([...qt, ...kt]).size >= 0.34) {
        const m = getMcat(id);
        if (m) { hints.push({ k, m }); if (!cands.some((c) => c.id === m.id)) cands.push({ ...m, score: 1.2 }); }
      }
    }
    if (cands.length) pending.push({ text, srcs: [...srcs], cands, hints: hints.slice(0, 3) });
  }
  if (pending.length) {
    const prompt = pending.map((p, i) => `#${i} product: "${p.text}"\n` + p.cands.map((c) => `  ${c.id} | ${c.name} | ${c.parent} | ${c.category}`).join("\n") + (p.hints.length ? "\n  (sellers previously confirmed: " + p.hints.map((h) => `"${h.k}" -> ${h.m.id}`).join("; ") + ")" : "")).join("\n");
    let res = { picks: [] };
    try {
      res = await llmJson(`You map seller products to the IndiaMART category (MCAT) taxonomy. For each numbered product, choose the single best candidate id (prefer the most general MCAT that still describes the product; do not pick a variant with extra attributes that the product text does not state). If none is a good fit, use null.\nReturn ONLY JSON: {"picks":[{"i":number,"id":number|null,"confidence":number between 0 and 1}]}`, prompt);
    } catch { /* fall back to retrieval order below */ }
    pending.forEach((p, i) => {
      const pick = (res.picks || []).find((x) => x.i === i);
      let cand = pick?.id ? p.cands.find((c) => c.id === +pick.id) : null;
      let conf = pick ? Math.max(0, Math.min(1, +pick.confidence || 0.5)) : 0.4;
      if (!pick) cand = p.cands[0]; // LLM unavailable: top retrieval hit, low confidence
      if (!cand) return;
      const retr = Math.min(1, cand.score / 2);
      let c = Math.min(0.93, 0.15 + conf * 0.55 + retr * 0.3), via = pick ? "retrieval+llm" : "retrieval";
      if (p.hints.length && !p.hints.some((h) => h.m.id === cand.id)) { c = Math.min(c, 0.55); via += " · similar product was corrected by another seller: please review"; }
      out.push(toCat(p.text, cand, +c.toFixed(2), via, p.srcs));
    });
  }
  return out;
}
const toCat = (text, m, confidence, via, sources) => ({
  sourceText: text, mcatId: m.id, mcat: m.name, parent: m.parent, category: m.category, group: m.group,
  imCategory: `${m.group} > ${m.category} > ${m.name}`, confidence, via, sources,
});

// ---------- main ----------
export async function enrich(input, { feedback } = {}) {
  const { sources, notes } = await collectSources(input);
  const fb = feedback || (await loadFeedback());
  if (!sources.length) return { profile: null, notes: [...notes, "No data sources available. Add a website, Google listing text, or card/brochure text."] };

  const results = await Promise.all(sources.map(extractOne));
  const ok = results.filter((r) => r.data);
  if (!ok.length) return { profile: null, notes: [...notes, "Extraction failed for all sources."] };

  // business name: seller input wins; otherwise majority across sources, others kept as alternatives
  const names = ok.map((r) => ({ v: (r.data.businessName || "").trim(), s: r.src.name })).filter((x) => x.v);
  const tally = new Map();
  for (const n of names) { const k = termKey(n.v); tally.set(k, [...(tally.get(k) || []), n]); }
  const best = [...tally.values()].sort((a, b) => b.length - a.length)[0];
  const businessName = input.businessName
    ? { value: input.businessName, confidence: 0.99, sources: ["seller-input"], alternatives: best && termKey(best[0].v) !== termKey(input.businessName) ? [{ value: best[0].v, source: best[0].s }] : [] }
    : best ? { value: best[0].v, confidence: +Math.min(0.95, 0.5 + 0.15 * best.length + (tally.size > 1 ? -0.1 : 0.1)).toFixed(2), sources: best.map((x) => x.s), alternatives: [...tally.values()].filter((g) => g !== best).map((g) => ({ value: g[0].v, source: g[0].s })) }
    : { value: null, confidence: 0, sources: [] };

  const gstRe = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
  const gstHit = ok.map((r) => ({ v: (r.data.gst || "").toUpperCase().replace(/\s/g, ""), s: r.src.name })).find((x) => gstRe.test(x.v));
  const gst = gstHit ? { value: gstHit.v, confidence: 0.85, sources: [gstHit.s], note: "format valid; not verified against the GST portal" } : { value: null, confidence: 0, sources: [] };

  const productSources = new Map();
  for (const { src, data } of ok) for (const p of (data.products || []).slice(0, 10)) {
    const k = String(p).trim();
    if (k.length > 2 && k.length < 80) productSources.set(k, new Set([...(productSources.get(k) || []), src.name]));
  }
  const [categories] = await Promise.all([mapCategories(productSources, fb)]);

  const locations = mergeLocations(ok, fb).sort((a, b) => b.confidence - a.confidence);
  const people = mergePeople(ok, input, fb).sort((a, b) => b.confidence - a.confidence);
  const profile = { businessName, phone: input.phone ? { value: input.phone, confidence: 0.99, sources: ["seller-input"] } : { value: null, confidence: 0, sources: [] }, gst, locations, people, categories };

  const slots = [businessName.value, input.phone, gst.value, locations.length, people.length, categories.length];
  return {
    profile,
    meta: {
      sourcesUsed: sources.map((s) => s.name),
      fieldsFilled: [businessName.value, gst.value, ...locations, ...people, ...categories].filter(Boolean).length,
      sectionsFilled: slots.filter(Boolean).length + "/" + slots.length,
      consent: "Only the pages and files you provided were read. Nothing is saved until you confirm. You can remove any item.",
    },
    notes,
  };
}
