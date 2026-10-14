// Keeps track lengths available for a set of paths: what the database
// already knows is used as is, anything else is read from the files and
// saved back in batches.

import { useEffect, useRef, useState } from "react";
import { durationKey } from "@/core/duration";
import { readDurations } from "@/lib/durations";

/** How long to gather freshly read lengths before saving them together. */
const SAVE_DELAY_MS = 500;

export function useDurations(
  paths: string[],
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
    ? paths.filter((p) => {
        const key = durationKey(p);
        return saved[key] === undefined && fresh[key] === undefined && !failed.current.has(key);
      })
    : [];
  const missingKey = missing.map(durationKey).sort().join("\n");

  useEffect(() => {
    if (missing.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      timer = undefined;
      const updates = pendingSave.current;
      pendingSave.current = {};
      if (Object.keys(updates).length > 0) saveRef.current(updates);
    };

    const cancel = readDurations(missing, (path, seconds) => {
      const key = durationKey(path);
      if (seconds === null) {
        failed.current.add(key);
        return;
      }
      setFresh((prev) => ({ ...prev, [key]: seconds }));
      pendingSave.current[key] = seconds;
      timer ??= setTimeout(flush, SAVE_DELAY_MS);
    });

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
