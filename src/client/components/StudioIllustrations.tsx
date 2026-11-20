import type { SectionCode } from '../../shared/contracts';

/**
 * Isometric ink-drawn open book + floating star illustration for Today's Practice (Apricot card).
 */
export function IsometricBookStarIllustration({ className = 'w-28 h-24' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 132 108"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Subtle grounded shadow */}
      <ellipse cx="66" cy="92" rx="46" ry="7" fill="#113C36" fillOpacity="0.09" />

      {/* Book cover base */}
      <path
        d="M16 58L64 81L114 58L114 66L64 89L16 66V58Z"
        fill="#E9A87D"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />

      {/* Left open pages */}
      <path
        d="M18 52C31 44 49 45 64 56V80C49 69 31 68 18 75V52Z"
        fill="#FFFBF6"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      {/* Right open pages */}
      <path
        d="M112 52C99 44 81 45 64 56V80C81 69 99 68 112 75V52Z"
        fill="#FFFFFF"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />

      {/* Page ruled ink lines (left) */}
      <path d="M27 56C37 52 47 53 56 59" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />
      <path d="M27 63C37 59 47 60 56 66" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />

      {/* Page ruled ink lines (right) */}
      <path d="M103 56C93 52 83 53 74 59" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />
      <path d="M103 63C93 59 83 60 74 66" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />

      {/* Bookmark ribbon */}
      <path
        d="M64 56V87L69 83L74 87V54"
        fill="#113C36"
        stroke="#113C36"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />

      {/* Primary editorial four-point star */}
      <path
        d="M84 14C85.2 21.8 88.2 24.8 96 26C88.2 27.2 85.2 30.2 84 38C82.8 30.2 79.8 27.2 72 26C79.8 24.8 82.8 21.8 84 14Z"
        fill="#FFFBF6"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />

      {/* Secondary small star & sparkle */}
      <path
        d="M44 22C44.7 26.2 46.3 27.8 50.5 28.5C46.3 29.2 44.7 30.8 44 35C43.3 30.8 41.7 29.2 37.5 28.5C41.7 27.8 43.3 26.2 44 22Z"
        fill="#113C36"
      />
      <circle cx="62" cy="36" r="2.2" fill="#113C36" />
    </svg>
  );
}

/**
 * Isometric ink-drawn fountain pen + manuscript sheets for Writing Sprint (Warm Stone card).
 */
export function IsometricPenManuscriptIllustration({ className = 'w-24 h-20' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Grounded shadow */}
      <ellipse cx="60" cy="83" rx="40" ry="6" fill="#113C36" fillOpacity="0.08" />

      {/* Bottom stacked sheet */}
      <path
        d="M22 61L66 43L98 59L54 78L22 61Z"
        fill="#E5DFD5"
        stroke="#113C36"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />

      {/* Top manuscript sheet */}
      <path
        d="M22 53L66 34L98 51L54 70L22 53Z"
        fill="#FFFFFF"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />

      {/* Manuscript lines */}
      <path d="M36 52L64 40" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />
      <path d="M43 56L72 44" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />
      <path d="M50 61L74 51" stroke="#113C36" strokeWidth="1.35" strokeLinecap="round" strokeOpacity="0.45" />

      {/* Diagonal fountain pen barrel */}
      <path
        d="M84 14L93 22L63 54L54 46L84 14Z"
        fill="#F29A63"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      {/* Gold/Pine ring */}
      <path d="M58 42L67 50" stroke="#113C36" strokeWidth="2.5" strokeLinecap="round" />
      {/* Fountain pen nib */}
      <path
        d="M54 46L63 54L47 61L54 46Z"
        fill="#FFFBF6"
        stroke="#113C36"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M54 54L47 61" stroke="#113C36" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="55.5" cy="52.5" r="1.4" fill="#113C36" />
    </svg>
  );
}

/**
 * Isometric ink-drawn geometry compass + timer for Official Mock (Soft Eucalyptus card).
 */
