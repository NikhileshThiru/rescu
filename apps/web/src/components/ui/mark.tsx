/** The Rescu mark: hex outline + airdrop. Same SVG on every page. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z" fill="none" stroke="#2dd4bf" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 7v10M8 11.5l4 4 4-4" fill="none" stroke="#e6edf7" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ subtitle, compact }: { subtitle?: string; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <Mark />
      <span className="text-[15px] font-semibold tracking-tight">Rescu</span>
      {subtitle && !compact && <span className="hidden text-sm text-text-3 lg:inline">{subtitle}</span>}
    </div>
  );
}
