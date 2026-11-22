# Selective Lab — Local Agent Playbook (`AGENTS.md`)

## Codebase Rule: Authorized Models for Code Edits
- **Only models from Google (Gemini), Anthropic (Claude), and OpenAI (GPT/Codex) are permitted to edit real application code** (anything under `src/`, `api/`, `server.ts`, `scripts/`, `package.json`, config files, etc.).
- **No other models/providers** may modify real codebase files; other models are restricted to read-only tasks or content/question JSON drafts only unless explicitly approved by the user.

---

## Question-Bank Generation & Claude Paste Workflow

When the user asks you to **generate questions** (e.g., *"generate a set of 40 maths"*, *"generate today's full exam set"*, *"generate 5 reading and 5 thinking"*) or **pastes questions into this project chat**, use the question skill for both preparation and the sync decision. Accept plain question text as well as Claude.ai JSON.

## 1. Authoring Reference
- Always read `docs/selective-lab-question-skill/SKILL.md` and `docs/selective-lab-question-skill/references/calibration-anchors-1.5x.json` before authoring.
- **No web verification of NSW exam format or syllabus:** Do NOT web-search `education.nsw.gov.au`, `curriculum.nsw.edu.au`, or NESA to re-verify test format, section counts, timing, or Year 6 / Stage 3 maths scope — `SKILL.md` already contains the locked official specification.
- Check `batches/scenarios-log.txt` (if present) so new batches never repeat earlier scenarios.
- Standard full-set counts when the user says *"a set of [section]"* or *"a full set"* (**93 Qs / 114 slots** total; use custom counts only when explicitly requested):
  - **Reading (5 parts / 17 Qs / 38 slots — current 2025+ computer-based format):** Part 1: 8 single/paired (`READ_FICTION_MCQ`), Part 2: 1 cloze × 8 gaps (`READ_VOCAB_CLOZE`), Part 3: 6 on 20–28 line poem (`READ_POETRY_MCQ`), Part 4: 1 gapped/headings × 6 gaps (`READ_GAPPED_TEXT`, 7 extracts A–G), Part 5: 1 multiple match × 10 statements (`READ_MULTIPLE_MATCH`, 4 extracts A–D)
  - **Maths:** 35 questions (`MATH_MCQ_5`, ~60% visuals)
  - **Thinking Skills:** 40 questions (`THINK_MCQ_4`, ~20% "whose reasoning", ~10% plain-English mistake, ~25–35% spatial/visual)
  - **Writing:** 1 task (`WRIT_TYPED_TASK`, linked `stimulus` with descriptive `title` + `mainTextMarkdown`; ~50% image-prompt with crisp `< 95 KB` WebP `image_asset` and `caption` when image generation is supported, otherwise ignore image gen)

## 2. Cost-Efficient Single-Chat Generation (Default)
- **Default to one fresh chat per 93-question batch with NO subagents** so `SKILL.md`, `calibration-anchors-1.5x.json`, and `batches/scenarios-log.txt` remain warm in the prompt cache across turns (avoiding 5–6× uncached context reload overhead).
- Write 5–6 sequential section/half chunks directly to disk (e.g., Reading P1–3, Reading P4–5 + Writing, Maths Q1–18, Maths Q19–35, Thinking Q1–20, Thinking Q21–40), never echoing large raw JSON in chat prose.
- Verify every mathematical answer, SVG coordinate, and logic deduction in Node before merging.
- Only fan out parallel subagents when the user explicitly prioritizes wall-clock speed over token/usage cost.

## 3. Automatic Post-Generation & Claude Paste Handling (Zero User Friction)
For either source, prepare a manifest containing only the current batch.
1. Strip any accidental Markdown code fences, ensure unique `batchLabel` / `questionId` / `partId` / `stimulusId`, and fix any schema, SVG, or `distractorRationales` issues automatically.
2. Validate strictly with:
   ```bash
   node docs/selective-lab-question-skill/scripts/validate_manifest.mjs <file.json> --strict
   ```
   and cross-check against `src/server/manifestValidator.ts` (`validateAndDryRunManifest`). Fix all errors/warnings until it passes with **0 errors, 0 warnings**.
3. Save/merge into **`batches/ready-to-import.json`** (and archive a dated copy in `batches/archive/YYYY-MM-DD_<label>.json`) using:
   ```bash
   node docs/selective-lab-question-skill/scripts/merge_manifests.mjs <inputs...> \
     --out batches/ready-to-import.json \
     --batch-label "batch_YYYY_MM_DD_<slug>" \
     --append-scenarios batches/scenarios-log.txt
   ```
4. Strictly validate the final merged file, then run the read-only bank check with `npm run db:push -- batches/ready-to-import.json --dry-run`. Keep the validated archive for this batch.
5. Follow **Output and local sync** in the question skill. For local generation, ask at the end and wait for the answer. For pasted question content, sync automatically after validation. Explicit instructions such as “review only” take precedence.

## 4. Publishing questions to Neon

- When publishing, run `npm run db:push -- <validated-batch-path>` from this checkout. Use the specific archived file when acting on a later approval. The command reads the server-only `DATABASE_URL` from the environment or the ignored local `.env` and writes directly to Postgres. Check the command’s exit status and summary before reporting publication.
- Keep `batches/` out of git. Question edits are data changes and take effect on the next bank read. Deploy with `npm run deploy` when the application code changes.
- Use the pooled TLS URL from the Selective Lab Neon project. Keep database credentials and the session signing secret in the local `.env` and the Vercel production environment. Google Identity Services supplies sign-in and `ADMIN_EMAILS` controls admin access.
