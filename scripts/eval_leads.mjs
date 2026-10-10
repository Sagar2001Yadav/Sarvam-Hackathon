// Outbound-call evaluation: input = company name only (what IM knows) + consented non-IM sources; answer key = verified IM profile.
process.loadEnvFile();
import { readFile } from "node:fs/promises";
import { enrich } from "../lib.mjs";
import { tokens } from "../taxonomy.mjs";

const leads = JSON.parse(await readFile(new URL("../data/leads.json", import.meta.url), "utf8")).slice(0, +(process.argv[2] || 100));
const raw = JSON.parse(await readFile(new URL("../data/eval_set.json", import.meta.url), "utf8"));
const partners = Object.fromEntries(raw.map((e) => [e.glid, e.truth.partners]));
const key = (s) => [...new Set(tokens(s))].sort().join(" ");

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ error: String(e.message) })); } }));
  return out;
}
const results = await pool(leads, 4, (l) => enrich({ businessName: l.company, extra: l.sources }));

const m = { n: 0, err: 0, city: 0, state: 0, pin: 0, slots: 0, filled: 0, catN: 0, catStrict: 0, catBroad: 0, pTruth: 0, pHit: 0, pOut: 0, pOutOk: 0 };
leads.forEach((l, i) => {
  const r = results[i]; m.n++;
  if (!r?.profile) { m.err++; return; }
  const p = r.profile, t = l.truth, loc = p.locations[0];
  m.city += !!(loc && (key(loc.city) === key(t.city) || key(t.city).includes(key(loc.city)) || key(loc.city).includes(key(t.city))));
  m.state += !!(loc && key(loc.state) === key(t.state)); m.pin += !!(loc && loc.pincode === t.pincode);
  m.slots += 5; m.filled += 1 + (loc?.city ? 1 : 0) + (loc?.state ? 1 : 0) + (loc?.pincode ? 1 : 0) + (p.categories.length ? 1 : 0);
  const truthNames = (partners[l.glid] || "").split(",").map((x) => key(x)).filter(Boolean);
  const gotNames = p.people.map((x) => key(x.name));
  for (const tn of truthNames) { m.pTruth++; m.pHit += gotNames.some((g) => g === tn || (g && tn && (g.includes(tn) || tn.includes(g)))); }
  for (const g of gotNames) { m.pOut++; m.pOutOk += truthNames.some((tn) => g === tn || g.includes(tn) || tn.includes(g)); }
  const ids = new Set(t.mcat_ids), parents = new Set(t.parents), cats = new Set(t.categories);
  for (const c of p.categories) { m.catN++; const s = ids.has(c.mcatId); m.catStrict += s; m.catBroad += s || parents.has(c.parent) || cats.has(c.category); }
});
const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : null);
console.log({
  leads: m.n, errors: m.err,
  "fields auto-populated %": pct(m.filled, m.slots),
  "city %": pct(m.city, m.n), "state %": pct(m.state, m.n), "pincode %": pct(m.pin, m.n),
  "people recall vs GST partners %": pct(m.pHit, m.pTruth), "people precision %": pct(m.pOutOk, m.pOut),
  "categories mapped": m.catN, "category precision strict %": pct(m.catStrict, m.catN), "category precision broad %": pct(m.catBroad, m.catN),
});
