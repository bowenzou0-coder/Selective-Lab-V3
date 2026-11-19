---
name: selective-lab-question-skill
description: Write, verify, preview, and export original NSW Selective High School practice questions for Selective Lab as BankImportManifest JSON. Use when generating, hardening, or fixing question-bank content; adapt this skill to the app's current schema.
---

# App contract comes first

Adapt this skill and its output to the app. Do not change the app, importer, taxonomy, database, or schema to accommodate this skill. Preferred counts, difficulty targets and visual styles below are authoring choices, not app-wide requirements.

Contract snapshot: app commit `4bfa2fdb189891be47037cd82ce05251466aae66`. When available, check current `src/shared/v3Schema.ts`, `src/shared/contracts.ts`, `src/shared/skills.ts`, and `src/server/manifestValidator.ts` before export. The authorized admin schema export is `/api/admin/import/schema`; use existing authorized access rather than requesting credentials. If these sources change, update the skill. Outside the repository, use this documented snapshot and do not claim a newer importer was checked. Starter examples show shape, not the required quality of working.

# Principle

Do not fill templates. For every question, start from the outcome: which thinking move should a strong 11-year-old have to make, and where will a weaker student go wrong? Then invent a fresh situation and mechanism that tests that move. No archetype lists, parameter tables, or reusable scenario shapes. If a question could be produced by swapping numbers in an earlier one, throw it away and start again.

# Process

1. **Name the outcome.** One sentence: what reasoning is tested, and what does a student who only half understands do instead? Moves include spotting what stays constant, reading a rule in the right direction, choosing the cheaper plan, tracking a viewpoint change, or noticing which sentence a gap needs.
2. **Invent the situation.** Pick a scenario not used in this batch or accessible earlier batches. Keep a running list of scenarios and mechanisms. Vary the surface, what is asked, where the unknown sits, and the format. Do not claim memory of unavailable batches. Never copy or closely echo official NSW or PT3 material.
3. **Build the next-step trap.** Difficulty comes from decisions, not big numbers or odd wording. Aim for three or more decisions where the next step is not obvious: a hidden total, a before-and-after swap, a reversed chain, a changed viewpoint. Use clean numbers, simple fractions, 0.5 and 0.25, solvable on paper without a calculator. Do not force artificial arithmetic steps into reading inference.
4. **Design wrong answers from real mistakes.** Each distractor follows a plausible error: stopping early, reversing a rule, double counting, ignoring a qualifier, or taking a lure word. Explain each incorrect option specifically in that part's `distractorRationales`.
5. **Verify independently of the first derivation.** Re-solve, test every option, and establish uniqueness. Compute geometry, charts and tables in code when available; never eyeball raw SVG coordinates. Brute force and truth tables are private checks, never student solutions. If essential checks cannot be completed, simplify or defer the item rather than claim verification.
6. **Write the complete solution for Year 6.** Maths uses numbered reasoning and simple arithmetic. Reading and Thinking Skills sound like a teacher talking it through. Explain formal ideas in everyday words with a small example where useful. Follow the complete-working requirements below.
7. **Audit, preview, export.** Check schema and semantic consistency, then use the app's dry run when available. Fix errors before export/import. Passing import validation does not prove correctness or explanation quality. Importing or promoting items requires the user's request; exporting verified pilots does not authorize making them active.

# Difficulty targets (1.5x authoring goal)

Reading 3.8–4.5, Maths 3.7–4.5, Thinking Skills 4.0–4.8, Writing 3.8–4.4. These are initial authoring targets, not a measured claim of exactly 1.5 times exam difficulty. Do not emit `difficultyCalibrated` without calibration evidence.

Reading tests subtext and tone shifts, with plausible motives as distractors. Cloze has two or three grammatically possible options but only one fitting meaning and collocation. Gapped text includes a keyword-sharing decoy that does not satisfy the required link. Matching uses strict qualifiers such as “mainly”, “still” and “despite”.

# Sizing is a judgement, not a setting

Choose passage/set sizes to suit the reasoning. Guide: about 60 passage words per question; five questions around 330 words, eight around 520–650. Eight-gap cloze needs real context, around 150–300 words. Poems of 12–24 lines support two to four questions. Scale up when the user says a set is too short or small. Keep normal format counts below unless the user requests a different app-supported size.

