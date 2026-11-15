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
export type SessionMode = 'daily_adaptive' | 'section_drill' | 'diagnostic' | 'spaced_review' | 'benchmark_exam' | 'writing_sprint' | 'admin_calibration';
export type MockTestBatch = 'PT1' | 'PT2' | 'PT3';

export interface VisualSpec {
  visualType: 'none' | 'inline_svg' | 'image_asset' | 'structured_table';
  altText: string;
  svgMarkup?: string;
  imageUrl?: string;
  caption?: string;
  tableData?: { headers: string[]; rows: (string | number)[][]; caption?: string };
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
  // SERVER-ONLY FIELDS — stripped before sending StudentQuestionView
  correctAnswerKey: string;
  workedExplanation: string;
  distractorRationales?: Record<string, string>;
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
  parts: Omit<QuestionPart, 'correctAnswerKey' | 'workedExplanation' | 'distractorRationales'>[];
}

export interface BankImportManifest {
  manifestVersion: '1.0';
  batchLabel: string;
  defaultPoolType: PoolType;
  defaultQcStatus: Extract<QcStatus, 'draft' | 'verified' | 'active'>;
  stimuli: StimulusGroup[];
  questions: QuestionItem[];
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
}

export interface SkillState {
  skillId: string;
  masteryScore: number;
  uncertainty: number;
  attemptsCount: number;
  correctCount: number;
  ewmaAccuracy: number;
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
}

export interface PartAttemptRecord {
  attemptId: string;
  studentId?: string;
  sessionId: string;
  questionId: string;
  questionFamilyId: string;
  partId: string;
  skillId: string;
  difficultyAtAttempt: number;
  selectedAnswer: string | null;
  isCorrect: boolean;
  timeSpentSec: number;
  isSpacedReview: boolean;
  isSandbox?: boolean;
  createdAt: string;
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
  checkpoint?: {
    currentIndex: number;
    elapsedSec: number;
    answersByPartId: Record<string, string | null>;
    flaggedQuestionIds: string[];
    eliminatedOptionsByPartId?: Record<string, string[]>;
    passageHighlightsByStimulusId?: Record<string, string[]>;
    writingDraft?: { planNotes: string; responseText: string };
  };
  timeLimitSec?: number;
  totalSlots: number;
  correctSlots: number;
  startedAt: string;
  completedAt?: string;
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
    spacedReviewWeight: 1.8, weakestSkillWeight: 1.4, transferSiblingWeight: 1.2,
    noveltyCoverageWeight: 1.0, minRepeatCooldownHours: 12,
    sm2InitialIntervalDays: 1, sm2EaseFloor: 1.3, lapseIntervalResetDays: 1
  },
  plateauDetection: {
    minAttemptsForEvaluation: 8, windowSize: 6, minGainThreshold: 0.03,
    stagnantAccuracyCeiling: 0.70, repeatTrapTriggerCount: 3
  }
};