export function IsometricCompassTimerIllustration({ className = 'w-24 h-20' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Grounded shadow */}
      <ellipse cx="60" cy="83" rx="38" ry="6" fill="#113C36" fillOpacity="0.08" />

      {/* Exam stopwatch body */}
      <circle
        cx="74"
        cy="54"
        r="21"
        fill="#FFFFFF"
        stroke="#113C36"
        strokeWidth="1.75"
      />
      <circle cx="74" cy="54" r="16" stroke="#113C36" strokeWidth="1.2" strokeOpacity="0.22" />
      {/* Stopwatch crown */}
      <path d="M70 33V28H78V33" fill="#E5F0EA" stroke="#113C36" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="M67 28H81" stroke="#113C36" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M89 39L93 35" stroke="#113C36" strokeWidth="1.75" strokeLinecap="round" />
      {/* Stopwatch hands */}
      <path d="M74 54V43" stroke="#113C36" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M74 54L82 58" stroke="#F29A63" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="74" cy="54" r="2.2" fill="#113C36" />

      {/* Drafting compass */}
      <circle cx="38" cy="25" r="4.5" fill="#F9CAA7" stroke="#113C36" strokeWidth="1.75" />
      <path d="M38 17V20.5" stroke="#113C36" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M35.5 29L23 73" stroke="#113C36" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M40.5 29L52 72" stroke="#113C36" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M26 57C33 61 42 61 49 57" stroke="#113C36" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="3 2.5" />
    </svg>
  );
}

/**
 * Square 36px editorial SVG thumbnail for section drill rows and recent session rows.
 */
export function SectionThumbnail({
  kind,
  className = 'w-9 h-9',
}: {
  kind: SectionCode | 'DAILY' | 'MOCK';
  className?: string;
}) {
  if (kind === 'READ') {
    return (
      <div
        className={`${className} rounded-[10px] bg-[#FDF1E7] border border-[#E5DFD5] flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <path
            d="M4 6.5C6.5 5.5 9.5 5.8 12 7.5C14.5 5.8 17.5 5.5 20 6.5V17.5C17.5 16.5 14.5 16.8 12 18.5C9.5 16.8 6.5 16.5 4 17.5V6.5Z"
            fill="#FFFFFF"
            stroke="#113C36"
            strokeWidth="1.65"
            strokeLinejoin="round"
          />
          <path d="M12 7.5V18.5" stroke="#113C36" strokeWidth="1.5" />
        </svg>
      </div>
    );
  }

  if (kind === 'MATH') {
    return (
      <div
        className={`${className} rounded-[10px] bg-[#E5F0EA] border border-[#D4E4DC] flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <path
            d="M5 17.5L11.5 6L19 17.5H5Z"
            fill="#FFFFFF"
            stroke="#113C36"
            strokeWidth="1.65"
            strokeLinejoin="round"
          />
          <path d="M9.5 14.5H13.5" stroke="#113C36" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="11.5" cy="11.2" r="1.1" fill="#113C36" />
        </svg>
      </div>
    );
  }

  if (kind === 'THINK') {
    return (
      <div
        className={`${className} rounded-[10px] bg-[#F3EFE8] border border-[#E5DFD5] flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <path
            d="M12 4.5L18.5 8.2V15.8L12 19.5L5.5 15.8V8.2L12 4.5Z"
            fill="#FFFFFF"
            stroke="#113C36"
            strokeWidth="1.65"
            strokeLinejoin="round"
          />
          <path d="M12 12L18.5 8.2M12 12L5.5 8.2M12 12V19.5" stroke="#113C36" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }

  if (kind === 'WRIT') {
    return (
      <div
        className={`${className} rounded-[10px] bg-[#ECE8E1] border border-[#DFD8CC] flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <path
            d="M15.8 5.2L18.8 8.2L9.5 17.5L5.5 18.5L6.5 14.5L15.8 5.2Z"
            fill="#FFFFFF"
            stroke="#113C36"
            strokeWidth="1.65"
            strokeLinejoin="round"
          />
          <path d="M13.5 7.5L16.5 10.5" stroke="#F29A63" strokeWidth="1.75" />
        </svg>
      </div>
    );
  }

  if (kind === 'MOCK') {
    return (
      <div
        className={`${className} rounded-[10px] bg-[#E5F0EA] border border-[#D4E4DC] flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
          <circle cx="12" cy="13" r="6.5" fill="#FFFFFF" stroke="#113C36" strokeWidth="1.65" />
          <path d="M10 4.5H14M12 4.5V6.5M12 13V9.8M12 13L14.5 14.5" stroke="#113C36" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  return (
    <div
      className={`${className} rounded-[10px] bg-[#F9CAA7]/60 border border-[#E5DFD5] flex items-center justify-center shrink-0`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
        <path
          d="M12 4.5C12.9 9.2 14.8 11.1 19.5 12C14.8 12.9 12.9 14.8 12 19.5C11.1 14.8 9.2 12.9 4.5 12C9.2 11.1 11.1 9.2 12 4.5Z"
          fill="#FFFFFF"
          stroke="#113C36"
          strokeWidth="1.65"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
