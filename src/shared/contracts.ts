export type SectionCode = 'READ' | 'MATH' | 'THINK' | 'WRIT';

export type QuestionFormatType =
  | 'READ_FICTION_MCQ'
  | 'READ_VOCAB_CLOZE'
  | 'READ_POETRY_MCQ'
  | 'READ_GAPPED_TEXT'
  | 'READ_MULTIPLE_MATCH'
  | 'MATH_MCQ_5'
  | 'THINK_MCQ_4'
  | 'WRIT_TYPED_TASK';

export type PoolType = 'diagnostic' | 'practice' | 'benchmark_holdout' | 'official_calibration';
export type QcStatus = 'draft' | 'verified' | 'active' | 'quarantined' | 'retired';
export type CognitiveDemand = 'recall_locate' | 'apply_procedural' | 'analyze_infer' | 'evaluate_transfer';
export type SessionMode =
  | 'daily_adaptive'
  | 'section_drill'
  | 'diagnostic'
  | 'spaced_review'
  | 'benchmark_exam'
  | 'writing_sprint'
  | 'admin_calibration';
export type MockTestBatch = 'PT1' | 'PT2' | 'PT3';

export const MASTERY_POLICY_VERSION = 'v3_3stage_24h_7d';

export interface MasteryPolicyConfig {
  policyVersion: string;
  stage2MinDelayHours: number;
  stage3MinDelayHours: number;
  requireAllPartsClean: boolean;
  disqualifyOnAssistance: boolean;
  resetOnFailure: boolean;
}

export const DEFAULT_MASTERY_POLICY: MasteryPolicyConfig = {
  policyVersion: MASTERY_POLICY_VERSION,
  stage2MinDelayHours: 24,
  stage3MinDelayHours: 168,
  requireAllPartsClean: true,
  disqualifyOnAssistance: true,
  resetOnFailure: true,
};

export interface VisualSpec {
  visualType: 'none' | 'inline_svg' | 'image_asset' | 'structured_table';
  altText: string;
  svgMarkup?: string;
  imageUrl?: string;
  caption?: string;
  tableData?: { headers: string[]; rows: (string | number)[][]; caption?: string };
}

export interface EvidenceCitationRef {
  refId: string;
  stimulusRevision: number;
  targetKind: 'mainText' | 'extract';
  extractLabel?: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}

export interface StimulusExtract {
  label: string;
  title?: string;
  bodyMarkdown: string;
  isDecoy?: boolean; // Stripped on student delivery
}

export interface StimulusGroup {
  stimulusId: string;
  stimulusFamilyId: string;
  version: number;
  contentHash?: string;
  section: SectionCode;
  genreOrTextType: string;
  title?: string;
  preamble?: string;
  mainTextMarkdown?: string;
  extracts?: StimulusExtract[];
  visual?: VisualSpec;
  wordCount?: number;
  sourceType: 'official_doe' | 'ai_generated' | 'human_authored';
  batchId?: string;
  createdAtIso?: string;
  updatedAtIso?: string;
}

export interface AnswerOption {
  key: string;
  text: string;
  visual?: VisualSpec;
}

export interface QuestionPart {
  partId: string;
  partIndex: number;
  slotRef?: string;
  promptText: string;
  skillId: string;
  secondarySkillIds?: string[];
  difficultyInitial: number;
  difficultyCalibrated?: number;
  targetTimeSec: number;
  cognitiveDemand: CognitiveDemand;
  trapTags?: string[];
  options: AnswerOption[];
  // SERVER-ONLY / POST-SUBMISSION FIELDS — stripped before sending unsubmitted StudentQuestionView
  correctAnswerKey: string;
  workedExplanation: string;
  distractorRationales?: Record<string, string>;
  evidenceRefs?: EvidenceCitationRef[];
}

export interface WritingTaskSpec {
  genre: string;
  audience: string;
  purpose: string;
  bulletSuggestions?: string[];
  mandatoryOpeningLine?: string;
  recommendedWordRange: [number, number];
  timeLimitSec: number;
}

