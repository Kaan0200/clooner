import type { IssueKind, TrackIssue } from "@/core/issues";

/** Red when an edit may be lost or a file is gone, amber for a duplicate, blue for a track shared between crates. */
const COLORS: Record<IssueKind, string> = {
  sync: "bg-destructive",
  notFound: "bg-destructive",
  duplicate: "bg-amber-500",
  shared: "bg-sky-500",
};

/**
 * The dot on a track row. Its colour is that of the first (most serious)
 * issue. Hovering it explains every issue.
 */
export function IssueDot({ issues }: { issues: TrackIssue[] }) {
  const detail = issues.map((i) => i.detail).join("\n\n");
  const color = COLORS[issues[0].kind];
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
