import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { isAudioFile } from "@/core/audio";
import { cloneFolders, isInside, leafFolders, normalizeRoot } from "@/core/clone";
import {
  MANIFEST_VERSION,
  manifestPath,
  parseManifest,
  serializeManifest,
  type Manifest,
  type Peer,
} from "@/core/manifest";
import { baseName } from "@/core/paths";
import { writeTextAtomic } from "@/lib/store";

export interface ScanResult {
  tracks: number;
  /** Every folder below the root, as "/"-separated paths relative to it. */
  folders: string[];
  /** Every audio file below the root, as "/"-separated paths relative to it. */
  files: string[];
}

export interface CloneResult {
  /** The clone's location id. */
  id: string;
  /** What the clone is called. */
  name: string;
  /** True when the folder was already a clooner clone and has been re-attached. */
  existing: boolean;
  /** Folders now present in the clone, including any created on this pass. */
  folders: number;
  /** Audio files found under the clone's `Tracks/`. */
  tracks: number;
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
 * Reads the manifest at a location root. Resolves to null when there is
 * none. Throws when the file exists but isn't a clooner manifest, so an
 * unrelated `clooner.json` is never overwritten.
 */
export async function readManifestAt(root: string): Promise<Manifest | null> {
  const path = manifestPath(root);
  if (!(await exists(path))) return null;
  return parseManifest(await readTextFile(path));
}

/** Writes a location's manifest, atomically and coalesced. */
export function writeManifestAt(root: string, manifest: Manifest): Promise<void> {
  return writeTextAtomic(manifestPath(root), serializeManifest(manifest));
}

/**
 * Walks a library root, counting audio files and recording its folder tree.
 * Serato's own `_Serato_` folder is skipped because it holds databases and
 * crates, not tracks.
 */
export async function scanLibrary(root: string): Promise<ScanResult> {
  const result: ScanResult = { tracks: 0, folders: [], files: [] };
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
        result.files.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }

  result.folders.sort();
  result.files.sort();
  return result;
}

/**
 * Makes `cloneRoot` a clone of the library described by `source`, or
 * re-attaches it when it already is one. Either way the `Tracks/` tree is
 * brought up to date with the source's folders (creating a folder that
 * exists is a no-op), `Crates/` is ensured, the clone's own tracks are
 * counted, and the clone's manifest is written with the source's crates and
 * revision and the source as a peer. No track files are copied yet.
 */
export async function attachClone(
  source: Manifest,
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
  const previous = await readManifestAt(cloneRoot);
  if (previous?.kind === "source") {
    throw new Error("That folder is a source library, not a clone.");
  }
  if (previous?.libraryId && source.libraryId && previous.libraryId !== source.libraryId) {
    throw new Error(
      `That folder is a clone of a different library${previous.name ? ` ("${previous.name}")` : ""}.`,
    );
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

  // An existing clone may already hold tracks; a fresh one never does.
  const tracks = previous ? (await scanLibrary(`${cloneRoot}/Tracks`)).tracks : 0;

  const now = new Date().toISOString();
  const known = previous?.peers[source.locationId];
  const sourcePeer: Peer = {
    name: source.name,
    kind: "source",
    revision: known?.revision ?? 0,
    lastSync: known?.lastSync ?? null,
    path: normalizeRoot(sourceRoot),
  };
  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    kind: "clone",
    libraryId: source.libraryId,
    locationId: previous?.locationId ?? crypto.randomUUID(),
    name: previous?.name || baseName(cloneRoot),
    created: previous?.created ?? now,
    revision: source.revision,
    crates: source.crates,
    tracks: source.tracks,
    peers: { ...(previous?.peers ?? {}), [source.locationId]: sourcePeer },
    synced: previous?.synced ?? {},
  };
  await writeManifestAt(cloneRoot, manifest);

  return {
    id: manifest.locationId,
    name: manifest.name,
    existing: previous !== null,
    folders: scan.folders.length + 2,
    tracks,
  };
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
