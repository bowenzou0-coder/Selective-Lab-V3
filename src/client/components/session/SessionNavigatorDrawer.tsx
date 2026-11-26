import type { ComponentProps } from 'react';
import { QuestionNavigator } from './QuestionNavigator';

type NavigatorProps = ComponentProps<typeof QuestionNavigator>;

interface SessionNavigatorDrawerProps extends Omit<NavigatorProps, 'currentIndex' | 'onGoIndex'> {
  open: boolean;
  /** Global index of the first question in the active section. */
  sectionStart: number;
  /** Global index of the current question. */
  currentIndex: number;
  /** Receives a global question index. */
  onGoIndex: (globalIndex: number) => void;
}

/**
 * Drop-down question grid under the exam rail. Translates between the section-local indices the
 * grid uses and the session-wide indices the player tracks.
 */
export function SessionNavigatorDrawer({
  open,
  sectionStart,
  currentIndex,
  onGoIndex,
  ...navigatorProps
}: SessionNavigatorDrawerProps) {
  if (!open) return null;
  return (
    <QuestionNavigator
      {...navigatorProps}
      currentIndex={Math.max(0, currentIndex - sectionStart)}
      onGoIndex={(idx) => onGoIndex(sectionStart + idx)}
    />
  );
}
