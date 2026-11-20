---
name: selective-lab-question-skill
description: Write, verify, preview, and export original NSW Selective High School practice questions for Selective Lab as BankImportManifest JSON. Use when generating, hardening, or fixing question-bank content; adapt this skill to the app's current schema.
---

# App contract comes first

Adapt this skill and its output to the app. Do not change the app, importer, taxonomy, database, or schema to accommodate this skill. Preferred counts, difficulty targets and visual styles below are authoring choices, not app-wide requirements.

Contract snapshot: synced with Selective Lab's unified Question Bank, Firestore Starter Tier rules (`firestore.rules`), `src/shared/v3Schema.ts`, `src/shared/contracts.ts`, `src/shared/skills.ts`, `src/shared/bankStatus.ts`, `src/client/optionLayout.ts`, `src/client/components/VisualRenderer.tsx`, and `src/server/manifestValidator.ts`. When inside the repository, verify against those files before export. The authorized admin schema export is `/api/admin/import/schema`. Outside the repository, use this documented snapshot and do not claim a newer importer was checked. Starter examples show shape, not the required quality of working.

# Principle

Do not fill templates. For every question, start from the outcome: which thinking move should a strong 11-year-old have to make, and where will a weaker student go wrong? Then invent a fresh situation and mechanism that tests that move. No archetype lists, parameter tables, or reusable scenario shapes. If a question could be produced by swapping numbers in an earlier one, throw it away and start again.

# Process

1. **Name the outcome.** One sentence: what reasoning is tested, and what does a student who only half understands do instead? Moves include spotting what stays constant, reading a rule in the right direction, choosing the cheaper plan, tracking a viewpoint change, or noticing which sentence a gap needs.
2. **Invent the situation.** Pick a scenario not used in this batch or accessible earlier batches. Keep a running list of scenarios and mechanisms. Vary the surface, what is asked, where the unknown sits, and the format. Do not claim memory of unavailable batches. Never copy or closely echo official NSW or PT3 material.
3. **Build the next-step trap.** Difficulty comes from decisions, not big numbers or odd wording. Aim for three or more decisions where the next step is not obvious: a hidden total, a before-and-after swap, a reversed chain, a changed viewpoint. Use clean numbers, simple fractions, 0.5 and 0.25, solvable on paper without a calculator. Do not force artificial arithmetic steps into reading inference.
4. **Design wrong answers from real mistakes.** Each distractor follows a plausible error: stopping early, reversing a rule, double counting, ignoring a qualifier, or taking a lure word. Explain each incorrect option specifically in that part's `distractorRationales`.
5. **Verify independently of the first derivation.** Re-solve, test every option, and establish uniqueness. Compute geometry, charts and tables in code when available; never eyeball raw SVG coordinates. Brute force and truth tables are private checks, never student solutions. If essential checks cannot be completed, simplify or defer the item rather than claim verification.
6. **Write the complete solution for Year 6.** Maths uses numbered reasoning and simple arithmetic. Reading and Thinking Skills sound like a teacher talking it through. Explain formal ideas in everyday words with a small example where useful. Follow the complete-working requirements below.
7. **Audit, preview, export.** Check schema and semantic consistency, then use the app's Dry-run validate before committing. Fix all errors before export/import. Passing import validation does not prove correctness or explanation quality. Importing or promoting items requires the user's request; exporting verified pilots does not automatically make them active unless requested.

# Difficulty targets (1.5x authoring goal)

Reading 3.8–4.5, Maths 3.7–4.5, Thinking Skills 4.0–4.8, Writing 3.8–4.4. These are initial authoring targets, not a measured claim of exactly 1.5 times exam difficulty. Do not emit `difficultyCalibrated` without calibration evidence.

Reading tests subtext and tone shifts, with plausible motives as distractors. Cloze has two or three grammatically possible options but only one fitting meaning and collocation. Gapped text includes a keyword-sharing decoy that does not satisfy the required link. Matching uses strict qualifiers such as "mainly", "still" and "despite".

# Sizing is a judgement, not a setting

