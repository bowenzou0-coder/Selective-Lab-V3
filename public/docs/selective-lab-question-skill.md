---
name: selective-lab-question-skill
description: Generate original 1.5x-difficulty NSW Selective High School practice questions (Reading, Mathematical Reasoning, Thinking Skills, Writing) as Selective Lab BankImportManifest JSON. In the Selective Lab checkout, also accept pasted question text or Claude.ai JSON for validated import into the live question bank.
---

# 1. Difficulty Anchor & Scope

Read `references/calibration-anchors-1.5x.json` before authoring to lock the **1.5× real NSW Selective exam** bar, passage/poem lengths, SVG style, and JSON shape. Never reuse anchor scenarios.

- **Volume:** Generate whatever the user requests, or a **full standardised exam set (`93 Qs / 114 slots`)** by default. For full sections in chat, split cleanly into 2 turns in one chat (e.g. Reading P1–3 then P4–5; Maths/Thinking Q1–18 then rest) — each turn emits one self-contained manifest with zero repeated scenarios. Small Reading requests (e.g. "5 Reading Qs") still use **one full passage (~500–650w) or full 20–28 line poem**, never micro-snippets.
- **Spread:** Distribute evenly across canonical `skillId`s, formats, mechanisms, and answer letters (`A`–`D` / `A`–`E`). No two items share a scenario or trick.
- **1.5× Depth (`difficultyInitial`: READ 3.9–4.6, MATH 4.0–4.7, THINK 4.1–4.8, WRIT 3.9–4.5; omit `difficultyCalibrated`):** Require **3+ linked decisions** with a non-obvious bridge (hidden invariants, before/after transfers, bar-model systems, systematic counting, worst-case bounds, clean dependent probability, overlapping 2D/3D geometry, chained *"only if"* rules, two-cut folds, subtext/tone shifts). Keep arithmetic paper-solvable (no calculator).
- **Locked NSW Stage 3 (Year 5–6) Maths Scope (Authoritative — Do NOT web-search NSW/NESA):**
  - *In scope:* place value/decimals/negatives, order of operations, factors/multiples/primes/divisibility/remainders, fractions/percentages/ratios/proportions/clean dependent probability, bar-model/two-unknown word systems/working backwards/symbol equations/inequalities/cryptarithms/sequences, 24h time/time zones/clock angles, metric conversions/scales, 2D perimeter/composite area/angles/compass/symmetry/transformations/Cartesian grids, 3D nets/prisms/cube stacks/views/shadows/volume & mass scaling, basic Pythagoras with clean triples (`3-4-5`, `5-12-13`, `6-8-10`) and clean standard 3D formulas, graphs/tables/mean-median-mode reconstruction, systematic counting & constrained optimisation.
  - *Forbidden (never use):* quadratics, formal `nCr`/`nPr` or `(n−1)!`, trigonometry/radians, logarithms, calculus, calculator-heavy decimals, Latin fallacy jargon (*modus tollens*, *ad hominem*), or archaic vocabulary stumpers.

# 2. Locked Official NSW Format (2025+ Computer-Based — No Web Lookup)

> Do NOT browse or search `education.nsw.gov.au` or `curriculum.nsw.edu.au` to re-verify exam counts, timing, or syllabus scope. Deeper craft patterns live in `references/real-exam-calibration-2021-2023.md`.