export interface QuestionItem {
  questionId: string;
  questionFamilyId: string;
  version: number;
  contentHash?: string;
  evidenceRevision?: string;
  section: SectionCode;
  formatType: QuestionFormatType;
  poolType: PoolType;
  qcStatus: QcStatus;
  stimulusId?: string;
  transferGroupId?: string;
  stemPrefix?: string;
  visual?: VisualSpec;
  sharedPoolConfig?: { reuseAllowed: boolean; poolKeys: string[] };
  parts: QuestionPart[];
  writingSpec?: WritingTaskSpec;
  batchId?: string;
  batchLabel?: string;
  createdAtIso?: string;
  updatedAtIso?: string;
  provenance: {
    sourceType: 'official_doe' | 'ai_generated' | 'human_authored';
    sourceReference?: string;
    verifierAgreed: boolean;
    auditorReviewed: boolean;
  };
}

export interface StudentQuestionView {
  questionId: string;
  section: SectionCode;
  formatType: QuestionFormatType;
  stemPrefix?: string;
  visual?: VisualSpec;
  sharedPoolConfig?: { reuseAllowed: boolean; poolKeys: string[] };
  writingSpec?: WritingTaskSpec;
  stimulus?: Omit<StimulusGroup, 'extracts'> & {
    extracts?: Omit<StimulusExtract, 'isDecoy'>[];
  };
  parts: Omit<
    QuestionPart,
    'correctAnswerKey' | 'workedExplanation' | 'distractorRationales' | 'evidenceRefs'
  >[];
}

export interface BankImportManifest {
  manifestVersion: '1.0';
  batchLabel: string;
  defaultPoolType: PoolType;
  defaultQcStatus: Extract<QcStatus, 'draft' | 'verified' | 'active'>;
  stimuli: StimulusGroup[];
  questions: QuestionItem[];
}

export interface ImportBatchRecord {
  batchId: string;
  batchLabel: string;
  createdAtIso: string;
  importedBy: string;
  stimuliCount: number;
  questionsCount: number;
  newQuestionIds: string[];
  versionBumpedQuestionIds: string[];
  skippedQuestionIds: string[];
}

export interface AutoCalibrateConfig {
  enabled: boolean;
  minDailyQuestions: number;
  maxDailyQuestions: number;
  includeWriting: boolean;
}

export interface PoolPolicyConfig {
  autoRetireMastered: boolean;
}

export const DEFAULT_AUTO_CALIBRATE: AutoCalibrateConfig = {
  enabled: true,
  minDailyQuestions: 6,
  maxDailyQuestions: 14,
  includeWriting: false,
};

export const DEFAULT_POOL_POLICY: PoolPolicyConfig = {
  autoRetireMastered: false,
};

export interface LearningConfig {
  sessionDefaults: {
    dailyQuestionLimitBySection: Record<SectionCode, number>;
    dailyGoalMinutes: number;
    sectionDrillQuestionCount: number;
    sectionDrillTimeMinutes: number;
  };
  sectionWeights: Record<SectionCode, number>;
  calibration: { targetSuccessRateRange: [number, number]; difficultyScaleMin: number; difficultyScaleMax: number };
  scheduling: {
    spacedReviewWeight: number;
    weakestSkillWeight: number;
    transferSiblingWeight: number;
    noveltyCoverageWeight: number;
    minRepeatCooldownHours: number;
    sm2InitialIntervalDays: number;
    sm2EaseFloor: number;
    lapseIntervalResetDays: number;
  };
  plateauDetection: {
    minAttemptsForEvaluation: number;
    windowSize: number;
    minGainThreshold: number;
    stagnantAccuracyCeiling: number;
    repeatTrapTriggerCount: number;
  };
  masteryPolicy?: MasteryPolicyConfig;
  autoCalibrate?: AutoCalibrateConfig;
  poolPolicy?: PoolPolicyConfig;
  primaryMonitoredStudentId?: string;
}

export interface LearnerAccountRecord {
  uid: string;
  role: 'student' | 'admin';
  displayName: string;
  email?: string;
  updatedAtIso?: string;
}

export interface AdminLearnerSummary extends LearnerAccountRecord {
  sessionsCount: number;
  attemptsCount: number;
  lastActiveAtIso?: string;
  unseenLiveCount: number;
  doneLiveCount: number;
  needsRepairLiveCount: number;
  inReviewLiveCount: number;
  unseenLivePercent: number;
  estimatedRunwayDays: number;
}

export interface SkillState {
  skillId: string;
  masteryScore: number; // Recent weighted scheduling score (NOT bank-wide mastery)
  uncertainty: number;
  attemptsCount: number;
  correctCount: number;
  ewmaAccuracy: number; // Recent accuracy estimate for scheduling
  avgTimeRatio: number;
  lastPracticedAt?: string;
  nextReviewAt?: string;
  reviewIntervalDays: number;
  easeFactor: number;
  plateauStatus: 'none' | 'watch' | 'detected';
}

