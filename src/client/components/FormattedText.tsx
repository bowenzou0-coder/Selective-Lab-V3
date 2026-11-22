import { Fragment } from 'react';
import {
  parseFormattedBlocks,
  parseInlineSpans,
  splitSpeakerPrefix,
} from '../promptFormatting';

export type FormattedTextVariant = 'prompt' | 'boxedRules' | 'explanation' | 'prose';

interface FormattedTextProps {
  text: string;
  variant?: FormattedTextVariant;
  className?: string;
}

function InlineSpans({ text }: { text: string }) {
  const spans = parseInlineSpans(text);
  return (
    <>
      {spans.map((span, idx) => {
        if (span.type === 'bold') {
          return (
            <strong key={idx} className="font-semibold text-[#113C36]">
              {span.text}
            </strong>
          );
        }
        if (span.type === 'italic') {
          return (
            <em key={idx} className="italic">
              {span.text}
            </em>
          );
        }
        return <Fragment key={idx}>{span.text}</Fragment>;
      })}
    </>
  );
}

const VARIANT_CONTAINER_CLASS: Record<FormattedTextVariant, string> = {
  prompt: 'space-y-3 text-[16px] font-medium text-[#113C36] leading-[1.65]',
  boxedRules: 'space-y-2 text-[15px] text-[#113C36] leading-relaxed',
  explanation: 'space-y-2 text-xs text-[var(--text-secondary)] leading-relaxed',
  prose: 'reading-prose space-y-3 text-[#113C36]',
};

export function FormattedText({
  text,
  variant = 'prompt',
  className = '',
}: FormattedTextProps) {
  const blocks = parseFormattedBlocks(text, {
    isBoxedRules: variant === 'boxedRules',
  });

  if (blocks.length === 0) return null;

  const isCompact = variant === 'explanation';
  const bulletDotClass = isCompact
    ? 'w-1 h-1 rounded-full bg-[#4A5955]/75 mt-[0.62em] shrink-0'
    : 'w-1.5 h-1.5 rounded-full bg-[#113C36]/75 mt-[0.62em] shrink-0';
  const markerClass = isCompact
    ? 'font-sans-display font-semibold text-[#113C36] tabular-nums shrink-0 min-w-[1.25rem]'
    : 'font-sans-display font-semibold text-[#113C36] tabular-nums shrink-0 min-w-[1.5rem]';

  return (
    <div className={`${VARIANT_CONTAINER_CLASS[variant]} ${className}`.trim()}>
      {blocks.map((block, bIdx) => {
        if (block.kind === 'heading') {
          return (
            <div
              key={bIdx}
              className="text-[11px] font-sans-display font-semibold uppercase tracking-[0.06em] text-[#4A5955]"
            >
              {block.text}
            </div>
          );
        }

        if (block.kind === 'bullet_list') {
          return (
            <ul key={bIdx} className={isCompact ? 'space-y-1.5 pl-1' : 'space-y-2 pl-1'}>
              {block.items.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2.5">
                  <span aria-hidden="true" className={bulletDotClass} />
                  <span className="flex-1 min-w-0">
                    <InlineSpans text={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }

        if (block.kind === 'ordered_list') {
          return (
            <ol key={bIdx} className={isCompact ? 'space-y-1.5 pl-1' : 'space-y-2 pl-1'}>
              {block.items.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className={markerClass}>{item.marker}</span>
                  <span className="flex-1 min-w-0">
                    <InlineSpans text={item.text} />
                  </span>
                </li>
              ))}
            </ol>
          );
        }

        const joined = block.lines.join('\n');
        const preserveMultiSpace = / {2,}/.test(joined) || block.lines.length > 1;
        return (
          <p key={bIdx} className={preserveMultiSpace ? 'whitespace-pre-wrap' : undefined}>
            {block.lines.map((line, lIdx) => {
              const speakerParts = variant === 'prompt' ? splitSpeakerPrefix(line) : null;
              return (
                <Fragment key={lIdx}>
                  {lIdx > 0 && '\n'}
                  {speakerParts ? (
                    <>
                      <span className="font-sans-display font-semibold text-[#113C36]">
                        {speakerParts.speaker}
                      </span>{' '}
                      <InlineSpans text={speakerParts.rest} />
                    </>
                  ) : (
                    <InlineSpans text={line} />
                  )}
                </Fragment>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
