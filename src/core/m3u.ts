// Extended M3U playlists.
//
// A playlist is plain text: a header line, then for every track a
// `#EXTINF` line with its title followed by its path. It is the lowest
// common denominator every player opens, which is why a crate can be
// auditioned by opening one.

export interface PlaylistEntry {
  /** Absolute path, with either separator. */
  path: string;
  /** Shown by the player. Defaults to the file name without its extension. */
  title?: string;
}

export type Separator = "/" | "\\";

/** Builds the playlist text. Paths are written with the given separator. */
export function buildM3u(entries: PlaylistEntry[], separator: Separator = "/"): string {
  const lines = ["#EXTM3U"];
  for (const entry of entries) {
    lines.push(`#EXTINF:-1,${entry.title ?? titleOf(entry.path)}`);
    lines.push(entry.path.replace(/[\\/]/g, separator));
  }
  return lines.join("\n") + "\n";
}

/** The file name without its extension: "C:/Music/Club/Track.mp3" -> "Track". */
export function titleOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The separator a path's own platform expects: backslashes for drive-letter paths. */
export function nativeSeparator(path: string): Separator {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\") ? "\\" : "/";
}