export interface QuestionMemoryState {
  questionFamilyId: string;
  timesSeen: number;
  lastSeenAt: string;
  lastAllCorrect: boolean;
  nextDueAt: string;
  intervalDays: number;
  easeFactor?: number;
  lapseCount: number;
  lastEvidenceStatus?: MasteryCertificationStatus;
}

export interface AlgorithmAdjustments {
  spacedReviewWeightMultiplier?: number;
  weakestSkillWeightMultiplier?: number;
  noveltyCoverageWeightMultiplier?: number;
  zpdDifficultyOffset?: number;
}

export interface DailyFocusPlan {
  planDate: string;
  studentId: string;
  generatedAtIso: string;
  source: 'gemini' | 'deterministic';
  modelId?: string;
  focusSkillIds: string[];
  skillWeights: Record<string, number>;
  algorithmAdjustments?: AlgorithmAdjustments;
  recommendedSection?: Extract<SectionCode, 'READ' | 'MATH' | 'THINK'>;
  dailyQuestionLimitBySection?: Record<SectionCode, number>;
  dailyGoalMinutes?: number;
  autoCalibrated?: boolean;
  rationale: string;
}

export type MasteryCertificationStatus =
  | 'unseen'
  | 'correct_once'
  | 'awaiting_review'
  | 'retained'
  | 'needs_repair';

export interface QuestionMasteryEvidence {
  evidenceKey: string; // `${questionFamilyId}__${evidenceRevision}`
  questionFamilyId: string;
  questionId: string;
  evidenceRevision: string;
  section: SectionCode;
  status: MasteryCertificationStatus;
  cleanPassesCount: number;
  passTimestampsIso: string[];
  everCleanPassed: boolean;
  firstSubmissionCleanPass: boolean;
  attemptsCount: number;
  resetCount: number;
  lastAttemptAtIso?: string;
  lastAllCorrect: boolean;
  nextEligibleAtIso?: string;
  policyVersion: string;
  updatedAtIso: string;
}

export interface SectionMasteryBreakdown {
  eligible: number;
  unseen: number;
  correctOnce: number;
  awaitingReview: number;
  retained: number;
  needsRepair: number;
  correctOnceOrMoreCount: number;
  retainedPercentDisplay: string;
  correctOncePercentDisplay: string;
}

export interface BankMasterySummary {
  policyVersion: string;
  eligibleCount: number;
  excludedHoldoutCount: number;
  excludedWritingCount: number;
  excludedInactiveCount: number;
  unseenCount: number;
  correctOnceCount: number;
  awaitingReviewCount: number;
  retainedCount: number;
  needsRepairCount: number;
  correctOnceOrMoreCount: number;
  firstPassCleanCount: number;
  retainedPercentDisplay: string;
  correctOncePercentDisplay: string;
  firstPassPercentDisplay: string;
  legacyAttemptsCount: number;
  bySection: Record<SectionCode, SectionMasteryBreakdown>;
  holdoutSummary: {
    totalQuestions: number;
    attemptedQuestions: number;
    latestCorrectSlots: number;
    latestTotalSlots: number;
    accuracyDisplay: string;
  };
  writingSummary: {
    totalPrompts: number;
    submissionsCount: number;
    evaluatedCount: number;
  };
}

export interface WritingDeterministicMetrics {
  wordCount: number;
  paragraphCount: number;
  sentenceCount: number;
  avgWordsPerSentence: number;
  typeTokenRatio: number;
  matchedMandatoryStarter: boolean;
}

export type WritingBandLetter = 'A' | 'B' | 'C' | 'D' | 'E';

export const WRITING_CRITERION_MAX_MARKS = 4;
export const WRITING_MAX_TOTAL_MARKS = 20;

export const WRITING_CRITERION_MAX_MARKS_BY_SKILL: Record<string, number> = {
  'WRIT.CRIT.TOPIC_PROMPT_ADHERENCE': 4,
  'WRIT.CRIT.IDEAS_CREATIVITY': 4,
  'WRIT.CRIT.PURPOSE_AUDIENCE_VOICE': 3,
  'WRIT.CRIT.STRUCTURE_LAYOUT': 3,
  'WRIT.CRIT.STYLE_VOCABULARY': 3,
  'WRIT.CRIT.GRAMMAR_SPELLING_PUNCT': 3,
};