# Full working must survive JSON export

Every objectively scored part needs a nonempty `workedExplanation` **string** containing its complete reasoning. Use exactly that part-level field. Do not put working only in the preview, a question-level `solution`, an `explanation` alias, or a `steps` array/object.

- Maths: numbered steps explaining why each operation is chosen, intermediate arithmetic with units, and the final answer/option. Do not replace the chain with a one-line answer justification.
- Thinking Skills: walk through the rules in order, show why the selected option follows, and explain the tempting mistake.
- Reading: connect specific wording, contrast, tone or cohesion to the answer; explain the inference and plausible alternative. Avoid circular claims such as “A fits best”.
- Give every gap/statement its own complete solution and rationales. Shared stimulus does not mean shared working. Do not shorten solutions to resemble terse seed examples.
- Use readable plain text: `1)`, `2)`, paragraph breaks, `×`, `÷`, `=`, fractions such as `3/4`, ordinary brackets, and units. Do not depend on HTML, Markdown or LaTeX rendering for meaning. Retain full working despite current UI formatting limitations.
- The decoded string contains actual line breaks. JSON serialization escapes them as `\n` once; do not double-escape into literal backslash-n text. Use a JSON serializer when available.
- `distractorRationales` maps each incorrect available option/extract key to an explanation string. In shared pools, keys match `poolKeys`. Never label the correct answer as wrong.
- Writing uses task-specific rubric guidance and pitfalls rather than one objectively correct response. Do not present a single model essay as the only answer.

# Schema contract: BankImportManifest

## Manifest, identity and ownership of metadata

- Top-level: `manifestVersion: "1.0"`, unique `batchLabel`, `defaultPoolType: "practice"`, `defaultQcStatus: "verified"`, `stimuli`, and nonempty `questions`. Non-passage batches may use `stimuli: []`.
- Verified pilots remain outside normal active practice and can be inspected in the admin simulator. Do not select `active` or a protected holdout pool unless explicitly requested.
- Every question: explicit `questionId`, `questionFamilyId`, positive integer `version` (start at 1), `section`, `formatType`, `parts`, and `provenance`. Every referenced `stimulusId` must resolve; export self-contained batches unless explicitly referencing a verified existing item.
- Every stimulus: explicit `stimulusId`, `stimulusFamilyId`, positive integer `version`, `section`, `genreOrTextType`, `sourceType: "ai_generated"`, and its passage/extracts/visual. Put passage text in `mainTextMarkdown`; extracts use `bodyMarkdown`.
- Use unique ASCII IDs containing only letters, numbers, underscores and hyphens, at most 128 characters. Keep them short and readable. `partId` is unique across the whole manifest. `partIndex` is zero-based and matches array order.
- Independent questions sharing one passage have different question families but the same stimulus. Revisions retain the original family; unrelated new questions get new families. For fixes, inspect the existing identity/version and allow the importer to resolve any version bump.
- Omit generated `contentHash`, `evidenceRevision`, `batchId`, per-item `batchLabel`, and created/updated timestamps. The top-level `batchLabel` supplies import grouping. Do not emit learner, session, scheduling or mastery records.
- `section` is exactly `READ`, `MATH`, `THINK` or `WRIT`. The question field is `formatType`, not `format` or `type`.

## Parts and formats

Each part includes `partId`, `partIndex`, `promptText`, canonical `skillId`, `difficultyInitial`, positive `targetTimeSec`, `cognitiveDemand`, `trapTags`, `options`, `correctAnswerKey`, `workedExplanation`, and `distractorRationales`. Optional `secondarySkillIds` also use canonical IDs. `cognitiveDemand` is `recall_locate`, `apply_procedural`, `analyze_infer` or `evaluate_transfer`.

Options contain `key`, `text`, optional `visual`. Retain text labels for picture choices. Option keys are unique; answer keys name an available option or extract.

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

## Visuals and website fonts

