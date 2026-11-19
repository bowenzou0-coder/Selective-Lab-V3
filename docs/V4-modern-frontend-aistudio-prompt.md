# Selective Lab V4 — Editorial Studio & Quiet Exam Room Refactor Prompt

Use this prompt directly in **Google AI Studio** (after pushing/syncing our current GitHub state) or in a local session to overhaul the Selective Lab frontend while keeping every backend sync, exam-lock, and Banded A–E writing contract intact.

---

## Prompt to Paste

You are redesigning the frontend of **Selective Lab**, a server-authoritative NSW Selective High School exam trainer (React 19 + TypeScript + Tailwind CSS v4 + Vite + Express + Cloud Firestore + Gemini).

### 1. Aesthetic Direction: **Sunlit Editorial Studio (Compadre-Inspired) + Quiet Exam Room**
Build a joyful, expressive, high-dopamine editorial study studio for Year 5–6 students and their parents/tutors — grounded in custom Anthropic typography (`public/fonts/*.otf`), warm oat paper, deep botanical pine, tactile peach-apricot and eucalyptus color blocks, and bespoke ink-drawn isometric illustrations — paired with an ultra-quiet, distraction-free Exam Room during locked tests.

#### A. Custom Typography System (`@font-face` served from `/fonts/*.otf`)
The curated Anthropic `.otf` font files are already installed in `public/fonts/` and served by Express at `/fonts`:
- **`AnthropicSerifDisplay`**:
  - `500` → `/fonts/AnthropicSerif-Display-Medium-Static.otf`
  - `500 italic` → `/fonts/AnthropicSerif-Display-MediumItalic-Static.otf`
  - `700` → `/fonts/AnthropicSerif-Display-Bold-Static.otf`
  - `800` → `/fonts/AnthropicSerif-Display-Extrabold-Static.otf` (for wordmark `Selective Lab` & hero numbers/Band grades)
  - `400` → `/fonts/AnthropicSerif-Display-Regular-Static.otf`
- **`AnthropicSerifText`**:
  - `400` → `/fonts/AnthropicSerif-Text-Regular-Static.otf` (reading passages, `17px`, `1.74` line-height, `max-w-[65ch]`)
  - `400 italic` → `/fonts/AnthropicSerif-Text-RegularItalic-Static.otf`
  - `500` → `/fonts/AnthropicSerif-Text-Medium-Static.otf`
- **`AnthropicSansDisplay`**:
  - `500` → `/fonts/AnthropicSans-Display-Medium-Static.otf`
  - `600` → `/fonts/AnthropicSans-Display-Semibold-Static.otf` (greetings, card headings, primary buttons)
- **`AnthropicSansText`**:
  - `400` → `/fonts/AnthropicSans-Text-Regular-Static.otf` (body copy, options, labels)
  - `500` → `/fonts/AnthropicSans-Text-Medium-Static.otf`
  - `600` → `/fonts/AnthropicSans-Text-Semibold-Static.otf`
- **`AnthropicMono`**:
  - `400` → `/fonts/Anthropic%20Mono%20Web.otf` (**exclusively** for the live exam countdown clock and Admin IDs/JSON — never sprinkle monospace across ordinary student UI stats or tags).
- **CRITICAL CSS RULE:** Explicitly set `button, input, select, textarea { font-family: inherit; }` in `src/index.css` so no browser falls back to Arial/system-ui inside buttons or form controls.

