import type { SessionDetailResponse } from '../../api';
import type { WritingBandLetter, WritingEvaluationRecord } from '../../../shared/contracts';

export type WritingReviewEntry = NonNullable<SessionDetailResponse['writingReview']>[number];
export type WritingViewMode = 'critique' | 'exemplar' | 'prompt';
export type AnnotationFilter = 'all' | 'strength' | 'fix';

export function legacyEstimateToBand(est: WritingEvaluationRecord['overallBandEstimate']): WritingBandLetter {
  if (est === 'top_band') return 'A';
  if (est === 'strong') return 'B';
  if (est === 'solid') return 'C';
  return 'D';
}

export function scoreToBand(score: number, maxMarks = 3): WritingBandLetter {
  const s = Math.round(score);
  if (maxMarks <= 0 || s <= 0) return 'E';
  const ratio = s / maxMarks;
  if (ratio >= 0.9) return 'A';
  if (ratio >= 0.65) return 'B';
  if (ratio >= 0.45) return 'C';
  if (ratio >= 0.25) return 'D';
  return 'E';
}

export function bandBadgeClass(band: WritingBandLetter): string {
  if (band === 'A') return 'bg-[#E5F3EC] text-[#1D6346] border-[#1D6346]/30';
  if (band === 'B') return 'bg-[#E5F0EA] text-[#113C36] border-[#113C36]/25';
  if (band === 'C') return 'bg-[#F3EFE8] text-[#113C36] border-[#CFC6B9]';
  if (band === 'D') return 'bg-[#FDF0E2] text-[#A35116] border-[#A35116]/30';
  return 'bg-[#FDECEB] text-[#B42318] border-[#B42318]/30';
}

export function scrollAttrIntoView(attrName: string, id: string): void {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const el = document.querySelector(`[${attrName}="${CSS.escape(id)}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}
