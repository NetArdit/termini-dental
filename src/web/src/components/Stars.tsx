// Stars, shown and chosen. Shown: the number is also said in words, so the picture is never the only way
// to know it. Chosen: five radio buttons that look like stars, usable with the keyboard like any radio group.

const PATH = "M10 1.800l2.500 5.200 5.700.8-4.100 4 1 5.700L10 14.800 4.900 17.500l1-5.700-4.100-4 5.700-.8z";

function Star({ fill }: { fill: number }) {
  // `fill` from 0 to 1: how much of this star is coloured.
  return (
    <span className="relative inline-block size-[1.1em]" aria-hidden="true">
      <svg viewBox="0 0 20 20" className="absolute inset-0 size-full text-line-strong" fill="currentColor">
        <path d={PATH} />
      </svg>
      <span className="absolute inset-0 overflow-hidden" style={{ width: `${Math.round(fill * 100)}%` }}>
        <svg viewBox="0 0 20 20" className="size-[1.1em] text-amber-500" fill="currentColor">
          <path d={PATH} />
        </svg>
      </span>
    </span>
  );
}

export function Stars({ value, count, className = "" }: { value: number; count?: number; className?: string }) {
  const label = `${value.toLocaleString("sq", { maximumFractionDigits: 1 })} nga 5${count === undefined ? "" : `, ${count} ${count === 1 ? "vlerësim" : "vlerësime"}`}`;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="inline-flex" role="img" aria-label={label}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Star key={i} fill={Math.max(0, Math.min(1, value - i))} />
        ))}
      </span>
      {count === undefined ? null : (
        <span className="text-sm text-ink-soft" aria-hidden="true">
          {value.toLocaleString("sq", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ({count})
        </span>
      )}
    </span>
  );
}

export function StarPicker({ value, onChange, name }: { value: number; onChange: (value: number) => void; name: string }) {
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-ink">Sa yje i jepni?</legend>
      <div className="flex gap-1 text-3xl">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer rounded-md has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-700">
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} className="sr-only" />
            <span className="sr-only">{n === 1 ? "1 yll" : `${n} yje`}</span>
            <Star fill={n <= value ? 1 : 0} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
