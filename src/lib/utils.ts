// Helpers behind the screens: text for labels and tooltips, drag-and-drop
// rules, and the look the rows share.

import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { CloneEntry } from "@/core/db";
import { formatDuration, sumDurations } from "@/core/duration";
import {
  findCrate,
  isWithin,
  type CrateNode,
  type CrateTree,
  type TreeRow,
} from "@/core/tree";
import type { RelinkPlan } from "@/core/relink";
import type { CloneResult } from "@/lib/library";
import type { CopySummary, PullPlan, PullSummary, PushSummary } from "@/lib/sync";
import type { CloneStatus, RelinkSummary, SourceStatus } from "@/lib/useLibrary";

export { cn } from "cn";
export { baseName, folderOf } from "@/core/paths";

// --- Text ------------------------------------------------------------------

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
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

export const PUSH_HINT =
  "Copy new and changed files from the library to the clone, then write its crates and Serato database. Nothing is copied back.";
export const PULL_HINT =
  "Bring files edited or added on the clone into the library. You confirm the list first.";

/** Why a clone's Push or Pull button is enabled or not. */
export function cloneActionTitle(
  action: "push" | "pull",
  sourceReady: boolean,
  status: CloneStatus | undefined,
): string {
  if (!sourceReady) return `The source must be connected to ${action}`;
  switch (status?.kind) {
    case "ready":
      return action === "push" ? PUSH_HINT : PULL_HINT;
    case "working":
      return "Busy";
    case "missing":
      return "The clone isn't connected";
    default:
      return "The clone isn't ready yet";
  }
}

/** The question asked before a pull: what will be copied in, and what is left alone. */
export function describePullPlan(plan: PullPlan, cloneName: string): string {
  const lines: string[] = [];
  if (plan.copy.length > 0) {
    const what = plan.copy.length === 1 ? "this file" : `these ${plural(plan.copy.length, "file")}`;
    lines.push(`Bring ${what} from "${cloneName}" into the library? The library's copies are replaced.`, "");
    lines.push(...plan.copy.slice(0, 12).map((t) => t.relative));
    if (plan.copy.length > 12) lines.push(`…and ${plan.copy.length - 12} more`);
  }
  if (plan.bothChanged.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${plural(plan.bothChanged.length, "file")} changed both in the library and on the clone and will be left alone until you decide which to keep:`,
    );
    lines.push(...plan.bothChanged.slice(0, 6).map((t) => t.relative));
    if (plan.bothChanged.length > 6) lines.push(`…and ${plan.bothChanged.length - 6} more`);
  }
  return lines.join("\n");
}

export function describeSource(status: SourceStatus | null): string {
  switch (status?.kind) {
    case "ready": {
      const { tracks, folders } = status.scan;
      const parts = [`${tracks.toLocaleString()} tracks in ${folders.length.toLocaleString()} folders`];
      parts.push(...describeRelinkCounts(status.relink));
      return parts.join(", ");
    }
    case "missing":
      return "Not connected: the folder isn't there right now";
    case "error":
      return status.message;
    default:
      return "Scanning…";
  }
}

/** The parts of a relink worth mentioning after a scan; empty when every track was in place. */
function describeRelinkCounts(relink: RelinkSummary): string[] {
  const parts: string[] = [];
  if (relink.moved) parts.push(`${plural(relink.moved, "track")} relinked after moving`);
  if (relink.ambiguous) parts.push(`${relink.ambiguous.toLocaleString()} with several files of the same name`);
  if (relink.notFound) parts.push(`${relink.notFound.toLocaleString()} not found`);
  return parts;
}

/**
 * The question asked before the source changes: where the crates' tracks
 * will end up under the new root.
 */
export function describeRelink(from: string, to: string, plan: RelinkPlan): string {
  const lines = [`Change the source from\n${from}\nto\n${to}?`, ""];
  lines.push("Tracks are matched by file name. Nothing is copied, moved or deleted.", "");
  lines.push(`${plural(plan.kept, "track")} stay where they are.`);
  if (plan.moved) lines.push(`${plural(plan.moved, "track")} were found at a new place and will be relinked.`);
  if (plan.ambiguous)
    lines.push(
      `${plural(plan.ambiguous, "track")} have several files with their name and will be flagged.`,
    );
  if (plan.notFound) lines.push(`${plural(plan.notFound, "track")} weren't found and will be flagged.`);
  return lines.join("\n");
}

export function describeClone(
  clone: CloneEntry,
  status: CloneStatus | undefined,
): string {
  switch (status?.kind) {
    case "ready": {
      // The most recent thing that happened to the clone this session.
      const events: Array<[string, () => string]> = [];
      if (status.lastPush) events.push([status.lastPush.finished, () => describePush(status.lastPush!)]);
      if (status.lastPull) events.push([status.lastPull.finished, () => describePull(status.lastPull!)]);
      if (status.lastCopy) events.push([status.lastCopy.finished, () => describeCopy(status.lastCopy!)]);
      events.sort((a, b) => b[0].localeCompare(a[0]));
      return events.length > 0 ? events[0][1]() : describeAttached(clone, status.result);
    }
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
    ? `last pushed ${relativeTime(clone.lastSync)}`
    : "never pushed";
  return `${trackText} in ${folderText}, ${when}`;
}

function describePush(s: PushSummary): string {
  const parts = [`${s.crates.toLocaleString()} crates written`];
  if (s.databaseAdded)
    parts.push(
      `${s.databaseAdded.toLocaleString()} tracks added to the Serato database`,
    );
  if (s.databaseError)
    parts.push(`Serato database left alone (${s.databaseError})`);
  if (s.relinked) parts.push(`${s.relinked.toLocaleString()} moved into place`);
  if (s.copied) parts.push(`${s.copied.toLocaleString()} copied to clone`);
  if (s.unchanged) parts.push(`${s.unchanged.toLocaleString()} unchanged`);
  if (s.cloneChanged)
    parts.push(`${s.cloneChanged.toLocaleString()} changed on the clone, left alone (pull to bring in)`);
  if (s.bothChanged)
    parts.push(`${s.bothChanged.toLocaleString()} changed on both sides, left alone`);
  if (s.onlyClone)
    parts.push(`${s.onlyClone.toLocaleString()} only on the clone (pull to bring in)`);
  if (s.missing) parts.push(`${s.missing.toLocaleString()} missing everywhere`);
  if (s.outside)
    parts.push(`${s.outside.toLocaleString()} outside the library left out`);
  return `Pushed ${relativeTime(s.finished)}: ${parts.join(", ")}`;
}

function describePull(s: PullSummary): string {
  const parts = [`${s.copied.toLocaleString()} brought into the library`];
  if (s.bothChanged)
    parts.push(`${s.bothChanged.toLocaleString()} changed on both sides, left alone`);
  return `Pulled ${relativeTime(s.finished)}: ${parts.join(", ")}`;
}

function describeCopy(s: CopySummary): string {
  const parts = [`${s.copied.toLocaleString()} copied`];
  if (s.unchanged) parts.push(`${s.unchanged.toLocaleString()} already here`);
  if (s.missing)
    parts.push(`${s.missing.toLocaleString()} missing from source`);
  if (s.outside)
    parts.push(`${s.outside.toLocaleString()} outside the library`);
  return `Tracks ${relativeTime(s.finished)}: ${parts.join(", ")}. Press Push to write the crates.`;
}
