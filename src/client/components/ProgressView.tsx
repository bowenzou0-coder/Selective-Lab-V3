import { useEffect, useMemo, useState } from 'react';
import { Award, BookOpen, Download, PenTool, ShieldCheck } from 'lucide-react';
import { api, type ProgressResponse } from '../api';
import type { SectionCode } from '../../shared/contracts';

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
      <main className="max-w-6xl mx-auto px-6 py-12 text-sm text-[var(--text-secondary)]">
        Loading progress analytics...
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="max-w-6xl mx-auto px-6 py-12">
        <p role="alert" className="p-4 rounded-[var(--radius-md)] bg-[var(--status-error-bg)] text-[var(--status-error)] text-sm">
          {error || 'No data available.'}
        </p>
      </main>
    );
  }

  const ms = data.masterySummary;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 space-y-10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Progress &amp; Mastery</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1 tabular-nums">
            {data.totalAttempts} recorded part attempts · {data.sessions.length} sessions ·{' '}
            {data.writingSubmissions.length} writing pieces
          </p>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <a
            href="/api/student/export?format=csv"
            onClick={(e) => {
              e.preventDefault();
              api.downloadFile('/api/student/export?format=csv', 'selective-lab-progress.csv');
            }}
            className="px-3.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"
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
            className="px-3.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] text-xs font-semibold text-[var(--text-primary)] inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export JSON</span>
          </a>
        </div>
      </div>

      {/* Bank-Wide Retained Mastery Dashboard */}
      {ms && (
        <section className="p-6 rounded-[var(--radius-lg)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--accent-primary)]">
                <Award className="w-4 h-4" />
                <span>Certified Mastery Policy · {ms.policyVersion}</span>
              </div>
              <h2 className="text-xl font-bold text-[var(--text-primary)]">Bank-Wide Retained Mastery</h2>
              <p className="text-xs text-[var(--text-secondary)] max-w-2xl">
                Requires 3 clean, unassisted passes across spacing gates (Initial → ≥24 hours → ≥7 days). An incorrect, unanswered, or assisted attempt resets certification on that question revision.
              </p>
            </div>
            <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-surface)] px-3.5 py-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] tabular-nums shrink-0">
              Denominator: <strong className="text-[var(--text-primary)]">{ms.eligibleCount}</strong> active eligible questions
              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Excluded: {ms.excludedHoldoutCount} PT3 holdout · {ms.excludedWritingCount} writing · {ms.excludedInactiveCount} inactive
              </div>
            </div>
          </div>

          {/* Headline Mastery Percentages */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--status-success)]/40 bg-[var(--status-success-bg)]/50 space-y-1">
              <div className="text-xs font-semibold text-[var(--status-success)]">
                Retained Mastery (Certified)
              </div>
              <div className="text-3xl font-bold text-[var(--text-primary)] tabular-nums">
                {ms.retainedPercentDisplay}
              </div>
              <div className="text-xs text-[var(--text-secondary)] tabular-nums">
                {ms.retainedCount} / {ms.eligibleCount} eligible questions (3 spaced clean passes)
              </div>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-1">
              <div className="text-xs font-semibold text-[var(--text-secondary)]">
                Answered Cleanly ≥1×
              </div>
              <div className="text-3xl font-bold text-[var(--text-primary)] tabular-nums">
                {ms.correctOncePercentDisplay}
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                {ms.correctOnceOrMoreCount} / {ms.eligibleCount} active questions currently in pass streak
              </div>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-1">
              <div className="text-xs font-semibold text-[var(--text-secondary)]">
                First-Pass Clean Rate
              </div>
              <div className="text-3xl font-bold text-[var(--text-primary)] tabular-nums">
                {ms.firstPassPercentDisplay}
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                {ms.firstPassCleanCount} / {ms.eligibleCount} clean on initial encounter
              </div>
            </div>
          </div>

          {/* 5 Explicit Mutually Exclusive Buckets */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">
              Question Status Breakdown (Mutually Exclusive · Sums to {ms.eligibleCount})
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 tabular-nums">
              {[
                { label: 'Unseen', count: ms.unseenCount, cls: 'bg-[var(--bg-canvas)] border-[var(--border-hairline)] text-[var(--text-primary)]' },
                { label: 'Correct Once (Stage 1)', count: ms.correctOnceCount, cls: 'bg-[var(--bg-surface)] border-[var(--border-strong)] text-[var(--text-primary)]' },
                { label: 'Awaiting Final Review (Stage 2)', count: ms.awaitingReviewCount, cls: 'bg-sky-50 border-sky-200 text-sky-900' },
                { label: 'Retained Mastery (Certified)', count: ms.retainedCount, cls: 'bg-[var(--status-success-bg)] border-[var(--status-success)]/40 text-[var(--status-success)]' },
                { label: 'Needs Repair', count: ms.needsRepairCount, cls: 'bg-[var(--status-warn-bg)] border-[var(--status-warn)]/40 text-[var(--status-warn)]' },
              ].map((b) => (
                <div key={b.label} className={`p-3 rounded-[var(--radius-sm)] border ${b.cls}`}>
                  <div className="text-[11px] font-medium leading-tight">{b.label}</div>
                  <div className="text-xl font-bold mt-1">{b.count}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-Section Breakdown Table */}
          <div className="overflow-x-auto border border-[var(--border-hairline)] rounded-[var(--radius-md)]">
            <table className="w-full text-xs text-left tabular-nums">
              <thead className="bg-[var(--bg-surface)] border-b border-[var(--border-hairline)] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-3.5 py-2.5 font-semibold">Section</th>
                  <th className="px-3.5 py-2.5 font-semibold">Eligible</th>
                  <th className="px-3.5 py-2.5 font-semibold">Retained</th>
                  <th className="px-3.5 py-2.5 font-semibold">Clean ≥1×</th>
                  <th className="px-3.5 py-2.5 font-semibold">Unseen</th>
                  <th className="px-3.5 py-2.5 font-semibold">Stage 1</th>
                  <th className="px-3.5 py-2.5 font-semibold">Stage 2</th>
                  <th className="px-3.5 py-2.5 font-semibold">Needs Repair</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)] bg-[var(--bg-elevated)]">
                {(['READ', 'MATH', 'THINK'] as SectionCode[]).map((sec) => {
                  const s = ms.bySection[sec];
                  return (
                    <tr key={sec}>
                      <td className="px-3.5 py-2.5 font-semibold text-[var(--text-primary)]">
                        {SECTION_LABELS[sec]}
                      </td>
                      <td className="px-3.5 py-2.5">{s.eligible}</td>
                      <td className="px-3.5 py-2.5 font-bold text-[var(--status-success)]">
                        {s.retainedPercentDisplay} ({s.retained})
                      </td>
                      <td className="px-3.5 py-2.5">{s.correctOncePercentDisplay}</td>
                      <td className="px-3.5 py-2.5">{s.unseen}</td>
                      <td className="px-3.5 py-2.5">{s.correctOnce}</td>
                      <td className="px-3.5 py-2.5">{s.awaitingReview}</td>
                      <td className="px-3.5 py-2.5 text-[var(--status-warn)]">{s.needsRepair}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Separate Excluded Benchmark / Writing / Legacy Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                <span>Benchmark Holdout (PT3)</span>
              </div>
              <div className="text-lg font-bold text-[var(--text-primary)] tabular-nums">
                {ms.holdoutSummary.accuracyDisplay}
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                {ms.holdoutSummary.attemptedQuestions} / {ms.holdoutSummary.totalQuestions} holdout questions attempted (isolated from mastery certification)
              </div>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                <PenTool className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                <span>Writing Rubric Progress</span>
              </div>
              <div className="text-lg font-bold text-[var(--text-primary)] tabular-nums">
                {ms.writingSummary.submissionsCount} submitted · {ms.writingSummary.evaluatedCount} graded
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                Across {ms.writingSummary.totalPrompts} active writing prompts (evaluated separately via rubric)
              </div>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                <BookOpen className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                <span>Legacy History (Pre-Certification)</span>
              </div>
              <div className="text-lg font-bold text-[var(--text-primary)] tabular-nums">
                {ms.legacyAttemptsCount} historical attempts
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                Pre-V3 attempts are archived outside certified mastery buckets.
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
              className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-2"
            >
              <div className="text-xs font-semibold text-[var(--text-secondary)]">
                {SECTION_LABELS[sec]}
              </div>
              <div className="text-2xl font-bold text-[var(--text-primary)] tabular-nums">
                {acc !== null ? `${acc}%` : '—'}
              </div>
              <div className="text-xs text-[var(--text-muted)] tabular-nums">
                {st.attempts} attempts · Avg pace {st.avgTimeSec}s vs target {st.targetTimeSec}s
              </div>
            </div>
          );
        })}
      </section>

      {/* Recent Accuracy Estimate (Scheduling) Grouped by Family */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">
              Recent accuracy estimate (scheduling)
            </h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Recency-weighted EWMA signals used by the adaptive scheduler to target weak skill families (separate from certified retention).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 p-1 bg-[var(--bg-surface)] rounded-[var(--radius-sm)]">
              {(['ALL', 'READ', 'MATH', 'THINK', 'WRIT'] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setSectionFilter(sec)}
                  className={`px-3 py-1 text-xs font-semibold rounded-[var(--radius-sm)] cursor-pointer ${
                    sectionFilter === sec
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {sec}
                </button>
              ))}
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyPracticed}
                onChange={(e) => setOnlyPracticed(e.target.checked)}
                className="accent-[var(--accent-primary)]"
              />
              <span>Practiced only</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {groupedByFamily.map(([family, skills]) => (
            <div
              key={family}
              className="p-5 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--border-hairline)] space-y-3"
            >
              <div className="text-xs font-bold text-[var(--text-secondary)]">{family}</div>
              <div className="space-y-2.5">
                {skills.map((sk) => {
                  const pct = sk.state ? Math.round(sk.state.masteryScore * 100) : null;
                  return (
                    <div key={sk.skillId} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[var(--text-primary)] font-medium">{sk.displayName}</span>
                        <span className="tabular-nums text-[var(--text-secondary)]">
                          {pct !== null
                            ? `${pct}% (${sk.state!.correctCount}/${sk.state!.attemptsCount})`
                            : 'Unseen'}
                          {sk.state?.plateauStatus && sk.state.plateauStatus !== 'none'
                            ? ` · Plateau: ${sk.state.plateauStatus}`
                            : ''}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-[var(--bg-surface)] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--accent-primary)]"
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
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Writing Archive</h2>
        {data.writingSubmissions.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] p-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)]">
            No writing submissions yet. Launch a Writing Sprint from Home to practice.
          </p>
        ) : (
          <div className="space-y-3">
            {data.writingSubmissions.map((sub) => (
              <div
                key={sub.submissionId}
                className="p-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
                  <span>
                    {new Date(sub.submittedAt).toLocaleString()} · {sub.wordCount} words · {sub.evaluations.length} evaluation(s)
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenSession(sub.sessionId)}
                    className="text-[var(--accent-primary)] font-semibold hover:underline cursor-pointer"
                  >
                    Open Review →
                  </button>
                </div>
                <p className="text-sm text-[var(--text-primary)] line-clamp-3 whitespace-pre-line">
                  {sub.responseText}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Session History */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold text-[var(--text-primary)]">Session History</h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)] p-5 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)]">
            No sessions recorded yet.
          </p>
        ) : (
          <div className="border border-[var(--border-hairline)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)] overflow-x-auto">
            <table className="w-full text-sm text-left tabular-nums">
              <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] text-xs text-[var(--text-secondary)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Session</th>
                  <th className="px-4 py-3 font-semibold">Mode</th>
                  <th className="px-4 py-3 font-semibold">Score</th>
                  <th className="px-4 py-3 font-semibold">Started</th>
                  <th className="px-4 py-3 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-hairline)]">
                {data.sessions.map((s) => (
                  <tr key={s.sessionId}>
                    <td className="px-4 py-3 font-medium text-[var(--text-primary)]">
                      {s.title || s.sessionId}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-secondary)]">
                      {s.mode.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-primary)]">
                      {s.status === 'submitted' ? `${s.correctSlots}/${s.totalSlots}` : 'In progress'}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {new Date(s.startedAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenSession(s.sessionId)}
                        className="text-xs font-semibold text-[var(--accent-primary)] hover:underline cursor-pointer"
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
