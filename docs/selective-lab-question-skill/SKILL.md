---
name: selective-lab-question-skill
description: Generate original 1.5x-difficulty NSW Selective High School practice questions (Reading, Mathematical Reasoning, Thinking Skills, Writing) as Selective Lab BankImportManifest JSON. In the Selective Lab checkout, also accept pasted question text or Claude.ai JSON for validated import into the live question bank. Supports any requested volume or a full standardised exam set with natural randomised skill distribution, clear Year 6 worked solutions, and Sunlit Editorial Studio inline SVGs.
---

# Difficulty Anchor First (Never Zero-Shot)

Before generating questions, read `references/calibration-anchors-1.5x.json` to lock the **1.5× real NSW Selective exam** difficulty bar, full passage/poem lengths, Sunlit Editorial Studio SVG style, and exact JSON shape. Never copy those anchor scenarios — match their reasoning depth, length, and solution clarity on completely fresh scenarios.

# Autonomous Generation & Natural Randomised Distribution

Generate **whatever the user asks for** — whether a custom drill (`"5 Reading, 5 Thinking"`, `"10 Maths"`) or a **standardised full exam set** (`Reading 5 parts / 17 Qs / 38 slots`, `Maths 35–40 Qs`, `Thinking 40 Qs`, `Writing 1`).

- **Multi-turn scaling for large sets:** For a full section, split cleanly into **2 turns in the same chat** (e.g., Reading Turn 1: Parts 1–3 [Fiction/Paired 8 + Cloze 8 gaps + Poetry 6], Turn 2: Parts 4–5 [Gapped/Headings 6 + Multiple Match 10]; Maths/Thinking Turn 1: Q1–20, Turn 2: Q21–40). Each turn emits one complete, self-contained valid `BankImportManifest` JSON object with zero truncation and zero repeated scenarios/skills from earlier turns.
- **Natural randomised spread:** Unless the user requests specific topics, spread evenly across canonical `skillId`s, formats, mechanisms, and correct-answer letters (`A`–`D` / `A`–`E`). No two questions in a set may share a scenario or reasoning trick.
- **Reading sizing on small counts:** If asked for e.g. `"5 Reading questions"`, write **one full-length passage (~500–650 words) or one full 20–28 line poem** with 5 questions testing 5 distinct `READ.*` skills — never 5 tiny micro-snippets.

# 1.5× Difficulty Within Year 6 / Selective Scope

Target **~1.5× real 2021–2023 NSW Selective exam difficulty** (`difficultyInitial`: READ 3.9–4.6, MATH 4.0–4.7, THINK 4.1–4.8, WRIT 3.9–4.5; never emit `difficultyCalibrated`).

- **How to build true 1.5× depth (DO THIS):**
  - Require **3+ linked decisions** with a non-obvious bridge step: hidden invariants, before-and-after transfers, implicit simultaneous / bar-model reasoning, systematic case counting, worst-case "minimum to guarantee" bounds, intuitive dependent probability with clean fractions, overlapping 2D/3D geometry, chained *"only if"* / exception rules, two-cut or asymmetric spatial folds, and Reading subtext/tone shifts with tightly matched half-true distractors.
  - **Well-known geometry is allowed:** Basic Pythagoras (`a² + b² = c²` with clean triples like 3-4-5, 5-12-13, 6-8-10) and standard shape/3D formulas (sphere, cylinder, cone, prism area/volume when numbers stay clean or a formula is given in problem solving) are completely fine.
  - **No-calculator arithmetic:** Keep numbers clean and solvable on paper without a calculator (tidy integers, halves/quarters/thirds/fifths, clean ratios/multiples).
- **Strictly forbidden "fake difficulty" (NEVER DO THIS):**
  - No quadratic equations, no formal `nCr`/`nPr` or circular permutation `(n−1)!` formulas, no trigonometry/radians, no calculus.
  - No Latin fallacy jargon (*modus tollens*, *ad hominem*) or formal symbolic logic proofs — explain every Thinking Skills rule in plain, everyday Year 6 English.
  - No tedious multi-digit calculator arithmetic or obscure archaic dictionary-stumper vocabulary.

