import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadCsv } from "./csv.mjs";

// Seller enrichment database: current field values + an append-only event log (the audit trail).
export const db = new DatabaseSync(fileURLToPath(new URL("./data/enrichment.db", import.meta.url)));
db.exec(`
CREATE TABLE IF NOT EXISTS sellers (seller_id TEXT PRIMARY KEY, origin TEXT, designation TEXT);
CREATE TABLE IF NOT EXISTS seller_fields (
  seller_id TEXT, field TEXT, value TEXT, data TEXT, source TEXT, verification_status TEXT, updated_at TEXT,
  PRIMARY KEY (seller_id, field));
CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, seller_id TEXT, started_at TEXT, ended_at TEXT, consent_given INTEGER, consent_text TEXT, transcript TEXT);
CREATE TABLE IF NOT EXISTS field_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, seller_id TEXT, field TEXT,
  previous_value TEXT, previous_data TEXT, new_value TEXT, new_data TEXT,
  classification TEXT, original_source TEXT, evidence TEXT, utterance TEXT,
  extraction_confidence REAL, value_reliability REAL, confidence_factors TEXT,
  verification_status TEXT, audit_status TEXT, audit_reasons TEXT, applied INTEGER,
  reviewer TEXT, reviewer_note TEXT, reviewed_at TEXT, final_value TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS ev_seller ON field_events(seller_id, field);
CREATE INDEX IF NOT EXISTS ev_audit ON field_events(audit_status);
`);

for (const col of ["outcome TEXT", "callback_note TEXT"]) { try { db.exec("ALTER TABLE calls ADD COLUMN " + col); } catch { /* already there */ } }
export const FIELDS = ["person_name", "company_name", "address", "website", "products"];
const now = () => new Date().toISOString();
const j = (x) => (x == null ? null : JSON.stringify(x));
const unj = (x) => { try { return x == null ? null : JSON.parse(x); } catch { return null; } };

