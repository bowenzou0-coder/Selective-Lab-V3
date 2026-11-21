# Selective Lab Question Skill

Self-contained **1.5× NSW Selective High School** question-generation skill for Selective Lab (`BankImportManifest` JSON).

## Two Zero-Friction Ways to Use It

### 1. On Claude.ai (Free or Pro — Upload `.zip` Once)
1. Upload **[selective-lab-question-skill-claude.zip](../selective-lab-question-skill-claude.zip)** in **Claude.ai → Settings → Capabilities → Skills**.
2. In a chat, just ask for what you want (2 turns in the same chat per 5-hour window = max prompt-cache hit & zero truncation):
   - **Window 1 (Reading + Writing):** Turn 1 `"Generate Reading Parts 1–3 (8 paired/fiction Qs + 8-gap cloze + 6 poem Qs) + 1 Writing task"` → Turn 2 `"Continue: Reading Parts 4–5 (6 gapped/headings + 10 multiple-match)"`
   - **Window 2 (Thinking Skills):** Turn 1 `"Generate Thinking Skills Q1–20"` → Turn 2 `"Continue: Thinking Skills Q21–40, new scenarios & skills"`
   - **Window 3 (Maths):** Turn 1 `"Generate Maths Q1–20"` → Turn 2 `"Continue: Maths Q21–40, new scenarios & skills"`
3. Paste the JSON into this project chat. The agent validates it, syncs it to the live bank automatically, and returns the batch ID. Plain-text questions work too. You can also import a manifest manually through **Admin → Import & Batches**.

### 2. Locally Here (Antigravity / Neon / GPT)
Just say `"generate a set of 40 maths"` or `"generate today's full exam set"`. The agent verifies the questions, saves the validated batch, and asks whether to sync it to the live bank. Reply “yes” to publish or “no” to keep the draft. See [the project playbook](../../AGENTS.md).

## Folder Contents
- `SKILL.md` — Master 1.5× authoring rules, Year 6 + Pythagoras/3D scope, and exact JSON schema
- `references/calibration-anchors-1.5x.json` — Compact 5-question 1.5× one-shot difficulty anchors
- `references/real-exam-calibration-2021-2023.md` — Blueprint from real 2021–2023 NSW SHSPT papers
- `references/visual-palette-and-sizing.md` — Sunlit Editorial Studio palette, SVG hygiene & 2×2 tile sizing
- `schema/` — Full Draft 2020-12 JSON Schema + 77 canonical skills
- `fonts/` — 14 bundled Anthropic Serif, Sans & Mono `.otf` fonts (for local HTML previews)
- `examples/` — Full 12-question (33-part) verified showcase covering all 8 `formatType`s + preview HTML
- `scripts/` — Behind-the-scenes agent tools (`validate_manifest.mjs`, `merge_manifests.mjs`, `preview_manifest.mjs`, `compute_evidence_refs.mjs`)
