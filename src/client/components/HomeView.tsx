import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Calculator, Clock, Compass, PenTool, Play, RotateCcw } from 'lucide-react';
import { api, type DashboardResponse } from '../api';
import type { MockTestBatch, SectionCode, SessionMode } from '../../shared/contracts';

interface HomeViewProps {
  onOpenSession: (sessionId: string, isLocked?: boolean) => void;
  onNavigate: (path: string) => void;
}

const SECTION_DRILLS: { code: SectionCode; label: string; detail: string; mode: SessionMode }[] = [
  { code: 'READ', label: 'Reading', detail: 'Fiction, cloze, poetry, gapped & matching', mode: 'section_drill' },
  { code: 'MATH', label: 'Mathematical Reasoning', detail: '5-option problem solving & diagrams', mode: 'section_drill' },
  { code: 'THINK', label: 'Thinking Skills', detail: '4-option logic, critical & spatial reasoning', mode: 'section_drill' },
  { code: 'WRIT', label: 'Writing Sprint', detail: '30-min typed task & rubric feedback', mode: 'writing_sprint' },
];

export function HomeView({ onOpenSession, onNavigate }: HomeViewProps) {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Mock Test Simulator controls
  const [mockBatch, setMockBatch] = useState<MockTestBatch>('PT1');
  const [mockScope, setMockScope] = useState<'ALL' | SectionCode>('MATH');
  const [timerPreset, setTimerPreset] = useState<'1.0' | '0.75' | '1.25' | '1.5' | 'custom' | '0'>('1.0');
  const [customMinutes, setCustomMinutes] = useState('40');

  useEffect(() => {
    let active = true;
    api
      .getDashboard()
      .then((res) => {
        if (!active) return;
        if (res.activeSession) {
          onOpenSession(res.activeSession.sessionId, true);
          return;
        }
        setData(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load dashboard.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onOpenSession]);

  const launch = async (
    key: string,
    payload: Parameters<typeof api.createSession>[0]
  ) => {
    setLaunching(key);
    setError('');
    try {
      const res = await api.createSession(payload);
      onOpenSession(res.sessionId, true);
    } catch (err) {
      const activeId = (err as { activeSessionId?: string })?.activeSessionId;
      if (activeId) {
        onOpenSession(activeId, true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to start session.');
      setLaunching(null);
    }
  };

  const handleLaunchMock = () => {
    const sectionFilter = mockScope === 'ALL' ? undefined : mockScope;
    if (timerPreset === 'custom') {
      const mins = Math.max(1, Number(customMinutes) || 40);
      launch('mock', {
        mode: mockBatch === 'PT3' ? 'benchmark_exam' : 'section_drill',
        mockBatch,
        sectionFilter,
        customTimeLimitSec: mins * 60,
      });
      return;
    }
    const mult = Number(timerPreset);
    launch('mock', {
      mode: mockBatch === 'PT3' ? 'benchmark_exam' : 'section_drill',
      mockBatch,
      sectionFilter,
      timeMultiplier: mult,
    });
  };

  const mockQuestionCount = data
    ? mockScope === 'ALL'
      ? Object.values(data.batchCounts[mockBatch]).reduce((a, b) => a + b, 0)
      : data.batchCounts[mockBatch][mockScope]
    : 0;

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-12">
      {error && (
        <div role="alert" className="p-3.5 rounded-[var(--radius-md)] bg-[var(--status-error-bg)] text-[var(--status-error)] text-sm font-medium">
          {error}
        </div>
      )}

      {/* Primary Focal Entry */}
      <section className="bg-[var(--bg-elevated)] border border-[var(--border-hairline)] rounded-[var(--radius-lg)] p-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-3 max-w-xl">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
              <span>Selective Lab</span>
              <span aria-hidden="true">·</span>
              <span>Streak: {loading ? '—' : `${data?.streakDays ?? 0} days`}</span>
              <span aria-hidden="true">·</span>
              <span>
                Today: {loading ? '—' : `${data?.todayMinutes ?? 0} / ${data?.dailyGoalMinutes ?? 25} min`}
              </span>
              {data && data.todaySlotsAttempted > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {data.todaySlotsCorrect}/{data.todaySlotsAttempted} slots today
                  </span>
                </>
              )}
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)] text-balance">
              Focused Selective Practice
            </h1>
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
              Adaptive daily practice mixes spaced-review items with weakest-skill drills in a clean Janison-style test workspace.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {data?.activeSession && (
              <button
                type="button"
                onClick={() => onOpenSession(data.activeSession!.sessionId)}
                className="px-4 py-3 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-sm font-semibold text-[var(--text-primary)] inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Resume Active Session</span>
              </button>
            )}
            <button
              type="button"
              disabled={launching !== null}
              onClick={() => launch('daily', { mode: 'daily_adaptive' })}
              className="px-6 py-3 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white text-sm font-semibold inline-flex items-center gap-2 transition-colors disabled:opacity-60 cursor-pointer whitespace-nowrap"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>{launching === 'daily' ? 'Preparing...' : "Start Today's Practice"}</span>
            </button>
          </div>
        </div>

        {/* Quick Section Drills */}
        <div className="mt-8 pt-6 border-t border-[var(--border-hairline)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-[var(--text-secondary)]">
              Quick Practice Drills ({data?.sectionDrillQuestionCount ?? 10} Qs · {data?.sectionDrillTimeMinutes ?? 8} min)
            </h2>
            <button
              type="button"
              disabled={launching !== null}
              onClick={() => launch('review', { mode: 'spaced_review' })}
              className="text-xs font-medium text-[var(--accent-primary)] hover:underline cursor-pointer"
            >
              Spaced Review Queue →
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {SECTION_DRILLS.map((drill) => {
              const Icon =
                drill.code === 'READ'
                  ? BookOpen
                  : drill.code === 'MATH'
                    ? Calculator
                    : drill.code === 'THINK'
                      ? Compass
                      : PenTool;
              return (
                <button
                  key={drill.code}
                  type="button"
                  disabled={launching !== null}
                  onClick={() =>
                    launch(`drill_${drill.code}`, {
                      mode: drill.mode,
                      sectionFilter: drill.code,
                    })
                  }
                  className="text-left p-4 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-surface)] hover:border-[var(--border-strong)] transition-colors cursor-pointer group"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{drill.label}</span>
                    <Icon className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--accent-primary)] transition-colors shrink-0" />
                  </div>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {drill.code === 'WRIT'
                      ? drill.detail
                      : `${data?.sectionDrillQuestionCount ?? 10} Qs · ${data?.sectionDrillTimeMinutes ?? 8} min · ${drill.detail}`}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Full Mock Test Simulator (Same Official Questions + Adjustable Timer) */}
      <section
        id="mock-simulator"
        className="bg-[var(--bg-surface)] border border-[var(--border-hairline)] rounded-[var(--radius-lg)] p-8"
      >
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Full Mock Test Simulator</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
              Run official practice tests in fixed exam order with an adjustable timer while keeping the exact same canonical questions.
            </p>
          </div>
          <div className="text-xs text-[var(--text-secondary)] tabular-nums whitespace-nowrap">
            Selected set: <strong className="text-[var(--text-primary)]">{mockQuestionCount}</strong> question items
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label htmlFor="mock-batch-select" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Official Practice Test
            </label>
            <select
              id="mock-batch-select"
              value={mockBatch}
              onChange={(e) => setMockBatch(e.target.value as MockTestBatch)}
              className="w-full px-3 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)]"
            >
              <option value="PT1">Official Practice Test 1 (Calibration)</option>
              <option value="PT2">Official Practice Test 2 (Calibration)</option>
              <option value="PT3">Official Practice Test 3 (Benchmark Holdout)</option>
            </select>
          </div>

          <div>
            <label htmlFor="mock-scope-select" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Test Scope
            </label>
            <select
              id="mock-scope-select"
              value={mockScope}
              onChange={(e) => setMockScope(e.target.value as 'ALL' | SectionCode)}
              className="w-full px-3 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)]"
            >
              <option value="READ">Reading (40 min)</option>
              <option value="MATH">Mathematical Reasoning (40 min)</option>
              <option value="THINK">Thinking Skills (40 min)</option>
              <option value="WRIT">Writing (30 min)</option>
              <option value="ALL">Full 4-Section Exam (150 min)</option>
            </select>
          </div>

          <div>
            <label htmlFor="mock-timer-select" className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
              Timer Setting
            </label>
            <div className="flex gap-2">
              <select
                id="mock-timer-select"
                value={timerPreset}
                onChange={(e) => setTimerPreset(e.target.value as typeof timerPreset)}
                className="flex-1 px-3 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)]"
              >
                <option value="1.0">1.0× Official Time</option>
                <option value="0.75">0.75× Speed Pace</option>
                <option value="1.25">1.25× Extended Time</option>
                <option value="1.5">1.5× Extended Time</option>
                <option value="custom">Custom Minutes</option>
                <option value="0">Untimed Practice</option>
              </select>
              {timerPreset === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={240}
                  aria-label="Custom timer minutes"
                  value={customMinutes}
                  onChange={(e) => setCustomMinutes(e.target.value)}
                  className="w-20 px-2.5 py-2.5 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm tabular-nums text-[var(--text-primary)]"
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Clock className="w-3.5 h-3.5" />
            <span>
              {mockBatch === 'PT3'
                ? 'Benchmark holdout items are strictly isolated from daily adaptive practice.'
                : 'Same canonical questions and sequence across every timer setting.'}
            </span>
          </div>
          <button
            type="button"
            disabled={launching !== null || mockQuestionCount === 0}
            onClick={handleLaunchMock}
            className="px-5 py-2.5 rounded-[var(--radius-sm)] bg-[var(--text-primary)] hover:opacity-90 text-white text-sm font-semibold inline-flex items-center gap-2 transition-opacity disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <span>{launching === 'mock' ? 'Starting Mock...' : 'Start Mock Test Simulator'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* Recent Sessions */}
      {data && data.recentSessions.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Recent Sessions</h2>
            <button
              type="button"
              onClick={() => onNavigate('/progress')}
              className="text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              View full analytics →
            </button>
          </div>
          <div className="border border-[var(--border-hairline)] rounded-[var(--radius-md)] bg-[var(--bg-elevated)] divide-y divide-[var(--border-hairline)]">
            {data.recentSessions.slice(0, 5).map((s) => (
              <div key={s.sessionId} className="px-5 py-3.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {s.title || s.mode.replace(/_/g, ' ')}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] tabular-nums mt-0.5">
                    {new Date(s.startedAt).toLocaleDateString()} ·{' '}
                    {s.status === 'submitted'
                      ? `Score ${s.correctSlots}/${s.totalSlots} slots`
                      : 'In progress'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenSession(s.sessionId)}
                  className="px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] border border-[var(--border-strong)] hover:bg-[var(--bg-surface)] text-[var(--text-primary)] cursor-pointer whitespace-nowrap shrink-0"
                >
                  {s.status === 'submitted' ? 'Review' : 'Resume'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="pt-6 border-t border-[var(--border-hairline)] flex flex-wrap items-center justify-between gap-4 text-xs text-[var(--text-muted)]">
        <span>Selective Lab</span>
        <div className="flex items-center gap-4">
          <a
            href="/progress"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/progress');
            }}
            className="hover:text-[var(--text-primary)] underline underline-offset-2"
          >
            Progress Report
          </a>
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/admin');
            }}
            className="hover:text-[var(--text-primary)] underline underline-offset-2"
          >
            Admin &amp; Calibration Console
          </a>
        </div>
      </footer>
    </main>
  );
}
