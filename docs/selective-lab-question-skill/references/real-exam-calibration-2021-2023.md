# Real NSW Selective High School Placement Test Calibration (2021–2023)

Structural, distributional, and craft patterns extracted from the **actual 2021, 2022, and 2023 NSW Selective High School Placement Test (SHSPT)** papers prepared by Cambridge University Press & Assessment for the NSW Department of Education (distinct from the 2022 Sample Test).

> **Authoring rule:** Use these patterns purely for structural fidelity, timing, format coverage, and reasoning authenticity. Never copy, adapt, or echo real exam passages, scenarios, diagrams, or wording.
>
> **Locked format & syllabus (No Web Lookup):** The current **2025+ computer-based NSW Selective test format** (Reading 45 min / 5 parts / 17 Qs / 38 slots; Mathematical Reasoning 40 min / 35 Qs A–E; Thinking Skills 40 min / 40 Qs A–D; Writing 30 min / 1 task = **93 Qs total**) and Stage 3 Year 6 Maths scope are already verified and locked in `SKILL.md` — **do NOT run web searches against `education.nsw.gov.au` or `curriculum.nsw.edu.au` (NESA) to re-check them.**

---

## 1. Reading (Current 2025+ Computer-Based Format: 45 min, 5 parts, 17 Qs = 38 answer slots)

The **current official computer-based NSW Selective Reading test (2025+ via Janison/Cambridge, matching Official Practice Tests PT1–PT3)** is **45 minutes** across **5 parts** (`8 + 8 + 6 + 6 + 10 = 38` answer slots across 17 on-screen questions). *(Older 2021–2023 paper-based PDFs were 40 minutes / 4 parts / 30 questions without Part 2 Vocab Cloze; the text craft, paired-extract Part 1, 6-question Poetry, and paragraph-summary Gapped Text variants carry directly into the 5-part computer-based exam.)*

| Part | Slots (Qs) | Format in Selective Lab | Options | Official Blueprint |
|---|---:|---|---|---|
| **Part 1** | **8** (8 Qs) | `READ_FICTION_MCQ` | A–D | **Two official variants:**<br>1. **Single literary extract** (~550–700 words, optional numbered glossary footnotes): Q1–6 paragraph-anchored inference, tone, idiom, and character shifts; Q7–8 whole-extract arc/contrast.<br>2. **Paired extracts (`Text A` + `Text B`)** on a shared theme (literary + non-fiction, ~600–750 words combined, `genreOrTextType: "paired_extracts"`, `extracts: [A, B]`) with single-text and cross-text synthesis questions. |
| **Part 2** | **8** (1 Q, 8 gaps) | `READ_VOCAB_CLOZE` | A–D each | **Informational cloze passage** (~180–300 words) with 8 inline word gaps (`{{gap:1}}`–`{{gap:8}}`). 2–3 options are grammatically possible in each gap; only one fits exact meaning, collocation, and discourse flow. |
| **Part 3** | **6** (6 Qs) | `READ_POETRY_MCQ` | A–D | **Full poem** (~20–28 lines, contemporary/Australian or classic lyric). Always **6 questions**, progressing from literal sense and narrator perspective → figurative imagery → structural/repetition effect → symbolic meaning / tonal shift. |
| **Part 4** | **6** (1 Q, 6 gaps) | `READ_GAPPED_TEXT` | A–G (`isDecoy: true` on 1) | **Two official variants (both fit `READ_GAPPED_TEXT` cleanly):**<br>1. **6 removed sentences** from a non-fiction feature article (~450–600 words) with `{{gap:1}}`–`{{gap:6}}` inline.<br>2. **6 paragraph summary headings** matched to 6 numbered paragraphs (`{{gap:1}}`–`{{gap:6}}` above each paragraph; extracts A–G are concise summaries with 1 keyword-sharing decoy). |
| **Part 5** | **10** (1 Q, 10 stmts) | `READ_MULTIPLE_MATCH` | A–D (reuse allowed) | **Four thematic extracts (A–D)** (~140–190 words each, ~560–750 words total) exploring one broad theme from distinct angles/voices. 10 "Which writer / Which extract..." prompts testing precise qualifiers, implied stance, humour/mockery, and subtle contrast. |

### Reading Calibration Takeaways
- **Poetry set size:** Target **6 questions** for full exam-style poetry sets (shorter 2–4 question micro-sets only if the user explicitly asks for a quick drill).
- **Part 1 variety:** Alternate between single literary extracts and **paired `Text A` + `Text B` extracts** (`genreOrTextType: "paired_extracts"`).
- **Part 4 variety:** Alternate between **removed-sentence gapped texts** and **paragraph-summary matching** (both use `READ_GAPPED_TEXT`, `slotRef: "gap:1"`–`"gap:6"`, 7 extracts A–G with 1 `isDecoy: true`).
- **Reading distractors:** Use plausible motives, reversed cause/effect, half-true details from the wrong paragraph, or literal readings of figurative language.

