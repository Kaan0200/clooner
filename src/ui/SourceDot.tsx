import type { SourceEntry } from "@/core/db";
import type { SourceStatus } from "@/lib/useLibrary";
import { describeSource } from "@/lib/utils";

/**
 * A small dot in the footer that shows whether the source is connected:
 * green when scanned, amber while scanning, red when missing or broken.
 * Hovering it gives the source's path and what the last scan found.
 */
export function SourceDot({
  source,
  status,
}: {
  source: SourceEntry;
  status: SourceStatus | null;
}) {
  const color =
    status?.kind === "ready"
      ? "bg-emerald-500"
      : status?.kind === "scanning"
        ? "bg-amber-500"
        : "bg-destructive";
  const detail = `Source: ${source.path}. ${describeSource(status)}.`;
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      // Padding makes the dot easier to hover than its two pixels alone.
      className="flex size-5 shrink-0 items-center justify-center"
    >
      <span className={`size-2 rounded-full ${color}`} />
    </span>
  );
}
