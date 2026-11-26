import type { BenchmarkAiCoaching, BenchmarkReportRecord, SectionCode } from '../shared/contracts.ts';
import { SKILLS_TAXONOMY } from '../shared/skills.ts';
import { evaluateNswBenchmark, buildParentVerdict } from '../shared/nswBenchmark.ts';
import {
  createGeminiClient,
  GEMINI_DECISION_MODEL,
  getGeminiWritingModel,
  isGeminiConfigured,
  withGeminiRetry,
} from './geminiClient.ts';
import {
  runDecisionsApi,
  type DecisionQuestionSpec,
  type DecisionsExecutor,
} from './geminiPlanner.ts';

const SKILL_NAME_BY_ID = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

const BOTTLENECK_LEVELS = [
  'Low impact: strong accuracy and completed cleanly within time.',
  'Mild impact: isolated careless error or minor timing slip.',
  'Moderate impact: clear room to recover 2-3 marks with targeted drills.',
  'High impact: recurring errors or notable unanswered pacing bottleneck.',
  'Critical bottleneck: largest drag on composite /120 placement score and offer tier.',
];

interface CandidateBottleneck {
  key: string;
  skillId: string;
  section: SectionCode;
  label: string;
  missed: number;
  total: number;
  unanswered: number;
  baseUrgency: number;
  reasonEn: string;
  reasonZh: string;
}

const SECTION_LABEL_EN: Record<SectionCode, string> = {
  READ: 'Reading',
  MATH: 'Mathematical Reasoning',
  THINK: 'Thinking Skills',
  WRIT: 'Writing',
};

const SECTION_LABEL_ZH: Record<SectionCode, string> = {
  READ: '阅读理解',
  MATH: '数学推理',
  THINK: '思维能力',
  WRIT: '英文写作',
};

function buildCandidates(report: BenchmarkReportRecord): CandidateBottleneck[] {
  const candidates: CandidateBottleneck[] = [];

  // 1. Section-level pacing / accuracy candidates
  for (const sec of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const s = report.sections[sec];
    if (s.total <= 0) continue;
    const missed = Math.max(0, s.total - s.correct);
    if (sec === 'WRIT') {
      if (report.writingStatus === 'graded' && s.correct < 17) {
        candidates.push({
          key: 'sec_writ',
          skillId: 'WRIT.CRIT.IDEAS_CREATIVITY',
          section: 'WRIT',
          label: `Writing (${s.correct}/${s.total})`,
          missed,
          total: s.total,
          unanswered: 0,
          baseUrgency: (1 - s.accuracyPct / 100) * 4,
          reasonEn: `Writing scored ${s.correct}/${s.total} (${s.accuracyPct.toFixed(0)}%) — lifting by +2 marks directly raises the equal-weighted 25% component.`,
          reasonZh: `写作得分 ${s.correct}/${s.total}（${s.accuracyPct.toFixed(0)}%），在新制 25% 均权下每提 2 分都会明显拉高总折算分。`,
        });
      }
      continue;
    }

    if (s.unanswered >= 3) {
      candidates.push({
        key: `pace_${sec.toLowerCase()}`,
        skillId: `${sec}.PACING`,
        section: sec,
        label: `${SECTION_LABEL_EN[sec]} exam pacing`,
        missed,
        total: s.total,
        unanswered: s.unanswered,
        baseUrgency: 2.2 + s.unanswered * 0.25,
        reasonEn: `${s.unanswered} of ${s.total} ${SECTION_LABEL_EN[sec]} slots were left unanswered under timed conditions.`,
        reasonZh: `${SECTION_LABEL_ZH[sec]}在限时下有 ${s.unanswered} / ${s.total} 空未作答，时间分配是主要瓶颈。`,
      });
    }
  }

  // 2. Top missed skill candidates
  for (const sk of report.weakSkillStats.slice(0, 6)) {
    const name = SKILL_NAME_BY_ID.get(sk.skillId) || sk.skillId;
    const missRate = sk.total > 0 ? sk.missed / sk.total : 0;
    candidates.push({
      key: `sk_${candidates.length}`,
      skillId: sk.skillId,
      section: sk.section,
      label: `${SECTION_LABEL_EN[sk.section]}: ${name}`,
      missed: sk.missed,
      total: sk.total,
      unanswered: sk.unanswered,
      baseUrgency: sk.missed * 0.7 + missRate * 1.6 + sk.unanswered * 0.3,
      reasonEn: `Missed ${sk.missed} of ${sk.total} in ${name}${sk.unanswered > 0 ? ` (${sk.unanswered} unanswered)` : ''}.`,
      reasonZh: `「${name}」错失 ${sk.missed} / ${sk.total} 题${sk.unanswered > 0 ? `（含 ${sk.unanswered} 题未答）` : ''}。`,
    });
  }

  candidates.sort((a, b) => b.baseUrgency - a.baseUrgency);
  return candidates.slice(0, 6);
}

