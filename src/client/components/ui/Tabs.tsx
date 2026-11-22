import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface TabListProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  baseId?: string;
}

export function tabIds(baseId: string, id: string) {
  return { tab: `${baseId}-tab-${id}`, panel: `${baseId}-panel-${id}` };
}

export function useTabsBaseId() {
  return useId().replace(/:/g, '');
}

/** ARIA tablist with roving focus (Left/Right/Home/End). Pair with <TabPanel baseId>. */
export function TabList<T extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  className = '',
  baseId,
}: TabListProps<T>) {
  const fallbackId = useTabsBaseId();
  const id = baseId ?? fallbackId;
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = items.findIndex((item) => item.id === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    e.preventDefault();
    onValueChange(items[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[12px] border border-[#E5DFD5] bg-[#F3EFE8] p-1 ${className}`}
    >
      {items.map((item) => {
        const active = item.id === value;
        const ids = tabIds(id, item.id);
        return (
          <button
            key={item.id}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={ids.panel}
            tabIndex={active ? 0 : -1}
            onClick={() => onValueChange(item.id)}
            className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 py-1.5 font-sans-display text-xs font-semibold transition-[background-color,color,box-shadow] duration-150 ${
              active
                ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]'
                : 'text-[#4A5955] hover:text-[#113C36]'
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  baseId,
  id,
  active,
  children,
  className = '',
}: {
  baseId: string;
  id: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ids = tabIds(baseId, id);
  if (!active) return null;
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className={`focus:outline-none ${className}`}>
      {children}
    </div>
  );
}
