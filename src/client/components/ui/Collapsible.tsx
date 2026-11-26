import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

const SETTLE_MS = 320;

interface CollapsibleProps {
  open: boolean;
  /** Region id; point the trigger's `aria-controls` at it. */
  id: string;
  children: ReactNode;
  className?: string;
  /** Classes on the clipped inner wrapper (padding/borders belong here so they collapse too). */
  innerClassName?: string;
  /** Keep the content unmounted until the first open (default true). */
  lazy?: boolean;
  /** Optional label for the region (e.g. the trigger's id via aria-labelledby). */
  labelledBy?: string;
}

/**
 * Height-agnostic expand/collapse: animates `grid-template-rows` 0fr ↔ 1fr plus opacity (see
 * `.collapsible` in tokens.css; instant under reduced motion). Closed content is `inert`, so it
 * leaves the tab order and accessibility tree. Overflow is released once fully open so focus
 * rings and shadows inside are not clipped.
 */
export function Collapsible({
  open,
  id,
  children,
  className = '',
  innerClassName = '',
  lazy = true,
  labelledBy,
}: CollapsibleProps) {
  const [hasOpened, setHasOpened] = useState(open);
  const [settled, setSettled] = useState(open);
  if (open && !hasOpened) setHasOpened(true);

  useEffect(() => {
    setSettled(false);
    if (!open) return;
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      id={id}
      role={labelledBy ? 'region' : undefined}
      aria-labelledby={labelledBy}
      data-open={open ? 'true' : 'false'}
      inert={!open}
      className={`collapsible ${className}`}
    >
      <div className={`collapsible-inner ${open && settled ? 'overflow-visible' : 'overflow-hidden'}`}>
        <div className={innerClassName}>{hasOpened || !lazy ? children : null}</div>
      </div>
    </div>
  );
}

/** Chevron that turns 180° with its disclosure (transform only; static under reduced motion). */
export function DisclosureChevron({ open, className = 'h-4 w-4' }: { open: boolean; className?: string }) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        open ? 'rotate-180' : ''
      } ${className}`}
    />
  );
}
