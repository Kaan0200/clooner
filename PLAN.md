# Plan

A desktop app that copies a Serato library (crates and their tracks) onto other drives and computers, and keeps every copy in sync.

## Goals

- Easy enough for non-technical DJs to install and use, so it can catch on.
- Small download.
- Written in TypeScript so it is easy to audit and to build UI for.
- **Free and open source** (MIT). Other projects are format references only (see References); GPL code is never copied.
- **One-click sync:** hit "Sync", then open Serato and everything is ready to use. The app never launches, controls or talks to Serato.
- **v1:** while Serato is running, show a notice and disable Sync until it closes.

## Stack

- **Tauri v2**: app shell and installer. It uses the system webview, so the download stays small.
- **Vite + TypeScript**: UI and core logic.
- **Vitest**: tests.

Keep the logic in TypeScript. File I/O goes through `@tauri-apps/plugin-fs` and folder picking through `@tauri-apps/plugin-dialog`. Only write Rust for what the plugins can't do, such as checking whether Serato is running or listing Windows drive letters.

## Model

- **Library (logical):** tracks plus crates. A crate is a set of tracks. Crates are the same in every location.
- **Collection:** a top-level crate (for example `Weddings` or `Club`) with its subcrates. All collections share the same SOURCE.
- **Location:** a root folder with a database file at its root.
  - **SOURCE:** the complete music library. It may contain tracks that are not in any crate, and it must have a single root folder.
  - **CLONE:** a partial mirror. It holds only the tracks in the crates it syncs.
- **Layout of each location:**
  - `Tracks/` holds the real files. Paths match SOURCE, relative to the root. On SOURCE, the root folder itself is the tracks folder; SOURCE is never reorganized.
  - `Crates/` has one folder per crate, holding one generated `.m3u` stub per song, so every crate looks complete when browsing. Only changed stubs are written, because creating many small files is slow on cheap USB drives. Stubs use about 1% of the space the audio does.
  - Generated Serato `.crate` files point into `Tracks/`. On an external drive they go in `<drive>/_Serato_/Subcrates`.
- **Each track is stored once per location.** Crates reference tracks; they do not duplicate them.
- **Crates are always the truth.** Building crates from a folder is a one-time import, not a sync mode.
- **The app manages only its own crates:** its collections and everything under them. Other Serato crates are never touched.

## Name encoding

Applies to `Tracks/` paths and to `Crates/` folder and stub names. Track paths inside Serato `.crate` files must use the encoded paths, because that's where the files actually are on the clone. How Serato itself names `.crate` files for crates with these characters is still to test.

