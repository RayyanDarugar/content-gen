export function TrainIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <rect x="10" y="14" width="11" height="9" rx="1.5" fill="currentColor" />
      <rect x="14" y="23" width="20" height="13" rx="2" fill="currentColor" />
      <circle cx="20" cy="37" r="6" fill="currentColor" />
      <circle cx="20" cy="37" r="2.4" fill="var(--sidebar)" />
      <rect x="35" y="25" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.7" />
      <rect x="35" y="30" width="7" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
    </svg>
  );
}