#### B. Studio Palette & Spatial Shell (Dashboard, Mock Tests, Progress, Admin)
- **Outer Oat Shell:** `#F3EFE8` left sidebar (`208px` desktop, collapsible bottom strip mobile) with bold **`Selective Lab`** wordmark in `AnthropicSerifDisplay` (`800`), sentence-case nav items (`Dashboard`, `Practice drills`, `Mock tests`, `Progress`, `Admin`) where the active item renders as a crisp floating white pill (`#FFFFFF`), and a subtle learner/sync badge at the bottom.
- **Floating Studio Canvas:** Content sits inside a warm white rounded sheet (`#FFFFFF`, `18px` radius, subtle `1px solid #E5DFD5` hairline) inside the `#F3EFE8` surround.
- **Palette:**
  - Deep Pine Ink / Primary Text & Primary CTA Fill: `#113C36` (with `#FFFFFF` button text)
  - Secondary Ink: `#4A5955` · Quiet Meta: `#78756E`
  - Editorial Hero Card 1 (Today's Practice): Warm Apricot `#F9CAA7` with expressive oversized `AnthropicSerifDisplay` numbers (`18m`, `5d`), custom crisp SVG isometric open book + star illustration, and `#113C36` launch button.
  - Editorial Hero Card 2 (Writing Sprint): Warm Stone `#ECE8E1` with custom SVG isometric fountain pen + manuscript, `AnthropicSerifDisplay` italic/regular headline, and tactile warm coral `#F29A63` launch button.
  - Editorial Hero Card 3 (Official Mock): Soft Eucalyptus `#E5F0EA` with custom SVG isometric geometry compass + timer and `#113C36` launch button.
  - Clean hairline-divided section drill & recent session rows below with square `36px` SVG thumbnails, clear `AnthropicSansDisplay` row titles, soft pill metadata, and single-click launch.

#### C. Anti-Slop Copy & Layout Discipline
- **Zero internal jargon in student views:** Never show `gemini-decision-1`, `SM-2`, `EWMA`, `v3_3stage`, or `Locked exam session` chips to students. Keep AI/diagnostic tags exclusively in `/admin` and post-submission Writing Feedback attribution.
- **Zero ALL-CAPS eyebrows, zero middle-dot (`·`) chains, zero `→` on button labels, and zero single-word italic headline tricks.**

#### D. Quiet Exam Room (`SessionPlayerView`, `QuestionWorkspace`, `ReadingRenderers`, `WritingEditor`)
- When entering an exam session, **drop the oat sidebar, apricot cards, and illustrations completely**:
  - `48px` quiet `#F3EFE8` top rail: plain title + soft emerald `Saved` left | centered `AnthropicMono` countdown clock (`24:58`, click to hide) | `Question X of Y`, `Flag`, `Navigator`, and `#113C36` `Finish test` button (opening the 2-step confirmation modal).
  - Open-book split spread (`#FFFFFF` serif reading sheet in `AnthropicSerifText` on the left with soft `#FDE8D7` highlight; `#FAF8F5` answer pane in `AnthropicSansText` on the right with `#113C36` / `#E5F0EA` active option tint and subtle strike-through elimination).

### 2. Strict Behavioral & Security Contracts (DO NOT BREAK)
1. **Cross-device sync:** Preserve `checkpointRevision` optimistic concurrency (`SessionPlayerView.tsx` + `api.ts`), `409` conflict banner, and `alreadySubmitted || expiredAutoSubmitted` recovery into review mode.
2. **Exam lock:** Keep synchronous `lockedPath` / `effectivePath` routing in `src/App.tsx`, `HomeView` `s.status === 'in_progress'` lock flag on Review clicks, server-side 5 s submit grace window, and offline auto-submit retry backoff.
3. **Writing A–E Banded Rubric:** Preserve `totalMarks / maxTotalMarks` (`30`), per-criterion `band` (`A–E`) & `score / 5`, `bandCappedByTopicAdherence` warning badge, and fallback support for legacy evaluations.
4. **Question formats & visuals:** All 8 formats (`READ_FICTION_MCQ`, `READ_VOCAB_CLOZE`, `READ_POETRY_MCQ`, `READ_GAPPED_TEXT`, `READ_MULTIPLE_MATCH`, `MATH_MCQ_5`, `THINK_MCQ_4`, `WRIT_TYPED_TASK`) + `VisualRenderer` `imgError` reset must keep working.

### 3. Verification Before Finishing
Run all four checks and confirm exit code `0`:
- `npm run lint`
- `npm run lint:rules`
- `npm test`
- `npm run build`
