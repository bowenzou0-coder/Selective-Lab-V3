// Admin studio deep links: `/admin?tab=<tab>&qid=<questionId>`.

export type StudioTab = 'bank' | 'learners' | 'adaptive' | 'batches' | 'data';

/** Accepts current tab ids plus the older aliases still found in bookmarks. */
export function parseStudioTab(raw: string | null | undefined): StudioTab {
  if (raw === 'bank' || raw === 'browser' || raw === 'calibration') return 'bank';
  if (raw === 'learners' || raw === 'students') return 'learners';
  if (raw === 'adaptive' || raw === 'config') return 'adaptive';
  if (raw === 'batches' || raw === 'importer') return 'batches';
  if (raw === 'data' || raw === 'backup') return 'data';
  return 'bank';
}

/** Tab and question from a query string. A `qid` always opens the bank, whatever `tab` says. */
export function readAdminDeepLink(search: string): { tab: StudioTab; qid: string } {
  const qs = new URLSearchParams(search);
  const qid = (qs.get('qid') || '').trim();
  return { tab: qid ? 'bank' : parseStudioTab(qs.get('tab')), qid };
}

/** Link that opens the Question Bank with one question selected in the inspector. */
export function buildBankQuestionHref(questionId: string): string {
  const qs = new URLSearchParams({ tab: 'bank', qid: questionId });
  return `/admin?${qs.toString()}`;
}
