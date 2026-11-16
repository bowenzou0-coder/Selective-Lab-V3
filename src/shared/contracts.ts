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
  lapseCount: number;
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

export interface WritingEvaluationRecord {
  evaluationId: string;
  submissionId: string;
  evaluatorType: 'ai' | 'admin';
  modelId?: string;
  topicAdherencePass: boolean;
  overallBandEstimate: 'developing' | 'solid' | 'strong' | 'top_band';
  criteriaScores: { criterionSkillId: string; score: number; evidenceQuote?: string; comment: string }[];
  topStrengths: string[];
  priorityFixes: string[];
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
  }[];
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
  checkpointRevision?: number;
  checkpoint?: SessionCheckpoint;
  timeLimitSec?: number;
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
  storageProvider: 'gcs' | 'local_temp';
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
};