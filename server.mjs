process.loadEnvFile();
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { enrich, saveFeedback, llmJson, mapCategories, loadFeedback } from "./lib.mjs";
import { search } from "./taxonomy.mjs";
import { readCard, transcribe, speak } from "./inputs.mjs";
import * as store from "./db.mjs";
import { classify, chooseUpdate, normalise, scoreOutcome, SCORING } from "./verify.mjs";

const leads = JSON.parse(await readFile(new URL("./data/leads.json", import.meta.url), "utf8"));
const REFERENCE = new URL("./data/seller_reference.csv", import.meta.url);
const refPath = REFERENCE.pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/%20/g, " ");
store.seedFromCsv(refPath);

const raw = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
const body = async (req) => JSON.parse((await raw(req)).toString() || "{}");
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const page = async (res, file) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await readFile(new URL(`./public/${file}`, import.meta.url))); };

// Products to verify come from the non-IM sources on file (GST record, invoice, sign board), used only after consent.
async function suggestProducts(seller_id) {
  const lead = leads.find((l) => l.glid === seller_id);
  if (!lead) return { items: [], sources: [] };
  const r = await enrich({ businessName: lead.company, extra: lead.sources });
  const items = (r.profile?.categories || []).filter((c) => c.confidence >= 0.5).slice(0, 4);
  return { items, sources: r.meta?.sourcesUsed || [] };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, post = req.method === "POST";
  try {
    // ---------- pages
    if (req.method === "GET" && p === "/") return page(res, "index.html");
    if (req.method === "GET" && p === "/audit") return page(res, "audit.html");
    if (req.method === "GET" && p === "/enrich") return page(res, "enrich.html");

    // ---------- verification workflow
    if (req.method === "GET" && p === "/api/reference") return json(res, 200, store.listSellers());
    if (req.method === "GET" && p.startsWith("/api/seller/")) return json(res, 200, store.getSeller(decodeURIComponent(p.slice(12))));
    if (req.method === "GET" && p === "/api/scoring") return json(res, 200, SCORING);
    if (req.method === "GET" && p === "/api/stats") return json(res, 200, store.stats());
    if (post && p === "/api/reset") { store.seedFromCsv(refPath, { reset: true }); return json(res, 200, { ok: true }); }

    if (post && p === "/api/call/start") {
      const { seller_id } = await body(req);
      const seller = store.getSeller(seller_id);
      if (!seller) return json(res, 404, { error: "unknown seller" });
      const call_id = randomUUID();
      store.startCall(call_id, seller_id);
      return json(res, 200, { call_id, seller });
    }
    if (post && p === "/api/call/products") return json(res, 200, await suggestProducts((await body(req)).seller_id));

    // classify what the seller said about the fields still being verified
    if (post && p === "/api/call/turn") {
      const { seller_id, focus, question, pending, utterance } = await body(req);
      const withPrev = pending.map((f) => ({ field: f.field, previous: f.previous ?? store.getField(seller_id, f.field)?.value ?? "" }));
      return json(res, 200, await classify({ pending: withPrev, focus, question, utterance }));
    }

    if (post && p === "/api/call/choice") return json(res, 200, await chooseUpdate((await body(req)).utterance));

    // turn one field outcome into a scored, audited database event
    if (post && p === "/api/call/record") {
      const b = await body(req);
      const cur = store.getField(b.seller_id, b.field);
      const previous = b.previous ?? { value: cur?.value || "", data: cur?.data || null };
      const origin = b.original_source || cur?.source || "csv";
      let norm = null;
      if (["corrected", "newly_provided"].includes(b.classification) && b.value != null) norm = await normalise(b.field, b.value, previous);
      // contradiction: this call already produced a different value for the same field
      const earlier = store.listEvents({ seller_id: b.seller_id }).filter((e) => e.call_id === b.call_id && e.field === b.field && ["corrected", "newly_provided"].includes(e.classification));
      const contradiction = !!b.contradiction || (norm && earlier.some((e) => e.new_value && e.new_value.toLowerCase() !== norm.value.toLowerCase()));
      const s = await scoreOutcome({ seller_id: b.seller_id, field: b.field, classification: b.classification, previous, normalised: norm, evidence: b.evidence, utterance: b.utterance,
        clarity: b.clarity, asr_noise: b.asr_noise, language_probability: b.language_probability, contradiction, origin, attempts: b.attempts || 1 });
      const confirmedValue = b.classification === "confirmed" ? previous : null;
      const event = store.insertEvent({
        call_id: b.call_id, seller_id: b.seller_id, field: b.field,
        previous_value: previous.value, previous_data: previous.data,
        new_value: norm ? norm.value : confirmedValue ? confirmedValue.value : null, new_data: norm ? norm.data : confirmedValue ? confirmedValue.data : null,
        classification: b.classification, original_source: origin, evidence: b.evidence || "", utterance: b.utterance || "", ...s,
      });
      return json(res, 200, { event, validation_notes: s.validation_notes });
    }
    if (post && p === "/api/call/end") { const b = await body(req); store.endCall(b.call_id, b); return json(res, 200, { ok: true }); }

    // ---------- manual audit
    if (req.method === "GET" && p === "/api/audit") return json(res, 200, store.listEvents({ audit_status: url.searchParams.get("status") || undefined, seller_id: url.searchParams.get("seller") || undefined }));
    if (post && p.startsWith("/api/audit/")) return json(res, 200, store.decide(+p.split("/")[3], await body(req)));

    // ---------- earlier enrichment prototype (kept)
    if (req.method === "GET" && p === "/api/leads") return json(res, 200, leads.map(({ glid, company, city, state }) => ({ glid, company, city, state })));
    if (post && p === "/api/enrich") {
      const input = await body(req);
      const lead = input.glid && leads.find((l) => l.glid === input.glid);
      if (lead) { input.businessName = lead.company; if (input.consented) input.extra = lead.sources; }
      return json(res, 200, await enrich(input));
    }
    if (post && p === "/api/feedback") return json(res, 200, await saveFeedback(await body(req)));
    if (req.method === "GET" && p === "/api/category-search") return json(res, 200, search(url.searchParams.get("q") || "", 8));
    if (post && p === "/api/card") return json(res, 200, { text: await readCard(await raw(req), url.searchParams.get("name") || "card", url.searchParams.get("type") || undefined) });
    if (post && p === "/api/category-map") {
      const { text } = await body(req);
      const [cat] = await mapCategories(new Map([[String(text), new Set(["seller-voice"])]]), await loadFeedback());
      return json(res, 200, cat || null);
    }

    // ---------- voice
    if (post && p === "/api/voice") {
      const { transcript, language_probability } = await transcribe(await raw(req), req.headers["content-type"] || "audio/webm", url.searchParams.get("mode") || "codemix");
      const seed = transcript && url.searchParams.get("seed") !== "0"
        ? await llmJson(`The seller spoke (Hindi/English/Hinglish). Extract seed details. Return ONLY JSON: {"businessName":string|null,"phone":string|null,"website":string|null}. Write businessName in Roman (English) letters, not Devanagari. Phone as digits only. Website as a bare domain. Never invent.`, transcript).catch(() => ({}))
        : {};
      return json(res, 200, { transcript, language_probability, seed });
    }
    if (post && p === "/api/tts") { const b = await body(req); return json(res, 200, { audio: await speak(b.text, { speaker: b.speaker, lang: b.lang, pace: b.pace }) }); }
    if (post && p === "/api/interpret") {
      const { question, items = [], utterance } = await body(req);
      const list = items.map((i) => `${i.id}: ${i.label}`).join("\n");
      const out = await llmJson(
        `You interpret a seller's spoken reply (Hindi/English/Hinglish, may be transcribed in Devanagari) to an onboarding assistant's question.
Return ONLY JSON: {"intent":"yes"|"no"|"edit"|"remove"|"add"|"unclear","target":string|null,"field":string|null,"value":string|null}
- yes: confirms. no: rejects without saying what is right. remove: wants an item deleted (target = item id). edit: gives a corrected value (target = item id, field one of name|role|street|locality|city|state|pincode|type, value in Roman letters).
- Examples: "haan/हाँ/sahi hai/ठीक है" = yes; "nahi/नहीं" alone = no; "hata do/हटा दो/delete karo/ye galat hai, nikal do" = remove; "Rakesh partner hain" = edit role=Partner.
- add: seller says they ALSO sell/make something (e.g. "haan, aur pipes bhi bechte hain") -> intent add, value = the product as a short English phrase (e.g. "pipes"), even if they also said yes.
- If the item list has one item and the seller asks to remove/delete it, target is that item id.
- For an edit, value is the COMPLETE new value of that field. If the seller adds a detail to an address (e.g. "building number 12"), merge it into the existing text shown in the item label and return ONLY the street part (no city, state or pincode), e.g. "Building 12, G.T. Road"; use field street.
- If you cannot tell which item or field is meant, use intent unclear instead of guessing.
- target must be one of the item ids listed, or null. Never invent.`,
        `Question asked: ${question}\nItems:\n${list || "(none)"}\nSeller said: ${utterance}`,
      ).catch(() => ({ intent: "unclear" }));
      return json(res, 200, out);
    }
    json(res, 404, { error: "not found" });
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
}).listen(3000, () => console.log("http://localhost:3000"));
