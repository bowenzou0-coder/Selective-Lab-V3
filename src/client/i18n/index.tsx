import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BankPoolStatus, QuestionCompletionStatus } from '../../shared/bankStatus';
import type { SectionCode } from '../../shared/contracts';
import { SKILLS_TAXONOMY } from '../../shared/skills';
import {
  MESSAGES_EN,
  getZhSkillLabels,
  isZhMessagesLoaded,
  loadZhMessages,
  translateMessage,
  type AppLocale,
  type MessageKey,
} from './messages';

export { type AppLocale, type MessageKey } from './messages';

const LOCALE_STORAGE_KEY = 'selective_lab_locale';
const SKILL_EN_MAP = new Map(SKILLS_TAXONOMY.map((s) => [s.skillId, s.displayName]));

export function readStoredLocale(): AppLocale {
  if (typeof window === 'undefined') return 'en';
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw === 'zh-CN' || raw === 'en') return raw;
  } catch {
    // ignore storage access errors
  }
  return 'en';
}

interface I18nContextValue {
  locale: AppLocale;
  isZh: boolean;
  setLocale: (next: AppLocale) => void;
  toggleLocale: () => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  sectionLabel: (section: string) => string;
  sectionShortLabel: (section: string) => string;
  formatLabel: (formatType: string) => string;
  poolStatusLabel: (status: BankPoolStatus) => string;
  completionStatusLabel: (status: QuestionCompletionStatus) => string;
  skillName: (skillId: string) => string;
  familyLabel: (familyCode: string) => string;
  formatDate: (iso?: string, withTime?: boolean) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredLocale);
  // Bumps once the lazily loaded Chinese dictionary arrives so `t` re-renders in Chinese.
  const [zhReady, setZhReady] = useState(isZhMessagesLoaded);

  useEffect(() => {
    if (locale !== 'zh-CN' || zhReady) return;
    let active = true;
    loadZhMessages()
      .then(() => {
        if (active) setZhReady(true);
      })
      .catch(() => undefined); // stay on the English fallback if the chunk fails to load
    return () => {
      active = false;
    };
  }, [locale, zhReady]);
  const dictLocale: AppLocale = locale === 'zh-CN' && zhReady ? 'zh-CN' : 'en';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // ignore storage errors
    }
  }, [locale]);

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => (prev === 'en' ? 'zh-CN' : 'en'));
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translateMessage(dictLocale, key, vars),
    [dictLocale]
  );

  const sectionLabel = useCallback(
    (section: string) => {
      const k = `section.${section}` as MessageKey;
      return k in MESSAGES_EN ? translateMessage(dictLocale, k) : section;
    },
    [dictLocale]
  );

  const sectionShortLabel = useCallback(
    (section: string) => {
      const k = `sectionShort.${section}` as MessageKey;
      return k in MESSAGES_EN ? translateMessage(dictLocale, k) : section;
    },
    [dictLocale]
  );

  const formatLabel = useCallback(
    (formatType: string) => {
      const k = `format.${formatType}` as MessageKey;
      return k in MESSAGES_EN ? translateMessage(dictLocale, k) : formatType.replace(/_/g, ' ');
    },
    [dictLocale]
  );

  const poolStatusLabel = useCallback(
    (status: BankPoolStatus) => translateMessage(dictLocale, `poolStatus.${status}` as MessageKey),
    [dictLocale]
  );

  const completionStatusLabel = useCallback(
    (status: QuestionCompletionStatus) =>
      translateMessage(dictLocale, `completion.${status}` as MessageKey),
    [dictLocale]
  );

  const skillName = useCallback(
    (skillId: string) => {
      const zhName = dictLocale === 'zh-CN' ? getZhSkillLabels().names[skillId] : undefined;
      if (zhName) return zhName;
      return SKILL_EN_MAP.get(skillId) || skillId;
    },
    [dictLocale]
  );

  const familyLabel = useCallback(
    (familyCode: string) => {
      const zhFamily = dictLocale === 'zh-CN' ? getZhSkillLabels().families[familyCode] : undefined;
      if (zhFamily) return zhFamily;
      return familyCode;
    },
    [dictLocale]
  );

  const formatDate = useCallback(
    (iso?: string, withTime = false) => {
      if (!iso) return locale === 'zh-CN' ? '从未' : 'Never';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return locale === 'zh-CN' ? '未知' : 'Unknown';
      const loc = locale === 'zh-CN' ? 'zh-CN' : 'en-AU';
      return withTime ? d.toLocaleString(loc) : d.toLocaleDateString(loc);
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      isZh: locale === 'zh-CN',
      setLocale,
      toggleLocale,
      t,
      sectionLabel,
      sectionShortLabel,
      formatLabel,
      poolStatusLabel,
      completionStatusLabel,
      skillName,
      familyLabel,
      formatDate,
    }),
    [
      locale,
      setLocale,
      toggleLocale,
      t,
      sectionLabel,
      sectionShortLabel,
      formatLabel,
      poolStatusLabel,
      completionStatusLabel,
      skillName,
      familyLabel,
      formatDate,
    ]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK_I18N: I18nContextValue = {
  locale: 'en',
  isZh: false,
  setLocale: () => undefined,
  toggleLocale: () => undefined,
  t: (key, vars) => translateMessage('en', key, vars),
  sectionLabel: (s) => {
    const k = `section.${s}` as MessageKey;
    return k in MESSAGES_EN ? translateMessage('en', k) : s;
  },
  sectionShortLabel: (s) => {
    const k = `sectionShort.${s}` as MessageKey;
    return k in MESSAGES_EN ? translateMessage('en', k) : s;
  },
  formatLabel: (f) => {
    const k = `format.${f}` as MessageKey;
    return k in MESSAGES_EN ? translateMessage('en', k) : f.replace(/_/g, ' ');
  },
  poolStatusLabel: (st) => translateMessage('en', `poolStatus.${st}` as MessageKey),
  completionStatusLabel: (st) => translateMessage('en', `completion.${st}` as MessageKey),
  skillName: (id) => SKILL_EN_MAP.get(id) || id,
  familyLabel: (fam) => fam,
  formatDate: (iso, withTime = false) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown';
    return withTime ? d.toLocaleString() : d.toLocaleDateString();
  },
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK_I18N;
}

export function LanguageToggle({
  compact = false,
  className = '',
}: {
  compact?: boolean;
  className?: string;
}) {
  const { locale, setLocale } = useI18n();
  return (
    <div
      role="group"
      aria-label="Switch language / 切换界面语言"
      className={`inline-flex items-center p-0.5 rounded-[10px] bg-[#F3EFE8] border border-[#E5DFD5] gap-0.5 shrink-0 ${className}`}
    >
      {(
        [
          ['en', compact ? 'EN' : 'English'],
          ['zh-CN', '中文'],
        ] as [AppLocale, string][]
      ).map(([code, label]) => {
        const active = locale === code;
        return (
          <button
            key={code}
            type="button"
            aria-pressed={active}
            onClick={() => setLocale(code)}
            className={`px-2.5 py-1 rounded-[8px] text-[11px] font-sans-display font-semibold cursor-pointer whitespace-nowrap transition-tactile ${
              active
                ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                : 'text-[#4A5955] hover:text-[#113C36]'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function getLocalizedSectionMixParts(
  limits: Partial<Record<SectionCode, number>>,
  sectionShortLabel: (sec: string) => string
): string[] {
  return (['READ', 'MATH', 'THINK', 'WRIT'] as SectionCode[])
    .filter((sec) => Number(limits[sec] || 0) > 0)
    .map((sec) => `${sectionShortLabel(sec)} ${limits[sec]}`);
}