Choose passage/set sizes to suit the reasoning. Guide: about 60 passage words per question; five questions around 330 words, eight around 520–650. Eight-gap cloze needs real context, around 150–300 words. Poems of 12–24 lines support two to four questions. Scale up when the user says a set is too short or small. Keep normal format counts below unless the user requests a different app-supported size.

# Full working must survive JSON export

Every objectively scored part needs a nonempty `workedExplanation` **string** containing its complete reasoning. Use exactly that part-level field. Do not put working only in the preview, a question-level `solution`, an `explanation` alias, or a `steps` array/object.

- Maths: numbered steps explaining why each operation is chosen, intermediate arithmetic with units, and the final answer/option. Do not replace the chain with a one-line answer justification.
- Thinking Skills: walk through the rules in order, show why the selected option follows, and explain the tempting mistake.
- Reading: connect specific wording, contrast, tone or cohesion to the answer; explain the inference and plausible alternative. Avoid circular claims such as "A fits best".
- Give every gap/statement its own complete solution and rationales. Shared stimulus does not mean shared working. Do not shorten solutions to resemble terse seed examples.
- Use readable plain text: `1)`, `2)`, paragraph breaks, `×`, `÷`, `=`, fractions such as `3/4`, ordinary brackets, and units. Do not depend on HTML, Markdown or LaTeX rendering for meaning. Retain full working despite current UI formatting limitations.
- The decoded string contains actual line breaks. JSON serialization escapes them as `\n` once; do not double-escape into literal backslash-n text. Use a JSON serializer when available.
- `distractorRationales` maps each incorrect available option/extract key to an explanation string. In shared pools, keys match `poolKeys`. Never label the correct answer as wrong.
- Writing uses task-specific rubric guidance and pitfalls rather than one objectively correct response. Do not present a single model essay as the only answer.

# Schema contract: BankImportManifest

## Manifest, identity, pool status, and Firestore limits

- Top-level: `manifestVersion: "1.0"`, unique `batchLabel` (max 200 chars), `defaultPoolType: "practice"`, `defaultQcStatus`, `stimuli`, and nonempty `questions`. Non-passage batches may use `stimuli: []`.
- **Pool status mapping in the unified Question Bank**:
  - `active` → **In pool** (immediately eligible for Daily Practice, Section Drills, and Fresh Pool Mocks).
  - `verified`, `draft`, `quarantined` → **Paused** (held out of student practice so you can inspect them in the Question Bank or click **Activate all** in Import & Batches).
  - `retired` → **Archived** (retired from rotation; admins can also permanently delete questions).
  - Default to `defaultQcStatus: "verified"` for new batches unless the user explicitly asks to publish directly into the live pool (`defaultQcStatus: "active"`). Never target `benchmark_holdout` unless explicitly requested.
- Every question: explicit `questionId`, `questionFamilyId`, positive integer `version` (start at 1), `section`, `formatType`, `parts`, and `provenance`. Every referenced `stimulusId` must resolve; export self-contained batches unless explicitly referencing a verified existing item.
- Every stimulus: explicit `stimulusId`, `stimulusFamilyId`, positive integer `version`, `section`, `genreOrTextType`, `sourceType: "ai_generated"`, and its passage/extracts/visual. Put passage text in `mainTextMarkdown`; extracts use `bodyMarkdown`.
- **Strict ID & Firestore rules bounds**:
  - `questionId`, `questionFamilyId`, `stimulusId`, `stimulusFamilyId`: unique ASCII matching `^[a-zA-Z0-9_-]+$`, **1 to 128 characters** (keep short and readable).
  - `batchLabel`: **max 200 characters**.
  - `formatType` and `poolType`: **max 64 characters**.
  - `partId`: unique across the entire manifest. `partIndex` is zero-based and matches array order.
  - Keep every question/stimulus document well under Firestore's 1 MiB document ceiling (never embed giant multi-hundred-KB base64 PNGs inside JSON manifests; prefer clean `inline_svg` or `structured_table`).
  - Large batches (e.g., 30–100+ questions) are fine — the importer automatically commits in 40-document chunks to stay safely below Firestore's index-entry commit limit.