| Section | Time | Qs (Slots) | Format & Options | Blueprint & Rules |
|---|---:|---:|---|---|
| **Reading** | 45m | **17 (38)** | 5 parts (`A`–`D` / pool) | **P1 `READ_FICTION_MCQ` (8 Qs, A–D):** ~550–700w single literary extract OR paired `Text A` (~300–350w fiction) + `Text B` (~250–320w non-fiction) with `genreOrTextType: "paired_extracts"`, `extracts: [A, B]`.<br>**P2 `READ_VOCAB_CLOZE` (1 Q × 8 gaps, A–D):** ~180–300w informational cloze (`{{gap:1}}`–`8`), 2–3 grammatical options per gap.<br>**P3 `READ_POETRY_MCQ` (6 Qs, A–D):** 20–28 line poem (3–5 stanzas) testing imagery, structure, tone shift.<br>**P4 `READ_GAPPED_TEXT` (1 Q × 6 gaps, A–G):** ~450–600w article; alternate removed sentences vs paragraph headings (`{{gap:1}}`–`6`), 7 extracts A–G with 1 `isDecoy: true`, `options: []`, `sharedPoolConfig: { reuseAllowed: false, poolKeys: ["A".."G"] }`.<br>**P5 `READ_MULTIPLE_MATCH` (1 Q × 10 stmts, A–D):** 4 voices (~140–180w each), `options: []`, `sharedPoolConfig: { reuseAllowed: true, poolKeys: ["A".."D"] }`. |
| **Maths** | 40m | **35 (35)** | `MATH_MCQ_5` (A–E), 65–85s | 55–65% visual density; `[diagram not to scale]` on schematic figures; 2–3 multi-statement (`1/2/3`) verification items per set. |
| **Thinking** | 40m | **40 (40)** | `THINK_MCQ_4` (A–D), 60–75s | ~20% boxed-rule *"whose reasoning is correct?"* (put boxed rules in `stemPrefix`, options `A <N1> only / B <N2> only / C Both / D Neither`); ~10% concrete mistake/flaw in plain Year 6 English; ~10% weaken/strengthen (~3:1 weaken); ~7% must/cannot be true (zero parallel-reasoning/main-conclusion); ~25–35% spatial & visual-data. |
| **Writing** | 30m | **1 (1)** | `WRIT_TYPED_TASK`, 1800s | Rotate authentic genres (newspaper report, diary, competition email, advice sheet, persuasive letter, speech, narrative). MUST link `stimulusId` (`WRIT` stimulus with evocative non-generic `title` + 2–4 sentence scenario/task in `mainTextMarkdown`), `writingSpec` (`genre`, `audience`, `purpose`, 3 `bulletSuggestions`, optional `mandatoryOpeningLine`, `recommendedWordRange: [250,480]`, `timeLimitSec: 1800`), 1 part (`options: []`, `correctAnswerKey: ""`, `skillId: "WRIT.CRIT.TOPIC_PROMPT_ADHERENCE"`, `distractorRationales: {}`). Target ~50% image-prompt (`image_asset` `<95 KB` landscape WebP data URI, zero embedded text, `altText` + 1-sentence `caption`); skip image generation cleanly if unsupported. |

# 3. Locked Naming Standard (Validator-Enforced)

Every manifest MUST follow this exact naming grammar — **no `seed_`, no `batch_`, no topic slugs, and never chunk codes like `m1`/`m2`, `r1`/`r2`, or `t1`/`t2`**:

- **`batchLabel`:** `YYYY-MM-DD_bNN` — date + 2-digit daily batch counter (e.g. `2026-11-22_b01`, `2026-11-22_b02`).
- **`<sec>`:** exact lowercase section name: **`read`**, **`math`**, **`think`**, or **`writ`**.
- **`stimulusFamilyId`:** `<batchLabel>_<sec>_s<nn>` (e.g. `2026-11-22_b01_read_s01`) → **`stimulusId`:** `<stimulusFamilyId>_v<version>` (`..._v1`).
- **`questionFamilyId`:** `<batchLabel>_<sec>_<nn>` (e.g. `2026-11-22_b01_math_01`) → **`questionId`:** `<questionFamilyId>_v<version>` (`..._v1`).
- **`partId`:** `<questionFamilyId>_p<partIndex+1>` (1-based, e.g. `2026-11-22_b01_read_09_p1`..`_p8`).
- **Full-set Reading order:** `read_01`–`08` (P1 Fiction, `read_s01`), `read_09` (P2 Cloze, `read_s02`), `read_10`–`15` (P3 Poetry, `read_s03`), `read_16` (P4 Gapped, `read_s04`), `read_17` (P5 Match, `read_s05`).

# 4. Formatting, Solutions & Strict Quality Gate

`scripts/validate_manifest.mjs --strict` enforces these — re-solve every item silently before returning:

- **Scannable stems:** Break multi-condition Maths/Thinking stems into short `\n\n` paragraphs (context → conditions/list → closing question). Put every `• ` bullet and `1. ` item on its own line with blank lines around the list. Use real `\n` (never double-escaped `\\n`). No raw `**bold**` in `promptText`, `stemPrefix`, or `workedExplanation` (use plain text or occasional ALL-CAPS like `SMALLEST`, `NOT`, `MUST`).
- **Math typography:** Write unit powers as Unicode `cm²`, `m³`, `km²` (never `cm2`). Other exponents may use `3^2` or `x^{n+1}` in prompts, options and explanations (the app typesets them as superscripts); inside SVG `<text>` use `²`/`³` or `<tspan baseline-shift="super">`, never `^`. Show `[diagram not to scale]` once per item, preferably as `visual.caption`, not also in `promptText`.
- **Year 6 `workedExplanation` & `distractorRationales`:** Maths uses numbered steps `1)`, `2)`, `3)` with units, quick sanity check, and ends on the final answer letter/value. Thinking walks rules/counter-examples in plain Year 6 English. Reading quotes textual evidence and contrasts the closest distractor. Writing gives 6-criterion rubric guidance + pitfalls (`distractorRationales: {}`). For all objective parts, explain every wrong key in `distractorRationales` (≥20 chars naming the specific mistake; never include `correctAnswerKey`).
- **Answer hygiene:** Zero duplicate option texts; no "all/none of the above"; correct option not ≥1.9× longer than distractor median; per format across a batch, no letter >40%, every letter used, never 4+ consecutive identical keys; ≤35% literal-recall Reading MCQs.

