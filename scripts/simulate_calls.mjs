// Simulated calls: scripted seller utterances -> classify -> score -> DB, against the running server (no microphone needed).
// Usage: node scripts/simulate_calls.mjs   (resets the demo DB first)
const B = "http://localhost:3000";
const post = (p, b) => fetch(B + p, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
await post("/api/reset", {});
const ref = await (await fetch(B + "/api/reference")).json();
const csvSellers = ref.filter((r) => r.origin !== "csv:demo").slice(0, 2).map((r) => r.seller_id);

// [seller, focus field, question, utterance, expected classification(s) per field]
const CASES = [
  ["D001", "address", "Address ABC, Noida likha hai. Kya ye sahi hai?", "nahi, hamara address XYZ, Noida hai", { address: "corrected" }],
  ["D001", "company_name", "Company ka naam Raghav Enterprises hai. Sahi hai?", "haan bilkul sahi hai", { company_name: "confirmed" }],
  ["D001", "website", "Aapki website kya hai?", "website raghaventerprises dot in hai", { website: "newly_provided" }],
  ["D001", "website", "Website ek baar phir bata dijiye", "arre nahi, website raghav enterprises dot com hai", { website: "corrected" }, "contradiction"],
  ["D002", "company_name", "Company ka naam Verma Packaging Works hai. Sahi hai?", "company ka naam sahi hai lekin address badal gaya hai, ab Sector 62 Noida mein hain", { company_name: "confirmed", address: "corrected" }],
  ["D002", "products", "Aap kya banate ya bechte hain?", "hum corrugated boxes aur cartons banate hain", { products: "newly_provided" }],
  ["D003", "company_name", "Company ka naam Khan Steel Traders hai. Sahi hai?", "pata nahi yaar, main sure nahi hoon", { company_name: "unconfirmed" }],
  ["D003", "address", "Address Sahibabad Industrial Area, Ghaziabad hai. Sahi hai?", "umm shayad, mujhe theek se yaad nahi, ya Loni ho sakta hai", { address: "ambiguous|unconfirmed" }],
  ["D003", "website", "Aapki website kya hai?", "hamari koi website nahi hai", { website: "confirmed" }],
  [csvSellers[0], "company_name", "Company ka naam sahi hai?", "haan ji sahi hai", { company_name: "confirmed" }],
  [csvSellers[1], "address", "Address sahi hai?", "nahi, ab hum naye office mein hain, plot 45 sector 6 Noida, pincode 201301", { address: "corrected" }],
  ["D002", "person_name", "Kya main Sunita ji se baat kar raha hoon?", "haan main hi hoon", { person_name: "confirmed" }],
];
const callIds = {};
let ok = 0, total = 0;
for (const [sid, focus, question, utterance, expect, flag] of CASES) {
  callIds[sid] ||= (await post("/api/call/start", { seller_id: sid })).call_id;
  const pending = Object.keys(expect).map((f) => ({ field: f }));
  if (!pending.find((p) => p.field === focus)) pending.push({ field: focus });
  const t = await post("/api/call/turn", { seller_id: sid, focus, question, pending, utterance });
  console.log(`\n[${sid}] "${utterance}"`);
  for (const [field, want] of Object.entries(expect)) {
    const r = t.results.find((x) => x.field === field);
    const cls = r?.classification || "not_answered";
    total++; const good = want.split("|").includes(cls); ok += good;
    if (!r) { console.log(`  ${field}: (no result) expected ${want} ${good ? "OK" : "MISS"}`); continue; }
    const e = (await post("/api/call/record", { call_id: callIds[sid], seller_id: sid, field, classification: cls, value: r.value, clarity: r.clarity, evidence: r.evidence, asr_noise: r.asr_noise, utterance, language_probability: 0.8, contradiction: t.contradiction })).event;
    console.log(`  ${field}: ${cls} ${good ? "OK" : "MISS (expected " + want + ")"} | "${e.previous_value || ""}" -> "${e.new_value ?? ""}" | ext ${e.extraction_confidence} rel ${e.value_reliability} | ${e.audit_status}${e.audit_reasons.length ? " <- " + e.audit_reasons.join("; ") : ""}`);
  }
}
console.log(`\nClassification accuracy: ${ok}/${total}`);

// manual audit: approve one, reject one, approve one with an edited value
const pend = await (await fetch(B + "/api/audit?status=pending")).json();
console.log("\nPending review:", pend.map((e) => `#${e.id} ${e.seller_id}/${e.field}`).join(", "));
if (pend[0]) await post(`/api/audit/${pend[0].id}/decision`, { decision: "approve", note: "verified by phone", reviewer: "sim" });
if (pend[1]) await post(`/api/audit/${pend[1].id}/decision`, { decision: "reject", note: "could not verify", reviewer: "sim" });
const s = await (await fetch(B + "/api/seller/D001")).json();
console.log("\nD001 after audit:", s.fields.map((f) => `${f.field}=${f.value || "-"} [${f.verification_status}]`).join(" | "));
console.log("D001 audit trail:", s.events.map((e) => `${e.field}:${e.classification}:${e.audit_status}`).join(" , "));
console.log("stats:", JSON.stringify(await (await fetch(B + "/api/stats")).json()));
