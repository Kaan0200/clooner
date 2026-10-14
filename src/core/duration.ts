// Track lengths: adding them up and showing them.

/** The key a track's length is stored under: its path, normalized and case-folded. */
export function durationKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** "m:ss" under an hour, "h:mm:ss" from an hour on. Fractions are rounded away. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export interface DurationSum {
  /** Total of the tracks whose length is known. */
  seconds: number;
  /** How many tracks have no known length. */
  unknown: number;
}

/** Adds up the known lengths of some tracks. */
export function sumDurations(paths: string[], known: Record<string, number>): DurationSum {
  let seconds = 0;
  let unknown = 0;
  for (const path of paths) {
    const length = known[durationKey(path)];
    if (length === undefined) unknown += 1;
    else seconds += length;
  }
  return { seconds, unknown };
}
