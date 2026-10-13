import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, writeTextFile } from "@tauri-apps/plugin-fs";
import { isAudioFile } from "@/core/audio";
import { cloneFolders, isInside, leafFolders, normalizeRoot } from "@/core/clone";

export interface ScanResult {
  tracks: number;
  /** Every folder below the root, as "/"-separated paths relative to it. */
  folders: string[];
}

export interface CloneResult {
  foldersCreated: number;
}

/** Opens the OS folder picker. Resolves to null when the user cancels. */
export async function pickFolder(title: string): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    recursive: true,
    title,
  });
  return typeof picked === "string" ? picked : null;
}

/**
 * Walks a library root, counting audio files and recording its folder tree.
 * Serato's own `_Serato_` folder is skipped because it holds databases and
 * crates, not tracks.
 */
export async function scanLibrary(root: string): Promise<ScanResult> {
  const result: ScanResult = { tracks: 0, folders: [] };
  const pending = [""];

  while (pending.length > 0) {
    const rel = pending.pop()!;
    const dir = rel ? `${root}/${rel}` : root;
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory) {
        if (entry.name === "_Serato_") continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        result.folders.push(child);
        pending.push(child);
      } else if (entry.isFile && isAudioFile(entry.name)) {
        result.tracks += 1;
      }
    }
  }

  result.folders.sort();
  return result;
}

/**
 * Turns `cloneRoot` into a managed clone of `sourceRoot`: writes the
 * `Tracks/` tree mirroring the source's folders, an empty `Crates/`, and a
 * `clooner.json` marker. No track files are copied yet.
 */
export async function createClone(
  sourceRoot: string,
  cloneRoot: string,
  scan: ScanResult,
  onProgress?: (done: number, total: number) => void,
): Promise<CloneResult> {
  if (isInside(sourceRoot, cloneRoot)) {
    throw new Error("A clone cannot live inside the source library.");
  }
  if (isInside(cloneRoot, sourceRoot)) {
    throw new Error("A clone cannot contain the source library.");
  }
  const marker = `${cloneRoot}/clooner.json`;
  if (await exists(marker)) {
    throw new Error("That folder is already a clooner location.");
  }

  // Only the deepest folders need an explicit mkdir; recursive creation
  // fills in their ancestors. Calls run concurrently because each one is an
  // IPC round trip and a large library can have thousands of folders.
  const folders = cloneFolders(leafFolders(scan.folders));
  let done = 0;
  await forEachConcurrent(folders, 32, async (folder) => {
    await mkdir(`${cloneRoot}/${folder}`, { recursive: true });
    onProgress?.(++done, folders.length);
  });

  const db = {
    version: 1,
    kind: "clone",
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    source: { path: normalizeRoot(sourceRoot) },
  };
  await writeTextFile(marker, JSON.stringify(db, null, 2) + "\n");

  return { foldersCreated: scan.folders.length + 2 };
}

async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
