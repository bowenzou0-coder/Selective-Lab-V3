# Selective Lab Question Skill

Self-contained **1.5× NSW Selective High School** question-generation skill for Selective Lab (`BankImportManifest` JSON).

## Two Zero-Friction Ways to Use It

### 1. On Claude.ai (Upload `.zip` Once)
1. Upload **[selective-lab-question-skill-claude.zip](../selective-lab-question-skill-claude.zip)** in **Claude.ai → Settings → Capabilities → Skills**.
2. Ask for what you want (2 turns in the same chat per section = high prompt-cache hit & zero truncation):
   - **Reading + Writing:** Turn 1 `"Generate Reading Parts 1–3 + 1 Writing task"` → Turn 2 `"Continue: Reading Parts 4–5"`
   - **Thinking Skills:** Turn 1 `"Generate Thinking Skills Q1–20"` → Turn 2 `"Continue: Thinking Skills Q21–40, new scenarios & skills"`
   - **Maths:** Turn 1 `"Generate Maths Q1–18"` → Turn 2 `"Continue: Maths Q19–35, new scenarios & skills"`
3. Paste the JSON (or plain-text questions) into this project chat — the agent standardizes IDs & SVG fonts via `merge_manifests.mjs`, validates strictly, and syncs to the live bank. Or import manually under **Admin → Import & Batches**.

### 2. Locally Here
Ask e.g. `"generate 40 maths"` or `"generate today's full exam set"`. The agent verifies answers/SVGs, saves the standardized batch (`YYYY-MM-DD_bNN`), and asks once before publishing. See [AGENTS.md](../../AGENTS.md).

## Standardized Naming
- `batchLabel`: `YYYY-MM-DD_bNN` (e.g. `2026-11-22_b01`)
- Stimuli: `<batch>_<sec>_s<nn>_v1` (e.g. `2026-11-22_b01_read_s01_v1`)
- Questions: `<batch>_<sec>_<nn>_v1` (e.g. `2026-11-22_b01_math_01_v1`)
- Parts: `<questionFamilyId>_p<n>` (e.g. `2026-11-22_b01_math_01_p1`)
- `<sec>` is always `read`, `math`, `think`, or `writ` (never chunk labels like `m1`/`m2`).

## Folder Contents
- `SKILL.md` — Compact master 1.5× authoring rules, naming standard, Year 6 scope, and JSON contract
- `references/calibration-anchors-1.5x.json` — 5-question 1.5× calibration anchors
- `references/real-exam-calibration-2021-2023.md` — Craft patterns from real 2021–2023 NSW SHSPT papers
- `references/visual-palette-and-sizing.md` — Palette, automatic Anthropic SVG fonts, hygiene & 2×2 tile sizing
- `schema/` — Draft 2020-12 JSON Schema + 77 canonical skills
- `examples/` — 12-question (33-part) verified showcase covering all 8 `formatType`s + preview HTML
- `scripts/` — Zero-dep agent tools (`validate_manifest.mjs`, `merge_manifests.mjs`, `preview_manifest.mjs`, `compute_evidence_refs.mjs`)
