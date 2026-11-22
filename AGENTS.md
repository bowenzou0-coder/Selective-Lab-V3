# Selective Lab — agent playbook

## Rules
- Only Google (Gemini), Anthropic (Claude) and OpenAI (GPT/Codex) models may edit application code (`src/`, `api/`, `server.ts`, `scripts/`, configs). Other models: read-only, or question JSON drafts unless the user approves.
- Keep `batches/` out of git. Keep EN/ZH parity (`src/client/i18n/en.ts` + `zh.ts`) and the design system in `FRONTEND_DESIGN.md`.
- Start with [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md) to find files. Verify with `npm run lint && npm test && npm run build`.

## Questions: generate or paste
Use `docs/selective-lab-question-skill/SKILL.md` for both authoring and pasted questions (plain text or Claude.ai JSON). It holds the locked NSW format, counts, scope and quality gate; do not web-search NSW/NESA to re-verify them.

1. Read `SKILL.md` and `references/calibration-anchors-1.5x.json`; check `batches/scenarios-log.txt` so scenarios never repeat.
2. Default to one chat per batch with no subagents (keeps the skill cached); fan out only when the user prioritises speed over cost. Write section chunks straight to disk, never echo large JSON. Verify every answer, deduction and SVG in Node.
3. Fix fences, IDs, schema and rationale issues, then `node docs/selective-lab-question-skill/scripts/validate_manifest.mjs <file> --strict` until 0 errors and 0 warnings.
4. Merge and archive (auto-standardizes IDs to `<YYYY-MM-DD_bNN>_<sec>_<nn>_v1` and normalizes SVG fonts):
   `node docs/selective-lab-question-skill/scripts/merge_manifests.mjs <inputs...> --out batches/ready-to-import.json --batch-label YYYY-MM-DD_b01 --append-scenarios batches/scenarios-log.txt`, copy to `batches/archive/YYYY-MM-DD_b01.json`, re-validate strictly, then `npm run db:push -- batches/ready-to-import.json --dry-run` (runs the server-side `manifestValidator.ts` checks read-only).
5. Sync per the skill's "Output and local sync": generated batches ask once before publishing; pasted batches publish after validation. "Review only" overrides.

## Publishing and deploy
- `npm run db:push -- <validated-archive>` writes to Neon using `DATABASE_URL` from the environment or `.env`; check its exit status and summary before reporting. Bank edits take effect on the next request (the server revalidates its cache).
- `npm run deploy` when application code changes. Secrets (`DATABASE_URL`, `SESSION_SECRET`) live in `.env` and Vercel production env; `ADMIN_EMAILS` controls admin access.
