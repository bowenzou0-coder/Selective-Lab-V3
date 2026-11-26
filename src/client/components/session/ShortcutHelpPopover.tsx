import { useI18n } from '../../i18n';
import { Popover } from '../ui/Popover';
import { EXAM_SHORTCUT_LEGEND } from './examShortcuts';

interface ShortcutHelpPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Quiet `?` button in the exam rail with a compact legend of the Exam Room shortcuts. */
export function ShortcutHelpPopover({ open, onOpenChange }: ShortcutHelpPopoverProps) {
  const { t } = useI18n();
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      label={t('shortcuts.title')}
      panelClassName="w-[min(19rem,calc(100vw-2rem))]"
      trigger={(props, isOpen) => (
        <button
          type="button"
          {...props}
          aria-label={t('shortcuts.buttonAria')}
          aria-keyshortcuts="Shift+/"
          title={t('shortcuts.title')}
          className={`inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border text-xs font-sans-display font-semibold cursor-pointer transition-tactile ${
            isOpen
              ? 'border-[#113C36] bg-[#E5F0EA] text-[#113C36]'
              : 'border-[#E5DFD5] bg-white text-[#4A5955] hover:text-[#113C36] hover:border-[#CFC6B9]'
          }`}
        >
          ?
        </button>
      )}
    >
      <div className="space-y-3">
        <h2 className="font-sans-display font-semibold text-[13px] text-[#113C36]">{t('shortcuts.title')}</h2>
        <dl className="space-y-2 text-xs">
          {EXAM_SHORTCUT_LEGEND.map((row) => (
            <div key={row.labelKey} className="flex items-center justify-between gap-3">
              <dt className="text-[#4A5955]">{t(row.labelKey)}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {row.keys.map((k) => (
                  <kbd
                    key={k}
                    className="min-w-[22px] rounded-[5px] border border-[#CFC6B9] bg-[#FAF8F5] px-1.5 py-px text-center font-sans-text text-[11px] font-medium leading-[18px] text-[#113C36]"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="border-t border-[#E5DFD5] pt-2.5 text-[11px] leading-relaxed text-[#615E57]">{t('shortcuts.note')}</p>
      </div>
    </Popover>
  );
}