# Real 2021–2023 NSW Exam Calibration

Full structural breakdown in `references/real-exam-calibration-2021-2023.md`:

- **Reading (Current 2025+ Computer-Based NSW Format: 45 min, 5 parts, 17 questions = 38 answer slots):**
  - **Part 1 (`READ_FICTION_MCQ`, 8 Qs / 8 slots, A–D):** Full **~550–700 words** — alternate between a single literary extract (ending with whole-text arc/contrast Qs) and **paired extracts (`Text A` fiction ~300–350w + `Text B` non-fiction ~250–320w)** using `genreOrTextType: "paired_extracts"` with `extracts: [{ label: "A", ... }, { label: "B", ... }]` and cross-text synthesis/qualification Qs.
  - **Part 2 (`READ_VOCAB_CLOZE`, 1 question / 8 gaps, A–D each):** ~180–300 word informational cloze where 2–3 options are grammatically possible in every gap, testing exact meaning, collocation, and discourse connectors.
  - **Part 3 (`READ_POETRY_MCQ`, 6 Qs / 6 slots, A–D):** Full **20–28 line poem** (3–5 stanzas) with figurative imagery, structural/repetition effect, and tonal shift.
  - **Part 4 (`READ_GAPPED_TEXT`, 1 question / 6 gaps, 7 extracts A–G with 1 `isDecoy: true`):** Alternate between **6 removed sentences** and **6 paragraph summary headings** (`{{gap:1}}`–`{{gap:6}}` above each paragraph) on a ~450–600 word article, with a strong keyword-sharing decoy.
  - **Part 5 (`READ_MULTIPLE_MATCH`, 1 question / 10 statements, 4 thematic extracts A–D, reuse allowed):** Four voices (~140–180 words each) with overlapping surface details so strict qualifiers determine the unique match.
- **Mathematical Reasoning (`MATH_MCQ_5`, 35–40 Qs, A–E):** 55–65% visual density (geometry, grids, nets, 3D cubes/shadows, incomplete graphs/tables, balance scales, number lines), `[diagram not to scale]` on schematic figures, and 2–3 multi-statement (`1/2/3` or `X/Y/Z`) verification items per full set.
- **Thinking Skills (`THINK_MCQ_4`, 40 Qs, A–D):** ~20% boxed-rule *"If the information in the box is true, whose reasoning is correct?"* (`A <N1> only / B <N2> only / C Both / D Neither`), ~10% *"Which one of the following sentences shows the mistake <Name> has made?"* (plain-English concrete counter-examples), ~10% weaken/strengthen (weaken ~3:1), ~7% must/cannot be true (zero "parallel reasoning" or "main conclusion"), plus ~25–35% spatial & visual-data items.
- **Writing (`WRIT_TYPED_TASK`, 1 task, 30 min):** Rotate authentic NSW genres (newspaper report, diary entry, competition email, advice sheet, persuasive letter, speech, narrative) with a crisp 2–4 sentence scenario, 3 open `bulletSuggestions`, and optional `mandatoryOpeningLine`, inline SVG `stimulus.visual`, or layout note.

# Full Year 6 Working (Must Survive JSON Export)

Every objectively scored part requires a clear, thorough, easy-to-read `workedExplanation` **string** and complete `distractorRationales` mapping every wrong option/extract key to the specific mistake behind it (never include `correctAnswerKey` in `distractorRationales`):

