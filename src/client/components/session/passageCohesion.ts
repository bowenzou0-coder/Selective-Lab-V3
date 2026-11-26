// Reading passage cohesion: which passage a Reading question belongs to and where it sits
// inside that passage's run of questions.

export interface PassageCue {
  /** 1-based number of the distinct passage, in the order passages first appear. */
  passageNumber: number;
  /** 1-based position of the question inside its passage group. */
  position: number;
  /** Questions in the passage group. */
  total: number;
}

interface CohesionQuestion {
  questionId: string;
  section: string;
  stimulusId?: string;
  stimulus?: { stimulusId?: string };
}

function stimulusIdOf(q: CohesionQuestion): string | undefined {
  return q.stimulus?.stimulusId || q.stimulusId || undefined;
}

/**
 * Numbers distinct Reading passages in section order and gives each passage-linked question its
 * position. Only passages with two or more questions get a cue (a lone question needs none).
 */
export function buildPassageCues(questions: readonly CohesionQuestion[]): Map<string, PassageCue> {
  const groups = new Map<string, string[]>();
  const passageOrder: string[] = [];
  for (const q of questions) {
    if (q.section !== 'READ') continue;
    const stimId = stimulusIdOf(q);
    if (!stimId) continue;
    const ids = groups.get(stimId);
    if (ids) {
      ids.push(q.questionId);
    } else {
      groups.set(stimId, [q.questionId]);
      passageOrder.push(stimId);
    }
  }

  const cues = new Map<string, PassageCue>();
  passageOrder.forEach((stimId, idx) => {
    const ids = groups.get(stimId)!;
    if (ids.length < 2) return;
    ids.forEach((qid, pos) => {
      cues.set(qid, { passageNumber: idx + 1, position: pos + 1, total: ids.length });
    });
  });
  return cues;
}
