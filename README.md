# Seller Enrichment (IndiaMART × Sarvam hackathon, Problem 6)

Minimal input (voice, name, phone, website, Google link, card/PDF, pasted text) → public data → locations, people, categories → IM schema → pre-filled, editable profile with confidence and source per field → corrections improve the system.

## Run
```
npm install
# .env must contain SARVAM_API_KEY=...
node server.mjs            # http://localhost:3000
node scripts/demo_learning.mjs   # seller A corrects, seller B improves
python -I scripts/prep_data.py   # rebuild taxonomy + eval set from datasets/
node scripts/eval.mjs 100        # accuracy on 100 labelled sellers (several minutes)
```

## Pipeline
1. **Input**: Sarvam Saaras speech-to-text (Hindi/English/Hinglish) → LLM seed parse; Sarvam Document Intelligence reads card/brochure images and PDFs; website pages (home/about/contact) and Google link are fetched only when the seller supplies them, after a consent tick.
2. **Extraction**: one Sarvam LLM call per source, strict JSON with a verbatim evidence snippet per value, output normalised to English/Roman script.
3. **Normalisation**:
   - Addresses split into street / locality / city / state / pincode; missing state inferred from IM city and pincode lookups (flagged as inferred); pincode/state disagreement lowers confidence and offers the alternative.
   - People merged across sources by token and transliteration-tolerant name match, roles assigned.
   - Categories: retrieval over the full IM taxonomy (96,957 product MCATs, built from `ref_category_taxonomy.csv`), then LLM picks the best candidate.
4. **Fusion**: values merged across sources with provenance; disagreements kept as alternatives with their sources and lowered confidence.
5. **Confidence** = evidence found in source + format/lookup validation + cross-source agreement + category retrieval/LLM score, scaled by a per-source trust learned from edits. Green ≥ 0.8, amber 0.5–0.8, red < 0.5 ("needs your review").
6. **Learning**: confirm/edit/remove events update (a) a category alias table keyed by product phrase, applied exactly and by similarity (hints + extra candidates), and (b) per-source trust. Similar-but-not-identical corrected products are flagged for review.

## Privacy
- Nothing is read until the seller ticks consent; only seller-provided sources are used.
- Every field shows its source and can be removed; nothing is stored until Confirm.
- Only business-relevant person data (name, role). Phones/emails are not extracted for people.
- Raw pages are not persisted; only structured values and provenance in `data/feedback.json`.
- Google Maps is not scraped; paste listing text or use an official API.

