import type {
  LearningConfig,
  PartAttemptRecord,
  QuestionFlagRecord,
  QuestionItem,
  QuestionMemoryState,
  SessionRecord,
  SkillState,
  StimulusGroup,
  VisualSpec,
  WritingEvaluationRecord,
} from '../shared/contracts';

/**
 * Legacy type definition preserved only for privileged `/api/admin/migrate/apply` CLI/Admin imports.
 * Browser-mediated Firestore syncing and `/api/sync/hydrate` are permanently retired in V3:
 * all reads, writes, grading, and mastery state are handled authoritatively on the Node server.
 */
export interface SyncHydratePayload {
  stimuli?: StimulusGroup[];
  questions?: QuestionItem[];
  questionOverrides?: { questionId: string; qcStatus: QuestionItem['qcStatus']; visual?: VisualSpec }[];
  configVersions?: {
    configVersionId: string;
    versionNumber: number;
    notes?: string;
    createdAt: string;
    config: LearningConfig;
  }[];
  sessions?: SessionRecord[];
  attempts?: PartAttemptRecord[];
  skillStates?: SkillState[];
  questionMemory?: QuestionMemoryState[];
  writingSubmissions?: {
    submissionId: string;
    studentId?: string;
    sessionId: string;
    questionId: string;
    planNotes: string;
    responseText: string;
    wordCount: number;
    timeSpentSec: number;
    deterministicMetricsJson: string;
    submittedAt: string;
    evaluations: WritingEvaluationRecord[];
  }[];
  flags?: QuestionFlagRecord[];
}