- Independent questions sharing one passage have different `questionFamilyId` values but the same `stimulusId`. Revisions retain the original family; unrelated new questions get new families.
- Omit server/client-generated fields: `contentHash`, `evidenceRevision`, `batchId`, per-item `batchLabel`, and created/updated timestamps. The top-level `batchLabel` supplies import grouping. Do not emit learner, session, scheduling or mastery records.
- `section` is exactly `READ`, `MATH`, `THINK` or `WRIT`. The question field is `formatType`, not `format` or `type`.

## Parts and formats

Each part includes `partId`, `partIndex`, `promptText`, canonical `skillId`, `difficultyInitial` (1–5), positive integer `targetTimeSec`, `cognitiveDemand`, `trapTags`, `options`, `correctAnswerKey`, `workedExplanation`, and `distractorRationales`. Optional `secondarySkillIds` also use canonical IDs. `cognitiveDemand` is `recall_locate`, `apply_procedural`, `analyze_infer` or `evaluate_transfer`.

Options contain `key` (`"A"`–`"H"`, max 8 options), `text`, optional `visual`. Option keys are unique; answer keys name an available option or extract.

- `MATH_MCQ_5`: five options A–E; 65–85 seconds.
- `THINK_MCQ_4`: four options A–D; 60–75 seconds.
- `READ_FICTION_MCQ` and `READ_POETRY_MCQ`: four options A–D; passage-set questions share one `stimulusId`. Choose realistic part times.
- `READ_VOCAB_CLOZE`: one question, eight ordered parts with `slotRef: "gap:1"` through `"gap:8"`, four options A–D each. The passage contains matching `{{gap:1}}` through `{{gap:8}}` placeholders exactly once each.
- `READ_GAPPED_TEXT`: one question, six ordered parts with `slotRef: "gap:1"` through `"gap:6"` and matching passage placeholders. Seven extracts A–G: six unique correct labels plus one unused extract marked `isDecoy: true`. Each part has `options: []`. Question-level `sharedPoolConfig` is `{ "reuseAllowed": false, "poolKeys": ["A","B","C","D","E","F","G"] }`. The decoy cannot be correct.
- `READ_MULTIPLE_MATCH`: one question, ten ordered parts with `slotRef: "stmt:1"` through `"stmt:10"`; each statement is its part's `promptText`. Four extracts A–D, with answers reasonably balanced across all labels. Each part has `options: []`. Question-level `sharedPoolConfig` is `{ "reuseAllowed": true, "poolKeys": ["A","B","C","D"] }`.
- `WRIT_TYPED_TASK`: instructions in the stimulus/stem; `writingSpec` includes `genre`, `audience`, `purpose`, `bulletSuggestions`, optional `mandatoryOpeningLine`, `recommendedWordRange: [250,480]`, `timeLimitSec: 1800`. One part has `options: []`, `correctAnswerKey: ""`, `skillId: "WRIT.CRIT.TOPIC_PROMPT_ADHERENCE"`, `targetTimeSec: 1800`, rubric guidance in `workedExplanation`, and `distractorRationales: {}`.

Keep array order, zero-based `partIndex`, and one-based gap/statement numbers aligned. Check matching placeholders, pool cardinality, reuse rules and every referenced label; importer acceptance alone does not establish a coherent exercise.

## Optional reading evidence

Use existing `parts[].evidenceRefs` for precise text supporting an answer. Do not invent block IDs, another schema, or ranges estimated by eye. Omit references when not appropriate or not verifiable; explain the supporting quote in `workedExplanation` instead.

Each reference has `refId`, `stimulusRevision`, `targetKind`, integer `startOffset`, integer `endOffset`, and `quote`. `targetKind: "mainText"` targets `mainTextMarkdown`; `targetKind: "extract"` also includes `extractLabel` and targets that extract's `bodyMarkdown`.

