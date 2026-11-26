import type { ComponentProps } from 'react';
import { useI18n } from '../../i18n';
import { QuestionNavigator } from './QuestionNavigator';

export const SESSION_NAVIGATOR_ID = 'session-navigator-panel';

type NavigatorProps = ComponentProps<typeof QuestionNavigator>;

interface SessionNavigatorDrawerProps extends Omit<NavigatorProps, 'currentIndex' | 'onGoIndex'> {
  open: boolean;
  /** Global index of the first question in the active section. */
  sectionStart: number;
  /** Global index of the current question. */
  currentIndex: number;
  /** Receives a global question index. */
  onGoIndex: (globalIndex: number) => void;
  /** Escape inside the grid closes it and returns focus to the rail toggle. */
  onClose?: () => void;
}

/**
 * Drop-down question grid under the exam rail (a non-modal disclosure controlled by the rail's
 * Navigator toggle). Translates between the section-local indices the grid uses and the
 * session-wide indices the player tracks.
 */
export function SessionNavigatorDrawer({
  open,
  sectionStart,
  currentIndex,
  onGoIndex,
  onClose,
  ...navigatorProps
}: SessionNavigatorDrawerProps) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div
      id={SESSION_NAVIGATOR_ID}
      role="region"
      aria-label={t('session.navigator')}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !onClose) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        document.querySelector<HTMLElement>(`[aria-controls="${SESSION_NAVIGATOR_ID}"]`)?.focus();
      }}
    >
      <QuestionNavigator
        {...navigatorProps}
        currentIndex={Math.max(0, currentIndex - sectionStart)}
        onGoIndex={(idx) => onGoIndex(sectionStart + idx)}
      />
    </div>
  );
}