## Results (100 labelled sellers from `datasets/`, input = text from each seller's own KYC invoice; labels = verified IM profile)
| Metric | Result |
|---|---|
| Profile slots auto-populated (name, city, state, pincode, ≥1 category) | ~95% |
| Fields accepted without edits (simulated seller, train half) | 79% (98 of 124) |
| City / state correct | ~85% / ~90% |
| Pincode correct | ~57% (invoice addresses often differ from the profile address) |
| Category precision, strict (exact MCAT in seller's IM listing) | 23–27% |
| Category precision, broad (same MCAT, parent MCAT or category) | 65–70% |
| After learning, same products re-run | strict 27% → 47%, broad 65% → 89% |
| After learning, held-out sellers | no significant change (strict 22.7% → 17.5%, broad 69.7% → 71.4%) |

Caveats: the strict metric only counts the MCATs a seller happens to list, so it understates true precision; held-out sellers rarely share corrected products, so cross-seller gains show only for overlapping products (see `scripts/demo_learning.mjs`). Eval uses a simulated seller that corrects to its own listed categories.

## Gaps
No Google Places API integration, no GST lookup, no social pages, no live voice dialogue (voice is input-only), taxonomy retrieval is lexical (no embeddings yet).

## Outbound-call mode (current design)
IM dials a seller it already knows (company + city from sign-up), so the bot never asks for the business name:
1. Greets by company name and confirms identity. 2. Explains why it is calling and asks **consent by voice** (logged with time and the seller's words). 3. Only after consent reads the non-IM sources from the datasets: GST record (partners, legal status, nature of business), invoice, sign board and Udyam extractions (`data/leads.json`, built by `scripts/prep_leads.py`). Without consent nothing is read. 4. Asks only for what is still missing (location, products). 5. Confirms high-confidence fields in one batch, asks one by one about uncertain ones, applies spoken corrections/additions, saves by voice.

The verified IM profile (`so_sellers`, `so_seller_locations`, `so_seller_categories`) is used only as the answer key for evaluation.

`node scripts/eval_leads.mjs 100` (input = company name only + consented sources), 100 sellers:
| Metric | Result |
|---|---|
| Fields auto-populated (name, city, state, pincode, category) | 93.5% |
| People found vs GST partners (recall / precision) | 97.9% / 100% |
| City / state / pincode correct | 77% / 86% / 53% |
| Category precision, strict / broad | 25.5% / 71.5% |

---
# Current design: voice verification workflow (spec: "AI Voice-Based Seller Enrichment")

Outbound bot verifies stored seller data field by field, classifies each answer, scores it, and stores an auditable event. Corrections never overwrite silently: they wait for manual audit unless low-risk.

## Run
```
node server.mjs                      # http://localhost:3000   (call demo)   /audit (review queue)   /enrich (earlier prototype)
node scripts/simulate_calls.mjs      # scripted utterances through the same API, no microphone (resets demo data)
python -I scripts/prep_data.py && python -I scripts/prep_leads.py && python -I scripts/prep_reference.py   # rebuild data from datasets/
```

## Modules (what each consumes → produces)
| Module | File | Consumes | Produces |
|---|---|---|---|
| CSV data source | `data/seller_reference.csv`, `csv.mjs`, `db.mjs#seedFromCsv` | reference rows (real rows from `so_sellers`, plus 3 labelled `csv:demo` rows from the brief) | initial `seller_fields`, marked unverified |
| Outbound voice agent | `public/index.html` | seller record | spoken questions (Sarvam Bulbul), recorded answers |
| Speech-to-text | `inputs.mjs` (Sarvam Saaras, romanised) | audio | transcript + language probability |
| LLM processing | `verify.mjs#classify` (Sarvam LLM) | pending fields, question, utterance | per-field class (confirmed / corrected / newly_provided / unconfirmed / ambiguous), value, clarity, evidence |
| Validation + confidence | `verify.mjs#normalise/validate/scoreOutcome` | classification, value, utterance | normalised value, extraction confidence, value reliability, audit decision + reasons |
| Database | `db.mjs` (SQLite, `data/enrichment.db`) | scored events | `seller_fields` (current), `field_events` (append-only audit trail), `calls` (consent, transcript) |
| Manual audit UI | `public/audit.html` | pending events | approve / reject / approve-with-edit, note, reviewer, timestamp |
| Demo UI | `public/index.html` | any CSV seller | live field-outcome table |

Per field event stores: seller id, field, previous value, new/confirmed value, response class, original source, transcript evidence, extraction confidence, value reliability, factor breakdown, verification status, audit status + reasons, applied flag, reviewer/note/time, timestamp.

## Scoring (estimated, NOT calibrated probabilities; constants in `verify.mjs#SCORING`, served at `/api/scoring`)
- **Extraction confidence** = base by class (confirmed .90, corrected .85, new .80, unconfirmed .35, ambiguous .30) × clarity (explicit 1 / hedged .8 / unclear .6) × ASR (noisy .85, low language probability .9) × consistency (is the extracted value actually present in what was said: ≥.8 → 1, ≥.5 → .9, else .75) × contradiction (.75) × clarification rounds (.95).
- **Value reliability** (how likely the value itself is right, distinct from extraction): confirmed = source prior (.70) + .25 × extraction; changed value = .70 ± corroboration with GST/invoice/sign-board text (+.15 / −.20) ± validation (+.05 / −.15) + .10 if a website responds, scaled by (.6 + .4 × extraction).
- **Audit rules** → `pending` if any: ambiguous / unconfirmed; contradiction; validation failed (domain format, pincode format, pincode-state mismatch from IM geo data); extraction < .75; reliability < .70 on a new or corrected value; any corrected value (material change; only a reachable website at extraction ≥ .85 is auto-approved); conflict with a non-IM source. Otherwise `not_required` (confirmed) or `auto_approved` (new value). The live value changes only when an event is applied (auto-approved or approved by a reviewer); previous values are always kept in events.

## Implemented vs simulated vs missing
- **Real:** Sarvam STT, TTS and LLM; CSV load; classification; normalisation; validation (including live website reachability); scoring; SQLite audit trail; audit UI; consent logged by voice.
- **Simulated:** the "phone call" is the browser microphone and speakers. No telephony (real calls need Sarvam Voice Agents / Exotel-style integration, which would also give the caller number). `csv:demo` rows (D001–D003) are invented from the brief; the dataset has no website URLs so the website field is always asked.
- **Pre-call enrichment (kept from the earlier prototype):** products to verify come from GST / invoice / sign-board extractions (`enrichment:*` source), only after consent.
- **Not built:** Google or other live sources, reviewer authentication, score calibration against labelled outcomes, DB migration/production store.

## Test results
`scripts/simulate_calls.mjs`: 12 scripted Hinglish utterances across 6 sellers → 13/13 expected field classifications (confirmed, corrected, newly provided, unconfirmed, ambiguous/unconfirmed, partial confirmation, contradiction, "no website"). Small, scripted set: it checks the pipeline, not real-world accuracy. Browser voice path (translit transcripts, silence detection) still needs a live run.

## Conversation handling (any kind of reply)
`dialog()` in `public/index.html` wraps every question. The classifier (`verify.mjs#classify`) returns the field results plus a conversational type, and the bot reacts like a person:
| Seller says | Bot does |
|---|---|
| plain "no" (first time) | "Achha, to sahi address kya hai?" |
| "no" again | "Do you want to update this at all, or leave it?" → update: asks for the value; leave / later: records `unconfirmed` with the seller's words |
| who are you / why do you need this / is it safe / other question | answers briefly from fixed facts (no OTP/bank details, team reviews changes, can refuse), then re-asks |
| didn't hear / repeat | repeats the question with the stored value |
| "wait a minute" | waits up to 15 s before re-asking |
| busy / driving | asks when to call back, stores the callback note, ends the call (`outcome=callback`) |
| refuses / angry / "don't call" | apologises, ends, `outcome=refused` |
| wrong number | apologises, ends, `outcome=wrong_person` |
| a manager / employee answers | continues, evidence tagged "[answered by a representative]" |
| off-topic chatter | brief reply, steers back (after 3 digressions: "just a few questions") |
| mumbling / noise / silence | asks to repeat up to 3 times, then marks ambiguous; 2 silences → ends, "will call later" |
| answers a different field, or several at once | records each field it can, keeps asking the one still open |
`node scripts/test_dialog.mjs` runs the real `dialog()` with 12 scripted sellers against the server (all 12 behave as above). Not yet tested: the same flow with a live microphone, and barge-in (the bot cannot be interrupted while speaking).

## Interruptions (barge-in)
The microphone stays open for the whole call (`openMic`, `onFrame` in `public/index.html`). While the bot speaks, the level threshold is raised so its own voice leaking into the mic is ignored; when the seller speaks over it (about 260 ms of speech) the bot stops mid-word, the seller's words are captured from ~0.5 s before they started and are handled by the normal conversation logic (question, correction, answer). If the seller speaks over an acknowledgement, their words are used as the reply to the next question instead of being talked over. Audio is encoded to 16 kHz WAV in the browser. Toggle "allow interruptions" off when using speakers without headphones. `node scripts/test_engine.mjs` tests the detector, barge-in, pre-roll, click rejection and WAV/STT round trip offline. Not yet tested: a live microphone and real speaker echo.