Compute offsets against the exact final decoded raw field text, including whitespace, markup and placeholders, before JSON escaping. They are zero-based JavaScript **UTF-16 code units**, with the end excluded. Require `text.slice(startOffset, endOffset) === quote`, `0 <= startOffset < endOffset <= text.length`, and `stimulusRevision === stimulus.version`. Select the intended occurrence of repeated text. Byte offsets, rendered-HTML positions and unconverted Python code-point indices are incorrect.

For raw text `The hall was empty.`, this reference is valid:

```json
{"refId":"ev_q1_p1_1","stimulusRevision":1,"targetKind":"mainText","startOffset":13,"endOffset":18,"quote":"empty"}
```

## Visuals, image sizing, and Sunlit Editorial Studio palette

Prefer `visualType: "inline_svg"` for diagrams, charts, spatial tiles, and nets. Use visuals on roughly 60% of Maths and 30–40% of Thinking Skills where useful. The app also supports `structured_table` (2D `rows: string[][]` is supported cleanly — the client codec handles Firestore nested-array encoding automatically), `image_asset`, and `none`.

Use the existing `VisualSpec`: `visualType`, descriptive `altText`, `svgMarkup` for `inline_svg`, `imageUrl` for `image_asset`, `tableData` (`{ headers, rows, caption? }`) for `structured_table`, and optional `caption`. Put a question diagram at `question.visual`, passage-wide figure at `stimulus.visual`, or answer image at `options[].visual`; do not invent `part.visual`.

### Critical sizing rules so all 4 answer visuals fit on screen at once

The app's `optionLayout.ts` and `VisualRenderer.tsx` automatically render visual answer options in a compact **2-column tile grid** (`2×2` for 4-option questions, compact 2-column grid for 5-option Maths) **only when every option's `text` is `<= 48` characters** (short label or empty string). If any option's `text` exceeds 48 characters, options fall back to full-width stacked rows.

- **Answer option visuals (`options[].visual`)**:
  - **Rendered tile stage height**: `124px–136px` tall for 4-option grids (`~220–280px` wide per tile on desktop); `104px–112px` tall for 5-option grids. Each tile also gets a click-to-zoom button automatically.
  - **Keep `option.text` concise (`<= 48` chars, ideally `""` or a 1–4 word label like `"Net A"` or `"12 cm²"`)** so the 2-column grid activates and all 4 answers are visible simultaneously without scrolling.
  - **Inline SVG sizing for options**: Always include a tight `viewBox` with a compact landscape or square aspect ratio — **`viewBox="0 0 220 140"`** (~1.57:1), **`viewBox="0 0 180 140"`** (~1.28:1), or **`viewBox="0 0 160 160"`** (1:1). Do **not** hardcode huge pixel `width`/`height` attributes (omit `width`/`height` or match the `viewBox`, and let `viewBox` drive aspect ratio). Use tight padding (`6–10px`), stroke width `>= 1.5–2`, and label font size `12–15` so figures remain legible at `124–136px` height.
  - **Raster `image_asset` sizing for options**: Target **`360×240` to `480×320` px** (3:2 landscape) or **`320×320` px** (1:1 square), max aspect ratio **2:1**. Crop tightly with minimal empty border so the subject fills the `136px` tile stage cleanly.
- **Question & stimulus diagrams (`question.visual`, `stimulus.visual`)**:
  - Rendered in a white figure card up to **`max-h-72` (`288px`)** tall for raster images (with a full-screen zoom modal up to `70–72vh`), and responsive full-width for SVGs.
  - **Inline SVG sizing**: Target **`viewBox="0 0 560 320"`** to **`640 360`** (landscape charts/grids/geometry) or **`480 340`** (compact figures). Avoid excessive vertical height (`> 420` viewBox units) so stem + diagram + options stay comfortable on laptop screens.
  - **Raster `image_asset` sizing**: Target **`800×480` to `1200×720` px** (landscape) or **`720×720` px** (square), crisp contrast, tightly cropped.

### SVG hygiene & palette

Every SVG must parse as valid XML, include `xmlns="http://www.w3.org/2000/svg"` and a clean `viewBox`, and be properly escaped for XML and JSON. Use self-contained vector shapes/text with no `<script>`, event handlers, `foreignObject`, external images/fonts, animations, or network dependencies. Compute geometry in code and verify every visual value against the stem, options, and working. Never leak the answer through `altText`, captions, hidden labels, or filenames.

