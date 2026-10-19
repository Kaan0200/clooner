import { encodeName, encodePath } from "./names";
import { isAbsolutePath, normalizeRoot, relativePath } from "./paths";

export { isInside, normalizeRoot } from "./paths";

/**
 * Where a track lives inside a clone: the same path relative to the root,
 * under `Tracks/`, with names encoded. The track is a tree path (relative to
 * the source root) or an absolute path; null when it isn't under the source
 * root at all.
 */
export function cloneTrackPath(sourceRoot: string, cloneRoot: string, track: string): string | null {
  const relative = isAbsolutePath(track) ? relativePath(sourceRoot, track) : normalizeRoot(track);
  if (relative === null || relative === "") return null;
  return `${normalizeRoot(cloneRoot)}/Tracks/${encodePath(relative)}`;
}

/**
 * The folder that holds a crate's playlists inside a clone: `Crates/` then
 * one encoded folder per level of the crate's path, outermost first.
 */
export function cloneCrateFolder(cloneRoot: string, crateNames: string[]): string {
  return [normalizeRoot(cloneRoot), "Crates", ...crateNames.map(encodeName)].join("/");
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