---

## 2. Mathematical Reasoning (35 questions, 40 minutes, 5 options A–E)

Across 105 real questions (2021–2023), NSW Mathematical Reasoning is **problem-solving first, computation second**: clean arithmetic, zero calculators, high visual density, and multi-decision reasoning.

### Structural & Visual Benchmarks
- **Visual density:** **55–65%** of questions carry a diagram, grid, table, chart, net, number line, scale, clock, protractor, or 3D block/prism visual.
- **`[diagram not to scale]` convention:** Explicitly label diagrams `[diagram not to scale]` whenever lengths or angles are intentionally schematic so students reason mathematically rather than measuring by eye.
- **Multi-statement verification (`MATH.FRAC.TRUE_FALSE_STATEMENTS` & general logic):** **2–3 questions per paper** present three numbered/lettered statements (1, 2, 3 or X, Y, Z) and ask *"Which of these statements is/are correct?"* or *"Which of these statements cannot be correct?"* with subset options (e.g., `A statement 1 only` … `E statements 1, 2 and 3`).

### High-Value Reasoning Mechanisms Observed in 2021–2023
Every real mechanism maps onto the existing 32 canonical `MATH.*` skills — rotate broadly across these instead of overusing generic age/money word problems:

1. **Parity, remainders & number properties:** Remainder classes (`mod n`), all possible remainders of even/odd multiples, parity deductions from symbol equations (`▲ + ● is odd`, `● × ■ is odd`), lowest common multiple pyramids, light-flashing LCM exclusions ("A and B flash together *without* C").
2. **Missing-digit & bounds puzzles:** Maximising or minimising differences/sums with unknown digits (`$70.2■` vs `$68.5▲`), possible digit counts of products, digit cards placed in ascending order to locate the median.
3. **3D spatial & scaling:** Painted edges/faces of a `n×n×n` cube stack, adding/removing cubes from a prism, identifying which 2D nets fold into a triangular prism or patterned cube, **2D shadow projections** of 3D solids (cylinder, triangular/pentagonal prism), and **mass scaling by 3D volume** (doubling all dimensions multiplies volume/mass by 8, not 2!).
4. **2D geometry, symmetry & motion:** Composite areas built from identical rectangles with an inner shaded void, consecutive reflections across vertical/horizontal axes tracking labelled corners, compass walks around polygons, robot/protractor turns, minimum extra squares to complete line/rotational symmetry, map scale area (`1:k` length → `k²` area!).
5. **Data & incomplete statistics:** Column graphs with **missing bars** plus a ratio constraint (`two pets = 2 × three pets`), **incomplete frequency tables** with a mode constraint ("most common is 1 → smallest possible count"), pictograph key validity, total count from frequency graphs (`Σ value × frequency`, catching the classic trap of summing bars instead of multiplying!).
6. **Probability with hidden composition:** Deducing unknown coin/marble counts from a total value + given probability (`P(10c) = 2/7`) before finding a second probability (`P(20c)`).
7. **Time, cycles & units:** Cross-date international time zones (e.g., Sydney ↔ New York crossing midnight/date), faulty clocks gaining/losing minutes per hour, repeating shape cycles (`92nd and 93rd`), spiral coordinate grid walks (`up 10, right 9, down 8…`), multi-step unfamiliar unit conversions (`gill → pint → quart → peck`).

---

## 3. Thinking Skills (40 questions, 40 minutes, 4 options A–D)

Across 120 real questions (2021–2023), NSW Thinking Skills has a remarkably consistent blueprint split across **Critical/Verbal Reasoning (~40–45%)**, **Deductive & Numerical Problem Solving (~35–40%)**, and **Spatial / Visual-Data Reasoning (~20–25%)**.