export function getWritingCriterionMaxMarks(skillId: string): number {
  return WRITING_CRITERION_MAX_MARKS_BY_SKILL[skillId] ?? 3;
}

export const WRITING_BAND_DESCRIPTORS: Record<
  WritingBandLetter,
  { label: string; minMarks: number; maxMarks: number }
> = {
  A: { label: 'Extensive — Top Selective Band', minMarks: 17, maxMarks: 20 },
  B: { label: 'Thorough — Strong', minMarks: 13, maxMarks: 16 },
  C: { label: 'Sound — Solid', minMarks: 9, maxMarks: 12 },
  D: { label: 'Basic — Developing', minMarks: 5, maxMarks: 8 },
  E: { label: 'Elementary — Emerging', minMarks: 0, maxMarks: 4 },
};

export interface WritingCriterionScore {
  criterionSkillId: string;
  score: number;
  maxMarks?: number;
  band?: WritingBandLetter;
  evidenceQuote?: string;
  comment: string;
}

export interface WritingTextAnnotation {
  id: string;
  kind: 'strength' | 'issue' | 'suggestion';
  quote: string;
  tag: string;
  comment: string;
  rewrite?: string;
  criterionSkillId?: string;
}

export interface WritingExemplarAnnotation {
  id: string;
  quote: string;
  tag: string;
  explanation: string;
}

export interface WritingExemplarResponse {
  title?: string;
  text: string;
  keyTakeaway?: string;
  annotations: WritingExemplarAnnotation[];
}

export interface WritingEvaluationRecord {
  evaluationId: string;
  submissionId: string;
  evaluatorType: 'ai' | 'admin';
  modelId?: string;
  topicAdherencePass: boolean;
  overallBandEstimate: 'developing' | 'solid' | 'strong' | 'top_band';
  overallBand?: WritingBandLetter;
  overallBandDescriptor?: string;
  overallVerdict?: string;
  totalMarks?: number;
  maxTotalMarks?: number;
  bandCappedByTopicAdherence?: boolean;
  criteriaScores: WritingCriterionScore[];
  topStrengths: string[];
  priorityFixes: string[];
  annotations?: WritingTextAnnotation[];
  exemplar?: WritingExemplarResponse;
  createdAt: string;
}

export interface MarkingResult {
  partId: string;
  isCorrect: boolean;
  selectedAnswer: string | null;
  correctAnswerKey: string;
  workedExplanation: string;
  distractorRationale?: string;
  evidenceRefs?: EvidenceCitationRef[];
}

export interface PartAttemptRecord {
  attemptId: string;
  studentId?: string;
  sessionId: string;
  questionId: string;
  questionFamilyId: string;
  questionVersion?: number;
  evidenceRevision?: string;
  partId: string;
  skillId: string;
  difficultyAtAttempt: number;
  selectedAnswer: string | null;
  isCorrect: boolean;
  timeSpentSec: number;
  isSpacedReview: boolean;
  isSandbox?: boolean;
  isLegacy?: boolean;
  assisted?: boolean;
  createdAt: string;
}

export interface SessionCheckpoint {
  currentIndex: number;
  elapsedSec: number;
  answersByPartId: Record<string, string | null>;
  flaggedQuestionIds: string[];
  eliminatedOptionsByPartId?: Record<string, string[]>;
  passageHighlightsByStimulusId?: Record<string, string[]>;
  writingDraft?: { planNotes: string; responseText: string };
  writingDraftsByQuestionId?: Record<string, { planNotes: string; responseText: string }>;
}

export interface BenchmarkReportSectionSnapshot {
  section: SectionCode;
  correct: number;
  total: number;
  unanswered: number;
  accuracyPct: number;
  band: 'top_10' | 'next_15' | 'next_25' | 'lowest_50';
  estimatedPercentile: number;
  isAssumed?: boolean;
}

export interface BenchmarkAiCoaching {
  source: 'hybrid_gemini' | 'deterministic';
  decisionModelId?: string;
  textModelId?: string;
  generatedAtIso: string;
  rankedPriorities: {
    skillId: string;
    section: SectionCode;
    label: string;
    reasonEn: string;
    reasonZh: string;
    severityScore: number;
  }[];
  parentSummaryEn: string;
  parentSummaryZh: string;
  actionPlanEn: string[];
  actionPlanZh: string[];
}

