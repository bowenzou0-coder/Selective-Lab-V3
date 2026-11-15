interface TopNavProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onPrimaryAction: () => void;
  primaryLabel: string;
}

export function TopNav({ currentPath, onNavigate, onPrimaryAction, primaryLabel }: TopNavProps) {
  const linkClass = (active: boolean) =>
    `text-sm font-medium whitespace-nowrap shrink-0 transition-colors pb-0.5 border-b ${
      active
        ? 'text-[var(--text-primary)] border-[var(--accent-primary)]'
        : 'text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]'
    }`;

  return (
    <header className="w-full border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)]">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-8">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="text-lg font-bold tracking-tight text-[var(--text-primary)] whitespace-nowrap shrink-0"
        >
          Selective Lab
        </a>

        <nav className="hidden md:flex items-center gap-6" aria-label="Main navigation">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/');
            }}
            className={linkClass(currentPath === '/')}
          >
            Practice
          </a>
          <a
            href="/#mock-simulator"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/');
              setTimeout(() => {
                document.getElementById('mock-simulator')?.scrollIntoView({ behavior: 'smooth' });
              }, 50);
            }}
            className={linkClass(false)}
          >
            Mock Tests
          </a>
          <a
            href="/progress"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/progress');
            }}
            className={linkClass(currentPath.startsWith('/progress'))}
          >
            Progress
          </a>
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/admin');
            }}
            className={linkClass(currentPath.startsWith('/admin'))}
          >
            Admin
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onPrimaryAction}
            className="px-4 py-2 text-xs font-semibold rounded-[var(--radius-sm)] bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-primary-hover)] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </header>
  );
}
