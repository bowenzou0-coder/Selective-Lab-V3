import type { ReactNode } from 'react';

/** One shimmer block; size it with the same classes the real content would use. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton block ${className}`} />;
}

/** Announces a loading region once, while the shimmer blocks inside stay decorative. */
export function SkeletonRegion({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
