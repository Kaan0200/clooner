// Keeps track lengths available for a set of tracks: what the library
// already knows is used as is, anything else is read from the files and
// saved back in batches.

import { useEffect, useRef, useState } from "react";
import { readDurations } from "@/lib/durations";

/** How long to gather freshly read lengths before saving them together. */
const SAVE_DELAY_MS = 500;

/** A track to know the length of: its key in the library and the file to read. */
export interface DurationTarget {
  key: string;
  file: string;
}

export function useDurations(
  targets: DurationTarget[],
  saved: Record<string, number>,
  save: (updates: Record<string, number>) => void,
): Record<string, number> {
  /** Read this session but possibly not yet saved. */
  const [fresh, setFresh] = useState<Record<string, number>>({});
  /** Files that gave no length; not retried this session. */
  const failed = useRef(new Set<string>());
  const pendingSave = useRef<Record<string, number>>({});
  const saveRef = useRef(save);
  saveRef.current = save;

  // Outside Tauri there is no asset protocol to read files through.
  const canRead = "__TAURI_INTERNALS__" in window;

  // Which files still need reading. Keyed so the effect only reruns when the
  // set of unknown tracks actually changes, not on every render.
  const missing = canRead
    ? targets.filter(
        (t) => saved[t.key] === undefined && fresh[t.key] === undefined && !failed.current.has(t.key),
      )
    : [];
  const missingKey = missing
    .map((t) => t.key)
    .sort()
    .join("\n");

  useEffect(() => {
    if (missing.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keyOf = new Map(missing.map((t) => [t.file, t.key]));

    const flush = () => {
      timer = undefined;
      const updates = pendingSave.current;
      pendingSave.current = {};
      if (Object.keys(updates).length > 0) saveRef.current(updates);
    };

    const cancel = readDurations(
      missing.map((t) => t.file),
      (file, seconds) => {
        const key = keyOf.get(file);
        if (key === undefined) return;
        if (seconds === null) {
          failed.current.add(key);
          return;
        }
        setFresh((prev) => ({ ...prev, [key]: seconds }));
        pendingSave.current[key] = seconds;
        timer ??= setTimeout(flush, SAVE_DELAY_MS);
      },
    );

    return () => {
      cancel();
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    };
    // `missingKey` stands in for `missing`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  return { ...fresh, ...saved };
}