# 5. Visuals, Palette & Anthropic Fonts

Details in `references/visual-palette-and-sizing.md`. Attach visuals to `question.visual`, `stimulus.visual`, or `options[].visual` (never `part.visual`).

- **Sizing:** Question/stimulus SVGs `viewBox="0 0 560 320"` to `640 360` (height `<= 420`). Option tile SVGs (`options[].visual`) `viewBox="0 0 180 140"`, `220 140`, or `160 160` with `option.text <= 48` chars (enables 2×2 tile grid). Omit huge pixel `width`/`height`.
- **Anthropic fonts (automatic — save tokens):** Selective Lab bundles and automatically applies **`AnthropicSansText`** to all inline SVGs (in the app, preview, and importer). **Do NOT repeat `font-family` on every `<text>` element** — simply omit `font-family` (or set `font-family="AnthropicSansText"` once on `<svg>`). Use `font-family="AnthropicMono"` or `"AnthropicSerifText"` only where a different Anthropic face is intentionally needed; never hardcode `Arial`, `Times`, or misspelled `Anthropic Sans`.
- **SVG hygiene & palette:** Valid XML with `xmlns="http://www.w3.org/2000/svg"` and numeric `viewBox`; balanced tags; all labels inside `viewBox` with no overlap; zero `<script>`, `on*=`, `foreignObject`, external URLs, or answer leakage in `altText`/captions. Palette: surfaces `#FFFFFF` / `#FAF8F5` / `#F3EFE8`, ink `#113C36` / `#4A5955` / `#78756E`, borders `#E5DFD5` / `#CFC6B9`, accents `#F29A63`, `#1F7A4C`, `#3B5B6D`, `#B83A28`.

# 6. BankImportManifest Contract

- **Top-level:** `manifestVersion: "1.0"`, `batchLabel` (`YYYY-MM-DD_bNN`), `defaultPoolType: "practice"`, `defaultQcStatus: "active"` (use `"verified"` only if staging Paused), `stimuli: [...]`, `questions: [...]`.
- **Item rules:** `version: 1`, zero-based `partIndex`, `slotRef` = `gap:1..N` (Cloze/Gapped) or `stmt:1..10` (Match). Omit server-generated fields (`contentHash`, `evidenceRevision`, `batchId`, per-item `batchLabel`, timestamps, `difficultyCalibrated`). Include `evidenceRefs` ONLY if exact UTF-16 `startOffset`/`endOffset` are computed programmatically (`text.slice(start, end) === quote`).
- **Provenance:** `{ "sourceType": "ai_generated", "sourceReference": "<batchLabel>", "verifierAgreed": true, "auditorReviewed": false }`.

# 7. Canonical `skillId` Values (77 — Use ONLY These)

