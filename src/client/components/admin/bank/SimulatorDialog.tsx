import { useState } from 'react';
import { Play } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Sheet } from '../../ui/Sheet';

export interface SimulatorLaunchOptions {
  useSelected: boolean;
  /** 'ALL' = every matching question (capped server-side). */
  limit: number | 'ALL';
  timerMin: number;
  sandbox: boolean;
}

interface SimulatorDialogProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  matchingCount: number;
  launching: boolean;
  onLaunch: (options: SimulatorLaunchOptions) => void;
}

const COUNTS: (number | 'ALL')[] = [5, 10, 15, 25, 'ALL'];
const TIMERS = [0, 10, 20, 40];

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: T;
  options: T[];
  onChange: (v: T) => void;
  render: (v: T) => string;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-[#4A5955]">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-[12px] border border-[#E5DFD5] bg-[#F3EFE8] p-1">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={String(opt)}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt)}
              className={`flex-1 cursor-pointer whitespace-nowrap rounded-[9px] px-2.5 py-1.5 text-xs font-medium tabular-nums transition-colors ${
                active ? 'bg-white text-[#113C36] shadow-[0_1px_2px_rgba(17,60,54,0.08)]' : 'text-[#4A5955] hover:text-[#113C36]'
              }`}
            >
              {render(opt)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Focused launcher for admin practice runs (filtered results or the checked selection). */
export function SimulatorDialog({ open, onClose, selectedCount, matchingCount, launching, onLaunch }: SimulatorDialogProps) {
  const { t } = useI18n();
  const [useSelected, setUseSelected] = useState(selectedCount > 0);
  const [limit, setLimit] = useState<number | 'ALL'>(10);
  const [timerMin, setTimerMin] = useState(0);
  const [sandbox, setSandbox] = useState(true);
  // Default the scope to the current selection each time the dialog opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setUseSelected(selectedCount > 0);
  }
  const scopeSelected = useSelected && selectedCount > 0;
  const emptyScope = scopeSelected ? selectedCount === 0 : matchingCount === 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="center"
      title={t('bank.simulateTitle')}
      description={t('bank.simulateDesc')}
      closeLabel={t('common.close')}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-[10px] px-3 py-2 text-xs font-medium text-[#4A5955] transition-colors hover:text-[#113C36]"
          >
            {t('home.modalCancel')}
          </button>
          <button
            type="button"
            disabled={launching || emptyScope}
            onClick={() => onLaunch({ useSelected: scopeSelected, limit, timerMin, sandbox })}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] bg-[#113C36] px-4 py-2 font-sans-display text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-[#0B2B26] active:scale-[0.97] disabled:opacity-50"
          >
            <Play className="h-3 w-3 fill-current" />
            <span>{launching ? t('bank.launching') : t('bank.simLaunch')}</span>
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-[#4A5955]">{t('bank.simScope')}</legend>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-[#E5DFD5] bg-white px-3 py-2 text-sm text-[#113C36]">
            <input type="radio" name="sim-scope" checked={!scopeSelected} onChange={() => setUseSelected(false)} className="accent-[#113C36]" />
            <span>{t('bank.simScopeFiltered', { count: matchingCount })}</span>
          </label>
          <label
            className={`flex items-center gap-2.5 rounded-[10px] border border-[#E5DFD5] bg-white px-3 py-2 text-sm text-[#113C36] ${
              selectedCount === 0 ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
            }`}
          >
            <input
              type="radio"
              name="sim-scope"
              disabled={selectedCount === 0}
              checked={scopeSelected}
              onChange={() => setUseSelected(true)}
              className="accent-[#113C36]"
            />
            <span>{t('bank.simScopeSelected', { count: selectedCount })}</span>
          </label>
        </fieldset>

        {!scopeSelected && (
          <Segmented
            label={t('bank.simCount')}
            value={limit}
            options={COUNTS}
            onChange={setLimit}
            render={(v) => (v === 'ALL' ? t('bank.allMatching') : String(v))}
          />
        )}
        <Segmented
          label={t('bank.simTimer')}
          value={timerMin}
          options={TIMERS}
          onChange={setTimerMin}
          render={(v) => (v === 0 ? t('bank.untimed') : t('home.minShort', { min: v }))}
        />
        <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-[#E5DFD5] bg-white px-3 py-2.5">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} className="mt-0.5 accent-[#113C36]" />
          <span className="space-y-0.5">
            <span className="block text-sm text-[#113C36]">{t('bank.sandboxClean')}</span>
            <span className="block text-xs text-[#78756E]">{t('bank.sandboxHint')}</span>
          </span>
        </label>
      </div>
    </Sheet>
  );
}
