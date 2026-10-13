import { encodeName, encodePath } from "./names";

/**
 * Where a source track lives inside a clone: the same path relative to the
 * root, under `Tracks/`, with names encoded. Null when the track isn't under
 * the source root at all.
 */
export function cloneTrackPath(sourceRoot: string, cloneRoot: string, track: string): string | null {
  const root = normalizeRoot(sourceRoot);
  const path = normalizeRoot(track);
  if (!isInside(root, path) || path.length === root.length) return null;
  const relative = path.slice(root.length + 1);
  return `${normalizeRoot(cloneRoot)}/Tracks/${encodePath(relative)}`;
}

/**
 * The folder that holds a crate's playlists inside a clone: `Crates/` then
 * one encoded folder per level of the crate's path, outermost first.
 */
export function cloneCrateFolder(cloneRoot: string, crateNames: string[]): string {
  return [normalizeRoot(cloneRoot), "Crates", ...crateNames.map(encodeName)].join("/");
}

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

/**
 * The folders a fresh clone needs, relative to the clone root, given the
 * source's folder tree (relative "/"-separated paths, excluding the root).
 * Source names are encoded so they are legal on exFAT and FAT drives.
 */
export function cloneFolders(sourceFolders: string[]): string[] {
  const out = ["Tracks", "Crates"];
  for (const folder of sourceFolders) {
    if (folder) out.push(`Tracks/${encodePath(folder)}`);
  }
  return out;
}

/**
 * Drops every folder that is an ancestor of another in the list, since a
 * recursive mkdir of the deepest folders creates the ancestors for free.
 * Folders are "/"-separated relative paths, in any order.
 */
export function leafFolders(folders: string[]): string[] {
  const parents = new Set<string>();
  for (const folder of folders) {
    let slash = folder.lastIndexOf("/");
    while (slash > 0) {
      parents.add(folder.slice(0, slash));
      slash = folder.lastIndexOf("/", slash - 1);
    }
  }
  return folders.filter((f) => !parents.has(f));
}
