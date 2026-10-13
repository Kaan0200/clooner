import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { isAudioFile } from "@/core/audio";
import { cloneFolders, isInside, leafFolders, normalizeRoot } from "@/core/clone";
import type { SyncedEntry } from "@/core/sync";

export interface ScanResult {
  tracks: number;
  /** Every folder below the root, as "/"-separated paths relative to it. */
  folders: string[];
}

export interface CloneResult {
  /** The clone's id from its `clooner.json`. */
  id: string;
  /** True when the folder was already a clooner clone and has been re-attached. */
  existing: boolean;
  /** Folders now present in the clone, including any created on this pass. */
  folders: number;
  /** Audio files found under the clone's `Tracks/`. */
  tracks: number;
}

/** The `clooner.json` marker at the root of a clone. */
export interface CloneDb {
  version: number;
  kind: "clone";
  id: string;
  created: string;
  source: { path: string };
  /** When the clone was last opened by the app, as ISO 8601. */
  attached?: string;
  /** When the clone was last synced, as ISO 8601. */
  lastSync?: string;
  /** The source state of each copied track, keyed by its source-relative path. */
  synced?: Record<string, SyncedEntry>;
}

/** The marker file's path for a clone root. */
export function cloneMarker(cloneRoot: string): string {
  return `${normalizeRoot(cloneRoot)}/clooner.json`;
}

export async function writeCloneDb(cloneRoot: string, db: CloneDb): Promise<void> {
  await writeTextFile(cloneMarker(cloneRoot), JSON.stringify(db, null, 2) + "\n");
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
 * Makes `cloneRoot` a managed clone of `sourceRoot`, or re-attaches it when
 * it already is one. Either way the `Tracks/` tree is brought up to date with
 * the source's folders (creating a folder that exists is a no-op), `Crates/`
 * is ensured, the clone's own tracks are counted, and the `clooner.json`
 * marker is written. No track files are copied yet.
 */
export async function attachClone(
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
  const previous = await readCloneDb(marker);

  // Only the deepest folders need an explicit mkdir; recursive creation
  // fills in their ancestors. Calls run concurrently because each one is an
  // IPC round trip and a large library can have thousands of folders.
  const folders = cloneFolders(leafFolders(scan.folders));
  let done = 0;
  await forEachConcurrent(folders, 32, async (folder) => {
    await mkdir(`${cloneRoot}/${folder}`, { recursive: true });
    onProgress?.(++done, folders.length);
  });

  // An existing clone may already hold tracks; a fresh one never does.
  const tracks = previous ? (await scanLibrary(`${cloneRoot}/Tracks`)).tracks : 0;

  const now = new Date().toISOString();
  const db: CloneDb = previous
    ? { ...previous, source: { path: normalizeRoot(sourceRoot) }, attached: now }
    : {
        version: 1,
        kind: "clone",
        id: crypto.randomUUID(),
        created: now,
        source: { path: normalizeRoot(sourceRoot) },
        attached: now,
      };
  await writeTextFile(marker, JSON.stringify(db, null, 2) + "\n");

  return { id: db.id, existing: previous !== null, folders: scan.folders.length + 2, tracks };
}

/**
 * Reads a clone's marker. Resolves to null when there is none. Throws when
 * the file exists but isn't a clooner clone, so an unrelated `clooner.json`
 * is never overwritten.
 */
export async function readCloneDb(marker: string): Promise<CloneDb | null> {
  if (!(await exists(marker))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readTextFile(marker));
  } catch {
    throw new Error("That folder has a clooner.json that can't be read.");
  }

  const db = parsed as Partial<CloneDb> | null;
  if (!db || typeof db !== "object" || db.kind !== "clone" || typeof db.id !== "string") {
    throw new Error("That folder's clooner.json isn't a clone.");
  }
  return db as CloneDb;
}

/**
 * The audio files among some dropped paths. A folder contributes every audio
 * file beneath it, except under `_Serato_`. Anything that can't be inspected
 * is kept only if its name looks like audio, so a scope error doesn't lose
 * the drop.
 */
export async function collectAudioFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    let isDirectory = false;
    try {
      isDirectory = (await stat(path)).isDirectory;
    } catch {
      // Fall through and judge by the name.
    }
    if (isDirectory) {
      const scan = await scanLibraryFiles(path);
      out.push(...scan);
    } else if (isAudioFile(baseName(path))) {
      out.push(path);
    }
  }
  return out;
}

/** Every audio file under `root`, as absolute paths. */
async function scanLibraryFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory) {
        if (entry.name !== "_Serato_") pending.push(`${dir}/${entry.name}`);
      } else if (entry.isFile && isAudioFile(entry.name)) {
        files.push(`${dir}/${entry.name}`);
      }
    }
  }
  return files.sort();
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

export async function forEachConcurrent<T>(
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