export interface BenchmarkReportRecord {
  reportId: string;
  sessionId: string;
  studentId: string;
  batchLabel: string;
  title: string;
  completedAtIso: string;
  elapsedSec: number;
  timeLimitSec: number;
  difficulty: 'official_sample' | 'real_exam' | 'selective_lab_timed' | 'selective_lab_hard';
  scaledScore120: number;
  uncertaintyHalfWidth120: number;
  estimatedPercentile: number;
  estimatedStateRank: number;
  estimatedApplicantPool: number;
  writingStatus: 'graded' | 'pending' | 'missing';
  writingSubmissionId?: string;
  sections: Record<SectionCode, BenchmarkReportSectionSnapshot>;
  weakSkillStats: {
    skillId: string;
    section: SectionCode;
    missed: number;
    total: number;
    unanswered: number;
  }[];
  aiCoaching?: BenchmarkAiCoaching;
}

export interface SessionQuestionSnapshot {
  questionId: string;
  snapshotIndex: number;
  evidenceRevision: string;
  question: QuestionItem;
  stimulus?: StimulusGroup;
}

export interface SessionSubmissionPayload {
  ok: true;
  correctSlots: number;
  totalSlots: number;
  completedAt: string;
  checkpoint: SessionCheckpoint;
  attempts: PartAttemptRecord[];
  skillStates: SkillState[];
  questionMemory: QuestionMemoryState[];
  evidenceUpdates?: QuestionMasteryEvidence[];
  writingSubmission?: {
    submissionId: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
    evaluations: WritingEvaluationRecord[];
  };
  reviewResults: Record<string, MarkingResult[]>;
  writingReview: {
    submissionId: string;
    questionId: string;
    metrics: WritingDeterministicMetrics;
    evaluations: WritingEvaluationRecord[];
    responseText?: string;
    planNotes?: string;
  }[];
}

export interface SessionSelectionDecision {
  source: 'gemini' | 'deterministic';
  modelId?: string;
  rationale: string;
  algorithmAdjustments?: AlgorithmAdjustments;
}

export interface SessionRecord {
  sessionId: string;
  studentId?: string;
  configVersionId: string;
  mode: SessionMode;
  sectionFilter?: SectionCode;
  title?: string;
  isSandbox?: boolean;
  mockBatch?: MockTestBatch;
  timeMultiplier?: number;
  status: 'in_progress' | 'submitted' | 'abandoned';
  plannedQuestionIds: string[];
  selectionDecision?: SessionSelectionDecision;
  checkpointRevision?: number;
  checkpoint?: SessionCheckpoint;
  timeLimitSec?: number;
  deadlineAt?: string;
  expiredAutoSubmitted?: boolean;
  totalSlots: number;
  correctSlots: number;
  startedAt: string;
  completedAt?: string;
  submissionSummary?: SessionSubmissionPayload;
}

export interface QuestionFlagRecord {
  flagId: string;
  questionId: string;
  sessionId: string;
  studentId?: string;
  reason: string;
  notes?: string;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface MediaAssetRecord {
  assetId: string;
  questionId?: string;
  objectKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageProvider: 'postgres' | 'gcs' | 'local_temp';
  bytesBase64?: string;
  createdAtIso: string;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  sessionDefaults: {
    dailyQuestionLimitBySection: { READ: 2, MATH: 3, THINK: 3, WRIT: 0 },
    dailyGoalMinutes: 25,
    sectionDrillQuestionCount: 10,
    sectionDrillTimeMinutes: 8,
  },
  sectionWeights: { READ: 0.25, MATH: 0.25, THINK: 0.25, WRIT: 0.25 },
  calibration: { targetSuccessRateRange: [0.65, 0.80], difficultyScaleMin: 1.0, difficultyScaleMax: 5.0 },
  scheduling: {
    spacedReviewWeight: 1.8,
    weakestSkillWeight: 1.4,
    transferSiblingWeight: 1.2,
    noveltyCoverageWeight: 1.0,
    minRepeatCooldownHours: 12,
    sm2InitialIntervalDays: 1,
    sm2EaseFloor: 1.3,
    lapseIntervalResetDays: 1,
  },
  plateauDetection: {
    minAttemptsForEvaluation: 8,
    windowSize: 6,
    minGainThreshold: 0.03,
    stagnantAccuracyCeiling: 0.70,
    repeatTrapTriggerCount: 3,
  },
  masteryPolicy: DEFAULT_MASTERY_POLICY,
  autoCalibrate: DEFAULT_AUTO_CALIBRATE,
  poolPolicy: DEFAULT_POOL_POLICY,
};