import { readFileSync } from "node:fs";

// rows: [mcat_id, mcat_name, parent_mcat_name, category_name, group_name, mcat_rank]
const rows = JSON.parse(readFileSync(new URL("./data/taxonomy.json", import.meta.url), "utf8"));
const byId = new Map(rows.map((r) => [r[0], r]));

const STOP = new Set(["and", "the", "for", "of", "in", "with", "to", "a", "an", "mm", "kg", "pcs", "set", "new", "type", "size", "model", "high", "quality"]);
const stem = (w) => (w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export const tokens = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

// inverted index: token -> [[rowIdx, weight]]
const index = new Map();
const df = new Map();
rows.forEach((r, i) => {
  const seen = new Map();
  const add = (text, w) => { for (const t of tokens(text)) seen.set(t, Math.max(seen.get(t) || 0, w)); };
  add(r[1], 3); add(r[2], 1.5); add(r[3], 0.5);
  for (const [t, w] of seen) {
    if (!index.has(t)) index.set(t, []);
    index.get(t).push([i, w]);
    df.set(t, (df.get(t) || 0) + 1);
  }
});
const N = rows.length;

export function search(query, k = 12) {
  const qt = [...new Set(tokens(query))];
  if (!qt.length) return [];
  const score = new Map();
  for (const t of qt) {
    const list = index.get(t);
    if (!list) continue;
    const idf = Math.log(1 + N / df.get(t));
    for (const [i, w] of list) score.set(i, (score.get(i) || 0) + idf * w);
  }
  const maxPossible = qt.reduce((s, t) => s + (index.has(t) ? Math.log(1 + N / df.get(t)) * 3 : 0), 0) || 1;
  return [...score.entries()]
    .map(([i, s]) => {
      const r = rows[i];
      const nameTok = new Set(tokens(r[1]));
      const cover = qt.filter((t) => nameTok.has(t)).length / qt.length;           // how much of the query the MCAT name covers
      const tight = qt.filter((t) => nameTok.has(t)).length / Math.max(nameTok.size, 1); // penalise very long MCAT names
      return { id: r[0], name: r[1], parent: r[2], category: r[3], group: r[4], rank: r[5], score: s / maxPossible + cover * 0.6 + tight * 0.3 + Math.log10(1 + r[5]) * 0.01 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export const getMcat = (id) => {
  const r = byId.get(+id);
  return r && { id: r[0], name: r[1], parent: r[2], category: r[3], group: r[4] };
};
export const taxonomySize = rows.length;
