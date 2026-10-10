"""Builds data/seller_reference.csv: the pre-call reference data (stand-in for Google / production DB).
Real rows come from so_sellers.csv (existing profile values, NOT treated as ground truth by the bot).
Three clearly labelled demo rows mirror the example in the project brief.
Run: python -I scripts/prep_reference.py   (after prep_leads.py)
"""
import csv, json, re

D1 = "datasets/Seller Onboarding - Dataset 1 of 4 (sellers, KYC, lookups)/"
leads = json.load(open("data/leads.json", encoding="utf8"))
want = {l["glid"] for l in leads}
rows = {r["fk_glusr_usr_id"]: r for r in csv.DictReader(open(D1 + "so_sellers.csv", encoding="utf8")) if r["fk_glusr_usr_id"] in want}

def person(raw):
    first = (raw or "").split(",")[0]
    return re.sub(r"\s+", " ", first).strip().title()

out = []
for l in leads:
    s = rows[l["glid"]]
    out.append({
        "seller_id": l["glid"], "person_name": person(s["gst_partner_names"]), "company_name": s["company_name"],
        "locality": s["locality"], "city": s["city_name"], "state": s["state_name"], "pincode": s["pincode"],
        "website": "",  # dataset has no website URLs (only an availability flag), so the bot asks
        "designation": s["contact_designation"], "origin": "csv:so_sellers",
    })
# demo rows from the brief (labelled)
out += [
    {"seller_id": "D001", "person_name": "Raghav", "company_name": "Raghav Enterprises", "locality": "ABC", "city": "Noida", "state": "Uttar Pradesh", "pincode": "", "website": "", "designation": "Owner", "origin": "csv:demo"},
    {"seller_id": "D002", "person_name": "Sunita Verma", "company_name": "Verma Packaging Works", "locality": "Sector 63", "city": "Noida", "state": "Uttar Pradesh", "pincode": "201301", "website": "vermapackaging.in", "designation": "Partner", "origin": "csv:demo"},
    {"seller_id": "D003", "person_name": "Imran Khan", "company_name": "Khan Steel Traders", "locality": "Sahibabad Industrial Area", "city": "Ghaziabad", "state": "Uttar Pradesh", "pincode": "201010", "website": "", "designation": "Proprietor", "origin": "csv:demo"},
]
cols = list(out[0].keys())
with open("data/seller_reference.csv", "w", encoding="utf8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(out)
print("reference rows:", len(out), "| demo:", sum(1 for r in out if r["origin"] == "csv:demo"))