function buildDeterministicCoaching(
  report: BenchmarkReportRecord,
  ranked: BenchmarkAiCoaching['rankedPriorities'],
  meta?: { decisionModelId?: string; textModelId?: string; source?: 'hybrid_gemini' | 'deterministic' }
): BenchmarkAiCoaching {
  const evalOut = evaluateNswBenchmark({
    read: { score: report.sections.READ.correct, maxScore: Math.max(1, report.sections.READ.total) },
    math: { score: report.sections.MATH.correct, maxScore: Math.max(1, report.sections.MATH.total) },
    think: { score: report.sections.THINK.correct, maxScore: Math.max(1, report.sections.THINK.total) },
    writ: { score: report.sections.WRIT.correct, maxScore: Math.max(1, report.sections.WRIT.total) },
    difficulty: report.difficulty,
    weighting: 'official_2025_equal',
    genderFilter: 'all',
  });
  const verdict = buildParentVerdict(evalOut);
  const topNamesEn = ranked.slice(0, 2).map((p) => p.label).join(' and ');
  const totalUnanswered =
    report.sections.READ.unanswered +
    report.sections.MATH.unanswered +
    report.sections.THINK.unanswered;

  const parentSummaryEn = `${verdict.headlineEn}. Across this paper, Reading was ${report.sections.READ.correct}/${report.sections.READ.total} (${report.sections.READ.accuracyPct.toFixed(0)}%), Maths ${report.sections.MATH.correct}/${report.sections.MATH.total} (${report.sections.MATH.accuracyPct.toFixed(0)}%), Thinking ${report.sections.THINK.correct}/${report.sections.THINK.total} (${report.sections.THINK.accuracyPct.toFixed(0)}%), and Writing ${report.sections.WRIT.correct}/${report.sections.WRIT.total}${report.writingStatus !== 'graded' ? ' (pending grading)' : ''}.${topNamesEn ? ` Highest-return focus next: ${topNamesEn}.` : ''}`;

  const parentSummaryZh = `${verdict.headlineZh}。本卷各科成绩：阅读 ${report.sections.READ.correct}/${report.sections.READ.total}（${report.sections.READ.accuracyPct.toFixed(0)}%），数学 ${report.sections.MATH.correct}/${report.sections.MATH.total}（${report.sections.MATH.accuracyPct.toFixed(0)}%），思维 ${report.sections.THINK.correct}/${report.sections.THINK.total}（${report.sections.THINK.accuracyPct.toFixed(0)}%），写作 ${report.sections.WRIT.correct}/${report.sections.WRIT.total}${report.writingStatus !== 'graded' ? '（待批改）' : ''}。${ranked[0] ? `下阶段首要突破点：${ranked[0].label}。` : ''}`;

  const actionPlanEn: string[] = [];
  const actionPlanZh: string[] = [];

  for (const p of ranked.slice(0, 2)) {
    actionPlanEn.push(`Target ${p.label} — ${p.reasonEn}`);
    actionPlanZh.push(`重点专项突破 ${p.label} — ${p.reasonZh}`);
  }
  if (totalUnanswered >= 3) {
    actionPlanEn.push(
      `Run 2 timed 10-question section sprints this week to eliminate the ${totalUnanswered} unanswered slots left on the clock.`
    );
    actionPlanZh.push(
      `本周完成 2 次限时 10 题快节奏专项训练，消除本场遗留的 ${totalUnanswered} 个未作答空位。`
    );
  }
  if (report.writingStatus === 'pending') {
    actionPlanEn.push('Grade the Writing essay in Review so the 25% Writing score locks into your official /120 report.');
    actionPlanZh.push('在试卷复盘页完成作文 AI 批改，以锁定占 25% 权重的真实写作得分。');
  } else if (actionPlanEn.length < 3) {
    actionPlanEn.push('Re-sit the next reserved Benchmark Holdout paper in 2 weeks under strict 155-minute timing to confirm score growth.');
    actionPlanZh.push('2 周后在严格 155 分钟计时下完成下一套保留基准卷，验证提分幅度。');
  }

  return {
    source: meta?.source ?? 'deterministic',
    decisionModelId: meta?.decisionModelId,
    textModelId: meta?.textModelId,
    generatedAtIso: new Date().toISOString(),
    rankedPriorities: ranked.slice(0, 3),
    parentSummaryEn,
    parentSummaryZh,
    actionPlanEn: actionPlanEn.slice(0, 3),
    actionPlanZh: actionPlanZh.slice(0, 3),
  };
}