Prefer `visualType: "inline_svg"` for diagrams, charts, spatial tiles and data/price tables. Use visuals on roughly 60% of Maths and 30–40% of Thinking Skills where useful. These are authoring preferences; the app also supports `structured_table`, `image_asset` and `none`.

Use the existing `VisualSpec`: `visualType`, descriptive `altText`, `svgMarkup` for SVG, optional `caption`. Put a question diagram at `question.visual`, passage-wide figure at `stimulus.visual`, or answer image at `options[].visual`; do not invent `part.visual`.

Every SVG parses as XML, includes `xmlns="http://www.w3.org/2000/svg"` and a useful `viewBox`, and is correctly escaped for XML and JSON. Use self-contained vector shapes/text with no scripts, event handlers, `foreignObject`, external images/fonts, animation or network dependencies. Compute geometry and check visual values against the stem/options/working. Do not leak answers through alt text, captions, hidden labels or filenames.

Palette: `#FAF9F5` canvas, `#F3F1EC` fill, `#1F1E1D` ink, `#5F5B56` secondary, `#E5E0D8` grid/dividers, `#D97757` accent, `#3B5B6D`, `#2E6F40`. Tables have clean borders and canvas/fill rows. Use `font-family="'Plus Jakarta Sans', var(--font-sans, system-ui, -apple-system, sans-serif)"`, or `'Source Serif 4', var(--font-serif, Georgia, serif)` for literary excerpts. Set `font-variant-numeric="tabular-nums"` on numeric labels and allow at least 15% margin. Verify labels remain readable with fallback fonts. Do not add font dependencies to the app.

## Provenance must describe checks actually done

Use `sourceType: "ai_generated"`, `sourceReference` equal to the top-level `batchLabel`, and `auditorReviewed: false` until an actual separate audit. Set `verifierAgreed: true` only after the independent re-solve/computational check in this workflow occurred. Do not claim to have run code, seen a preview or passed a dry run without doing so.

Completed pilot batches default to `verified`. If essential verification is incomplete, use `defaultQcStatus: "draft"` and `verifierAgreed: false`. Never certify an unchecked answer simply to satisfy a default.

# Canonical skill IDs

Use only these snapshot IDs, or exact updated IDs from the current app taxonomy. Do not add new app IDs to fit an invented label.

