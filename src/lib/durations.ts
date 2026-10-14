// Reading how long a track is.
//
// The webview's own media decoders do the work: an audio element loads just
// the file's metadata through Tauri's asset protocol and reports its
// duration. Nothing is decoded beyond the headers, and formats the webview
// can't play (AIFF, for one) simply report no length.

import { convertFileSrc } from "@tauri-apps/api/core";

/** How long to wait for one file's metadata before giving up. */
const TIMEOUT_MS = 15_000;
/** Files inspected at once. More than this just thrashes a USB drive. */
const CONCURRENCY = 3;

/** The track's length in seconds, or null when it can't be determined. */
export function readDuration(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";

    const finish = (value: number | null) => {
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load(); // Releases the file handle.
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      finish(Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
    };
    audio.onerror = () => finish(null);
    audio.src = convertFileSrc(path);
  });
}

/**
 * Reads the lengths of many tracks a few at a time, reporting each as it
 * arrives. The returned function stops any reads not yet started.
 */
export function readDurations(
  paths: string[],
  onResult: (path: string, seconds: number | null) => void,
): () => void {
  const pending = [...paths];
  let cancelled = false;

  const worker = async () => {
    while (!cancelled && pending.length > 0) {
      const path = pending.shift()!;
      const seconds = await readDuration(path);
      if (!cancelled) onResult(path, seconds);
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, pending.length); i++) void worker();

  return () => {
    cancelled = true;
    pending.length = 0;
  };
}
