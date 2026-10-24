/** Silicr mark: a die with a sealed core. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <rect x="9" y="9" width="6" height="6" rx="1.2" fill="currentColor" />
      <path d="M8 2v2.5M12 2v2.5M16 2v2.5M8 19.5V22M12 19.5V22M16 19.5V22M2 8h2.5M2 12h2.5M2 16h2.5M19.5 8H22M19.5 12H22M19.5 16H22" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