- **READ:** `READ.FIC.LITERAL_DETAIL`, `READ.FIC.CHARACTER_INFERENCE`, `READ.FIC.IMPLIED_MEANING`, `READ.FIC.TONE_ATTITUDE`, `READ.FIC.TECHNIQUE_EFFECT`, `READ.FIC.TEXT_STRUCTURE`, `READ.CLOZE.COLLOCATION`, `READ.CLOZE.CONTEXT_NUANCE`, `READ.CLOZE.DISCOURSE_CONNECTOR`, `READ.POEM.LITERAL_SENSE`, `READ.POEM.FIGURATIVE_IMAGERY`, `READ.POEM.FORM_TONE_EFFECT`, `READ.GAP.COHESIVE_BRIDGE`, `READ.GAP.REFERENTIAL_PRONOUN_LINK`, `READ.GAP.PARAGRAPH_PROGRESSION`, `READ.MATCH.PRECISE_CONDITION`, `READ.MATCH.CROSS_TEXT_COMPARE`, `READ.MATCH.VIEWPOINT_CHANGE`.
- **MATH:** `MATH.NUM.DIVISIBILITY_REMAINDERS`, `MATH.NUM.NUMBER_SEQUENCES`, `MATH.NUM.PLACE_VALUE_DECIMALS`, `MATH.NUM.FACTORS_MULTIPLES_PRIMES`, `MATH.FRAC.FRACTION_CHAINS`, `MATH.FRAC.TRUE_FALSE_STATEMENTS`, `MATH.FRAC.RATIO_PROPORTION`, `MATH.FRAC.PERCENTAGES`, `MATH.FRAC.PROBABILITY_DEPENDENT`, `MATH.ALG.TWO_UNKNOWN_SYSTEMS`, `MATH.ALG.WORKING_BACKWARDS`, `MATH.ALG.SYMBOL_EQUATIONS`, `MATH.ALG.INEQUALITIES_BOUNDS`, `MATH.ALG.DIGIT_CRYPT_PUZZLES`, `MATH.TIME.ELAPSED_24H`, `MATH.TIME.TIME_ZONES_ITINERARY`, `MATH.TIME.CLOCK_ANGLES`, `MATH.MEAS.DIAL_GAUGE_OFFSET`, `MATH.MEAS.BALANCE_SCALES`, `MATH.MEAS.UNIT_CONVERSIONS`, `MATH.GEO2D.COMPOSITE_AREA`, `MATH.GEO2D.COMPOSITE_PERIMETER`, `MATH.GEO2D.ANGLES_PROTRACTOR`, `MATH.GEO2D.SYMMETRY_ROTATION_REFLECT`, `MATH.GEO2D.COMPASS_TURNS`, `MATH.GEO3D.CUBE_STACK_COUNT`, `MATH.GEO3D.NETS_SOLIDS`, `MATH.GEO3D.FACES_EDGES_VERTICES`, `MATH.DATA.BAR_LINE_GRAPHS`, `MATH.DATA.MEAN_RECONSTRUCTION`, `MATH.COMB.CONSTRAINED_OPTIMISATION`, `MATH.COMB.GRID_PATHS_COORDS`.
- **THINK:** `THINK.VERBAL.STRENGTHEN_ARGUMENT`, `THINK.VERBAL.WEAKEN_ARGUMENT`, `THINK.VERBAL.IDENTIFY_FLAW`, `THINK.VERBAL.IMPLICIT_ASSUMPTION`, `THINK.DEDUCT.WHOSE_REASONING_CORRECT`, `THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE`, `THINK.DEDUCT.LOGIC_GRID_CONSTRAINTS`, `THINK.DEDUCT.LINE_CIRCLE_ARRANGEMENT`, `THINK.DEDUCT.DEDUCTIVE_ORDERING`, `THINK.DEDUCT.SET_SYLLOGISMS`, `THINK.DEDUCT.KNIGHTS_AND_LIARS`, `THINK.DEDUCT.CRYPTOGRAM_MAPPING`, `THINK.DEDUCT.CYCLE_CHAIN_REASONING`, `THINK.NUM.SYSTEMS_WORD_PUZZLES`, `THINK.NUM.MIN_COST_COMBINATIONS`, `THINK.NUM.TABLE_CHART_RATE_LOGIC`, `THINK.NUM.OVERLAP_COUNTING`, `THINK.NUM.NETWORK_GRAPH_ROUTES`, `THINK.SPATIAL.VIEWS_3D_SILHOUETTES`, `THINK.SPATIAL.FOLD_CUT_TILE_ASSEMBLY`, `THINK.SPATIAL.PATTERN_ROTATION_SYMMETRY`.
- **WRIT:** `WRIT.CRIT.TOPIC_PROMPT_ADHERENCE`, `WRIT.CRIT.IDEAS_CREATIVITY`, `WRIT.CRIT.PURPOSE_AUDIENCE_VOICE`, `WRIT.CRIT.STRUCTURE_LAYOUT`, `WRIT.CRIT.STYLE_VOCABULARY`, `WRIT.CRIT.GRAMMAR_SPELLING_PUNCT`.

# Preview / output mode

- **Structured Outputs ON / JSON mode:** Perform available checks silently and emit ONLY one valid `BankImportManifest` JSON object. No Markdown fences, extra prose or preview HTML. Full student working stays inside every part's `workedExplanation`; JSON-only never means answer-only. Use verified/draft status truthfully as above.
- **Structured Outputs OFF / interactive mode:** Provide audited JSON and, when supported, a split-pane HTML/React preview: passage/diagram left; question, options and toggleable Year 6 solutions right. Bold option letters only. Use a 2×2 grid for four picture options; five-choice Maths remains five choices. Use the available preview surface, without changing the app or deploying a site. State any preview limitation honestly.
- Before export, check identities, taxonomy, format counts, stimulus links, gap/pool ordering, key uniqueness, complete explanations/rationales, SVG validity and evidence slices. Use the actual importer when available. Never truncate a batch into invalid JSON; reduce or split into complete labeled manifests according to the requested output mode.
