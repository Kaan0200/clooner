// What a track row's dot stands for: something about the track that wants
// a decision from the user. Two kinds so far. A sync conflict is a file that
// was edited on both the source and a clone between syncs, where the newer
// copy won and the other edit is gone. A duplicate is a different file in
// the crates with the same title, which usually means the same song twice.

import { titleOf } from "./m3u";
import { trackKey, type CrateNode, type CrateTree } from "./tree";

export type IssueKind = "sync" | "duplicate";

export interface TrackIssue {
  kind: IssueKind;
  /** One or two sentences for the tooltip. */
  detail: string;
}

/** A file that had changed on both sides when a clone was last synced. */
export interface Conflict {
  /** The track's source path. */
  path: string;
  /** Whose copy was kept, being the newer one. */
  kept: "source" | "clone";
  /** When the sync finished, ISO 8601. */
  when: string;
}

/** A clone and the conflicts from its last sync; `CloneEntry` fits. */
export interface ConflictSource {
  path: string;
  conflicts: Conflict[];
}

/**
 * Tracks that look like copies of one another: different files sharing a
 * title (the file name without its extension). The same file in several
 * crates is not a duplicate, that is just how crates work. Maps each such
 * track's key to the other paths with the same title.
 */
export function duplicateTracks(tree: CrateTree): Map<string, string[]> {
  const byTitle = new Map<string, Map<string, string>>();
  const walk = (nodes: CrateNode[]) => {
    for (const node of nodes) {
      for (const path of node.tracks) {
        const title = titleOf(path).toLowerCase();
        const group = byTitle.get(title) ?? new Map<string, string>();
        if (!group.has(trackKey(path))) group.set(trackKey(path), path);
        byTitle.set(title, group);
      }
      walk(node.children);
    }
  };
  walk(tree);

  const out = new Map<string, string[]>();
  for (const group of byTitle.values()) {
    if (group.size < 2) continue;
    for (const [key, path] of group) {
      out.set(
        key,
        [...group.values()].filter((other) => other !== path),
      );
    }
  }
  return out;
}

/**
 * Every issue to show, per track key. Sync conflicts come first since they
 * can mean a lost edit; duplicates follow.
 */
export function trackIssues(tree: CrateTree, clones: ConflictSource[]): Map<string, TrackIssue[]> {
  const out = new Map<string, TrackIssue[]>();
  const push = (key: string, issue: TrackIssue) => {
    const list = out.get(key) ?? [];
    list.push(issue);
    out.set(key, list);
  };

  for (const clone of clones) {
    for (const conflict of clone.conflicts) {
      push(trackKey(conflict.path), { kind: "sync", detail: describeConflict(conflict, clone.path) });
    }
  }
  for (const [key, others] of duplicateTracks(tree)) {
    push(key, { kind: "duplicate", detail: describeDuplicate(others) });
  }
  return out;
}

function describeConflict(conflict: Conflict, cloneRoot: string): string {
  const winner = conflict.kept === "clone" ? "the clone's" : "the library's";
  return `Edited on both sides before the last sync with ${cloneRoot}. The newer copy, ${winner}, was kept.`;
}

function describeDuplicate(others: string[]): string {
  const shown = others.slice(0, 3).join("\n");
  const more = others.length > 3 ? `\n…and ${others.length - 3} more` : "";
  return `${others.length === 1 ? "Another file" : "Other files"} with this title ${
    others.length === 1 ? "is" : "are"
  } in your crates:\n${shown}${more}`;
}
