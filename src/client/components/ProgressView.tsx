import { useEffect, useMemo, useState } from 'react';
import { Award, BookOpen, Download, PenTool, ShieldCheck } from 'lucide-react';
import { api, type ProgressResponse } from '../api';
import {
  WRITING_CRITERION_MAX_MARKS,
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

const SECTION_LABELS: Record<SectionCode, string> = {
  READ: 'Reading',
  MATH: 'Mathematical Reasoning',
  THINK: 'Thinking Skills',
  WRIT: 'Writing',
};

export function ProgressView({ onOpenSession }: ProgressViewProps) {
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

  if (loading) {
    return (
      <main className="px-6 sm:px-9 py-12 max-w-[1160px] mx-auto text-sm text-[#4A5955]">
        Loading progress overview...
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="px-6 sm:px-9 py-12 max-w-[1160px] mx-auto">
        <p role="alert" className="p-4 rounded-[12px] bg-[#FDECEB] text-[#B42318] text-sm">
          {error || 'No progress data available yet.'}
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
            Progress and mastery
          </h1>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#4A5955] tabular-nums">
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.totalAttempts} {data.totalAttempts === 1 ? 'question attempt' : 'question attempts'}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.sessions.length} {data.sessions.length === 1 ? 'session completed' : 'sessions completed'}
            </span>
            <span className="px-2.5 py-1 rounded-full bg-[#F3EFE8] font-medium">
              {data.writingSubmissions.length} {data.writingSubmissions.length === 1 ? 'writing piece' : 'writing pieces'}
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
            className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </a>
          <a
            href="/api/student/export?format=json"
            onClick={(e) => {
              e.preventDefault();
              api.downloadFile('/api/student/export?format=json', 'selective-lab-progress.json');
            }}
            className="px-3.5 py-2 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] inline-flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </a>
        </div>
      </header>

      {/* Bank-Wide Retained Mastery Dashboard */}
      {ms && (
        <section className="p-6 sm:p-7 rounded-[16px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#1D6346]">
                <Award className="w-4 h-4" />
                <span>Retained mastery tracker</span>
              </div>
              <h2 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36]">
                Question bank mastery
              </h2>
              <p className="text-[13px] text-[#4A5955] max-w-2xl leading-relaxed">
                A question counts as mastered after three clean, unassisted passes spaced at least 24 hours and 7 days apart. Missing a question resets its streak so it returns for repair.
              </p>
            </div>
            <div className="text-xs text-[#4A5955] bg-white px-4 py-2.5 rounded-[12px] border border-[#E5DFD5] tabular-nums shrink-0 space-y-1">
              <div>
                Eligible bank: <strong className="text-[#113C36]">{ms.eligibleCount}</strong> active questions
              </div>
              <div className="text-[11px] text-[#78756E]">
                Separate: {ms.excludedHoldoutCount} PT3 benchmark, {ms.excludedWritingCount} writing, {ms.excludedInactiveCount} inactive
              </div>
            </div>
          </div>

          {/* Headline Mastery Percentages */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-5 rounded-[14px] border border-[#D4E4DC] bg-[#E5F0EA] space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#1D6346]">
                Retained mastery
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.retainedPercentDisplay}
              </div>
              <div className="text-xs text-[#4A5955] tabular-nums pt-0.5">
                {ms.retainedCount} of {ms.eligibleCount} questions mastered
              </div>
            </div>

            <div className="p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                Answered cleanly at least once
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.correctOncePercentDisplay}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {ms.correctOnceOrMoreCount} of {ms.eligibleCount} currently in a clean streak
              </div>
            </div>

            <div className="p-5 rounded-[14px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
                First-pass accuracy
              </div>
              <div className="font-serif-display font-extrabold text-[38px] leading-none tracking-[-0.03em] text-[#113C36] tabular-nums">
                {ms.firstPassPercentDisplay}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {ms.firstPassCleanCount} of {ms.eligibleCount} right on first try
              </div>
            </div>
          </div>

          {/* 5 Explicit Mutually Exclusive Buckets */}
          <div className="space-y-2.5">
            <div className="text-xs font-sans-display font-semibold text-[#4A5955]">
              Question status breakdown (all {ms.eligibleCount} active questions)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 tabular-nums">
              {[
                { label: 'Unseen', count: ms.unseenCount, cls: 'bg-white border-[#E5DFD5] text-[#113C36]' },
                { label: 'Correct once (Stage 1)', count: ms.correctOnceCount, cls: 'bg-[#F3EFE8] border-[#E5DFD5] text-[#113C36]' },
                { label: 'Ready for final check', count: ms.awaitingReviewCount, cls: 'bg-[#EEF5F7] border-[#CDE0E7] text-[#113C36]' },
                { label: 'Retained mastery', count: ms.retainedCount, cls: 'bg-[#E5F3EC] border-[#1D6346]/30 text-[#1D6346]' },
                { label: 'Needs repair', count: ms.needsRepairCount, cls: 'bg-[#FDF0E2] border-[#A35116]/30 text-[#A35116]' },
              ].map((b) => (
                <div key={b.label} className={`p-3.5 rounded-[12px] border ${b.cls}`}>
                  <div className="text-[11px] font-medium leading-tight opacity-90">{b.label}</div>
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
                  <th className="px-4 py-3 font-sans-display font-semibold">Section</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Eligible</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Retained</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Clean ≥1×</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Unseen</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Stage 1</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Stage 2</th>
                  <th className="px-3.5 py-3 font-sans-display font-semibold">Needs repair</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5DFD5]">
                {(['READ', 'MATH', 'THINK'] as SectionCode[]).map((sec) => {
                  const s = ms.bySection[sec];
                  return (
                    <tr key={sec}>
                      <td className="px-4 py-3 font-sans-display font-semibold text-[#113C36]">
                        {SECTION_LABELS[sec]}
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
            <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                <ShieldCheck className="w-3.5 h-3.5 text-[#1D6346]" />
                <span>Practice Test 3 benchmark</span>
              </div>
              <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                {ms.holdoutSummary.accuracyDisplay}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums">
                {ms.holdoutSummary.attemptedQuestions} of {ms.holdoutSummary.totalQuestions} benchmark questions completed
              </div>
            </div>

            <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                <PenTool className="w-3.5 h-3.5 text-[#113C36]" />
                <span>Writing rubric progress</span>
              </div>
              <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                {ms.writingSummary.submissionsCount} submitted
              </div>
              <div className="text-xs text-[#78756E] tabular-nums">
                {ms.writingSummary.evaluatedCount} marked across {ms.writingSummary.totalPrompts} active writing prompts
              </div>
            </div>

            <div className="p-4 rounded-[12px] border border-[#E5DFD5] bg-white space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-sans-display font-semibold text-[#113C36]">
                <BookOpen className="w-3.5 h-3.5 text-[#4A5955]" />
                <span>Earlier practice archive</span>
              </div>
              <div className="font-serif-display font-extrabold text-[22px] text-[#113C36] tabular-nums">
                {ms.legacyAttemptsCount} archived attempts
              </div>
              <div className="text-xs text-[#78756E]">
                Saved outside the current retained mastery tracker.
              </div>
            </div>
          </div>
        </section>
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
                {SECTION_LABELS[sec]}
              </div>
              <div className="font-serif-display font-extrabold text-[30px] leading-none text-[#113C36] tabular-nums">
                {acc !== null ? `${acc}%` : '—'}
              </div>
              <div className="text-xs text-[#78756E] tabular-nums pt-0.5">
                {st.attempts} attempts, avg {st.avgTimeSec}s vs {st.targetTimeSec}s target
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
              Skill readiness by topic
            </h2>
            <p className="text-xs text-[#4A5955] mt-0.5">
              Recent accuracy across each skill family so you can spot where to focus next.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 p-1 bg-[#F3EFE8] rounded-[10px]">
              {(['ALL', 'READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSectionFilter(sec)}
                  className={`px-3 py-1 text-xs font-sans-display font-semibold rounded-[8px] cursor-pointer transition-colors ${
                    sectionFilter === sec
                      ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.06)]'
                      : 'text-[#4A5955] hover:text-[#113C36]'
                  }`}
                >
                  {sec}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-[#4A5955] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyPracticed}
                onChange={(e) => setOnlyPracticed(e.target.checked)}
                className="accent-[#113C36]"
              />
              <span>Practiced only</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groupedByFamily.map(([family, skills]) => (
            <div
              key={family}
              className="p-5 rounded-[14px] bg-[#FAF8F5] border border-[#E5DFD5] space-y-3"
            >
              <div className="text-xs font-sans-display font-semibold text-[#4A5955]">{family}</div>
              <div className="space-y-3">
                {skills.map((sk) => {
                  const pct = sk.state ? Math.round(sk.state.masteryScore * 100) : null;
                  return (
                    <div key={sk.skillId} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-[#113C36] font-medium">{sk.displayName}</span>
                        <span className="tabular-nums text-[#4A5955] shrink-0">
                          {pct !== null
                            ? `${pct}% (${sk.state!.correctCount}/${sk.state!.attemptsCount})`
                            : 'Not yet tried'}
                          {sk.state?.plateauStatus && sk.state.plateauStatus !== 'none'
                            ? ` (${sk.state.plateauStatus})`
                            : ''}
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-[#E5DFD5]/80 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#113C36] transition-all"
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
          Writing archive
        </h2>
        {data.writingSubmissions.length === 0 ? (
          <p className="text-sm text-[#4A5955] p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5]">
            No writing submissions yet. Start a Writing sprint from the Dashboard to practise.
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
                ? latestEval.maxTotalMarks ?? latestEval.criteriaScores.length * WRITING_CRITERION_MAX_MARKS
                : null;
              return (
                <div
                  key={sub.submissionId}
                  className="p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5] space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4A5955] tabular-nums">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{new Date(sub.submittedAt).toLocaleString()}</span>
                      <span className="px-2 py-0.5 rounded-full bg-white border border-[#E5DFD5]">
                        {sub.wordCount} words
                      </span>
                      {latestEval && evalBand ? (
                        <span className="px-2.5 py-0.5 rounded-full bg-[#E5F0EA] text-[#113C36] font-sans-display font-semibold">
                          Band {evalBand} ({evalMarks}/{evalMax})
                          {latestEval.bandCappedByTopicAdherence ? ' — capped' : ''}
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-full bg-[#F3EFE8] text-[#78756E] font-medium">
                          Not yet graded
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenSession(sub.sessionId)}
                      className="px-3 py-1 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#113C36] hover:text-white hover:border-[#113C36] text-[#113C36] font-sans-display font-semibold transition-colors cursor-pointer"
                    >
                      Open review
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
          Session history
        </h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-[#4A5955] p-5 rounded-[14px] border border-[#E5DFD5] bg-[#FAF8F5]">
            No sessions recorded yet.
          </p>
        ) : (
          <div className="border border-[#E5DFD5] rounded-[14px] bg-white overflow-x-auto">
            <table className="w-full text-sm text-left tabular-nums">
              <thead className="border-b border-[#E5DFD5] bg-[#FAF8F5] text-xs text-[#4A5955]">
                <tr>
                  <th className="px-4 py-3 font-sans-display font-semibold">Session</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">Type</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">Score</th>
                  <th className="px-4 py-3 font-sans-display font-semibold">Date</th>
                  <th className="px-4 py-3 font-sans-display font-semibold text-right">Action</th>
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
                      {s.status === 'submitted' ? `${s.correctSlots} / ${s.totalSlots}` : 'In progress'}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#78756E]">
                      {new Date(s.startedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenSession(s.sessionId)}
                        className="px-3 py-1 rounded-[8px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-xs font-sans-display font-semibold text-[#113C36] cursor-pointer"
                      >
                        {s.status === 'submitted' ? 'Review' : 'Resume'}
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