- **Maths:** Numbered steps (`1)`, `2)`, `3)`) explaining *why* each step is chosen, clean arithmetic with units, a quick sanity check, and the final option.
- **Thinking Skills:** Walk through the rules/clues step by step in conversational Year 6 English, show why the right option is forced (or give a concrete counter-example showing why a claim fails), and call out the tempting trap.
- **Reading:** Quote/connect specific wording, contrast, tone, or cohesion to the answer and explain why the closest runner-up fails.
- **Plain text formatting:** Use `1)`, `2)`, real line breaks serialized once as `\n` (never double-escaped `\\n`), `×`, `÷`, `=`, `3/4`, and units.
- **Writing:** Put 6-criterion rubric guidance + common pitfalls in `workedExplanation` and set `distractorRationales: {}`.

# Visuals & Sunlit Editorial Studio Sizing

Full palette and sizing rules in `references/visual-palette-and-sizing.md`:

- Prefer `visualType: "inline_svg"` or `"structured_table"`. Attach visuals to `question.visual`, `stimulus.visual`, or `options[].visual` (never `part.visual`).
- **2×2 visual option grid rule:** Whenever `options[].visual` is used, keep every `option.text` `<= 48` chars (ideally `""` or a 1–3 word label) and use compact `viewBox="0 0 180 140"`, `220 140`, or `160 160` (no huge pixel `width`/`height`) so Selective Lab renders all 4 visual answers in a compact 2×2 grid on screen at once.
- **Question/stimulus diagrams:** `viewBox="0 0 560 320"` to `640 360` (height `<= 420`).
- **SVG hygiene:** Valid XML with `xmlns="http://www.w3.org/2000/svg"` and explicit `viewBox`. No `<script>`, event handlers, `foreignObject`, external URLs, or answer leakage in `altText`/captions.
- **Sunlit Editorial Studio palette:** Surfaces `#FFFFFF` / `#FAF8F5` / `#F3EFE8`; ink `#113C36` (primary), `#4A5955` (secondary), `#78756E` (muted), `#E5DFD5`/`#CFC6B9` (borders); accents `#F29A63` (terracotta), `#1F7A4C` (emerald), `#3B5B6D` (slate blue), `#B83A28` (crimson).

# BankImportManifest JSON Contract

- **Top-level:** `manifestVersion: "1.0"`, unique `batchLabel` (max 200 chars, auto-generate e.g. `batch_YYYYMMDD_<section>_<part>`), `defaultPoolType: "practice"`, `defaultQcStatus: "verified"` (or `"active"` only if requested), `stimuli` (`[]` if none), and non-empty `questions`.
- **IDs & bounds:** `questionId`, `questionFamilyId`, `stimulusId`, `stimulusFamilyId` match `^[a-zA-Z0-9_-]{1,128}$`, `version: 1`, zero-based `partIndex`, globally unique `partId`. Independent questions sharing one stimulus have distinct `questionFamilyId`s and the same `stimulusId`. Omit `contentHash`, `evidenceRevision`, `batchId`, per-item `batchLabel`, timestamps, and `difficultyCalibrated`.
- **Formats & exact part shapes:**
  - `MATH_MCQ_5`: 5 options `A`–`E`; `targetTimeSec` 65–85.
  - `THINK_MCQ_4`: 4 options `A`–`D`; `targetTimeSec` 60–75.
  - `READ_FICTION_MCQ` / `READ_POETRY_MCQ`: 4 options `A`–`D`; linked `stimulusId`.
  - `READ_VOCAB_CLOZE`: 1 question, 8 parts (`slotRef: "gap:1"`–`"gap:8"`), 4 options `A`–`D` each, matching `{{gap:1}}`–`{{gap:8}}` once each in `mainTextMarkdown`.
  - `READ_GAPPED_TEXT`: 1 question, 6 parts (`slotRef: "gap:1"`–`"gap:6"`), 7 extracts `A`–`G` (1 unused `isDecoy: true`), `options: []`, `sharedPoolConfig: { "reuseAllowed": false, "poolKeys": ["A","B","C","D","E","F","G"] }`.
  - `READ_MULTIPLE_MATCH`: 1 question, 10 parts (`slotRef: "stmt:1"`–`"stmt:10"`), 4 extracts `A`–`D`, `options: []`, `sharedPoolConfig: { "reuseAllowed": true, "poolKeys": ["A","B","C","D"] }`.
  - `WRIT_TYPED_TASK`: `writingSpec` (`genre`, `audience`, `purpose`, `bulletSuggestions`, optional `mandatoryOpeningLine`, `recommendedWordRange: [250,480]`, `timeLimitSec: 1800`), 1 part with `options: []`, `correctAnswerKey: ""`, `skillId: "WRIT.CRIT.TOPIC_PROMPT_ADHERENCE"`, `targetTimeSec: 1800`, `distractorRationales: {}`.
