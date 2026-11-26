import { memo, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { createPortal } from 'react-dom';
import { ImageOff, Maximize2, X } from 'lucide-react';
import type { VisualSpec } from '../../shared/contracts';
import { normalizeSvgFonts } from '../../shared/svgFonts';
import { useFocusTrap } from './ui/focusTrap';

// Admin-authored SVG only; strip anything executable and normalize diagram fonts to Anthropic faces.
function sanitizeSvg(markup: string): string {
  const safe = markup
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<(foreignObject|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  return normalizeSvgFonts(safe);
}

interface VisualRendererProps {
  visual?: VisualSpec;
  compact?: boolean;
  variant?: 'default' | 'optionTile';
}

export const VisualRenderer = memo(function VisualRenderer({
  visual,
  compact = false,
  variant = 'default',
}: VisualRendererProps) {
  const { t } = useI18n();
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoomTitleId = `visual-zoom-${useId().replace(/:/g, '')}`;
  useFocusTrap(zoomRef, zoomOpen, { onEscape: () => setZoomOpen(false) });
  const [imgError, setImgError] = useState(false);
  const [errorForUrl, setErrorForUrl] = useState(visual?.imageUrl);
  if (errorForUrl !== visual?.imageUrl) {
    // New image: clear the previous error during render (no effect flash).
    setErrorForUrl(visual?.imageUrl);
    setImgError(false);
  }
  const safeSvg = useMemo(
    () => (visual?.visualType === 'inline_svg' && visual.svgMarkup ? { __html: sanitizeSvg(visual.svgMarkup) } : undefined),
    [visual?.visualType, visual?.svgMarkup]
  );

  if (!visual || visual.visualType === 'none') return null;

  const isOptionTile = variant === 'optionTile';
  const isCompact = compact || isOptionTile;

  const content = (
    <>
      {visual.visualType === 'inline_svg' && visual.svgMarkup && (
        <div className={isOptionTile ? 'w-full h-full flex items-center justify-center' : 'relative group'}>
          <div
            className={
              isOptionTile
                ? 'visual-svg-host w-full h-full flex items-center justify-center [&_svg]:max-h-full [&_svg]:max-w-full [&_svg]:w-auto [&_svg]:h-full'
                : isCompact
                  ? 'visual-svg-host flex justify-center overflow-hidden max-h-28 [&_svg]:max-h-28 [&_svg]:max-w-full [&_svg]:w-auto [&_svg]:h-auto'
                  : 'visual-svg-host flex justify-center overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto'
            }
            role="img"
            aria-label={visual.altText}
            dangerouslySetInnerHTML={safeSvg}
          />
          {!isCompact && (
            <button
              type="button"
              onClick={() => setZoomOpen(true)}
              aria-label={`${t('ws.zoomDiagram')}: ${visual.altText}`}
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>{t('ws.zoomDiagram')}</span>
            </button>
          )}
        </div>
      )}

      {visual.visualType === 'image_asset' && visual.imageUrl && (
        <div className={isOptionTile ? 'w-full h-full flex items-center justify-center' : ''}>
          {!imgError ? (
            isCompact ? (
              <div className={isOptionTile ? 'w-full h-full flex items-center justify-center' : 'w-full flex justify-center'}>
                <img
                  src={visual.imageUrl}
                  alt={visual.altText}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  onError={() => setImgError(true)}
                  className={
                    isOptionTile
                      ? 'max-h-full max-w-full w-auto h-auto object-contain rounded-[4px]'
                      : 'mx-auto object-contain rounded-[var(--radius-sm)] max-h-28 max-w-full w-auto'
                  }
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                aria-label={`Inspect image: ${visual.altText}`}
                className="block w-full text-left cursor-zoom-in"
              >
                <img
                  src={visual.imageUrl}
                  alt={visual.altText}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  onError={() => setImgError(true)}
                  className="mx-auto object-contain rounded-[var(--radius-sm)] max-h-72 max-w-full w-auto"
                />
              </button>
            )
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-4 px-3 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs text-center">
              <ImageOff className="w-5 h-5" />
              <span>{visual.altText || t('ws.visualUnavailable')}</span>
            </div>
          )}
          {!isCompact && !imgError && (
            <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>{visual.caption || visual.altText}</span>
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>{t('ws.zoom')}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {visual.visualType === 'structured_table' && visual.tableData && (
        <div className="scroll-x">
          {visual.tableData.caption && (
            <div className="text-xs font-semibold text-[var(--text-secondary)] mb-2">
              {visual.tableData.caption}
            </div>
          )}
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead>
              <tr className="border-b border-[var(--border-strong)] bg-[var(--bg-surface)]">
                {visual.tableData.headers.map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-semibold text-[var(--text-primary)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visual.tableData.rows.map((row, rIdx) => (
                <tr key={rIdx} className="border-b border-[var(--border-hairline)] last:border-b-0">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 text-[var(--text-primary)]">
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isOptionTile && visual.caption && visual.visualType !== 'image_asset' && (
        <figcaption className="mt-2 text-xs text-[var(--text-muted)]">{visual.caption}</figcaption>
      )}
    </>
  );

  return (
    <>
      {isOptionTile ? (
        <div className="w-full h-full flex items-center justify-center">{content}</div>
      ) : (
        <figure
          className={`rounded-[12px] border border-[#E5DFD5] bg-white ${
            isCompact ? 'p-2' : 'p-4'
          }`}
        >
          {content}
        </figure>
      )}

      {zoomOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="presentation"
            className="fixed inset-0 z-50 m-0 bg-[#113C36]/45 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-6 transition-opacity duration-150 starting:opacity-0"
            onClick={() => setZoomOpen(false)}
          >
            <div
              ref={zoomRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={zoomTitleId}
              tabIndex={-1}
              className="max-w-4xl w-full max-h-[calc(100dvh-1.5rem)] overflow-auto bg-[var(--bg-elevated)] rounded-[var(--radius-lg)] border border-[var(--border-hairline)] p-4 sm:p-6 shadow-xl outline-none transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 starting:scale-[0.97]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 mb-4">
                <h3 id={zoomTitleId} className="min-w-0 text-sm font-semibold text-[var(--text-primary)]">
                  {visual.caption || visual.altText}
                </h3>
                <button
                  type="button"
                  onClick={() => setZoomOpen(false)}
                  aria-label={t('ws.closeZoom')}
                  className="p-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {visual.visualType === 'inline_svg' && visual.svgMarkup && (
                <div
                  className="visual-svg-host flex justify-center [&_svg]:w-full [&_svg]:max-h-[70vh]"
                  dangerouslySetInnerHTML={safeSvg}
                />
              )}
              {visual.visualType === 'image_asset' && visual.imageUrl && (
                <img
                  src={visual.imageUrl}
                  alt={visual.altText}
                  referrerPolicy="no-referrer"
                  decoding="async"
                  className="mx-auto max-h-[72vh] w-auto object-contain"
                />
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
});
