// Carrying out a one-way sync from the source library into a clone.
//
// 1. Copy every track that is in a crate into the clone's `Tracks/`, skipping
//    files whose source hasn't changed since the last copy.
// 2. Write a Serato `.crate` file per crate under `_Serato_/Subcrates`.
// 3. Write the crate's playlist and one stub per track under `Crates/`.
// 4. Count clone files that are in no crate. They are reported, not deleted,
//    until deletion has a confirmation step.
// 5. Record what was copied in the clone's `clooner.json`.

import { copyFile, exists, mkdir, readDir, stat, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { isAudioFile } from "@/core/audio";
import { encodeCrate, newCrate } from "@/core/crate";
import { cloneCrateFolder } from "@/core/clone";
import { buildM3u, nativeSeparator } from "@/core/m3u";
import { encodeName } from "@/core/names";
import {
  planSync,
  needsCopy,
  seratoCrateFile,
  seratoSubcratesFolder,
  volumeRelative,
  type SyncedEntry,
  type TrackJob,
} from "@/core/sync";
import type { CrateTree } from "@/core/tree";
import { cloneMarker, forEachConcurrent, readCloneDb, writeCloneDb } from "@/lib/library";

export interface SyncSummary {
  copied: number;
  unchanged: number;
  /** Tracks whose source file couldn't be read. */
  missing: number;
  /** Tracks outside the source library, which can't be cloned. */
  outside: number;
  crates: number;
  stubs: number;
  /** Audio files in the clone's `Tracks/` that are in no crate. */
  orphans: number;
  /** When the sync finished, ISO 8601. */
  finished: string;
}

export async function syncClone(
  sourceRoot: string,
  cloneRoot: string,
  crates: CrateTree,
  onProgress: (message: string) => void,
): Promise<SyncSummary> {
  const db = await readCloneDb(cloneMarker(cloneRoot));
  if (!db) throw new Error("That folder isn't an attached clone.");

  const plan = planSync(sourceRoot, cloneRoot, crates);
  const previous = db.synced ?? {};
  const synced: Record<string, SyncedEntry> = {};
  const summary: SyncSummary = {
    copied: 0,
    unchanged: 0,
    missing: 0,
    outside: plan.outside.length,
    crates: 0,
    stubs: 0,
    orphans: 0,
    finished: "",
  };

  // 1. Tracks. Copies run a few at a time: enough to overlap IPC latency,
  // few enough not to thrash a USB drive.
  const present = new Set<string>();
  let done = 0;
  await forEachConcurrent(plan.tracks, 4, async (track) => {
    done += 1;
    onProgress(`Copying ${done.toLocaleString()} / ${plan.tracks.length.toLocaleString()}: ${fileName(track.source)}`);
    let current: SyncedEntry;
    try {
      const info = await stat(track.source);
      current = { size: info.size, mtime: info.mtime?.getTime() ?? null };
    } catch {
      summary.missing += 1;
      return;
    }

    const before = previous[track.relative];
    if (needsCopy(before, current, await exists(track.clonePath))) {
      await mkdir(parentOf(track.clonePath), { recursive: true });
      await copyFile(track.source, track.clonePath);
      summary.copied += 1;
    } else {
      summary.unchanged += 1;
    }
    synced[track.relative] = current;
    present.add(track.clonePath.toLowerCase());
  });

  const inClone = (track: TrackJob) => present.has(track.clonePath.toLowerCase());

  // 2. Serato crates. Paths are relative to the volume root, as Serato wants.
  onProgress("Writing Serato crates…");
  await mkdir(seratoSubcratesFolder(cloneRoot), { recursive: true });
  for (const crate of plan.crates) {
    const paths = crate.tracks.filter(inClone).map((t) => volumeRelative(t.clonePath));
    await writeFile(seratoCrateFile(cloneRoot, crate.names), encodeCrate(newCrate(paths)));
    summary.crates += 1;
  }

  // 3. Playlists and stubs. A stub's content is fixed by its track, so one
  // that already exists is left alone: small files are slow on cheap drives.
  const separator = nativeSeparator(cloneRoot);
  for (const crate of plan.crates) {
    onProgress(`Writing playlists: ${crate.names.join(" / ")}`);
    const folder = cloneCrateFolder(cloneRoot, crate.names);
    await mkdir(folder, { recursive: true });
    const tracks = crate.tracks.filter(inClone);
    const playlist = `${folder}/${encodeName(crate.names[crate.names.length - 1])}.m3u`;
    await writeTextFile(playlist, "﻿" + buildM3u(tracks.map((t) => ({ path: t.clonePath })), separator));
    for (const stub of crate.stubs) {
      if (!inClone(stub.track) || (await exists(stub.file))) continue;
      await writeTextFile(stub.file, "﻿" + buildM3u([{ path: stub.track.clonePath }], separator));
      summary.stubs += 1;
    }
  }

  // 4. Orphans.
  onProgress("Checking for files no crate uses…");
  for (const file of await audioFilesUnder(`${cloneRoot}/Tracks`)) {
    if (!present.has(file.toLowerCase())) summary.orphans += 1;
  }

  // 5. Record.
  summary.finished = new Date().toISOString();
  await writeCloneDb(cloneRoot, { ...db, lastSync: summary.finished, synced });
  return summary;
}

async function audioFilesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of await readDir(dir)) {
      if (entry.isDirectory) pending.push(`${dir}/${entry.name}`);
      else if (entry.isFile && isAudioFile(entry.name)) files.push(`${dir}/${entry.name}`);
    }
  }
  return files;
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