- **Reading `evidenceRefs`:** Only include `evidenceRefs` if you compute exact JavaScript UTF-16 `startOffset`/`endOffset` programmatically (`text.slice(startOffset, endOffset) === quote`). Otherwise omit `evidenceRefs` and quote the supporting evidence inside `workedExplanation`.
- **Provenance:** `{ "sourceType": "ai_generated", "sourceReference": "<batchLabel>", "verifierAgreed": true, "auditorReviewed": false }` (after silently re-solving every item and checking uniqueness + SVG alignment).

# Canonical `skillId` Values (77 — Use ONLY These)

- **READ (18):** `READ.FIC.LITERAL_DETAIL`, `READ.FIC.CHARACTER_INFERENCE`, `READ.FIC.IMPLIED_MEANING`, `READ.FIC.TONE_ATTITUDE`, `READ.FIC.TECHNIQUE_EFFECT`, `READ.FIC.TEXT_STRUCTURE`, `READ.CLOZE.COLLOCATION`, `READ.CLOZE.CONTEXT_NUANCE`, `READ.CLOZE.DISCOURSE_CONNECTOR`, `READ.POEM.LITERAL_SENSE`, `READ.POEM.FIGURATIVE_IMAGERY`, `READ.POEM.FORM_TONE_EFFECT`, `READ.GAP.COHESIVE_BRIDGE`, `READ.GAP.REFERENTIAL_PRONOUN_LINK`, `READ.GAP.PARAGRAPH_PROGRESSION`, `READ.MATCH.PRECISE_CONDITION`, `READ.MATCH.CROSS_TEXT_COMPARE`, `READ.MATCH.VIEWPOINT_CHANGE`.
- **MATH (32):** `MATH.NUM.DIVISIBILITY_REMAINDERS`, `MATH.NUM.NUMBER_SEQUENCES`, `MATH.NUM.PLACE_VALUE_DECIMALS`, `MATH.NUM.FACTORS_MULTIPLES_PRIMES`, `MATH.FRAC.FRACTION_CHAINS`, `MATH.FRAC.TRUE_FALSE_STATEMENTS`, `MATH.FRAC.RATIO_PROPORTION`, `MATH.FRAC.PERCENTAGES`, `MATH.FRAC.PROBABILITY_DEPENDENT`, `MATH.ALG.TWO_UNKNOWN_SYSTEMS`, `MATH.ALG.WORKING_BACKWARDS`, `MATH.ALG.SYMBOL_EQUATIONS`, `MATH.ALG.INEQUALITIES_BOUNDS`, `MATH.ALG.DIGIT_CRYPT_PUZZLES`, `MATH.TIME.ELAPSED_24H`, `MATH.TIME.TIME_ZONES_ITINERARY`, `MATH.TIME.CLOCK_ANGLES`, `MATH.MEAS.DIAL_GAUGE_OFFSET`, `MATH.MEAS.BALANCE_SCALES`, `MATH.MEAS.UNIT_CONVERSIONS`, `MATH.GEO2D.COMPOSITE_AREA`, `MATH.GEO2D.COMPOSITE_PERIMETER`, `MATH.GEO2D.ANGLES_PROTRACTOR`, `MATH.GEO2D.SYMMETRY_ROTATION_REFLECT`, `MATH.GEO2D.COMPASS_TURNS`, `MATH.GEO3D.CUBE_STACK_COUNT`, `MATH.GEO3D.NETS_SOLIDS`, `MATH.GEO3D.FACES_EDGES_VERTICES`, `MATH.DATA.BAR_LINE_GRAPHS`, `MATH.DATA.MEAN_RECONSTRUCTION`, `MATH.COMB.CONSTRAINED_OPTIMISATION`, `MATH.COMB.GRID_PATHS_COORDS`.
- **THINK (21):** `THINK.VERBAL.STRENGTHEN_ARGUMENT`, `THINK.VERBAL.WEAKEN_ARGUMENT`, `THINK.VERBAL.IDENTIFY_FLAW`, `THINK.VERBAL.IMPLICIT_ASSUMPTION`, `THINK.DEDUCT.WHOSE_REASONING_CORRECT`, `THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE`, `THINK.DEDUCT.LOGIC_GRID_CONSTRAINTS`, `THINK.DEDUCT.LINE_CIRCLE_ARRANGEMENT`, `THINK.DEDUCT.DEDUCTIVE_ORDERING`, `THINK.DEDUCT.SET_SYLLOGISMS`, `THINK.DEDUCT.KNIGHTS_AND_LIARS`, `THINK.DEDUCT.CRYPTOGRAM_MAPPING`, `THINK.DEDUCT.CYCLE_CHAIN_REASONING`, `THINK.NUM.SYSTEMS_WORD_PUZZLES`, `THINK.NUM.MIN_COST_COMBINATIONS`, `THINK.NUM.TABLE_CHART_RATE_LOGIC`, `THINK.NUM.OVERLAP_COUNTING`, `THINK.NUM.NETWORK_GRAPH_ROUTES`, `THINK.SPATIAL.VIEWS_3D_SILHOUETTES`, `THINK.SPATIAL.FOLD_CUT_TILE_ASSEMBLY`, `THINK.SPATIAL.PATTERN_ROTATION_SYMMETRY`.
- **WRIT (6):** `WRIT.CRIT.TOPIC_PROMPT_ADHERENCE`, `WRIT.CRIT.IDEAS_CREATIVITY`, `WRIT.CRIT.PURPOSE_AUDIENCE_VOICE`, `WRIT.CRIT.STRUCTURE_LAYOUT`, `WRIT.CRIT.STYLE_VOCABULARY`, `WRIT.CRIT.GRAMMAR_SPELLING_PUNCT`.

