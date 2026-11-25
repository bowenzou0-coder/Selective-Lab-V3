import { type ReactNode } from 'react';
import {
  Award,
  BarChart3,
  LayoutGrid,
  LogOut,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { LanguageToggle, useI18n } from '../i18n';

export interface StudioShellProps {
  currentPath: string;
  role: 'student' | 'admin' | null;
  studentId?: string | null;
  email?: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  banner?: ReactNode;
  children: ReactNode;
}

type NavKey = 'dashboard' | 'benchmarks' | 'progress' | 'settings' | 'admin';

export function StudioShell({
  currentPath,
  role,
  email,
  onNavigate,
  onSignOut,
  banner,
  children,
}: StudioShellProps) {
  const { t } = useI18n();

  const activeKey: NavKey = currentPath.startsWith('/admin')
    ? 'admin'
    : currentPath.startsWith('/settings')
      ? 'settings'
      : currentPath.startsWith('/benchmarks')
        ? 'benchmarks'
        : currentPath.startsWith('/progress')
          ? 'progress'
          : 'dashboard';

  const handleNav = (key: NavKey) => {
    if (key === 'dashboard') {
      onNavigate('/');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    onNavigate(
      key === 'benchmarks'
        ? '/benchmarks'
        : key === 'progress'
          ? '/progress'
          : key === 'settings'
            ? '/settings'
            : '/admin'
    );
  };

  const navItems: { key: NavKey; label: string; shortLabel: string; href: string; icon: typeof LayoutGrid }[] = [
    { key: 'dashboard', label: t('nav.dashboard'), shortLabel: t('nav.dashboardShort'), href: '/', icon: LayoutGrid },
    { key: 'benchmarks', label: t('nav.benchmarks'), shortLabel: t('nav.benchmarksShort'), href: '/benchmarks', icon: Award },
    { key: 'progress', label: t('nav.progress'), shortLabel: t('nav.progressShort'), href: '/progress', icon: BarChart3 },
    { key: 'settings', label: t('nav.settings'), shortLabel: t('nav.settingsShort'), href: '/settings', icon: Settings },
    ...(role === 'admin'
      ? [{ key: 'admin' as const, label: t('nav.admin'), shortLabel: t('nav.adminShort'), href: '/admin', icon: SlidersHorizontal }]
      : []),
  ];

  return (
    <div className="min-h-screen bg-[#F3EFE8] text-[#113C36] flex flex-col">
      {banner}

      {/* Mobile Top Brand Header */}
      <header className="md:hidden px-4 pt-3.5 pb-2.5 flex items-center justify-between gap-2 bg-[#F3EFE8]">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            handleNav('dashboard');
          }}
          className="font-serif-display font-extrabold text-[21px] tracking-[-0.02em] text-[#113C36] leading-none truncate"
        >
          {t('app.name')}
        </a>
        <div className="flex items-center gap-1.5 shrink-0">
          <LanguageToggle compact />
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-sans-display font-medium text-[#4A5955] hover:text-[#113C36] hover:bg-white/70 transition-colors cursor-pointer whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" />
            <span>{t('nav.signOut')}</span>
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row w-full max-w-[1440px] mx-auto">
        {/* Desktop Oat Studio Left Sidebar (208px) */}
        <aside className="hidden md:flex md:w-[208px] shrink-0 flex-col justify-between sticky top-0 h-screen px-4 py-6 bg-[#F3EFE8]">
          <div className="space-y-7">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                handleNav('dashboard');
              }}
              className="block px-2.5 font-serif-display font-extrabold text-[22px] tracking-[-0.02em] text-[#113C36] leading-tight"
            >
              {t('app.name')}
            </a>

            <nav className="space-y-1" aria-label={t('nav.mainAria')}>
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeKey === item.key;
                return (
                  <a
                    key={item.key}
                    href={item.href}
                    data-tour={`nav-${item.key}`}
                    onClick={(e) => {
                      e.preventDefault();
                      handleNav(item.key);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[14px] transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.98] whitespace-nowrap ${
                      isActive
                        ? 'bg-white text-[#113C36] font-sans-display font-semibold border border-[#E5DFD5] shadow-[0_1px_2px_rgba(17,60,54,0.05)]'
                        : 'text-[#4A5955] font-sans-text font-medium hover:text-[#113C36] hover:bg-white/55 border border-transparent'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0 opacity-85" />
                    <span className="truncate">{item.label}</span>
                  </a>
                );
              })}
            </nav>
          </div>

          {/* Subtle Learner / Sync Badge + Language + Sign Out */}
          <div className="pt-4 border-t border-[#E5DFD5] space-y-2.5 px-1">
            <div className="flex items-center gap-2 px-1.5 text-xs text-[#4A5955]">
              <span className="w-2 h-2 rounded-full bg-[#1D6346] shrink-0" aria-hidden="true" />
              <span className="truncate font-medium">
                {role === 'admin' ? t('nav.adminWorkspace') : email || t('nav.syncedAccount')}
              </span>
            </div>
            <div className="px-1">
              <LanguageToggle />
            </div>
            <button
              type="button"
              onClick={onSignOut}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-[10px] text-[13px] font-sans-display font-medium text-[#4A5955] hover:text-[#113C36] hover:bg-white/70 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" />
              <span>{t('nav.signOut')}</span>
            </button>
          </div>
        </aside>

        {/* Floating Warm White Studio Canvas */}
        <div className="flex-1 min-w-0 px-3 pb-24 md:py-3.5 md:pr-4 md:pl-0">
          <div className="bg-white rounded-[18px] border border-[#E5DFD5] shadow-[0_1px_3px_rgba(17,60,54,0.03)] min-h-[calc(100vh-1.75rem)] overflow-x-clip">
            {children}
          </div>
        </div>
      </div>

      {/* Collapsible Mobile Bottom Navigation Strip */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[#F3EFE8] border-t border-[#E5DFD5] px-2 py-2 flex items-center justify-around gap-1"
        aria-label={t('nav.mobileAria')}
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeKey === item.key;
          return (
            <a
              key={item.key}
              href={item.href}
              data-tour={`nav-${item.key}`}
              onClick={(e) => {
                e.preventDefault();
                handleNav(item.key);
              }}
              aria-current={isActive ? 'page' : undefined}
              className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 py-1.5 px-1 rounded-[10px] text-[11px] transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] ${
                isActive
                  ? 'bg-white text-[#113C36] font-sans-display font-semibold border border-[#E5DFD5]'
                  : 'text-[#4A5955] font-medium'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate max-w-full">{item.shortLabel}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