### Exact Real-Exam Verbal / Critical Thinking Invariants (2021, 2022, 2023)
| Archetype | Count per 40-Q paper | Canonical Skill ID | Exact Exam Pattern |
|---|---:|---|---|
| **Whose reasoning is correct?** | **8 every year (20%)** | `THINK.DEDUCT.WHOSE_REASONING_CORRECT` | A **boxed premise** of 1–3 clear rules/facts + **two named speakers** making deductions. Fixed 4 options: `A <Name1> only`, `B <Name2> only`, `C Both <Name1> and <Name2>`, `D Neither <Name1> nor <Name2>`. Tests contrapositive vs affirming the consequent, denying the antecedent, "unless", necessary vs sufficient conditions, and hidden scope shifts. |
| **Identify the concrete mistake** | **4 every year (10%)** | `THINK.VERBAL.IDENTIFY_FLAW` | One speaker draws a flawed conclusion from everyday facts. Stem: *"Which one of the following sentences shows the mistake <Name> has made?"* or *"shows that <Name> has made a mistake?"*. Options are **concrete counter-examples, alternative causes, or overlooked cases in plain Year 6 English** — never abstract Latin fallacy names. |
| **Strengthen / Weaken argument** | **3–4 every year (~9%)** | `THINK.VERBAL.STRENGTHEN_ARGUMENT` / `THINK.VERBAL.WEAKEN_ARGUMENT` | Everyday policy, experiment, nature-reserve, or consumer argument. Stem: *"Which one of these statements, if true, most strengthens / weakens …'s argument?"* (Note: weaken appears more often than strengthen, roughly 3:1). |
| **Deductive necessity / impossibility** | **2–4 every year (~7%)** | `THINK.DEDUCT.CONDITIONAL_CONTRAPOSITIVE` / `THINK.DEDUCT.SET_SYLLOGISMS` | Stem: *"Based on the above information, which one of the following must be true / cannot be true / is not possible?"* |

> **Calibration note:** Real 2021–2023 NSW Thinking Skills papers contain **zero** "parallel reasoning" or "main conclusion" items (unlike UK TSA/BMAT). Focus verbal items on the four authentic NSW patterns above plus `THINK.VERBAL.IMPLICIT_ASSUMPTION`.

### Recurring Spatial, Logic & Numerical Problem-Solving Patterns
- **Paper folding & cutting:** Fold rectangular/square sheet twice, cut a corner/edge, unfold → *"Which one of the following is NOT a possible appearance?"* (ideal for 2×2 `options[].visual` SVG tiles!).
- **3D views, puzzle completion & dice:** Matching top/side/bottom views of stacked blocks or a wire-wrapped cube; choosing the complementary 3D block to form a complete cube; standard dice (opposite faces sum to 7) arranged in a row to find hidden touching faces.
- **Data-to-visual matching:** Given a multi-row table (e.g., 4 students × 5 subjects), match an **unlabelled** bar/column graph to the single matching student; or match a table of room/plot dimensions to one of 4 floorplan layouts.
- **Minimum information / code deduction:** *"Which one of the following questions would allow you to deduce the code?"* or *"Which extra translator would make the chain possible?"*
- **Constraints, routes & tables:** Tiered pricing/hire tables, overlapping arrival/validity time windows, network routes visiting *k* attractions and returning to start, relay team selection from multi-column speed tables, truth-tellers/liars, circular/linear seating, and non-repeating symbol chains.

---

## 4. Writing (1 task, 30 minutes)

Real 2021–2023 NSW Writing papers test **purposeful, audience-aware communication across varied text types** — never just generic persuasive essays or open stories.

| Year | Text Type | Audience & Purpose | Scaffolding Features |
|---|---|---|---|
| **2021** | Newspaper report | Local paper readers — inform & report vividly | 3-sentence scenario + **visual stimulus illustration** + 3 open bullets (*"In your report, you could: …"*) |
| **2022** | Diary entry | Personal reflection (future year 2099) — entertain/imagine | Short scenario + **mandatory opening line** (`Dear Diary, When our house robot woke me up...`) + 3 open bullets |
| **2023** | Competition email | Movie company judges — pitch & persuade creatively | Short scenario + 3 open bullets + **explicit layout note** (*"You do not need to include email formatting such as To, Subject, etc."*) |

### Writing Calibration Takeaways
- Rotate across authentic NSW genres: **newspaper report, diary entry, competition/formal email, advice sheet, persuasive letter, speech, and imaginative narrative**.
- Every prompt includes: (1) punchy title, (2) crisp 2–4 sentence scenario, (3) clear genre/audience/purpose, (4) **3 open bullet suggestions** (`bulletSuggestions`), and (5) optionally a `mandatoryOpeningLine`, an inline SVG `stimulus.visual`, or a practical formatting note.
- Always `timeLimitSec: 1800` (30 min), `recommendedWordRange: [250, 480]`, single part with `skillId: "WRIT.CRIT.TOPIC_PROMPT_ADHERENCE"`, `options: []`, `correctAnswerKey: ""`, and rich 6-criterion rubric guidance + common pitfalls inside `workedExplanation`.
