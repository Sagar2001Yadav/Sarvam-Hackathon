"""Builds data/leads.json: outbound-call leads from the datasets.
Each lead = what IM knows when it dials (company, city) + non-IM sources that need seller consent
(GST record, invoice / sign board / Udyam extractions) + the verified IM profile as the answer key.
Run: python -I scripts/prep_leads.py   (after prep_data.py)
"""
import csv, json, collections, re

csv.field_size_limit(10**9)
D1 = "datasets/Seller Onboarding - Dataset 1 of 4 (sellers, KYC, lookups)/"
eval_set = json.load(open("data/eval_set.json", encoding="utf8"))
want = {e["glid"]: e for e in eval_set}
sellers = {r["fk_glusr_usr_id"]: r for r in csv.DictReader(open(D1 + "so_sellers.csv", encoding="utf8")) if r["fk_glusr_usr_id"] in want}

first = lambda v: (v[0] if isinstance(v, list) and v else v) or ""

sign, udyam = {}, {}
for r in csv.DictReader(open(D1 + "so_kyc_documents.csv", encoding="utf8")):
    g = r["fk_glusr_usr_id"]
    if g not in want or not r["llm_extraction"]:
        continue
    try:
        j = json.loads(r["llm_extraction"])
    except Exception:
        continue
    t = r["document_type"]
    if t == "Sign Board" and j.get("CompanyName") and g not in sign:
        sign[g] = first(j["CompanyName"])
    if t == "Udhyam Certificate" and g not in udyam:
        u = j.get("udyam_data") or {}
        udyam[g] = {"units": u.get("units"), "major_activity": u.get("major_activity"), "enterprise_type": u.get("enterprise_type"),
                    "nic": [n.get("nic_4_digit") for n in (u.get("nic_codes") or []) if isinstance(n, dict)]}

def names(raw):
    return [re.sub(r"\s+", " ", n).strip().title() for n in (raw or "").split(",") if n.strip()]

def gst_text(s):
    ppl = names(s["gst_partner_names"])
    legal = s["gst_legal_status"] or s["legal_status"]
    if "Proprietor" in legal:
        who = f"Proprietor (owner): {', '.join(ppl)}"
    elif "Partnership" in legal or "LLP" in legal:
        who = f"Partners: {', '.join(ppl)}"
    elif "Company" in legal or "Ltd" in legal:
        who = f"Directors: {', '.join(ppl)}"
    else:
        who = f"Registered persons: {', '.join(ppl)}"
    lines = [f"GST registration record for {s['company_name']}", f"Constitution of business: {legal}", who]
    if s["gst_nature_of_business"]:
        lines.append("Nature of business: " + s["gst_nature_of_business"])
    if s["gst_nature_of_business_secondary"]:
        lines.append("Other activities: " + s["gst_nature_of_business_secondary"])
    if s["gst_registration_year"]:
        lines.append("Registered since: " + s["gst_registration_year"][:4])
    return "\n".join(lines)

leads = []
for g, e in want.items():
    s = sellers.get(g)
    if not s:
        continue
    inv_lines = [l for l in e["input"]["rawText"].split("\n") if not l.startswith("Signboard:")]
    srcs = []
    if names(s["gst_partner_names"]):
        srcs.append({"name": "gst-record", "type": "gst", "text": gst_text(s)})
    srcs.append({"name": "invoice-extraction", "type": "invoice", "text": "\n".join(inv_lines)})
    if g in sign:
        srcs.append({"name": "signboard-extraction", "type": "signboard", "text": "Sign board reads: " + sign[g]})
    if g in udyam:
        srcs.append({"name": "udyam-extraction", "type": "udyam", "text": "Udyam registration: " + json.dumps(udyam[g], ensure_ascii=False)})
    leads.append({"glid": g, "company": s["company_name"], "city": s["city_name"], "state": s["state_name"], "sources": srcs, "truth": e["truth"]})

json.dump(leads, open("data/leads.json", "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("leads:", len(leads), "| with GST:", sum(1 for l in leads if any(s["type"] == "gst" for s in l["sources"])),
      "| sign:", len(sign), "| udyam:", len(udyam))
