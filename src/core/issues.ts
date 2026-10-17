// What a track row's dot stands for: something about the track that wants
// a decision from the user.
//
//   - A sync conflict is a file that was edited on both the source and a
//     clone between syncs, where the newer copy won and the other edit is gone.
//   - A not-found track has no file with its name under the library any
//     more, or several and none could be singled out (see core/relink.ts).
//   - A duplicate is a different file whose title wholly contains, or is
//     wholly contained in, this one's: "Super Song" and "Super Song (Remix)".
//     Whole words only, so "Song" is not inside "Songbird".
//   - A shared track is the same file in two crates that aren't one inside
//     the other. A track in a crate and in its subcrate is just scoping.

import { titleOf } from "./m3u";
import type { Match } from "./relink";
import { trackKey, type CrateNode, type CrateTree } from "./tree";

export type IssueKind = "sync" | "notFound" | "duplicate" | "shared";

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

/** Tracks the last scan couldn't place, keyed by track key. */
export type Unresolved = ReadonlyMap<string, Extract<Match, { kind: "ambiguous" | "notFound" }>>;

/** Words of a title, lower-cased, for whole-word containment. */
function wordsOf(title: string): string[] {
  return title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** True when `inner` appears as a contiguous run of words inside `outer`. */
function containsWords(outer: string[], inner: string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    let i = 0;
    while (i < inner.length && outer[start + i] === inner[i]) i++;
    if (i === inner.length) return true;
  }
  return false;
}

/**
 * Tracks that look like copies of one another: different files whose
 * titles contain each other whole, word for word. The same file in several
 * crates is not a duplicate. Maps each such track's key to the other paths.
 */
export function duplicateTracks(tree: CrateTree): Map<string, string[]> {
  // One entry per distinct file, with its words.
  const files = new Map<string, { path: string; words: string[] }>();
  const walk = (nodes: CrateNode[]) => {
    for (const node of nodes) {
      for (const path of node.tracks) {
        const key = trackKey(path);
        if (!files.has(key)) files.set(key, { path, words: wordsOf(titleOf(path)) });
      }
      walk(node.children);
    }
  };
  walk(tree);

  // Candidates for a title are the files that share its rarest word; only
  // those can contain it. Checking against them keeps large libraries quick.
  const byWord = new Map<string, string[]>();
  for (const [key, { words }] of files) {
    for (const word of new Set(words)) {
      const list = byWord.get(word);
      if (list) list.push(key);
      else byWord.set(word, [key]);
    }
  }

  const out = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = out.get(a) ?? [];
    const path = files.get(b)!.path;
    if (!list.includes(path)) list.push(path);
    out.set(a, list);
  };
  for (const [key, { words }] of files) {
    if (words.length === 0) continue;
    let rarest: string[] | undefined;
    for (const word of words) {
      const list = byWord.get(word)!;
      if (!rarest || list.length < rarest.length) rarest = list;
    }
    for (const other of rarest!) {
      if (other === key) continue;
      if (containsWords(files.get(other)!.words, words)) {
        link(key, other);
        link(other, key);
      }
    }
  }
  return out;
}

/** A crate holding a track: its id and its path of names, outermost first. */
export interface CrateRef {
  id: string;
  names: string[];
}

export interface IssueIndex {
  /** Issues that belong to the track wherever it appears, keyed by track key. */
  byTrack: Map<string, TrackIssue[]>;
  /** Every crate holding each track, keyed by track key. */
  holders: Map<string, CrateRef[]>;
  /** Each crate's ancestors' ids, keyed by crate id. */
  ancestors: Map<string, Set<string>>;
}

/**
 * Every issue to show. Sync conflicts come first since they can mean a lost
 * edit; then tracks that can't be found; then duplicates. Shared-crate
 * issues depend on which crate the row is in, so `issuesFor` adds them.
 */
