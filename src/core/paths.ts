// Track paths: written so they mean the same thing in every location.
//
// A track's path in the crate tree is relative to the library root,
// "/"-separated, with no leading slash. It is the track's identity: the same
// string names the file under the source root and, encoded, under a clone's
// `Tracks/`. A track that lives outside the library keeps its absolute path.
// It is still listed, but it has no place in a clone.

/** Normalize an absolute path for comparison: forward slashes, no trailing slash. */
export function normalizeRoot(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `child` is `parent` or lives anywhere beneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalizeRoot(parent).toLowerCase();
  const c = normalizeRoot(child).toLowerCase();
  return c === p || c.startsWith(p + "/");
}

/** True for a drive-letter, UNC or rooted path; false for a path relative to the library. */
export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.startsWith("\\");
}

/**
 * `path` relative to `root`, "/"-separated, or null when it isn't inside
 * the root (or is the root itself).
 */
export function relativePath(root: string, path: string): string | null {
  const r = normalizeRoot(root);
  const p = normalizeRoot(path);
  if (!isInside(r, p) || p.length === r.length) return null;
  return p.slice(r.length + 1);
}

/**
 * How a file is written in the crate tree: relative to the root when it is
 * inside the library, otherwise its own absolute path. Without a root every
 * file is outside.
 */
export function trackPath(root: string | null, file: string): string {
  const normalized = normalizeRoot(file);
  if (root === null) return normalized;
  return relativePath(root, normalized) ?? normalized;
}

/** Where a track's file is: under `root` for a library track, itself for one outside. */
export function absolutePath(root: string, track: string): string {
  return isAbsolutePath(track) ? normalizeRoot(track) : `${normalizeRoot(root)}/${track}`;
}

/** The folder part of a track path, "" for one at the root. */
export function folderOf(track: string): string {
  const normalized = normalizeRoot(track);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}
