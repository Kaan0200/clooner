import { useEffect, useRef, useState } from "react";

/** The inline field a crate's name is edited in. */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  /** Returns the error to show, or null when the name was accepted. */
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function commit() {
    setError(onCommit(draft));
  }

  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        aria-label="Crate name"
        aria-invalid={error ? true : undefined}
        className={`h-6 w-full rounded border bg-background px-1 text-sm outline-none focus-visible:ring-2 ${
          error
            ? "border-destructive ring-destructive/30"
            : "border-input ring-ring/50"
        }`}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        // Leaving the field keeps a valid name and drops an invalid one.
        onBlur={() => {
          if (onCommit(draft)) onCancel();
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {error && (
        <span
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 rounded-md border bg-popover px-2 py-1 text-xs text-destructive shadow-md"
        >
          {error}
        </span>
      )}
    </span>
  );
}
