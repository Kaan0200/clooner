// Helpers behind the screens: text for labels and tooltips, drag-and-drop
// rules, and the look the rows share.

import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { isInside, normalizeRoot } from "@/core/clone";
import type { CloneEntry } from "@/core/db";
import { formatDuration, sumDurations } from "@/core/duration";
import {
  findCrate,
  isWithin,
  type CrateNode,
  type CrateTree,
  type TreeRow,
} from "@/core/tree";
import type { CloneResult } from "@/lib/library";
import type { CopySummary, SyncSummary } from "@/lib/sync";
import type { CloneStatus, SourceStatus } from "@/lib/useLibrary";

export { cn } from "cn";

// --- Text ------------------------------------------------------------------

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** The last segment of a path, for a label; the full path goes in the tooltip. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

/** The folder part of a path, relative to the library root when inside it. Empty at the root. */
export function folderOf(path: string, sourceRoot: string | null): string {
  const normalized = normalizeRoot(path);
  const dir = normalized.slice(0, normalized.lastIndexOf("/"));
  if (sourceRoot && isInside(sourceRoot, dir))
    return dir.slice(normalizeRoot(sourceRoot).length + 1);
  return dir;
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// --- Crates ----------------------------------------------------------------

/** Every track path in the tree, in tree order. */
export function allTrackPaths(tree: CrateTree): string[] {
  const out: string[] = [];
  const walk = (nodes: CrateNode[]) => {
    for (const node of nodes) {
      out.push(...node.tracks);
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/** "12 tracks · 48:32", with a note when some lengths aren't known yet. */
export function describeLength(
  paths: string[],
  known: Record<string, number>,
): { text: string; title: string } {
  const { seconds, unknown } = sumDurations(paths, known);
  const count = plural(paths.length, "track");
  if (unknown === paths.length)
    return { text: "", title: `${count}, lengths not read yet` };
  const time = formatDuration(seconds);
  const title =
    unknown > 0
      ? `${count}, ${time} not counting ${plural(unknown, "track")} of unknown length`
      : `${count}, ${time}`;
  return { text: unknown > 0 ? `${time}+` : time, title };
}

// --- Rows and dragging -----------------------------------------------------

export const INDENT_PX = 16;

/** Where an in-app drag is hovering: a crate row, or the empty space (top level). */
export type DropTarget = { kind: "crate"; id: string } | { kind: "root" };

export interface DragState {
  row: TreeRow;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** False until the pointer has moved past the threshold. */
  active: boolean;
  target: DropTarget | null;
  /** Ctrl or Alt held: a track is added to the target while staying where it was. */
  keep: boolean;
}

/** Row background for the states a row can be in. */
export function rowBackground(
  dropTarget: boolean,
  dragging: boolean,
  selected: boolean,
): string {
  if (dropTarget) return "bg-primary/10 ring-2 ring-inset ring-primary";
  // While files are dragged over the window every row is a potential target,
  // so hint at it without shouting.
  if (dragging) return "ring-1 ring-inset ring-dashed ring-border";
  if (selected) return "bg-muted text-foreground";
  return "hover:bg-muted/50";
}

/** Whether a dragged row may be dropped on a target. */
export function dropAllowed(
  tree: CrateTree,
  row: TreeRow,
  target: DropTarget,
  keep: boolean,
): boolean {
  if (row.kind === "track") {
    if (target.kind !== "crate" || target.id === row.crateId) return false;
    const to = findCrate(tree, target.id);
    // Adding is pointless when the track is already there.
    return (
      !!to &&
      (!keep ||
        !to.tracks.some((t) => t.toLowerCase() === row.path.toLowerCase()))
    );
  }
  if (target.kind === "root") return row.parentId !== null;
  return target.id !== row.parentId && !isWithin(tree, row.node.id, target.id);
}

/**
 * The crate under a point reported by the native drag, which comes in
 * physical pixels relative to the webview. A track row stands in for the
 * crate that holds it.
 */
export function crateAt(position: PhysicalPosition): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(
    position.x / scale,
    position.y / scale,
  );
  return (
    element?.closest<HTMLElement>("[data-crate-id]")?.dataset.crateId ?? null
  );
}

// --- Locations -------------------------------------------------------------

export function syncTitle(
  sourceReady: boolean,
  status: CloneStatus | undefined,
): string {
  if (!sourceReady) return "The source must be connected to sync";
  switch (status?.kind) {
    case "ready":
      return "Copy newer files both ways, then write the crates and database into the drive's _Serato_ folder";
    case "working":
      return "Busy";
    case "missing":
      return "The clone isn't connected";
    default:
      return "The clone isn't ready yet";
  }
}

export function describeSource(status: SourceStatus | null): string {
  switch (status?.kind) {
    case "ready": {
      const { tracks, folders } = status.scan;
      return `${tracks.toLocaleString()} tracks in ${folders.length.toLocaleString()} folders`;
    }
    case "missing":
      return "Not connected: the folder isn't there right now";
    case "error":
      return status.message;
    default:
      return "Scanning…";
  }
}

export function describeClone(
  clone: CloneEntry,
  status: CloneStatus | undefined,
): string {
  switch (status?.kind) {
    case "ready":
      if (status.lastSync) return describeSync(status.lastSync);
      if (status.lastCopy) return describeCopy(status.lastCopy);
      return describeAttached(clone, status.result);
    case "working":
    case "attaching":
      return status.progress;
    case "missing":
      return "Not connected: the folder isn't there right now";
    case "error":
      return status.message;
    default:
      return "Waiting for the source";
  }
}

function describeAttached(
  clone: CloneEntry,
  { existing, folders, tracks }: CloneResult,
): string {
  const folderText = `${folders.toLocaleString()} folders`;
  if (!existing) return `${folderText} created, never synced`;
  const trackText =
    tracks === 0 ? "no tracks" : `${tracks.toLocaleString()} tracks`;
  const when = clone.lastSync
    ? `last synced ${relativeTime(clone.lastSync)}`
    : "never synced";
  return `${trackText} in ${folderText}, ${when}`;
}

function describeSync(s: SyncSummary): string {
  const parts = [`${s.crates.toLocaleString()} crates written`];
  if (s.databaseAdded)
    parts.push(
      `${s.databaseAdded.toLocaleString()} tracks added to the Serato database`,
    );
  if (s.databaseError)
    parts.push(`Serato database left alone (${s.databaseError})`);
  if (s.toClone) parts.push(`${s.toClone.toLocaleString()} copied to clone`);
  if (s.toSource)
    parts.push(`${s.toSource.toLocaleString()} copied back to source`);
  if (s.unchanged) parts.push(`${s.unchanged.toLocaleString()} unchanged`);
  if (s.bothChanged)
    parts.push(
      `${s.bothChanged.toLocaleString()} changed on both sides, newer kept`,
    );
  if (s.missing) parts.push(`${s.missing.toLocaleString()} missing everywhere`);
  if (s.outside)
    parts.push(`${s.outside.toLocaleString()} outside the library left out`);
  return `Synced ${relativeTime(s.finished)}: ${parts.join(", ")}`;
}

function describeCopy(s: CopySummary): string {
  const parts = [`${s.copied.toLocaleString()} copied`];
  if (s.unchanged) parts.push(`${s.unchanged.toLocaleString()} already here`);
  if (s.missing)
    parts.push(`${s.missing.toLocaleString()} missing from source`);
  if (s.outside)
    parts.push(`${s.outside.toLocaleString()} outside the library`);
  return `Tracks ${relativeTime(s.finished)}: ${parts.join(", ")}. Press Sync to write the crates.`;
}
