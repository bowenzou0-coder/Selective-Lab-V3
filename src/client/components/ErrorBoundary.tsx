import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { isStaleChunkError } from '../chunkError';
import { useI18n } from '../i18n';

export { isStaleChunkError };

interface ErrorBoundaryStrings {
  updateTitle: string;
  updateBody: string;
  updateReloadBtn: string;
  genericTitle: string;
  genericBody: string;
  retryBtn: string;
  reloadBtn: string;
}

interface ErrorBoundaryInnerProps {
  children: ReactNode;
  resetKey?: string;
  fullPage?: boolean;
  strings: ErrorBoundaryStrings;
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundaryInner extends Component<ErrorBoundaryInnerProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    if (error instanceof Error) {
      return { error };
    }
    return { error: new Error(typeof error === 'string' ? error : 'Unexpected render error') };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI ErrorBoundary caught error:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryInnerProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const { strings, fullPage = false } = this.props;
    const staleChunk = isStaleChunkError(error);

    return (
      <div
        role="alert"
        className={
          fullPage
            ? 'min-h-screen flex items-center justify-center px-5 py-12 bg-[#F3EFE8] text-[#113C36]'
            : 'w-full px-6 py-16 flex items-center justify-center text-[#113C36]'
        }
      >
        <div className="w-full max-w-[460px] rounded-[18px] bg-white border border-[#E5DFD5] p-7 sm:p-8 shadow-[0_2px_8px_rgba(17,60,54,0.04)] space-y-5">
          <div className="flex items-start gap-3.5">
            <div
              className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${
                staleChunk
                  ? 'bg-[#E5F0EA] text-[#113C36]'
                  : 'bg-[#FDF0E2] text-[#A35116]'
              }`}
              aria-hidden="true"
            >
              {staleChunk ? (
                <RefreshCw className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <div className="space-y-1.5 min-w-0">
              <h1 className="font-sans-display font-semibold text-[20px] tracking-[-0.015em] text-[#113C36] leading-snug">
                {staleChunk ? strings.updateTitle : strings.genericTitle}
              </h1>
              <p className="text-[13.5px] text-[#4A5955] leading-relaxed">
                {staleChunk ? strings.updateBody : strings.genericBody}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[10px] bg-[#113C36] hover:bg-[#0B2B26] text-white font-sans-display font-semibold text-xs transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{staleChunk ? strings.updateReloadBtn : strings.reloadBtn}</span>
            </button>
            {!staleChunk && (
              <button
                type="button"
                onClick={this.handleReset}
                className="px-4 py-2.5 rounded-[10px] border border-[#CFC6B9] bg-white hover:bg-[#FAF8F5] text-[#113C36] font-sans-display font-semibold text-xs transition-[background-color,transform,translate,scale] duration-150 ease-out active:scale-[0.98] cursor-pointer"
              >
                {strings.retryBtn}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string;
  fullPage?: boolean;
  onReload?: () => void;
}

export function ErrorBoundary({ children, resetKey, fullPage, onReload }: ErrorBoundaryProps) {
  const { t } = useI18n();
  return (
    <ErrorBoundaryInner
      resetKey={resetKey}
      fullPage={fullPage}
      onReload={onReload}
      strings={{
        updateTitle: t('errorBoundary.updateTitle'),
        updateBody: t('errorBoundary.updateBody'),
        updateReloadBtn: t('errorBoundary.updateReloadBtn'),
        genericTitle: t('errorBoundary.genericTitle'),
        genericBody: t('errorBoundary.genericBody'),
        retryBtn: t('errorBoundary.retryBtn'),
        reloadBtn: t('errorBoundary.reloadBtn'),
      }}
    >
      {children}
    </ErrorBoundaryInner>
  );
}
