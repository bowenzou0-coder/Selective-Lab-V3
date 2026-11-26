import {
  DEFAULT_MASTERY_POLICY,
  type BankMasterySummary,
  type MasteryPolicyConfig,
  type PartAttemptRecord,
  type QuestionItem,
  type QuestionMasteryEvidence,
  type SectionCode,
  type SectionMasteryBreakdown,
  type StimulusGroup,
} from './contracts.ts';

function stableCanonicalString(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCanonicalString(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableCanonicalString(obj[k])}`).join(',')}}`;
}

// Browser- and Node-safe deterministic 64-bit FNV-1a dual digest (16 hex chars)
export function deterministicDigest(value: unknown): string {
  const input = stableCanonicalString(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Computes an evidence revision strictly over answer-bearing & substantive assessment content.
 * Cosmetic changes (workedExplanation, distractorRationales, evidenceRefs, qcStatus, provenance, trapTags)
 * preserve the same evidenceRevision so existing learner mastery certification is preserved.
 */
export function computeEvidenceRevision(
  question: QuestionItem,
  stimulus?: StimulusGroup
): string {
  const substantiveStimulus = stimulus
    ? {
        stimulusFamilyId: stimulus.stimulusFamilyId,
        title: stimulus.title ?? '',
        preamble: stimulus.preamble ?? '',
        mainTextMarkdown: stimulus.mainTextMarkdown ?? '',
        extracts: (stimulus.extracts || []).map((ex) => ({
          label: ex.label,
          title: ex.title ?? '',
          bodyMarkdown: ex.bodyMarkdown,
        })),
        visual: stimulus.visual ?? null,
      }
    : null;

  const substantiveParts = [...question.parts]
    .sort((a, b) => a.partIndex - b.partIndex)
    .map((p) => ({
      partId: p.partId,
      partIndex: p.partIndex,
      slotRef: p.slotRef ?? '',
      promptText: p.promptText,
      skillId: p.skillId,
      options: p.options.map((o) => ({
        key: o.key,
        text: o.text,
        visual: o.visual ?? null,
      })),
      correctAnswerKey: p.correctAnswerKey,
    }));

  return `er_${deterministicDigest({
    questionFamilyId: question.questionFamilyId,
    section: question.section,
    formatType: question.formatType,
    stemPrefix: question.stemPrefix ?? '',
    visual: question.visual ?? null,
    sharedPoolConfig: question.sharedPoolConfig ?? null,
    writingSpec: question.writingSpec ?? null,
    parts: substantiveParts,
    stimulus: substantiveStimulus,
  })}`;
}

export function buildEvidenceKey(questionFamilyId: string, evidenceRevision: string): string {
  return `${questionFamilyId}__${evidenceRevision}`;
}

/**
 * Formats mastery percentage conservatively:
 * - Zero denominator => "No evidence"
 * - 100% only when numerator === denominator
 * - Otherwise floors to 0.1% capped at 99.9% so 99.96% never displays as 100%.
 */
export function formatMasteryPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return 'No evidence';
  if (numerator <= 0) return '0%';
  if (numerator >= denominator) return '100%';
  const floored = Math.min(99.9, Math.floor((numerator / denominator) * 1000) / 10);
  const formatted = floored.toFixed(1).replace(/\.0$/, '');
  return `${formatted}%`;
}

export function isQuestionEligibleForMastery(q: QuestionItem): boolean {
  return (
    q.qcStatus === 'active' &&
    q.poolType === 'practice' &&
    q.formatType !== 'WRIT_TYPED_TASK'
  );
}

export function advanceQuestionEvidence(input: {
  prev?: QuestionMasteryEvidence;
  question: QuestionItem;
  evidenceRevision: string;
  allPartsClean: boolean;
  assisted?: boolean;
  isSandbox?: boolean;
  submittedAtIso: string;
  policy?: MasteryPolicyConfig;
}): QuestionMasteryEvidence {
  const {
    prev,
    question,
    evidenceRevision,
    allPartsClean,
    assisted = false,
    isSandbox = false,
    submittedAtIso,
    policy = DEFAULT_MASTERY_POLICY,
  } = input;

  if (isSandbox) {
    throw new Error('Sandbox submissions must never mutate certified mastery evidence.');
  }

  const evidenceKey = buildEvidenceKey(question.questionFamilyId, evidenceRevision);
  const submittedMs = Date.parse(submittedAtIso);
  const base: QuestionMasteryEvidence = prev
    ? { ...prev, passTimestampsIso: [...prev.passTimestampsIso] }
    : {
        evidenceKey,
        questionFamilyId: question.questionFamilyId,
        questionId: question.questionId,
        evidenceRevision,
        section: question.section,
        status: 'unseen',
        cleanPassesCount: 0,
        passTimestampsIso: [],
        everCleanPassed: false,
        firstSubmissionCleanPass: false,
        attemptsCount: 0,
        resetCount: 0,
        lastAllCorrect: false,
        policyVersion: policy.policyVersion,
        updatedAtIso: submittedAtIso,
      };

  base.questionId = question.questionId;
  base.evidenceRevision = evidenceRevision;
  base.policyVersion = policy.policyVersion;
  base.attemptsCount += 1;
  base.lastAttemptAtIso = submittedAtIso;
  base.updatedAtIso = submittedAtIso;

  // Failed or unanswered submission resets only this revision's active certification, preserving history.
  if (!allPartsClean) {
    base.lastAllCorrect = false;
    if (policy.resetOnFailure) {
      if (base.cleanPassesCount > 0 || base.attemptsCount > 1 || base.status !== 'unseen') {
        base.resetCount += 1;
      }
      base.cleanPassesCount = 0;
      base.passTimestampsIso = [];
      base.nextEligibleAtIso = undefined;
      base.status = 'needs_repair';
    }
    return base;
  }

  base.lastAllCorrect = true;

  // Hints or external assistance disqualify this submission from advancing mastery certification
  if (policy.disqualifyOnAssistance && assisted) {
    return base;
  }

  if (base.attemptsCount === 1) {
    base.firstSubmissionCleanPass = true;
  }
  base.everCleanPassed = true;

  const stage2Ms = policy.stage2MinDelayHours * 3_600_000;
  const stage3Ms = policy.stage3MinDelayHours * 3_600_000;
  const passes = base.passTimestampsIso;

  if (passes.length === 0) {
    base.passTimestampsIso = [submittedAtIso];
    base.cleanPassesCount = 1;
    base.status = 'correct_once';
    base.nextEligibleAtIso = new Date(submittedMs + stage2Ms).toISOString();
  } else if (passes.length === 1) {
    const firstMs = Date.parse(passes[0]);
    if (submittedMs - firstMs >= stage2Ms) {
      base.passTimestampsIso = [passes[0], submittedAtIso];
      base.cleanPassesCount = 2;
      base.status = 'awaiting_review';
      base.nextEligibleAtIso = new Date(submittedMs + stage3Ms).toISOString();
    } else {
      base.status = 'correct_once';
      base.nextEligibleAtIso = new Date(firstMs + stage2Ms).toISOString();
    }
  } else if (passes.length === 2) {
    const secondMs = Date.parse(passes[1]);
    if (submittedMs - secondMs >= stage3Ms) {
      base.passTimestampsIso = [passes[0], passes[1], submittedAtIso];
      base.cleanPassesCount = 3;
      base.status = 'retained';
      base.nextEligibleAtIso = undefined;
    } else {
      base.status = 'awaiting_review';
      base.nextEligibleAtIso = new Date(secondMs + stage3Ms).toISOString();
    }
  } else {
    base.cleanPassesCount = 3;
    base.status = 'retained';
    base.nextEligibleAtIso = undefined;
  }

  return base;
}

export function computeBankMasterySummary(input: {
  questions: QuestionItem[];
  stimuliById?: Record<string, StimulusGroup>;
  evidenceMap: Record<string, QuestionMasteryEvidence>;
  legacyAttemptsCount?: number;
  holdoutAttempts?: PartAttemptRecord[];
  writingSubmissionsCount?: number;
  writingEvaluatedCount?: number;
  policyVersion?: string;
}): BankMasterySummary {
  const {
    questions,
    stimuliById = {},
    evidenceMap,
    legacyAttemptsCount = 0,
    holdoutAttempts = [],
    writingSubmissionsCount = 0,
    writingEvaluatedCount = 0,
    policyVersion = DEFAULT_MASTERY_POLICY.policyVersion,
  } = input;

  let excludedHoldoutCount = 0;
  let excludedWritingCount = 0;
  let excludedInactiveCount = 0;

  const makeEmptySec = (): SectionMasteryBreakdown => ({
    eligible: 0,
    unseen: 0,
    correctOnce: 0,
    awaitingReview: 0,
    retained: 0,
    needsRepair: 0,
    correctOnceOrMoreCount: 0,
    retainedPercentDisplay: 'No evidence',
    correctOncePercentDisplay: 'No evidence',
  });

  const bySection: Record<SectionCode, SectionMasteryBreakdown> = {
    READ: makeEmptySec(),
    MATH: makeEmptySec(),
    THINK: makeEmptySec(),
    WRIT: makeEmptySec(),
  };

  let unseenCount = 0;
  let correctOnceCount = 0;
  let awaitingReviewCount = 0;
  let retainedCount = 0;
  let needsRepairCount = 0;
  let correctOnceOrMoreCount = 0;
  let firstPassCleanCount = 0;
  let eligibleCount = 0;

  for (const q of questions) {
    if (q.qcStatus !== 'active') {
      excludedInactiveCount++;
      continue;
    }
    if (q.poolType === 'benchmark_holdout' || q.poolType === 'official_calibration') {
      excludedHoldoutCount++;
      continue;
    }
    if (q.formatType === 'WRIT_TYPED_TASK') {
      excludedWritingCount++;
      continue;
    }

    eligibleCount++;
    const sec = bySection[q.section];
    sec.eligible++;

    const stim = q.stimulusId ? stimuliById[q.stimulusId] : undefined;
    const rev = q.evidenceRevision || computeEvidenceRevision(q, stim);
    const key = buildEvidenceKey(q.questionFamilyId, rev);
    const ev = evidenceMap[key];

    if (!ev || ev.status === 'unseen') {
      unseenCount++;
      sec.unseen++;
    } else if (ev.status === 'correct_once') {
      correctOnceCount++;
      correctOnceOrMoreCount++;
      sec.correctOnce++;
      sec.correctOnceOrMoreCount++;
    } else if (ev.status === 'awaiting_review') {
      awaitingReviewCount++;
      correctOnceOrMoreCount++;
      sec.awaitingReview++;
      sec.correctOnceOrMoreCount++;
    } else if (ev.status === 'retained') {
      retainedCount++;
      correctOnceOrMoreCount++;
      sec.retained++;
      sec.correctOnceOrMoreCount++;
    } else if (ev.status === 'needs_repair') {
      needsRepairCount++;
      sec.needsRepair++;
    }

    if (ev?.firstSubmissionCleanPass) {
      firstPassCleanCount++;
    }
  }

  for (const secCode of ['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]) {
    const s = bySection[secCode];
    s.retainedPercentDisplay = formatMasteryPercent(s.retained, s.eligible);
    s.correctOncePercentDisplay = formatMasteryPercent(s.correctOnceOrMoreCount, s.eligible);
  }

  const holdoutAttemptedQs = new Set(holdoutAttempts.map((a) => a.questionId)).size;
  const holdoutCorrect = holdoutAttempts.filter((a) => a.isCorrect).length;

  return {
    policyVersion,
    eligibleCount,
    excludedHoldoutCount,
    excludedWritingCount,
    excludedInactiveCount,
    unseenCount,
    correctOnceCount,
    awaitingReviewCount,
    retainedCount,
    needsRepairCount,
    correctOnceOrMoreCount,
    firstPassCleanCount,
    retainedPercentDisplay: formatMasteryPercent(retainedCount, eligibleCount),
    correctOncePercentDisplay: formatMasteryPercent(correctOnceOrMoreCount, eligibleCount),
    firstPassPercentDisplay: formatMasteryPercent(firstPassCleanCount, eligibleCount),
    legacyAttemptsCount,
    bySection,
    holdoutSummary: {
      totalQuestions: excludedHoldoutCount,
      attemptedQuestions: holdoutAttemptedQs,
      latestCorrectSlots: holdoutCorrect,
      latestTotalSlots: holdoutAttempts.length,
      accuracyDisplay: formatMasteryPercent(holdoutCorrect, holdoutAttempts.length),
    },
    writingSummary: {
      totalPrompts: excludedWritingCount,
      submissionsCount: writingSubmissionsCount,
      evaluatedCount: writingEvaluatedCount,
    },
  };
}
