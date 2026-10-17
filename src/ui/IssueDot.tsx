import type { TrackIssue } from "@/core/issues";

/**
 * The dot on a track row. Red for a sync conflict, since an edit may have
 * been lost; amber for a duplicate. Hovering it explains every issue.
 */
export function IssueDot({ issues }: { issues: TrackIssue[] }) {
  const detail = issues.map((i) => i.detail).join("\n\n");
  const color = issues[0].kind === "sync" ? "bg-destructive" : "bg-amber-500";
  return (
    <span
      role="img"
      aria-label={detail}
      title={detail}
      // Padding makes the dot easier to hover than its two pixels alone.
      className="flex size-5 items-center justify-center"
    >
      <span className={`size-2 rounded-full ${color}`} />
    </span>
  );
}
