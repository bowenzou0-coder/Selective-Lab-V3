import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { Award, BookOpen, Download, PenTool, ShieldCheck } from 'lucide-react';
import { api, type ProgressResponse } from '../api';
import { OFFICIAL_SECTION_MAX_MARKS } from '../../shared/nswBenchmark';
import { NswBenchmarkEstimator } from './NswBenchmarkEstimator';
import {
  WRITING_MAX_TOTAL_MARKS,
  type SectionCode,
  type WritingBandLetter,
  type WritingEvaluationRecord,
} from '../../shared/contracts';

function legacyEstimateToBand(est: WritingEvaluationRecord['overallBandEstimate']): WritingBandLetter {
  if (est === 'top_band') return 'A';
  if (est === 'strong') return 'B';
  if (est === 'solid') return 'C';
  return 'D';
}

interface ProgressViewProps {
  onOpenSession: (sessionId: string) => void;
}

export function ProgressView({ onOpenSession }: ProgressViewProps) {
  const { t, sectionLabel, sectionShortLabel, skillName, familyLabel, formatDate } = useI18n();
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sectionFilter, setSectionFilter] = useState<'ALL' | SectionCode>('ALL');
  const [onlyPracticed, setOnlyPracticed] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getProgress()
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Unable to load progress.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const filteredSkills = useMemo(() => {
    if (!data) return [];
    return data.skills.filter((s) => {
      if (sectionFilter !== 'ALL' && s.section !== sectionFilter) return false;
      if (onlyPracticed && (!s.state || s.state.attemptsCount === 0)) return false;
      return true;
    });
  }, [data, sectionFilter, onlyPracticed]);

  const groupedByFamily = useMemo(() => {
    const map = new Map<string, typeof filteredSkills>();
    for (const sk of filteredSkills) {
      const arr = map.get(sk.familyCode) || [];
      arr.push(sk);
      map.set(sk.familyCode, arr);
    }
    return Array.from(map.entries());
  }, [filteredSkills]);

  const benchmarkSeed = useMemo(() => {
    if (!data) return null;
    const projectSection = (sec: 'READ' | 'MATH' | 'THINK') => {
      const st = data.sectionStats[sec];
      const maxScore = OFFICIAL_SECTION_MAX_MARKS[sec];
      if (st.attempts > 0) {
        return {
          score: Math.round((st.correct / st.attempts) * maxScore),
          maxScore,
          source: 'actual' as const,
        };
      }
      return { score: Math.round(maxScore * 0.78), maxScore, source: 'assumed' as const };
    };
    const readP = projectSection('READ');
    const mathP = projectSection('MATH');
    const thinkP = projectSection('THINK');
    const latestGradedWriting = data.writingSubmissions.find((w) => w.evaluations.length > 0)?.evaluations[0];
    const writMax = latestGradedWriting?.maxTotalMarks ?? OFFICIAL_SECTION_MAX_MARKS.WRIT;
    const writScore = latestGradedWriting
      ? latestGradedWriting.totalMarks ??
        latestGradedWriting.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0)
      : 15;
    const writSource = latestGradedWriting ? ('actual' as const) : ('assumed' as const);
    const actualCount = [readP.source, mathP.source, thinkP.source, writSource].filter(
      (s) => s === 'actual'
    ).length;
    return {
      scores: {
        read: { score: readP.score, maxScore: readP.maxScore },
        math: { score: mathP.score, maxScore: mathP.maxScore },
        think: { score: thinkP.score, maxScore: thinkP.maxScore },
        writ: { score: Math.min(writMax, Math.max(0, Math.round(writScore))), maxScore: writMax },
      },
      sectionSources: {
        READ: readP.source,
        MATH: mathP.source,
        THINK: thinkP.source,
        WRIT: writSource,
      },
      actualCount,
    };
  }, [data]);

  if (loading) {
    return (
      <main className="px-6 sm:px-9 py-12 max-w-[1160px] mx-auto text-sm text-[#4A5955]">
        {t('prog.loading')}
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="px-6 sm:px-9 py-12 max-w-[1160px] mx-auto">
        <p role="alert" className="p-4 rounded-[12px] bg-[#FDECEB] text-[#B42318] text-sm">
          {error || t('prog.noData')}
        </p>
      </main>
    );
  }

  const ms = data.masterySummary;

  return (
    <main className="px-6 sm:px-9 py-8 sm:py-9 space-y-10 max-w-[1160px] mx-auto text-[#113C36]">
      <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-sans-display font-semibold text-[28px] sm:text-[32px] tracking-[-0.025em] text-[#113C36] leading-tight">
            {t('prog.title')}
          </h1>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#4A5955] tabular-nums">
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.totalAttempts} {data.totalAttempts === 1 ? t('prog.attemptOne') : t('prog.attemptMany')}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.sessions.length} {data.sessions.length === 1 ? t('prog.sessionOne') : t('prog.sessionMany')}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.writingSubmissions.length}{' '}
              {data.writingSubmissions.length === 1 ? t('prog.writingOne') : t('prog.writingMany')}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/api/student/export?format=csv"
            onClick={(e) => {
              e.preventDefault();
              api.downloadFile('/api/student/export?format=csv', 'selective-lab-progress.csv');
            }}
            className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span>{t('prog.exportCsv')}</span>
          </a>
          <a
            href="/api/student/export?format=json"
            onClick={(e) => {
              e.preventDefault();
              api.downloadFile('/api/student/export?format=json', 'selective-lab-progress.json');
            }}
            className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span>{t('prog.exportJson')}</span>
          </a>
        </div>
      </header>

      {/* Bank-Wide Retained Mastery Dashboard */}
      {ms && (
        <section className="p-6 sm:p-7 rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
                <Award className="w-4 h-4 shrink-0" />
                <span>{t('prog.trackerBadge')}</span>
              </div>
              <h2 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36]">
                {t('prog.bankMasteryTitle')}
              </h2>
              <p className="text-[13px] text-[#4A5955] max-w-2xl leading-relaxed">
                {t('prog.bankMasteryDesc')}
              </p>
            </div>
            <div className="text-xs text-[#4A5955] bg-white px-4 py-2.5 rounded-[12px] border border-[#E5DFD5] tabular-nums shrink-0 space-y-1">
              <div>
                {t('prog.eligibleBankPrefix')} <strong className="text-[#113C36]">{ms.eligibleCount}</strong>{' '}
                {t('prog.eligibleBankSuffix')}
              </div>
              <div className="text-[11px] text-[#78756E]">
                {ms.excludedHoldoutCount > 0
                  ? t('prog.separateMeta', {
                      holdout: ms.excludedHoldoutCount,
                      writing: ms.excludedWritingCount,
                      inactive: ms.excludedInactiveCount,
                    })
                  : t('prog.separateMetaNoHoldout', {
                      writing: ms.excludedWritingCount,
                      inactive: ms.excludedInactiveCount,
                    })}
              </div>
            </div>
          </div>

          {/* Headline Mastery Percentages */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-5 rounded-[14px] border border-[#D4E4DC] bg-[#E5F0EA] space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#1D6346]">
                {t('prog.retainedMastery')}
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.retainedPercentDisplay}
              </div>
              <div className="text-xs text-[#4A5955] tabular-nums pt-0.5">
                {t('prog.masteredCountSub', { retained: ms.retainedCount, eligible: ms.eligibleCount })}
              </div>
            </div>

            <div className="p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {t('prog.cleanOnce')}
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.correctOncePercentDisplay}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {t('prog.cleanOnceSub', { count: ms.correctOnceOrMoreCount, eligible: ms.eligibleCount })}
              </div>
            </div>

            <div className="p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {t('prog.firstPassAcc')}
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.firstPassPercentDisplay}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {t('prog.firstPassSub', { count: ms.firstPassCleanCount, eligible: ms.eligibleCount })}
              </div>
            </div>
          </div>

          {/* 5 Explicit Mutually Exclusive Buckets */}
          <div className="space-y-2.5">
            <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
              {t('prog.breakdownTitle', { count: ms.eligibleCount })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 tabular-nums">
              {[
                { label: t('prog.bucketUnseen'), count: ms.unseenCount, cls: 'bg-white border-[#E5DFD5] text-[#113C36]' },
                { label: t('prog.bucketStage1'), count: ms.correctOnceCount, cls: 'bg-[#F3EFE8] border-[#E5DFD5] text-[#113C36]' },
                { label: t('prog.bucketStage2'), count: ms.awaitingReviewCount, cls: 'bg-[#EEF5F7] border-[#CDE0E7] text-[#113C36]' },
                { label: t('prog.bucketRetained'), count: ms.retainedCount, cls: 'bg-[#E5F3EC] border-[#1D6346]/30 text-[#1D6346]' },
                { label: t('prog.bucketRepair'), count: ms.needsRepairCount, cls: 'bg-[#FDF0E2] border-[#A35116]/30 text-[#A35116]' },
              ].map((b) => (
                <div key={b.label} className={`p-3.5 rounded-[12px] border min-w-0 ${b.cls}`}>
                  <div className="text-[11px] font-medium leading-tight opacity-90 break-words">{b.label}</div>
                  <div className="font-serif-display font-extrabold text-[24px] leading-none mt-2">{b.count}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-Section Breakdown Table */}
          <div className="overflow-x-auto border border-[#E5DFD5] rounded-[12px] bg-white">
            <table className="w-full text-xs text-left tabular-nums">
              <thead className="bg-[#F3EFE8]/70 border-b border-[#E5DFD5] text-[#4A5955]">
                <tr>
                  <th className="px-4 py-3 font-sans-display font-semibold">{t('prog.colSection')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colEligible')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colRetained')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colCleanOnce')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colUnseen')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colStage1')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colStage2')}</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">{t('prog.colRepair')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5DFD5]">
                {(['READ', 'MATH', 'THINK'] as SectionCode[]).map((sec) => {
                  const s = ms.bySection[sec];
                  return (
                    <tr key={sec}>
                      <td className="px-4 py-3 font-sans-display font-semibold text-[#113C36]">
                        {sectionLabel(sec)}
                      </td>
                      <td className="px-3.5 py-3">{s.eligible}</td>
                      <td className="px-3.5 py-3 font-semibold text-[#1D6346]">
                        {s.retainedPercentDisplay} ({s.retained})
                      </td>
                      <td className="px-3.5 py-3">{s.correctOncePercentDisplay}</td>
                      <td className="px-3.5 py-3">{s.unseen}</td>
                      <td className="px-3.5 py-3">{s.correctOnce}</td>
                      <td className="px-3.5 py-3">{s.awaitingReview}</td>
                      <td className="px-3.5 py-3 text-[#A35116] font-medium">{s.needsRepair}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Separate Excluded Benchmark / Writing / Legacy Cards */}
          <div
            className={`grid grid-cols-1 ${
              ms.excludedHoldoutCount > 0 || ms.holdoutSummary.attemptedQuestions > 0
                ? 'md:grid-cols-3'
                : 'md:grid-cols-2'
            } gap-4 pt-1`}
          >
            {(ms.excludedHoldoutCount > 0 || ms.holdoutSummary.attemptedQuestions > 0) && (
              <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#1D6346] shrink-0" />
                  <span>{t('prog.pt3BenchmarkTitle')}</span>
                </div>
                <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                  {ms.holdoutSummary.accuracyDisplay}
                </div>
                <div className="text-xs text-[#78756E] tabular-nums">
                  {t('prog.pt3BenchmarkSub', {
                    attempted: ms.holdoutSummary.attemptedQuestions,
                    total: ms.holdoutSummary.totalQuestions,
                  })}
                </div>
              </div>
            )}

            <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                <PenTool className="w-3.5 h-3.5 text-[#113C36] shrink-0" />
                <span>{t('prog.writingProgressTitle')}</span>
              </div>
              <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                {t('prog.writingSubmittedCount', { count: ms.writingSummary.submissionsCount })}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums">
                {t('prog.writingMarkedSub', {
                  evaluated: ms.writingSummary.evaluatedCount,
                  prompts: ms.writingSummary.totalPrompts,
                })}
              </div>
            </div>

            <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                <BookOpen className="w-3.5 h-3.5 text-[#4A5955] shrink-0" />
                <span>{t('prog.archiveTitle')}</span>
              </div>
              <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                {t('prog.archivedAttemptsCount', { count: ms.legacyAttemptsCount })}
              </div>
              <div className="text-xs text-[#78756E]">
                {t('prog.archiveSub')}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* NSW Selective School Benchmark & Cutoff Estimator */}
      {benchmarkSeed && (
        <NswBenchmarkEstimator
          initialScores={benchmarkSeed.scores}
          sectionSources={benchmarkSeed.sectionSources}
          initialDifficulty="selective_lab_timed"
          sourceNote={
            benchmarkSeed.actualCount === 4
              ? t('bench.seededFromProgress')
              : benchmarkSeed.actualCount > 0
                ? t('bench.seededPartial', { count: benchmarkSeed.actualCount })
                : t('bench.seededDefault')
          }
        />
      )}

      {/* Section Accuracy & Pace vs Target */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {(['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[]).map((sec) => {
          const st = data.sectionStats[sec];
          const acc = st.attempts > 0 ? Math.round((st.correct / st.attempts) * 100) : null;
          return (
            <div
              key={sec}
              className="p-5 rounded-[14px] bg-white border border-[#E5DFD5] space-y-2"
            >
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {sectionLabel(sec)}
              </div>
              <div className="font-serif-display font-extrabold text-[30px] leading-none text-[#113C36] tabular-nums">
                {acc !== null ? `${acc}%` : '—'}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {t('prog.sectionAttemptsSub', {
                  attempts: st.attempts,
                  avg: st.avgTimeSec,
                  target: st.targetTimeSec,
                })}
              </div>
            </div>
          );
        })}
      </section>

      {/* Skill Readiness by Topic (Deep Pine progress bars, plain student language) */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-sans-display font-semibold text-[19px] tracking-[-0.015em] text-[#113C36]">
              {t('prog.skillReadinessTitle')}
            </h2>
            <p className="text-xs text-[#4A5955] mt-0.5">
              {t('prog.skillReadinessDesc')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#F3EFE8] rounded-[10px]">
              {(['ALL', 'READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSectionFilter(sec)}
                  className={`px-3 py-1 text-xs font-sans-display font-semibold rounded-[8px] cursor-pointer transition-colors whitespace-nowrap ${
                    sectionFilter === sec
                      ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.06)]'
                      : 'text-[#4A5955] hover:text-[#113C36]'
                  }`}
                >
                  {sec === 'ALL' ? t('prog.allFilter') : sectionShortLabel(sec)}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={onlyPracticed}
                onChange={(e) => setOnlyPracticed(e.target.checked)}
                className="accent-[#113C36]"
              />
              <span>{t('prog.practicedOnly')}</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groupedByFamily.map(([family, skills]) => (
            <div
              key={family}
              className="p-5 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-3"
            >
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                {familyLabel(family)}
              </div>
              <div className="space-y-3">
                {skills.map((sk) => {
                  const pct = sk.state ? Math.round(sk.state.masteryScore * 100) : null;
                  return (
                    <div key={sk.skillId} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-[#113C36] font-medium min-w-0 break-words">
                          {skillName(sk.skillId)}
                        </span>
                        <span className="tabular-nums text-[#4A5955] shrink-0 whitespace-nowrap">
                          {pct !== null
                            ? `${pct}% (${sk.state!.correctCount}/${sk.state!.attemptsCount})`
                            : t('prog.notTried')}
                          {sk.state?.plateauStatus && sk.state.plateauStatus !== 'none'
                            ? ` (${sk.state.plateauStatus})`
                            : ''}
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-[#E5DFD5]/80 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#113C36] transition-[width] duration-500 ease-out"
                          style={{ width: `${pct ?? 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Writing Archive */}
      <section className="space-y-3">
        <h2 className="font-sans-display font-semibold text-[19px] tracking-[-0.015em] text-[#113C36]">
          {t('prog.writingArchiveTitle')}
        </h2>
        {data.writingSubmissions.length === 0 ? (
          <p className="text-sm text-[#4A5955] p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5]">
            {t('prog.noWritingYet')}
          </p>
        ) : (
          <div className="space-y-3">
            {data.writingSubmissions.map((sub) => {
              const latestEval = sub.evaluations[0];
              const evalBand = latestEval
                ? latestEval.overallBand ?? legacyEstimateToBand(latestEval.overallBandEstimate)
                : null;
              const evalMarks = latestEval
                ? latestEval.totalMarks ?? latestEval.criteriaScores.reduce((sum, c) => sum + Math.round(c.score), 0)
                : null;
              const evalMax = latestEval
                ? latestEval.maxTotalMarks ?? WRITING_MAX_TOTAL_MARKS
                : null;
              return (
                <div
                  key={sub.submissionId}
                  className="p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5] space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955] tabular-nums">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{formatDate(sub.submittedAt, true)}</span>
                      <span className="px-2 py-0.5 rounded-full bg-white border border-[#E5DFD5]">
                        {t('rev.wordsCount', { count: sub.wordCount })}
                      </span>
                      {latestEval && evalBand ? (
                        <span className="px-2.5 py-0.5 rounded-full bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold">
                          {t('rev.bandWithLetter', { band: evalBand })} ({evalMarks}/{evalMax})
                          {latestEval.bandCappedByTopicAdherence ? t('prog.cappedBadge') : ''}
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#78756E] font-medium">
                          {t('prog.notYetGraded')}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenSession(sub.sessionId)}
                      className="px-3 py-1 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-[#113C36] font-sans-display font-semibold transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {t('prog.openReview')}
                    </button>
                  </div>
                  <p className="font-serif-text text-[15px] text-[#113C36] line-clamp-3 whitespace-pre-line leading-relaxed">
                    {sub.responseText}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Session History */}
      <section className="space-y-3">
        <h2 className="font-sans-display font-semibold text-[19px] tracking-[-0.015em] text-[#113C36]">
          {t('prog.sessionHistoryTitle')}
        </h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-[#4A5955] p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5]">
            {t('prog.noSessionsYet')}
          </p>
        ) : (
          <div className="border border-[#E5DFD5] rounded-[14px] bg-white overflow-x-auto">
            <table className="w-full text-sm text-left tabular-nums">
              <thead className="border-b border-[#E5DFD5] bg-[#FAF8F5] text-xs text-[#4A5955]">
                <tr>
                  <th className="px-4 py-3 font-sans-display font-semibold">{t('prog.colSession')}</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">{t('prog.colType')}</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">{t('prog.colScore')}</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">{t('prog.colDate')}</th>
                  <th className="px-4 py-3 font-sans-display font-semibold text-right">{t('prog.colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5DFD5]">
                {data.sessions.map((s) => (
                  <tr key={s.sessionId}>
                    <td className="px-4 py-3 font-sans-display font-medium text-[#113C36]">
                      {s.title || s.sessionId}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#4A5955] capitalize">
                      {s.mode.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-[#113C36]">
                      {s.status === 'submitted' ? `${s.correctSlots} / ${s.totalSlots}` : t('home.inProgress')}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#78756E]">
                      {formatDate(s.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenSession(s.sessionId)}
                        className="px-3 py-1 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer whitespace-nowrap"
                      >
                        {s.status === 'submitted' ? t('home.review') : t('home.resume')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
