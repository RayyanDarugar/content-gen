export function PhoneFrame({
  aspectRatio, children,
}: { aspectRatio: string; children: React.ReactNode }) {
  const [w, h] = aspectRatio.split(":").map((n) => Number(n) || 1);
  return (
    <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-2xl border bg-black text-white shadow-lg">
      <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
        {children}
      </div>
    </div>
  );
}
