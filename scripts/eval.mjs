process.loadEnvFile();
import { readFile, writeFile } from "node:fs/promises";
import { enrich, applyFeedback } from "../lib.mjs";
import { search, getMcat, tokens } from "../taxonomy.mjs";

const N = +(process.argv[2] || 40);
const all = JSON.parse(await readFile(new URL("../data/eval_set.json", import.meta.url), "utf8")).slice(0, N);
const half = Math.floor(all.length / 2);
const train = all.slice(0, half), test = all.slice(half);

const key = (s) => [...new Set(tokens(s))].sort().join(" ");
const emptyFb = () => ({ categoryFixes: {}, sourceStats: {}, fieldStats: { accepted: 0, edited: 0, removed: 0 }, log: [] });

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch((e) => ({ error: String(e.message) })); } }));
  return out;
}

function score(sellers, results) {
  const m = { n: 0, errors: 0, nameOk: 0, cityOk: 0, stateOk: 0, pinOk: 0, anyLoc: 0, withCats: 0, catTotal: 0, catStrict: 0, catLenient: 0, filled: 0, slots: 0, confCorrect: [], confWrong: [] };
  sellers.forEach((s, i) => {
    const r = results[i]; m.n++;
    if (!r?.profile) { m.errors++; return; }
    const p = r.profile, t = s.truth;
    const nameOk = p.businessName.value && key(p.businessName.value) === key(t.company_name);
    const loc = p.locations[0];
    const cityOk = loc && (key(loc.city) === key(t.city) || key(t.city).includes(key(loc.city)) || key(loc.city).includes(key(t.city))), stateOk = loc && key(loc.state) === key(t.state), pinOk = loc && loc.pincode === t.pincode;
    m.nameOk += !!nameOk; m.cityOk += !!cityOk; m.stateOk += !!stateOk; m.pinOk += !!pinOk; m.anyLoc += !!loc;
    m.slots += 5; m.filled += (p.businessName.value ? 1 : 0) + (loc?.city ? 1 : 0) + (loc?.state ? 1 : 0) + (loc?.pincode ? 1 : 0) + (p.categories.length ? 1 : 0);
    if (p.categories.length) m.withCats++;
    const parents = new Set(t.parents), cats = new Set(t.categories), ids = new Set(t.mcat_ids);
    for (const c of p.categories) {
      m.catTotal++;
      const strict = ids.has(c.mcatId), lenient = strict || parents.has(c.parent) || cats.has(c.category);
      m.catStrict += strict; m.catLenient += lenient;
      (lenient ? m.confCorrect : m.confWrong).push(c.confidence);
    }
  });
  const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : null);
  const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  return {
    sellers: m.n, errors: m.errors,
    "auto-populated fields %": pct(m.filled, m.slots),
    "business name exact %": pct(m.nameOk, m.n), "city correct %": pct(m.cityOk, m.n), "state correct %": pct(m.stateOk, m.n), "pincode correct %": pct(m.pinOk, m.n),
    "category precision (strict mcat) %": pct(m.catStrict, m.catTotal), "category precision (mcat/parent/category) %": pct(m.catLenient, m.catTotal),
    "categories mapped": m.catTotal, "avg confidence when correct": avg(m.confCorrect), "avg confidence when wrong": avg(m.confWrong),
  };
}

// A simulated seller: for each wrong category mapping, pick the seller's own listed category that best matches the product text.
function simulateCorrections(seller, profile) {
  const ids = new Set(seller.truth.mcat_ids), parents = new Set(seller.truth.parents), cats = new Set(seller.truth.categories);
  const corrected = { ...profile, categories: [] };
  for (const c of profile.categories) {
    if (ids.has(c.mcatId) || parents.has(c.parent) || cats.has(c.category)) { corrected.categories.push(c); continue; }
    const better = search(c.sourceText, 40).find((x) => ids.has(x.id));
    if (better) corrected.categories.push({ ...c, mcatId: better.id, mcat: better.name, parent: better.parent, category: better.category });
  }
  corrected.locations = profile.locations; corrected.people = profile.people; corrected.businessName = { value: seller.truth.company_name };
  return corrected;
}

const run = (sellers, fb) => pool(sellers, 4, (s) => enrich(s.input, { feedback: fb }));

console.log(`Eval on ${all.length} labelled sellers (train ${train.length} / held-out test ${test.length})\n`);
const base = await run(test, emptyFb());
const baseScore = score(test, base);
console.log("HELD-OUT, before learning:", baseScore);

const trainRes = await run(train, emptyFb());
console.log("\nTRAIN set (first pass):", score(train, trainRes));
let fb = emptyFb();
trainRes.forEach((r, i) => { if (r?.profile) fb = applyFeedback(fb, { original: r.profile, corrected: simulateCorrections(train[i], r.profile) }); });
console.log("\nLearned corrections:", Object.keys(fb.categoryFixes).length, "| field stats:", fb.fieldStats, "| source stats:", fb.sourceStats);

const after = await run(test, fb);
const afterScore = score(test, after);
console.log("\nHELD-OUT, after learning from train corrections:", afterScore);
const trainAfter = await run(train, fb);
console.log("\nTRAIN set re-run after corrections:", score(train, trainAfter));

await writeFile(new URL("../data/eval_results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), baseScore, afterScore, trainFirst: score(train, trainRes), trainAfter: score(train, trainAfter) }, null, 2));
