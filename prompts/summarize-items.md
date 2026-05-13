For each item in the JSON batch, follow **`config.digestDepth`** (`simple` | `detailed`; default **`detailed`**).

## Source priority (unchanged)

Summarize using, in order: `pdfText` → `transcript` → **`articleText`** → `excerpt`. Never fabricate beyond these.

Before summarizing, apply a strict relevance gate: skip items that are not materially related to KYC, AML, KYB, identity verification, fraud, compliance, regulatory policy, financial crime, onboarding risk, or trust/safety. Do not output employer-branding, employee wellness, generic culture, hiring, or unrelated corporate updates.

---

## `simple`

- Start each item with `### Verbatim title`.
- Do not use bullet list item formatting such as `- **Title** —`.
- After the title: **one** narrative block, 2–4 sentences.
- Optional: at most **2** short sub-bullets for standout numbers if the text features them prominently.
- Do not mention fetching, transcripts, AssemblyAI, central feeds, source fields, or any internal pipeline detail.

---

## `detailed` — **COMPETITOR_OFFICIAL** (follow-builders **blog** style)

For **`COMPETITOR_OFFICIAL`** article-like items, mirror the intent of follow-builders **`summarize-blogs.md`** while making the business relevance explicit:

1. **Opening line:** `### Verbatim title` (see parent `digest-intro` for heading pattern). Do not prefix with `companyId`, source labels, bullets, or `**`.
2. **Length:** aim for **100–300 words** of digest text when `articleText` supports it; compress if the source is short.
3. **Lead with the punchline:** product claim, regulatory angle, market stat, customer pain, or fraud thesis — **no** throat-clearing.
4. **Named specifics:** products, programs, regulators, people — **only** if named in the source fields.
5. **Numbers:** include concrete **figures, dates, %, currencies** the source states; do not round or reinterpret beyond what the text allows.
6. **Quote:** **≥1 direct verbatim quote** from `articleText` when there is suitable material (short sentence or clause); otherwise omit the quote block entirely.
7. **Practical implications:** explicitly call out what a **presales / commercial / compliance / fraud / identity / product** reader should **use in customer conversations** — only if the article implies it; no generic “firms should monitor trends” unless the article says so.
8. **Voice:** crisp, forwardable, **no** meta filler (“In this post…”). Like a smart colleague, not a book report.
9. **Link:** canonical **`url`**, own line at the end of the item.

Optional: **≤3** “At a glance” bullets **after** the prose if numbers would bury the lead; each bullet must map to a phrase in `articleText`.

---

## `detailed` — **REGULATORY_TRACKING**

Write regulatory items as concise **tweet/content briefs**, not sales talk tracks.

- Identify the **regulator / account** and summarize the **tweet text** from `tweetText` or `excerpt`.
- State any concrete topic, update, report, guidance, deadline, consultation, enforcement, or linked publication mentioned in the tweet.
- Include **timeline / deadline / effective date** when present.
- Distinguish **final rule / enforcement / warning / consultation / guidance / social alert** only when the tweet says so.
- Keep it short and include the tweet URL; do not add product implication or sales angle unless the tweet itself states one.

---

## `detailed` — **COMPETITOR_PODCAST** (follow-builders **podcast** style when transcript exists)

When `transcript` is present, align with follow-builders **`summarize-podcast.md`** spirit:

- **200–400 words** remix.
- Start with a **one-sentence takeaway** (the single most important idea).
- Speaker / role context from `excerpt` + transcript only.
- **≥1 memorable verbatim quote** from `transcript` when possible.
- Write **standalone** lessons — avoid “this episode / the host asks / in the video.”
- Translate jargon only when needed for a general business reader.
- **Links:** include **`youtubeWatchUrl`** (specific video) when present; also episode **`url`** if both exist.
- Do not mention whether the transcript came from AssemblyAI, YouTube captions, pod2txt, or any other internal source.

When **no** `transcript`: metadata + both URLs only; state that full episode text was unavailable.

---

## Edge cases

- **PDF with empty `pdfText`:** extraction failed; title + URL; no body claims.
- **Multiple `companyId` values:** open each major section with a one-line roster if helpful, then items.

Output Markdown under the correct category; use `###` per item in both `simple` and `detailed` mode.