/**
 * Hybrid AI coaching layer:
 * 1) Deterministic formula owns ALL scores, bands, ranks, and school cutoffs.
 * 2) gemini-decision-1 ranks the top 2-3 highest-leverage bottlenecks.
 * 3) gemini-3.5-flash-lite turns those frozen numbers + ranked priorities into crisp EN/ZH parent guidance.
 */
export async function generateBenchmarkAiCoaching(
  report: BenchmarkReportRecord,
  options?: { decideFn?: DecisionsExecutor }
): Promise<BenchmarkAiCoaching> {
  const candidates = buildCandidates(report);
  let rankedPriorities: BenchmarkAiCoaching['rankedPriorities'] = candidates.slice(0, 3).map((c) => ({
    skillId: c.skillId,
    section: c.section,
    label: c.label,
    reasonEn: c.reasonEn,
    reasonZh: c.reasonZh,
    severityScore: Number(Math.min(4, Math.max(1, c.baseUrgency)).toFixed(2)),
  }));

  if (!isGeminiConfigured() && !options?.decideFn) {
    return buildDeterministicCoaching(report, rankedPriorities);
  }

  let usedDecisionModel: string | undefined;
  let usedTextModel: string | undefined;

  // Step 1: Rank bottlenecks with Gemini Decisions 1
  if (candidates.length > 0) {
    try {
      const inputLines = [
        `NSW Selective Benchmark Report (${report.batchLabel}, difficulty=${report.difficulty})`,
        `Composite: ${report.scaledScore120}/120 (P${report.estimatedPercentile}, Est Rank #${report.estimatedStateRank}/18000)`,
        `READ: ${report.sections.READ.correct}/${report.sections.READ.total} (${report.sections.READ.accuracyPct}%, unanswered=${report.sections.READ.unanswered}, band=${report.sections.READ.band})`,
        `MATH: ${report.sections.MATH.correct}/${report.sections.MATH.total} (${report.sections.MATH.accuracyPct}%, unanswered=${report.sections.MATH.unanswered}, band=${report.sections.MATH.band})`,
        `THINK: ${report.sections.THINK.correct}/${report.sections.THINK.total} (${report.sections.THINK.accuracyPct}%, unanswered=${report.sections.THINK.unanswered}, band=${report.sections.THINK.band})`,
        `WRIT: ${report.sections.WRIT.correct}/${report.sections.WRIT.total} (status=${report.writingStatus}, band=${report.sections.WRIT.band})`,
        '',
        'Candidate bottlenecks:',
        ...candidates.map(
          (c) =>
            `- ${c.key}: ${c.label} | missed=${c.missed}/${c.total}, unanswered=${c.unanswered} | ${c.reasonEn}`
        ),
      ].join('\n');

      const questions: Record<string, DecisionQuestionSpec> = {};
      for (const c of candidates) {
        questions[`prio_${c.key}`] = {
          type: 'score',
          instructions: `Rate how critical bottleneck "${c.label}" is to raising this student's NSW Selective /120 placement score over the next 2 weeks.`,
          criteria: BOTTLENECK_LEVELS,
        };
      }

      const answers = await runDecisionsApi(inputLines, questions, options?.decideFn);
      usedDecisionModel = GEMINI_DECISION_MODEL;
      rankedPriorities = candidates
        .map((c) => {
          const ans = answers[`prio_${c.key}`];
          const score = ans?.type === 'score' && Number.isFinite(ans.score) ? ans.score : c.baseUrgency;
          return {
            skillId: c.skillId,
            section: c.section,
            label: c.label,
            reasonEn: c.reasonEn,
            reasonZh: c.reasonZh,
            severityScore: Number(score.toFixed(2)),
          };
        })
        .sort((a, b) => b.severityScore - a.severityScore)
        .slice(0, 3);
    } catch (err) {
      console.warn('Benchmark Decisions 1 ranking failed, using deterministic ranking:', err instanceof Error ? err.message : err);
    }
  }

  // Step 2: Generate concise parent narrative with Gemini 3.5 Flash Lite
  if (isGeminiConfigured()) {
    try {
      const modelId = getGeminiWritingModel();
      const ai = await createGeminiClient();
      const prompt = [
        'You are an NSW Selective High School exam coach writing a concise, reassuring, concrete parent debrief.',
        'STRICT RULE: Never invent or alter any numbers, scores, ranks, or school cutoffs. Only cite the exact frozen facts below.',
        '',
        `Frozen Official Benchmark Facts:`,
        `- Scaled Score: ${report.scaledScore120.toFixed(1)} / 120 (Est. State Rank #${report.estimatedStateRank} / 18,000, P${report.estimatedPercentile.toFixed(1)})`,
        `- Reading: ${report.sections.READ.correct}/${report.sections.READ.total} (${report.sections.READ.accuracyPct.toFixed(0)}%, ${report.sections.READ.unanswered} unanswered)`,
        `- Maths: ${report.sections.MATH.correct}/${report.sections.MATH.total} (${report.sections.MATH.accuracyPct.toFixed(0)}%, ${report.sections.MATH.unanswered} unanswered)`,
        `- Thinking: ${report.sections.THINK.correct}/${report.sections.THINK.total} (${report.sections.THINK.accuracyPct.toFixed(0)}%, ${report.sections.THINK.unanswered} unanswered)`,
        `- Writing: ${report.sections.WRIT.correct}/${report.sections.WRIT.total} (${report.writingStatus})`,
        `- Ranked Priorities (from Decisions 1):`,
        ...rankedPriorities.map((p, i) => `  ${i + 1}. ${p.label}: ${p.reasonEn}`),
        '',
        'Return strict JSON with keys:',
        '{ "parentSummaryEn": "2-3 crisp sentences for a parent", "parentSummaryZh": "2-3 concise Simplified Chinese sentences", "actionPlanEn": ["3 short concrete 2-week steps"], "actionPlanZh": ["3 short Simplified Chinese steps"] }',
      ].join('\n');

      const rawText = await withGeminiRetry(
        async () => {
          const resp = await ai.models.generateContent({
            model: modelId,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.3,
              maxOutputTokens: 700,
            },
          });
          return resp.text || '';
        },
        2,
        300,
        modelId
      );

      const parsed = JSON.parse(rawText) as Partial<{
        parentSummaryEn: string;
        parentSummaryZh: string;
        actionPlanEn: string[];
        actionPlanZh: string[];
      }>;

      if (
        typeof parsed.parentSummaryEn === 'string' &&
        parsed.parentSummaryEn.trim().length > 20 &&
        typeof parsed.parentSummaryZh === 'string' &&
        parsed.parentSummaryZh.trim().length > 10 &&
        Array.isArray(parsed.actionPlanEn) &&
        parsed.actionPlanEn.length > 0
      ) {
        usedTextModel = modelId;
        return {
          source: 'hybrid_gemini',
          decisionModelId: usedDecisionModel,
          textModelId: usedTextModel,
          generatedAtIso: new Date().toISOString(),
          rankedPriorities,
          parentSummaryEn: parsed.parentSummaryEn.trim(),
          parentSummaryZh: parsed.parentSummaryZh.trim(),
          actionPlanEn: parsed.actionPlanEn.slice(0, 3).map((s) => String(s).trim()).filter(Boolean),
          actionPlanZh: Array.isArray(parsed.actionPlanZh) && parsed.actionPlanZh.length > 0
            ? parsed.actionPlanZh.slice(0, 3).map((s) => String(s).trim()).filter(Boolean)
            : parsed.actionPlanEn.slice(0, 3).map((s) => String(s).trim()).filter(Boolean),
        };
      }
    } catch (err) {
      console.warn('Benchmark Flash Lite narrative failed, using deterministic summary:', err instanceof Error ? err.message : err);
    }
  }

  return buildDeterministicCoaching(report, rankedPriorities, {
    source: usedDecisionModel ? 'hybrid_gemini' : 'deterministic',
    decisionModelId: usedDecisionModel,
    textModelId: usedTextModel,
  });
}