**Sunlit Editorial Studio palette** (matches Selective Lab's warm paper & forest-teal UI):
- Surfaces: `#FFFFFF` card white, `#FAF8F5` warm paper canvas, `#F3EFE8` muted warm fill
- Ink & lines: `#113C36` primary forest ink (or `#1F1E1D` neutral ink), `#4A5955` secondary text, `#78756E` muted labels, `#E5DFD5` / `#CFC6B9` gridlines & borders
- Accents: `#F29A63` warm terracotta/peach, `#1F7A4C` emerald, `#3B5B6D` slate blue, `#B83A28` crimson alert
- Fonts: `font-family="'Anthropic Sans', 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"` (or `'Anthropic Serif', 'Source Serif 4', Georgia, serif` for literary excerpts). Set `font-variant-numeric="tabular-nums"` on numeric labels and leave at least 12–15% breathing margin around labels so fallback fonts never clip.

## Provenance must describe checks actually done

Use `sourceType: "ai_generated"`, `sourceReference` equal to the top-level `batchLabel`, and `auditorReviewed: false` until an actual separate audit. Set `verifierAgreed: true` only after the independent re-solve/computational check in this workflow occurred. Do not claim to have run code, seen a preview or passed a dry run without doing so.

Completed pilot batches default to `defaultQcStatus: "verified"` (or `"active"` only when explicitly requested by the user). If essential verification is incomplete, use `defaultQcStatus: "draft"` and `verifierAgreed: false`. Never certify an unchecked answer simply to satisfy a default.

# Canonical skill IDs (77 skills)

Use only these exact canonical IDs from `src/shared/skills.ts`. Do not invent new IDs.

- **READ (18):** `READ.FIC.LITERAL_DETAIL`, `READ.FIC.CHARACTER_INFERENCE`, `READ.FIC.IMPLIED_MEANING`, `READ.FIC.TONE_ATTITUDE`, `READ.FIC.TECHNIQUE_EFFECT`, `READ.FIC.TEXT_STRUCTURE`, `READ.CLOZE.COLLOCATION`, `READ.CLOZE.CONTEXT_NUANCE`, `READ.CLOZE.DISCOURSE_CONNECTOR`, `READ.POEM.LITERAL_SENSE`, `READ.POEM.FIGURATIVE_IMAGERY`, `READ.POEM.FORM_TONE_EFFECT`, `READ.GAP.COHESIVE_BRIDGE`, `READ.GAP.REFERENTIAL_PRONOUN_LINK`, `READ.GAP.PARAGRAPH_PROGRESSION`, `READ.MATCH.PRECISE_CONDITION`, `READ.MATCH.CROSS_TEXT_COMPARE`, `READ.MATCH.VIEWPOINT_CHANGE`.
- **MATH (32):** `MATH.NUM.DIVISIBILITY_REMAINDERS`, `MATH.NUM.NUMBER_SEQUENCES`, `MATH.NUM.PLACE_VALUE_DECIMALS`, `MATH.NUM.FACTORS_MULTIPLES_PRIMES`, `MATH.FRAC.FRACTION_CHAINS`, `MATH.FRAC.TRUE_FALSE_STATEMENTS`, `MATH.FRAC.RATIO_PROPORTION`, `MATH.FRAC.PERCENTAGES`, `MATH.FRAC.PROBABILITY_DEPENDENT`, `MATH.ALG.TWO_UNKNOWN_SYSTEMS`, `MATH.ALG.WORKING_BACKWARDS`, `MATH.ALG.SYMBOL_EQUATIONS`, `MATH.ALG.INEQUALITIES_BOUNDS`, `MATH.ALG.DIGIT_CRYPT_PUZZLES`, `MATH.TIME.ELAPSED_24H`, `MATH.TIME.TIME_ZONES_ITINERARY`, `MATH.TIME.CLOCK_ANGLES`, `MATH.MEAS.DIAL_GAUGE_OFFSET`, `MATH.MEAS.BALANCE_SCALES`, `MATH.MEAS.UNIT_CONVERSIONS`, `MATH.GEO2D.COMPOSITE_AREA`, `MATH.GEO2D.COMPOSITE_PERIMETER`, `MATH.GEO2D.ANGLES_PROTRACTOR`, `MATH.GEO2D.SYMMETRY_ROTATION_REFLECT`, `MATH.GEO2D.COMPASS_TURNS`, `MATH.GEO3D.CUBE_STACK_COUNT`, `MATH.GEO3D.NETS_SOLIDS`, `MATH.GEO3D.FACES_EDGES_VERTICES`, `MATH.DATA.BAR_LINE_GRAPHS`, `MATH.DATA.MEAN_RECONSTRUCTION`, `MATH.COMB.CONSTRAINED_OPTIMISATION`, `MATH.COMB.GRID_PATHS_COORDS`.
- **THINK (21):** `THINK.VERBAL.STRENGTHEN_ARGUMENT`, `THINK.VERBAL.WEAKEN_ARGUMENT`, `THINK.VERBAL.IDENTIFY_FLAW`, `THINK.VERBAL.IMPLICIT_ASSUMPTION`, `THINK.DEDUCT.WHOSE_REASONING_CORRECT`, `THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE`, `THINK.DEDUCT.LOGIC_GRID_CONSTRAINTS`, `THINK.DEDUCT.LINE_CIRCLE_ARRANGEMENT`, `THINK.DEDUCT.DEDUCTIVE_ORDERING`, `THINK.DEDUCT.SET_SYLLOGISMS`, `THINK.DEDUCT.KNIGHTS_AND_LIARS`, `THINK.DEDUCT.CRYPTOGRAM_MAPPING`, `THINK.DEDUCT.CYCLE_CHAIN_REASONING`, `THINK.NUM.SYSTEMS_WORD_PUZZLES`, `THINK.NUM.MIN_COST_COMBINATIONS`, `THINK.NUM.TABLE_CHART_RATE_LOGIC`, `THINK.NUM.OVERLAP_COUNTING`, `THINK.NUM.NETWORK_GRAPH_ROUTES`, `THINK.SPATIAL.VIEWS_3D_SILHOUETTES`, `THINK.SPATIAL.FOLD_CUT_TILE_ASSEMBLY`, `THINK.SPATIAL.PATTERN_ROTATION_SYMMETRY`.
- **WRIT (6):** `WRIT.CRIT.TOPIC_PROMPT_ADHERENCE`, `WRIT.CRIT.IDEAS_CREATIVITY`, `WRIT.CRIT.PURPOSE_AUDIENCE_VOICE`, `WRIT.CRIT.STRUCTURE_LAYOUT`, `WRIT.CRIT.STYLE_VOCABULARY`, `WRIT.CRIT.GRAMMAR_SPELLING_PUNCT`.

# Preview / output mode

- **Structured Outputs ON / JSON mode:** Perform available checks silently and emit ONLY one valid `BankImportManifest` JSON object. No Markdown fences, extra prose or preview HTML. Full student working stays inside every part's `workedExplanation`; JSON-only never means answer-only. Use verified/draft/active status truthfully as above.
- **Structured Outputs OFF / interactive mode:** Provide audited JSON and, when supported, a split-pane HTML/React preview: passage/diagram left; question, options and toggleable Year 6 solutions right. Bold option letters only. Use a 2×2 grid for four picture options (`option.text` <= 48 chars); five-choice Maths remains five choices. Use the available preview surface, without changing the app or deploying a site. State any preview limitation honestly.
- Before export, check identities, ID length/charset (`^[a-zA-Z0-9_-]+$`, <= 128), taxonomy, format counts, stimulus links, gap/pool ordering, key uniqueness, complete explanations/rationales, SVG validity/viewBox sizing, and evidence slices. Use the app's Dry-run validate when available. Never truncate a batch into invalid JSON; reduce or split into complete labeled manifests according to the requested output mode.
