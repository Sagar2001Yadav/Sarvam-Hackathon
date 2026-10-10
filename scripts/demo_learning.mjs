// Live-demo helper: seller A corrects a category -> seller B (same pattern) maps differently.
process.loadEnvFile();
import { enrich, applyFeedback } from "../lib.mjs";

const empty = () => ({ categoryFixes: {}, sourceStats: {}, fieldStats: { accepted: 0, edited: 0, removed: 0 }, log: [] });
const A = { businessName: "Sharma Steel Industries", rawText: "Sharma Steel Industries, Sahibabad, Ghaziabad, Uttar Pradesh 201010. Prop. Rakesh Sharma. We supply construction steel bars to builders." };
const B = { businessName: "Verma Iron Traders", rawText: "Verma Iron Traders, Loni, Ghaziabad, Uttar Pradesh 201102. Director Anil Verma. Hum construction steel bars supply karte hain." };
const show = (label, r) => console.log(label, r.profile.categories.map((c) => `"${c.sourceText}" -> ${c.mcat} #${c.mcatId} (${Math.round(c.confidence * 100)}%, ${c.via})`));

let fb = empty();
const a1 = await enrich(A, { feedback: fb });
show("A before:", a1);
const b1 = await enrich(B, { feedback: fb });
show("B before:", b1);

// Seller A corrects: "construction steel bars" means TMT Bars (#2475)
const corrected = { ...a1.profile, categories: a1.profile.categories.map((c) => /construction steel/i.test(c.sourceText) ? { ...c, mcatId: 2475, mcat: "TMT Bars" } : c) };
fb = applyFeedback(fb, { original: a1.profile, corrected });
console.log("\nA corrected. Learned:", fb.categoryFixes, "\n");

const b2 = await enrich(B, { feedback: fb });
show("B after :", b2);