export function trackIssues(
  tree: CrateTree,
  clones: ConflictSource[],
  unresolved: Unresolved = new Map(),
): IssueIndex {
  const byTrack = new Map<string, TrackIssue[]>();
  const push = (key: string, issue: TrackIssue) => {
    const list = byTrack.get(key) ?? [];
    list.push(issue);
    byTrack.set(key, list);
  };

  for (const clone of clones) {
    for (const conflict of clone.conflicts) {
      push(trackKey(conflict.path), { kind: "sync", detail: describeConflict(conflict, clone.path) });
    }
  }

  const holders = new Map<string, CrateRef[]>();
  const ancestors = new Map<string, Set<string>>();
  const walk = (nodes: CrateNode[], above: CrateRef[]) => {
    for (const node of nodes) {
      const parent = above[above.length - 1];
      const ref: CrateRef = { id: node.id, names: parent ? [...parent.names, node.name] : [node.name] };
      ancestors.set(node.id, new Set(above.map((a) => a.id)));
      for (const path of node.tracks) {
        const key = trackKey(path);
        const match = unresolved.get(key);
        if (match && !byTrack.get(key)?.some((i) => i.kind === "notFound")) {
          push(key, { kind: "notFound", detail: describeUnresolved(path, match) });
        }
        const list = holders.get(key) ?? [];
        if (!list.some((h) => h.id === node.id)) list.push(ref);
        holders.set(key, list);
      }
      walk(node.children, [...above, ref]);
    }
  };
  walk(tree, []);

  for (const [key, others] of duplicateTracks(tree)) {
    push(key, { kind: "duplicate", detail: describeDuplicate(others) });
  }
  return { byTrack, holders, ancestors };
}

/**
 * The issues for a track as shown in one crate: the track's own, then a
 * shared-crate issue naming the other crates holding it that are neither
 * above nor below this one.
 */
export function issuesFor(index: IssueIndex, crateId: string, path: string): TrackIssue[] {
  const key = trackKey(path);
  const own = index.byTrack.get(key) ?? [];
  const chain = index.ancestors.get(crateId);
  const others = (index.holders.get(key) ?? []).filter(
    (h) => h.id !== crateId && !chain?.has(h.id) && !index.ancestors.get(h.id)?.has(crateId),
  );
  if (others.length === 0) return own;
  return [...own, { kind: "shared", detail: describeShared(others) }];
}

function describeConflict(conflict: Conflict, cloneRoot: string): string {
  const winner = conflict.kept === "clone" ? "the clone's" : "the library's";
  return `Edited on both sides before the last sync with ${cloneRoot}. The newer copy, ${winner}, was kept.`;
}

function describeUnresolved(path: string, match: Extract<Match, { kind: "ambiguous" | "notFound" }>): string {
  if (match.kind === "notFound") {
    return `Not found. No file called "${titleOf(path)}" is in the library. It was last seen at ${path}. Move it back and rescan, or remove it from the crate.`;
  }
  const shown = match.candidates.slice(0, 3).join("\n");
  const more = match.candidates.length > 3 ? `\n…and ${match.candidates.length - 3} more` : "";
  return `Not found at ${path}, and several files have its name, so it wasn't relinked:\n${shown}${more}`;
}

function describeDuplicate(others: string[]): string {
  const shown = others.slice(0, 3).join("\n");
  const more = others.length > 3 ? `\n…and ${others.length - 3} more` : "";
  return `${others.length === 1 ? "Another file" : "Other files"} in your crates ${
    others.length === 1 ? "has" : "have"
  } a title that contains or is contained in this one:\n${shown}${more}`;
}

function describeShared(others: CrateRef[]): string {
  const names = others.map((o) => o.names.join(" / "));
  const shown = names.slice(0, 3).join("\n");
  const more = names.length > 3 ? `\n…and ${names.length - 3} more` : "";
  return `Also in ${names.length === 1 ? "another crate" : `${names.length} other crates`}:\n${shown}${more}`;
}
