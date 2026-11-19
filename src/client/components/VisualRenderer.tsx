import { useEffect, useState } from 'react';
import { ImageOff, Maximize2, X } from 'lucide-react';
import type { VisualSpec } from '../../shared/contracts';

function sanitizeSvg(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

interface VisualRendererProps {
  visual?: VisualSpec;
  compact?: boolean;
}

export function VisualRenderer({ visual, compact = false }: VisualRendererProps) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [visual?.imageUrl]);

  if (!visual || visual.visualType === 'none') return null;

  return (
    <>
      <figure
        className={`rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--bg-elevated)] ${
          compact ? 'p-2' : 'p-4'
        }`}
      >
        {visual.visualType === 'inline_svg' && visual.svgMarkup && (
          <div className="relative group">
            <div
              className="flex justify-center overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
              role="img"
              aria-label={visual.altText}
              dangerouslySetInnerHTML={{ __html: sanitizeSvg(visual.svgMarkup) }}
            />
            {!compact && (
              <button
                type="button"
                onClick={() => setZoomOpen(true)}
                aria-label={`Zoom diagram: ${visual.altText}`}
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Zoom diagram</span>
              </button>
            )}
          </div>
        )}

        {visual.visualType === 'image_asset' && visual.imageUrl && (
          <div>
            {!imgError ? (
              <button
                type="button"
                onClick={() => !compact && setZoomOpen(true)}
                aria-label={`Inspect image: ${visual.altText}`}
                className={`block w-full text-left ${compact ? '' : 'cursor-zoom-in'}`}
              >
                <img
                  src={visual.imageUrl}
                  alt={visual.altText}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className={`mx-auto object-contain rounded-[var(--radius-sm)] ${
                    compact ? 'max-h-28 w-auto' : 'max-h-72 w-auto'
                  }`}
                />
              </button>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-6 px-4 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs text-center">
                <ImageOff className="w-5 h-5" />
                <span>{visual.altText || 'Visual asset unavailable'}</span>
              </div>
            )}
            {!compact && !imgError && (
              <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
                <span>{visual.caption || visual.altText}</span>
                <button
                  type="button"
                  onClick={() => setZoomOpen(true)}
                  className="inline-flex items-center gap-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>Zoom</span>
                </button>
              </div>
            )}
          </div>
        )}

        {visual.visualType === 'structured_table' && visual.tableData && (
          <div className="overflow-x-auto">
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

        {visual.caption && visual.visualType !== 'image_asset' && (
          <figcaption className="mt-2 text-xs text-[var(--text-muted)]">{visual.caption}</figcaption>
        )}
      </figure>

      {zoomOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={visual.altText}
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
          onClick={() => setZoomOpen(false)}
        >
          <div
            className="max-w-4xl w-full bg-[var(--bg-elevated)] rounded-[var(--radius-lg)] border border-[var(--border-hairline)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {visual.caption || visual.altText}
              </h3>
              <button
                type="button"
                onClick={() => setZoomOpen(false)}
                aria-label="Close zoom preview"
                className="p-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {visual.visualType === 'inline_svg' && visual.svgMarkup && (
              <div
                className="flex justify-center [&_svg]:w-full [&_svg]:max-h-[70vh]"
                dangerouslySetInnerHTML={{ __html: sanitizeSvg(visual.svgMarkup) }}
              />
            )}
            {visual.visualType === 'image_asset' && visual.imageUrl && (
              <img
                src={visual.imageUrl}
                alt={visual.altText}
                referrerPolicy="no-referrer"
                className="mx-auto max-h-[72vh] w-auto object-contain"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
