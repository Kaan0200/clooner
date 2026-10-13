import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { cloneCrateFolder, cloneTrackPath } from "@/core/clone";
import { buildM3u, nativeSeparator } from "@/core/m3u";
import { encodeName } from "@/core/names";

export interface PlaylistRequest {
  /** The crate's path in the tree, outermost first. The last is the crate itself. */
  crateNames: string[];
  /** The crate's tracks as absolute source paths. */
  tracks: string[];
  sourceRoot: string;
  cloneRoot: string;
}

export interface PlaylistResult {
  /** The playlist written, inside the clone's `Crates/` folder. */
  file: string;
  /** Tracks that weren't under the source root and were listed by their own path. */
  outsideLibrary: number;
}

/**
 * Writes `<clone>/Crates/<crate path>/<crate>.m3u` listing the crate's tracks
 * as they are laid out in the clone, then opens it with the default player.
 * The file starts with a byte-order mark so Windows players read it as UTF-8.
 */
export async function openCratePlaylist(request: PlaylistRequest): Promise<PlaylistResult> {
  const { crateNames, tracks, sourceRoot, cloneRoot } = request;
  if (crateNames.length === 0) throw new Error("A playlist needs a crate.");

  let outsideLibrary = 0;
  const entries = tracks.map((track) => {
    const inClone = cloneTrackPath(sourceRoot, cloneRoot, track);
    if (inClone === null) outsideLibrary += 1;
    return { path: inClone ?? track };
  });

  const folder = cloneCrateFolder(cloneRoot, crateNames);
  const file = `${folder}/${encodeName(crateNames[crateNames.length - 1])}.m3u`;
  await mkdir(folder, { recursive: true });
  await writeTextFile(file, "﻿" + buildM3u(entries, nativeSeparator(cloneRoot)));
  await openPath(file);

  return { file, outsideLibrary };
}