export const addressText = (a) => [a?.street || a?.locality, a?.city, [a?.state, a?.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// Load the reference CSV as the initial (unverified) values. reset=true wipes calls, events and values first.
export function seedFromCsv(path, { reset = false } = {}) {
  if (reset) db.exec("DELETE FROM field_events; DELETE FROM calls; DELETE FROM seller_fields; DELETE FROM sellers;");
  const have = db.prepare("SELECT COUNT(*) n FROM sellers").get().n;
  if (have) return have;
  const put = db.prepare("INSERT OR IGNORE INTO seller_fields VALUES (?,?,?,?,?,?,?)");
  const sel = db.prepare("INSERT OR IGNORE INTO sellers VALUES (?,?,?)");
  const rows = loadCsv(path);
  db.exec("BEGIN");
  for (const r of rows) {
    sel.run(r.seller_id, r.origin, r.designation);
    const src = r.origin || "csv";
    const addr = { street: r.locality, city: r.city, state: r.state, pincode: r.pincode };
    put.run(r.seller_id, "person_name", r.person_name, null, src, "unverified", now());
    put.run(r.seller_id, "company_name", r.company_name, null, src, "unverified", now());
    put.run(r.seller_id, "address", addressText(addr), j(addr), src, "unverified", now());
    put.run(r.seller_id, "website", r.website, null, src, "unverified", now());
    put.run(r.seller_id, "products", "", j({ items: [] }), src, "unverified", now());
  }
  db.exec("COMMIT");
  return rows.length;
}

export const listSellers = () => {
  const rows = db.prepare(`SELECT s.seller_id, s.origin, s.designation,
      MAX(CASE WHEN f.field='company_name' THEN f.value END) company, MAX(CASE WHEN f.field='person_name' THEN f.value END) person,
      MAX(CASE WHEN f.field='address' THEN f.value END) address
      FROM sellers s JOIN seller_fields f USING(seller_id) GROUP BY s.seller_id`).all();
  const pend = Object.fromEntries(db.prepare("SELECT seller_id, COUNT(*) n FROM field_events WHERE audit_status='pending' GROUP BY seller_id").all().map((r) => [r.seller_id, r.n]));
  return rows.map((r) => ({ ...r, pending: pend[r.seller_id] || 0 }));
};

export function getSeller(id) {
  const fields = db.prepare("SELECT * FROM seller_fields WHERE seller_id=?").all(id).map((f) => ({ ...f, data: unj(f.data) }));
  const events = db.prepare("SELECT * FROM field_events WHERE seller_id=? ORDER BY id").all(id).map(parseEvent);
  const seller = db.prepare("SELECT * FROM sellers WHERE seller_id=?").get(id);
  return seller && { ...seller, fields, events };
}
export const getField = (id, field) => {
  const f = db.prepare("SELECT * FROM seller_fields WHERE seller_id=? AND field=?").get(id, field);
  return f && { ...f, data: unj(f.data) };
};

const parseEvent = (e) => ({ ...e, previous_data: unj(e.previous_data), new_data: unj(e.new_data), confidence_factors: unj(e.confidence_factors), audit_reasons: unj(e.audit_reasons) || [] });

export function startCall(call_id, seller_id) {
  db.prepare("INSERT OR REPLACE INTO calls (call_id, seller_id, started_at) VALUES (?,?,?)").run(call_id, seller_id, now());
}
export function endCall(call_id, { consent_given, consent_text, transcript, outcome, callback_note }) {
  db.prepare("UPDATE calls SET ended_at=?, consent_given=?, consent_text=?, transcript=?, outcome=?, callback_note=? WHERE call_id=?").run(now(), consent_given ? 1 : 0, consent_text || "", j(transcript), outcome || "", callback_note || "", call_id);
}

// Append an event; never overwrites history. The live value changes only if the event is applied (auto-approved or later approved).
export function insertEvent(e) {
  const id = db.prepare(`INSERT INTO field_events (call_id, seller_id, field, previous_value, previous_data, new_value, new_data, classification, original_source, evidence, utterance,
      extraction_confidence, value_reliability, confidence_factors, verification_status, audit_status, audit_reasons, applied, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.call_id, e.seller_id, e.field, e.previous_value, j(e.previous_data), e.new_value, j(e.new_data), e.classification, e.original_source, e.evidence, e.utterance,
    e.extraction_confidence, e.value_reliability, j(e.confidence_factors), e.verification_status, e.audit_status, j(e.audit_reasons), e.applied ? 1 : 0, now()).lastInsertRowid;
  if (e.applied) applyToField(e.seller_id, e.field, e.new_value, e.new_data, e.classification, e.original_source, e.verification_status);
  else db.prepare("UPDATE seller_fields SET verification_status=?, updated_at=? WHERE seller_id=? AND field=?").run(e.verification_status + " (pending review)", now(), e.seller_id, e.field);
  return parseEvent(db.prepare("SELECT * FROM field_events WHERE id=?").get(id));
}

function applyToField(seller_id, field, value, data, classification, origin, verification) {
  const source = classification === "confirmed" ? `${origin}+seller-confirmed` : "seller-voice";
  db.prepare("INSERT INTO seller_fields VALUES (?,?,?,?,?,?,?) ON CONFLICT(seller_id, field) DO UPDATE SET value=excluded.value, data=excluded.data, source=excluded.source, verification_status=excluded.verification_status, updated_at=excluded.updated_at")
    .run(seller_id, field, value ?? "", j(data), source, verification, now());
}

export const listEvents = ({ audit_status, seller_id, limit = 200 } = {}) => {
  const w = [], a = [];
  if (audit_status) { w.push("audit_status=?"); a.push(audit_status); }
  if (seller_id) { w.push("seller_id=?"); a.push(seller_id); }
  return db.prepare(`SELECT e.*, (SELECT value FROM seller_fields WHERE seller_id=e.seller_id AND field='company_name') company FROM field_events e ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ${+limit}`).all(...a).map(parseEvent);
};

// Human review: approve (applies the proposed value), reject (keeps the previous value), or approve with a corrected value.
export function decide(id, { decision, value, data, note, reviewer = "reviewer" }) {
  const ev = db.prepare("SELECT * FROM field_events WHERE id=?").get(id);
  if (!ev) throw new Error("event not found");
  const status = decision === "reject" ? "rejected" : "approved";
  let final = null, finalData = null;
  if (decision !== "reject") {
    final = value != null && value !== "" ? value : ev.new_value;
    finalData = data ?? unj(ev.new_data);
    applyToField(ev.seller_id, ev.field, final, finalData, ev.classification, ev.original_source, value ? "reviewer-corrected" : ev.verification_status);
  } else {
    db.prepare("UPDATE seller_fields SET verification_status=?, updated_at=? WHERE seller_id=? AND field=?").run("update rejected by reviewer", now(), ev.seller_id, ev.field);
  }
  db.prepare("UPDATE field_events SET audit_status=?, applied=?, reviewer=?, reviewer_note=?, reviewed_at=?, final_value=? WHERE id=?")
    .run(status, decision === "reject" ? 0 : 1, reviewer, note || "", now(), final, id);
  return parseEvent(db.prepare("SELECT * FROM field_events WHERE id=?").get(id));
}

export const stats = () => ({
  sellers: db.prepare("SELECT COUNT(*) n FROM sellers").get().n,
  events: db.prepare("SELECT COUNT(*) n FROM field_events").get().n,
  byClassification: Object.fromEntries(db.prepare("SELECT classification k, COUNT(*) n FROM field_events GROUP BY classification").all().map((r) => [r.k, r.n])),
  byAudit: Object.fromEntries(db.prepare("SELECT audit_status k, COUNT(*) n FROM field_events GROUP BY audit_status").all().map((r) => [r.k, r.n])),
});
