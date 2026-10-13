import { encodePath } from "./names";

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