# Output and local sync

In the Selective Lab checkout, follow the preparation steps in the root `AGENTS.md`. Verify answers and visuals, save the batch, and complete strict validation and the database dry run before publishing.

- **Generated here.** After the whole requested batch is ready, give the question count and ask once, “Sync these questions to the live bank now?” Wait for an affirmative reply, then publish that exact archived manifest. A decline or no reply leaves it saved locally. An explicit “generate and sync” authorizes publication in the same turn.
- **Pasted here.** A pasted batch for the bank is a sync request, including a bare Claude.ai manifest, fenced JSON, or plain-text questions. Preserve the supplied questions, options, correct answers, and shared stimuli when fitting them to the schema. Resolve routine formatting and metadata locally. If essential content is missing or the correct answer is ambiguous, ask for that detail. Once validated, publish immediately. If the user asks to solve, review, preview, or save a draft instead, follow that request.
- **Publishing.** Run `npm run db:push -- <validated-batch-path>` and report the returned batch ID and counts. If the CLI reports a replay, say the batch was already synced. Reuse the same archived manifest and IDs on retry. If validation or the push fails, report the issue and keep the draft.

On Claude.ai or in another authoring-only chat, emit one raw valid `BankImportManifest` JSON object unless the user requests a preview. Check calculations, deductions, option uniqueness, SVG XML, and distractor rationales before returning it.
