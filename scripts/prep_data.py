"""Builds data/taxonomy.json (full IM tree, compact) and data/eval_set.json (labelled sellers).
Run: python -I scripts/prep_data.py
"""
import csv, json, random, collections, os, re

csv.field_size_limit(10**9)
D1 = "datasets/Seller Onboarding - Dataset 1 of 4 (sellers, KYC, lookups)/"
N_EVAL = 100
random.seed(7)

# ---- taxonomy: only product MCATs, compact arrays ----
tax = []
for r in csv.DictReader(open(D1 + "ref_category_taxonomy.csv", encoding="utf8")):
    if r["is_product"] != "P":
        continue
    tax.append([int(r["mcat_id"]), r["mcat_name"], r["parent_mcat_name"], r["category_name"], r["group_name"], int(r["mcat_rank"] or 0)])
json.dump(tax, open("data/taxonomy.json", "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print("taxonomy mcats:", len(tax))

# ---- sellers ----
sellers = {r["fk_glusr_usr_id"]: r for r in csv.DictReader(open(D1 + "so_sellers.csv", encoding="utf8"))}


# ---- geo lookup: city -> state (IM ref tables), pincode prefix -> state (from verified sellers) ----
states = {}
for r in csv.DictReader(open(D1 + "ref_states.csv", encoding="utf8")):
    states[r["gl_state_id"]] = r["gl_state_name"]
city_state = collections.defaultdict(collections.Counter)
for r in csv.DictReader(open(D1 + "ref_cities.csv", encoding="utf8")):
    st = states.get(r["fk_gl_state_id"])
    if st:
        city_state[r["gl_city_name"].strip().lower()][st] += 1
pin = collections.defaultdict(collections.Counter)
for s_ in sellers.values():
    if s_["pincode"] and s_["state_name"]:
        pin[s_["pincode"][:3]][s_["state_name"]] += 1
        city_state[s_["city_name"].strip().lower()][s_["state_name"]] += 1
geo = {"cityState": {k: v.most_common(1)[0][0] for k, v in city_state.items()},
       "pinPrefixState": {k: v.most_common(1)[0][0] for k, v in pin.items()},
       "states": sorted(states.values())}
json.dump(geo, open("data/geo.json", "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print("geo cities:", len(geo["cityState"]), "pin prefixes:", len(geo["pinPrefixState"]))

# ---- documents: invoices + sign boards carry text we can treat as raw input ----
docs = collections.defaultdict(lambda: {"invoice": [], "sign": []})
for r in csv.DictReader(open(D1 + "so_kyc_documents.csv", encoding="utf8")):
    if not r["llm_extraction"]:
        continue
    try:
        j = json.loads(r["llm_extraction"])
    except Exception:
        continue
    t = r["document_type"]
    g = r["fk_glusr_usr_id"]
    if t == "Product Invoice" and j.get("Address") and any(p.get("name") for p in (j.get("Products") or []) if isinstance(p, dict)):
        docs[g]["invoice"].append(j)
    elif t == "Sign Board" and j.get("CompanyName"):
        docs[g]["sign"].append(j)

# ---- categories (answer key) ----
cats = collections.defaultdict(list)
for r in csv.DictReader(open(D1 + "so_seller_categories.csv", encoding="utf8")):
    cats[r["fk_glusr_usr_id"]].append(r)

def toks(x):
    return set(re.findall(r"[a-z0-9]+", (x or "").lower())) - {"pvt", "ltd", "private", "limited", "m", "s", "ms", "and", "the", "llp", "co", "company", "enterprises", "enterprise"}
def first_(v):
    return (v[0] if isinstance(v, list) and v else v) or ""
def name_match(g):
    t = toks(sellers[g]["company_name"])
    if not t:
        return False
    for inv in docs[g]["invoice"]:
        a = toks(first_(inv.get("CompanyName")))
        if a and len(a & t) / len(t) >= 0.6:
            return True
    return False
cands = [g for g in docs if docs[g]["invoice"] and g in sellers and len(cats.get(g, [])) >= 3 and name_match(g)]
random.shuffle(cands)
out = []
for g in cands[:N_EVAL]:
    s = sellers[g]
    inv = next(i for i in docs[g]["invoice"] if toks(first_(i.get("CompanyName"))) and len(toks(first_(i.get("CompanyName"))) & toks(s["company_name"])) / max(len(toks(s["company_name"])), 1) >= 0.6)
    first = lambda v: (v[0] if isinstance(v, list) and v else v) or ""
    lines = []
    name = first(inv.get("CompanyName"))
    lines.append(f"{name}")
    lines.append("Address: " + first(inv.get("Address")))
    if inv.get("GST"):
        lines.append("GSTIN: " + first(inv["GST"]))
    prods = [p.get("name", "") for p in inv["Products"] if isinstance(p, dict) and p.get("name")]
    lines.append("Items: " + "; ".join(prods[:8]))
    if docs[g]["sign"]:
        lines.append("Signboard: " + first(docs[g]["sign"][0].get("CompanyName")))
    out.append({
        "glid": g,
        "input": {"businessName": "", "phone": "", "rawText": "\n".join(lines)},
        "truth": {
            "company_name": s["company_name"],
            "city": s["city_name"], "state": s["state_name"], "pincode": s["pincode"],
            "designation": s["contact_designation"],
            "partners": s["gst_partner_names"],
            "mcat_ids": [int(c["mcat_id"]) for c in cats[g]],
            "primary_mcat_ids": [int(c["mcat_id"]) for c in cats[g] if c["is_primary_mapping"] == "1" or c["is_a_rank"] == "1"],
            "parents": sorted({c["parent_mcat_name"] for c in cats[g]}),
            "categories": sorted({c["category_name"] for c in cats[g]}),
        },
    })
json.dump(out, open("data/eval_set.json", "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("eval sellers:", len(out), "of candidates", len(cands))
