// Runs the call page's real conversation code (dialog + opening/closing steps) in Node with scripted seller replies.
// The server must be running (it does the language understanding).  Usage: node scripts/test_dialog.mjs
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
const grab = (start) => { const i = js.indexOf(start); if (i < 0) throw new Error("not found: " + start); return js.slice(i, js.indexOf("\n", i)).replace(/\r$/, ""); };
const end = js.search(/\/\/ -+ the call\r?\n\$\('call'\)/);
if (end < 0) throw new Error("could not find the start of the call handler");
const src = [
  grab("const YES="), grab("const NO="), grab("const norm="), grab("const FIELD_HI="), grab("const CLARIFY="), grab("let ackN="),
  js.slice(js.indexOf("const FILLER="), end),
].join("\n");

const api = (p, b) => fetch("http://localhost:3000" + p, b ? { method: "POST", body: JSON.stringify(b) } : {}).then((r) => r.json());
function world(script) {
  const bot = [], queue = [...script], win = {};
  const next = () => ({ transcript: queue.shift() ?? "", language_probability: 0.8 });
  const ask = async (q) => { if (q) bot.push(q); return next(); };
  const say = async (t) => { bot.push(t); };
  const listen = async () => next();
  const $ = () => ({ textContent: "" });
  const fns = new Function("ask", "say", "api", "seller", "window", "listen", "log", "eng", "$", `${src}\nreturn {dialog,identityStep,consentStep,pickupStep,closingStep};`)(
    ask, say, api, { seller_id: "D001" }, win, listen, () => {}, { ctx: null }, $);
  return { fns, bot, win };
}
let pass = 0, fail = 0;
async function scenario(name, script, fn, expect) {
  const { fns, bot, win } = world(script);
  const r = await fn(fns, win);
  const got = JSON.stringify(expect.pick(r, win));
  const ok = got === JSON.stringify(expect.want);
  ok ? pass++ : fail++;
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}\n  seller: ${script.map((s) => `"${s}"`).join(" -> ")}\n  bot:`);
  bot.forEach((b) => console.log("     • " + b));
  console.log(`  result: ${got}${ok ? "" : "   (expected " + JSON.stringify(expect.want) + ")"}`);
}
const ADDR = { field: "address", name: "address", pending: [{ field: "address" }], localYes: true, noPolicy: "ask-value" };
const QADDR = "Aur address: ABC, Noida, Uttar Pradesh. Ye sahi hai?";
const D = (o = ADDR, q = QADDR) => (f) => f.dialog(q, o);
const kind = (r) => ({ kind: r.kind, outcome: r.outcome });

// ---- field-level conversation
await scenario("A. says no twice, agrees to update, gives the value", ["nahi", "nahi", "haan update karo", "Sector 18 Noida hai"], D(), { pick: (r) => ({ kind: r.kind, cls: r.t?.results?.[0]?.classification }), want: { kind: "answer", cls: "corrected" } });
await scenario("B. says no twice, then leaves it", ["nahi", "galat hai", "rehne do"], D(), { pick: kind, want: { kind: "declined" } });
await scenario("C. asks who/why, then confirms", ["kaun bol raha hai? kis company se?", "ye sab kyun chahiye?", "haan sahi hai"], D(), { pick: (r) => ({ kind: r.kind, local: r.local }), want: { kind: "answer", local: "confirmed" } });
await scenario("D. asks to hold, then confirms", ["ek minute ruko", "haan sahi hai"], D(), { pick: (r) => r.kind, want: "answer" });
await scenario("E. busy -> callback", ["abhi main busy hoon, baad mein call karna", "shaam ko 6 baje"], D(), { pick: kind, want: { kind: "end", outcome: "callback" } });
await scenario("F. HARD refusal ('don't call again') ends at once", ["mujhe koi baat nahi karni, dobara call mat karna"], D(), { pick: kind, want: { kind: "end", outcome: "refused" } });
await scenario("F2. SOFT 'not interested' -> one polite attempt, then agrees", ["mujhe isme koi interest nahi hai", "achha theek hai, haan sahi hai"], D(), { pick: (r) => r.kind, want: "answer" });
await scenario("F3. 'not interested' twice -> graceful exit", ["mujhe isme interest nahi hai", "sach mein mujhe interest nahi hai, rehne dijiye"], D({ field: null, name: "consent", pending: [], localYes: true, noPolicy: "decline" }, "Kya abhi baat karna theek rahega?"), { pick: kind, want: { kind: "end", outcome: "not_interested" } });
await scenario("G. mumbles three times", ["hmm", "uh aa", "mm"], D(), { pick: kind, want: { kind: "unclear" } });
await scenario("H. total silence: Hello? ... Hello, can you hear me? ... then offers to call back", ["", "", ""], D(), { pick: kind, want: { kind: "end", outcome: "silent" } });
await scenario("H2. silent first, then answers after 'Hello?'", ["", "haan sahi hai"], D(), { pick: (r) => ({ kind: r.kind, local: r.local }), want: { kind: "answer", local: "confirmed" } });
await scenario("I. a manager answers", ["main unka manager hoon, bolo kya poochna hai", "haan sahi hai"], D(), { pick: (r, w) => ({ kind: r.kind, proxy: !!w.proxy }), want: { kind: "answer", proxy: true } });
await scenario("J. didn't hear, then confirms", ["kya? sunai nahi diya, dobara bolo", "haan sahi hai"], D(), { pick: (r) => r.kind, want: "answer" });
await scenario("K. off-topic chatter, then corrects", ["aaj bahut garmi hai na", "nahi, ab hum Sector 62 Noida mein hain"], D(), { pick: (r) => ({ kind: r.kind, cls: r.t?.results?.[0]?.classification }), want: { kind: "answer", cls: "corrected" } });
await scenario("M. website question: 'nahi hai' = no website, not a rejection", ["nahi hai"], D({ ...ADDR, field: "website", name: "website", pending: [{ field: "website" }], localYes: false, noMeansNone: true }, "Ek aur cheez ji, aapki website kya hai?"), { pick: (r) => ({ kind: r.kind, local: r.local }), want: { kind: "answer", local: "confirmed" } });

// ---- the way a person opens, checks the time, and closes
await scenario("P1. seller says hello first -> bot proceeds", ["hello?"], (f) => f.pickupStep(), { pick: (r) => !!r.ok, want: true });
await scenario("P2. line silent after pickup -> bot says Hello? and waits", ["", "haan hello"], (f) => f.pickupStep(), { pick: (r) => !!r.ok, want: true });
await scenario("P3. nobody ever speaks -> no_answer", ["", "", ""], (f) => f.pickupStep(), { pick: (r) => r.end?.outcome, want: "no_answer" });
const ID = (f) => f.identityStep("Namaste ji! Main Priya bol rahi hoon, IndiaMART se. Kya main Raghav ji se baat kar rahi hoon?", "Raghav Enterprises");
await scenario("S1. 'no' to identity but right business (manager on phone) -> continues", ["nahi", "haan ji yahi number hai", "haan bolo"], ID, { pick: (r, w) => ({ proceed: !!r.proceed, proxy: !!w.proxy }), want: { proceed: true, proxy: true } });
await scenario("S2. 'no' three times to identity -> polite exit", ["nahi", "nahi", "nahi"], ID, { pick: (r) => r.end?.outcome, want: "wrong_person" });
await scenario("S3. right business, person cannot help -> callback time", ["nahi", "haan", "nahi", "shaam ko 7 baje"], ID, { pick: (r) => r.end?.outcome, want: "callback" });
const INTRO = "Ji Raghav ji, bas do minute lagenge. Ye call record ho rahi hai. Kya abhi baat karna theek rahega?";
const CS = (f) => f.consentStep(INTRO);
await scenario("T1. 'Is it a good time?' -> yes straight away", ["haan bolo"], CS, { pick: (r) => r.given, want: true });
await scenario("T2. 'no' (busy), then agrees after the short reassurance", ["nahi", "achha theek hai, bolo"], CS, { pick: (r) => r.given, want: true });
await scenario("T2b. 'abhi nahi' (busy) -> bot asks for a callback time and books it", ["nahi abhi nahi", "kal subah 10 baje"], CS, { pick: (r) => r.end?.outcome, want: "callback" });
await scenario("T3. 'no', 'no', then gives a callback time", ["nahi", "nahi", "kal subah 10 baje"], CS, { pick: (r) => r.end?.outcome, want: "callback" });
await scenario("T4. 'no' three times, even to the callback -> graceful exit", ["nahi", "nahi", "nahi"], CS, { pick: (r) => r.given, want: false });
await scenario("C1. closing: no questions -> goodbye, waits for their bye", ["nahi bas", "bye"], (f) => f.closingStep("Raghav", 3, 1), { pick: () => "done", want: "done" });
await scenario("C2. closing: seller asks a question first, bot answers, then says goodbye", ["ye update kab tak hoga?", "theek hai", "thank you"], (f) => f.closingStep("Raghav", 3, 1), { pick: () => "done", want: "done" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