- **Swap characters that aren't allowed on exFAT, FAT or Windows for Unicode look-alikes,** like rclone does:
  - `\ / : * ? " < > |` become `＼ ／ ： ＊ ？ ＂ ＜ ＞ ｜`.
  - Control characters, a trailing space or dot, and reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9`) are encoded the same way.
- **It must be reversible.** A name that already contains a look-alike gets it escaped, so decoding is never ambiguous. A clone path decodes straight back to the SOURCE path, with no lookup table.
- **Normalize every path to Unicode NFC before comparing.** macOS can store accented characters in decomposed form, so identical-looking paths would otherwise compare as different.
- **Flag names that differ only in case** (`Track.mp3` vs `track.mp3`) as a conflict. They collide on drives that ignore case.
- **Warn about paths over 260 characters** on Windows targets. Don't shorten them, because shortening would break identity.

## Sync

- **Any two locations can sync.** There is no fixed parent and child.
- **Each location's database stores the last-synced state for each peer location.** This is the base for three-way comparison.
- **Track identity is the file name** (ignoring case and extension). File names don't change; folders do.
  - A track that isn't where its path says is looked for by name under the root on every scan, and relinked when exactly one file has that name. Several files with the name are narrowed by the old relative place, then extension, then parent folder name; a tie that remains is flagged, as is a name found nowhere (`src/core/relink.ts`).
  - A renamed file is therefore a new track; the old entry is flagged as not found.
  - Clones do the same on sync: a track whose place in `Tracks/` is empty but whose name sits elsewhere under it is renamed into place, never copied again.
- **Files:** if only one side changed since the last sync, copy that side's file over the other. If both changed, raise a conflict. Tags are never merged.
- **Crates:** merge membership. Tracks added on either side are kept, and tracks removed on either side are removed. A crate renamed or deleted on one side and edited on the other is a conflict.
- **Selection:** each clone picks individual crates from any collection, and its database lists them. SOURCE always has every crate.
  - A three-state checkbox shows all, some or none of a crate's subtree. A fully checked crate includes its future subcrates. A partly checked crate includes only the subcrates picked.
  - If a subcrate is picked but its parent isn't, the parent is written as an empty crate so the tree looks right in Serato.

## Moving the library

- **Change Source** never deletes or copies anything. It picks a new root, scans it, matches every crate member by file name, and asks before changing anything: how many tracks stay, how many were relinked, how many are ambiguous or not found.
- Pointing the root one folder up or down, moving the library to another drive, or moving tracks between folders all relink without the user doing anything. Tracks that can't be placed keep their old path and show a dot until the file is put back and the library rescanned, or the track is removed from the crate.
- Clones follow at their next sync by renaming files into their new places. Serato's own database on the clone keeps stale records for the old paths; cleaning those is still to do, as is removing orphaned files from a clone's `Tracks/`.

## Track dots

A track row shows a dot for anything that wants a decision, with a tooltip explaining every issue (`src/core/issues.ts`):

- **Sync conflict** (red): edited on both the source and a clone between syncs; the newer copy won.
- **Not found** (red): no file with its name under the root, or several and none could be chosen.
- **Duplicate** (amber): a different file whose title wholly contains, or is wholly contained in, this one's, on word boundaries. "Super Song" and "Super Song (Remix)" are duplicates; "Super Song Version 1" and "Version 2" are not, and neither are "Song" and "Songbird".
- **Shared** (blue): the same file in two crates where neither is inside the other. A track in a crate and in its subcrate is scoping, not sharing.

## Adding tracks

- **Dropped into `Crates/<crate>/`:** the crate is known but not where to store the file. The app asks for a place in `Tracks/` (suggesting a default), moves the file there and adds it to the crate.
- **Dropped into `Tracks/`:** where it's stored is known but not which crate. The track goes into an automatic `Incoming` crate and the user is told to assign crates.
- **Either way:** the Serato crate files are rewritten, and the file goes up to SOURCE at the next sync.
- **Scanning:** for v1, scan when the app opens plus a manual "Scan" button. Watching folders comes later.

## Safety rules

1. Crate changes never delete files from SOURCE. A track removed from every crate stays in SOURCE as unorganized music.
2. A clone deletes its own copy of a file once the file is in no synced crate.
3. Deleting a file on a clone does not spread to other locations. If the track is still in a crate, the next sync copies it back.
4. Generated files (`.m3u` stubs, Serato crates) are rewritten on every sync and are never treated as tracks.

## Steps

1. **Scaffold the Tauri app, then build the TS crate codec and golden tests in Vitest.** ✅ Done: `src/core/crate.ts`, `src/core/names.ts`, tests in `test/`.
   - Verify: output matches a reference crate writer byte for byte on a fixture library.
   - Verify: a filename with a non-BMP character (such as an emoji) gets correct lengths.
   - Verify: name encoding round-trips. Cover every disallowed character, reserved names, a trailing space or dot, names that already contain look-alikes, and accented names in decomposed vs. composed form.
2. **Manual check in Serato:** run the Serato behaviour tests below, from both the system drive and a USB drive.
   - Verify: the crates appear in Serato with the correct tracks, and the answers are recorded here.
3. **Clone:** copy SOURCE's crates and their tracks to a target folder, and write `Tracks/`, `Crates/`, the Serato crates and the database.
   - Verify: on a fresh machine, Serato shows the clone's crates playing from the clone's files.
4. **Sync** between two locations: files, crates and conflicts.
   - Verify with tests: one side changed, both sides changed, renames, adds and removes.
5. **UI:** the Locations and Collections screens (see UI below).

## UI

There is no UI for folders; the OS file browser already handles them. Moving things around in the app is done by dragging. The app has two screens:

- **Locations:** a panel with every location and its status, plus a **New** button for creating a clone.
  - **Connected** locations (on this computer or a plugged-in drive) can sync.
  - **Not connected** locations (like another PC) are known only from sync history: "last synced with GIG USB 3 days ago".
  - Opening a location lists its **Conflicts**, **Incoming** tracks (not in any crate) and **Missing** tracks (in a crate but missing from SOURCE).
  - A banner shows while Serato is running, and **Sync** is disabled until Serato closes. Sync syncs every pair of connected locations.
- **Collections:** create and manage collections (top-level crate trees) and their crates, and choose which crates each clone holds. The tree is an always-visible side panel, so tracks can be dragged onto it from any screen.
  - Tracks are added by dragging them from a location's lists, or from Finder or Explorer, onto a crate.

## Crate format reference

Implemented in `src/core/crate.ts`, following the community format docs (see References).

- Every field is a 4-character ASCII tag, a 4-byte big-endian length, then the data. The tag's first letter gives the data type: `o` nested fields, `t`/`p` UTF-16BE text, `b` 1-byte flag. `vrsn` holds text.
- `vrsn`: `1.0/Serato ScratchLive Crate`.
- `osrt` { `tvcn` sort column, `brev` reverse flag }.
- `ovct` { `tvcn` column name, `tvcw` width as text }, one per column.
- `otrk` { `ptrk` track path }, one per track.
- Track paths are relative to the volume root and use `/`.
- Crate files are flat. `%%` in a file name marks a subcrate.
- Crates live in `~/Music/_Serato_/Subcrates` for the system drive, and in `<Volume>/_Serato_/Subcrates` for external drives. The app writes to the volume root, so a clone at `E:\CLONE` gets its crates in `E:\_Serato_\Subcrates`; a clone on the system drive isn't supported yet.

## Database format reference

Implemented in `src/core/database.ts`, from databases Serato wrote on Windows. Same field encoding as crates (`src/core/tlv.ts`), plus `u` 32-bit and `s` 16-bit numbers.

- `vrsn`: `2.0/Serato Scratch LIVE Database`.
- `otrk` per track: `ttyp` file type (`mp3`, `wave`, `aiff`, ...), `pfil` path relative to the volume root, text tags (`tsng`, `tart`, `talb`, `tgen`, `tlen`, `tsiz`, `tbit`, `tsmp`, `tbpm`, `tkey`, `tcom`, `ttyr`), `tadd` and `uadd` date added (Unix seconds, as text and as a number), `ulbl` label colour (`0xFFFFFF` for none), `utme` file modified, `ufsb` file size, `sbav`, then flags `bhrt bmis bply blop bitu bovc bcrt biro bwlb bwll buns bbgl bkrk bstm`.
- Sync merges: Serato's records and unknown fields are kept byte for byte, and tracks it lacks are appended with the file-system fields only.

## Later (v2)

- **Tags in `database V2`.** Sync already adds every clone track to the drive's `database V2` (`src/core/database.ts`), but only with what the file system knows: type, path, size and times. Serato reads the tags itself. Writing the tags too would let Serato show retagged files right after a sync, with no "Reload ID3 Tags" rescan, and needs a tag reader (ID3, MP4, FLAC) in TS.
- Read `database V2` for Serato's view, for example which tracks it marks as missing.

## Serato behaviour tests (step 2)

Done by hand in real Serato by the project owner, before any sync code is written. Each answer can change the design.

1. **Crate files alone:** put generated crate files in a fresh `_Serato_` folder on a USB drive. Do the tracks show up and play?
2. **Serato running:** edit a crate file while Serato is open, then close Serato. Is the edit kept or overwritten? Does Serato need a restart to see changes?
3. **Retagged files:** change a track's tags and sync it over. Does Serato show the old tags until "Reload ID3 Tags"? If so, v1 tells the user after a sync that updated files.
4. **Special characters:** create crates named with `/`, `:` and `?` in Serato. How are the `.crate` files named? Our generated files must follow the same convention.
5. **`.m3u` folders:** drag a `Crates/` folder of stubs into Serato. Does it create crates from them?

## References

Format references only; no code is copied from them.

- [cratedigger](https://github.com/adammillerio/cratedigger)
- [Mixxx](https://github.com/mixxxdj/mixxx)
- [serato-tools](https://pypi.org/project/serato-tools/)
- [sidecaramel](https://github.com/rdkrl/sidecaramel)
- [triseratops](https://github.com/Holzhaus/triseratops)
- [serato-tags](https://github.com/Holzhaus/serato-tags)