- **READ (18):** `READ.FIC.LITERAL_DETAIL`, `READ.FIC.CHARACTER_INFERENCE`, `READ.FIC.IMPLIED_MEANING`, `READ.FIC.TONE_ATTITUDE`, `READ.FIC.TECHNIQUE_EFFECT`, `READ.FIC.TEXT_STRUCTURE`, `READ.CLOZE.COLLOCATION`, `READ.CLOZE.CONTEXT_NUANCE`, `READ.CLOZE.DISCOURSE_CONNECTOR`, `READ.POEM.LITERAL_SENSE`, `READ.POEM.FIGURATIVE_IMAGERY`, `READ.POEM.FORM_TONE_EFFECT`, `READ.GAP.COHESIVE_BRIDGE`, `READ.GAP.REFERENTIAL_PRONOUN_LINK`, `READ.GAP.PARAGRAPH_PROGRESSION`, `READ.MATCH.PRECISE_CONDITION`, `READ.MATCH.CROSS_TEXT_COMPARE`, `READ.MATCH.VIEWPOINT_CHANGE`.
- **MATH (32):** `MATH.NUM.DIVISIBILITY_REMAINDERS`, `MATH.NUM.NUMBER_SEQUENCES`, `MATH.NUM.PLACE_VALUE_DECIMALS`, `MATH.NUM.FACTORS_MULTIPLES_PRIMES`, `MATH.FRAC.FRACTION_CHAINS`, `MATH.FRAC.TRUE_FALSE_STATEMENTS`, `MATH.FRAC.RATIO_PROPORTION`, `MATH.FRAC.PERCENTAGES`, `MATH.FRAC.PROBABILITY_DEPENDENT`, `MATH.ALG.TWO_UNKNOWN_SYSTEMS`, `MATH.ALG.WORKING_BACKWARDS`, `MATH.ALG.SYMBOL_EQUATIONS`, `MATH.ALG.INEQUALITIES_BOUNDS`, `MATH.ALG.DIGIT_CRYPT_PUZZLES`, `MATH.TIME.ELAPSED_24H`, `MATH.TIME.TIME_ZONES_ITINERARY`, `MATH.TIME.CLOCK_ANGLES`, `MATH.MEAS.DIAL_GAUGE_OFFSET`, `MATH.MEAS.BALANCE_SCALES`, `MATH.MEAS.UNIT_CONVERSIONS`, `MATH.GEO2D.COMPOSITE_AREA`, `MATH.GEO2D.COMPOSITE_PERIMETER`, `MATH.GEO2D.ANGLES_PROTRACTOR`, `MATH.GEO2D.SYMMETRY_ROTATION_REFLECT`, `MATH.GEO2D.COMPASS_TURNS`, `MATH.GEO3D.CUBE_STACK_COUNT`, `MATH.GEO3D.NETS_SOLIDS`, `MATH.GEO3D.FACES_EDGES_VERTICES`, `MATH.DATA.BAR_LINE_GRAPHS`, `MATH.DATA.MEAN_RECONSTRUCTION`, `MATH.COMB.CONSTRAINED_OPTIMISATION`, `MATH.COMB.GRID_PATHS_COORDS`.
- **THINK (21):** `THINK.VERBAL.STRENGTHEN_ARGUMENT`, `THINK.VERBAL.WEAKEN_ARGUMENT`, `THINK.VERBAL.IDENTIFY_FLAW`, `THINK.VERBAL.IMPLICIT_ASSUMPTION`, `THINK.DEDUCT.WHOSE_REASONING_CORRECT`, `THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE`, `THINK.DEDUCT.LOGIC_GRID_CONSTRAINTS`, `THINK.DEDUCT.LINE_CIRCLE_ARRANGEMENT`, `THINK.DEDUCT.DEDUCTIVE_ORDERING`, `THINK.DEDUCT.SET_SYLLOGISMS`, `THINK.DEDUCT.KNIGHTS_AND_LIARS`, `THINK.DEDUCT.CRYPTOGRAM_MAPPING`, `THINK.DEDUCT.CYCLE_CHAIN_REASONING`, `THINK.NUM.SYSTEMS_WORD_PUZZLES`, `THINK.NUM.MIN_COST_COMBINATIONS`, `THINK.NUM.TABLE_CHART_RATE_LOGIC`, `THINK.NUM.OVERLAP_COUNTING`, `THINK.NUM.NETWORK_GRAPH_ROUTES`, `THINK.SPATIAL.VIEWS_3D_SILHOUETTES`, `THINK.SPATIAL.FOLD_CUT_TILE_ASSEMBLY`, `THINK.SPATIAL.PATTERN_ROTATION_SYMMETRY`.
- **WRIT (6):** `WRIT.CRIT.TOPIC_PROMPT_ADHERENCE`, `WRIT.CRIT.IDEAS_CREATIVITY`, `WRIT.CRIT.PURPOSE_AUDIENCE_VOICE`, `WRIT.CRIT.STRUCTURE_LAYOUT`, `WRIT.CRIT.STYLE_VOCABULARY`, `WRIT.CRIT.GRAMMAR_SPELLING_PUNCT`.

# 8. Output & Local Sync

In the Selective Lab checkout, follow root `AGENTS.md`: verify answers/SVGs in Node, merge with `scripts/merge_manifests.mjs` (auto-standardizes IDs + SVG fonts), validate with `--strict`, and dry-run `npm run db:push -- <file> --dry-run`.

- **Generated here:** Give the question count and ask once, “Sync these questions to the live bank now?” Publish only after an affirmative reply (or explicit “generate and sync”).
- **Pasted here:** Treat pasted Claude.ai JSON or plain-text questions as a sync request (unless asked to review/preview/draft). Standardize IDs/metadata via `merge_manifests.mjs`, validate strictly, and publish immediately; ask only if essential content or the correct answer is missing/ambiguous.
- **Official past papers:** `official_pt1` = 2021, `official_pt2` = 2022, `official_pt3` = 2023 real NSW Selective placement tests (no sample papers). IDs `official_ptN_<sec>_NN_v1`, `poolType: "official_calibration"`, `provenance.sourceType: "official_doe"`. Unpublished (copyright) parts may be filled with original stand-ins in the same batch, marked `sourceType: "ai_generated"` and `sourceReference: "Stand-in for NSW SHSPT <year> <PTn> …"`.
- **Publishing:** Run `npm run db:push -- <validated-archive>` and report the batch ID and counts. On Claude.ai or authoring-only chats, return one raw valid `BankImportManifest` JSON object unless a preview is requested.
