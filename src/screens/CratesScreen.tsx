import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { ChevronRight, Folder, FolderOpen, Music, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  addCrate,
  addTracks,
  ancestorsOf,
  findCrate,
  renameCrate,
  visibleRows,
  type CrateTree,
  type TreeRow,
} from "@/core/tree";
import { collectAudioFiles } from "@/lib/library";

interface Props {
  tree: CrateTree;
  onChange: (tree: CrateTree) => void;
}

const INDENT_PX = 16;

/**
 * The crate tree. Add creates a collection when nothing is selected, or a
 * subcrate under the selected crate. A new crate opens in rename mode.
 * Dragging files from the OS onto a row adds them to that crate.
 */
export default function CratesScreen({ tree, onChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The crate under the cursor while files are being dragged over the window. */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // A selection can go stale if the tree changes underneath it.
  const selected = selectedId ? findCrate(tree, selectedId) : undefined;
  const rows = visibleRows(tree, expanded);

  useEffect(() => {
    if (!selectedId) return;
    treeRef.current
      ?.querySelector(`[data-crate-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId, rows.length]);

  // The drop handler needs the latest tree without re-subscribing on every
  // change, so the subscription reads through refs.
  const latest = useRef({ tree, onChange });
  latest.current = { tree, onChange };

  useEffect(() => {
    // Outside Tauri (plain browser dev) there is no native drag-drop channel.
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        switch (payload.type) {
          case "enter":
          case "over":
            setDropTargetId(crateAt(payload.position));
            break;
          case "drop": {
            setDropTargetId(null);
            const id = crateAt(payload.position);
            if (id) void dropFiles(id, payload.paths);
            break;
          }
          case "leave":
            setDropTargetId(null);
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function dropFiles(crateId: string, paths: string[]) {
    const crate = findCrate(latest.current.tree, crateId);
    if (!crate) return;

    let files: string[];
    try {
      files = await collectAudioFiles(paths);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      return;
    }
    if (files.length === 0) {
      setNotice(`Nothing in that drop was an audio file.`);
      return;
    }

    // The tree may have changed while files were being listed.
    const fresh = latest.current.tree;
    if (!findCrate(fresh, crateId)) return;
    const { tree: next, added } = addTracks(fresh, crateId, files);
    if (added > 0) latest.current.onChange(next);
    const skipped = files.length - added;
    setNotice(
      `${plural(added, "track")} added to "${crate.name}"` +
        (skipped > 0 ? `, ${skipped} already there` : ""),
    );
    setSelectedId(crateId);
  }

  function setExpandedFor(id: string, open: boolean) {
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function add() {
    const parentId = selected?.id ?? null;
    const result = addCrate(tree, parentId);
    onChange(result.tree);
    if (parentId) setExpandedFor(parentId, true);
    setSelectedId(result.node.id);
    setEditingId(result.node.id);
    setNotice(null);
  }

  function select(id: string | null) {
    setSelectedId(id);
    setEditingId(null);
  }

  /** Commits a rename. Returns the error to show, or null when it went through. */
  function commitRename(id: string, name: string): string | null {
    const current = findCrate(tree, id);
    if (!current) return null;
    if (name !== current.name) {
      try {
        onChange(renameCrate(tree, id, name));
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }
    setEditingId(null);
    treeRef.current?.focus();
    return null;
  }

  function cancelRename() {
    setEditingId(null);
    treeRef.current?.focus();
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (editingId) return;
    const index = rows.findIndex((r) => r.node.id === selectedId);
    const row = index >= 0 ? rows[index] : undefined;
    const moveTo = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (target) select(target.node.id);
    };

    switch (e.key) {
      case "ArrowDown":
        moveTo(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
        moveTo(index < 0 ? rows.length - 1 : index - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row || row.node.children.length === 0) return;
        if (expanded.has(row.node.id)) moveTo(index + 1);
        else setExpandedFor(row.node.id, true);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (expanded.has(row.node.id)) setExpandedFor(row.node.id, false);
        else if (row.parentId) select(row.parentId);
        break;
      case "Enter":
      case "F2":
        if (row) setEditingId(row.node.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  const addTitle = selected ? `Add a subcrate to "${selected.name}"` : "Add a collection";
  const dragging = dropTargetId !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b p-2">
        <Button variant="outline" size="lg" title={addTitle} onClick={add}>
          <Plus />
          <span>Add</span>
        </Button>
        {selected && (
          <span className="truncate text-xs text-muted-foreground">
            Add puts a subcrate in <span className="font-medium">{selected.name}</span>
          </span>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="p-2 text-sm text-muted-foreground">
            No crates yet. Add creates your first collection.
          </div>
        ) : (
          <div
            ref={treeRef}
            role="tree"
            aria-label="Crates"
            tabIndex={0}
            className="flex min-h-full flex-col p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onKeyDown={onTreeKeyDown}
            // Clicking empty space clears the selection so Add makes a collection.
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('[role="treeitem"]')) select(null);
            }}
          >
            {rows.map((row) => (
              <CrateRow
                key={row.node.id}
                row={row}
                selected={row.node.id === selectedId}
                expanded={expanded.has(row.node.id)}
                editing={row.node.id === editingId}
                dropTarget={row.node.id === dropTargetId}
                dragging={dragging}
                onSelect={() => select(row.node.id)}
                onToggle={() => setExpandedFor(row.node.id, !expanded.has(row.node.id))}
                onEdit={() => setEditingId(row.node.id)}
                onCommit={(name) => commitRename(row.node.id, name)}
                onCancel={cancelRename}
              />
            ))}
            {/* Fills the rest of the panel so clicks below the last row deselect. */}
            <div className="flex-1" />
          </div>
        )}
      </ScrollArea>

      {(notice || (selected && ancestorsOf(tree, selected.id)?.length)) && (
        <footer className="flex items-center justify-between gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {selected &&
              [...(ancestorsOf(tree, selected.id) ?? []), selected].map((n) => n.name).join(" / ")}
          </span>
          {notice && (
            <span role="status" className="shrink-0 truncate text-foreground">
              {notice}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}

/**
 * The crate row under a point reported by the native drag, which comes in
 * physical pixels relative to the webview.
 */
function crateAt(position: PhysicalPosition): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  return element?.closest<HTMLElement>("[data-crate-id]")?.dataset.crateId ?? null;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

interface RowProps {
  row: TreeRow;
  selected: boolean;
  expanded: boolean;
  editing: boolean;
  /** Files are being dragged over this row right now. */
  dropTarget: boolean;
  /** Files are being dragged somewhere over the window. */
  dragging: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}

function CrateRow({
  row,
  selected,
  expanded,
  editing,
  dropTarget,
  dragging,
  onSelect,
  onToggle,
  onEdit,
  onCommit,
  onCancel,
}: RowProps) {
  const { node, depth } = row;
  const hasChildren = node.children.length > 0;
  const Icon = expanded && hasChildren ? FolderOpen : Folder;

  let background: string;
  if (dropTarget) {
    background = "bg-primary/10 ring-2 ring-inset ring-primary";
  } else if (dragging) {
    // While a drag is in progress every row is a potential target, so hint at
    // it without shouting.
    background = "ring-1 ring-inset ring-dashed ring-border";
  } else if (selected) {
    background = "bg-muted text-foreground";
  } else {
    background = "hover:bg-muted/50";
  }

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      data-crate-id={node.id}
      data-drop-target={dropTarget || undefined}
      className={`flex h-8 cursor-default items-center gap-1 rounded-md pr-2 text-sm transition-colors select-none ${background}`}
      style={{ paddingLeft: 4 + depth * INDENT_PX }}
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      {hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight
            className={`size-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <Icon className={`size-4 shrink-0 ${dropTarget ? "text-primary" : "text-muted-foreground"}`} />
      {editing ? (
        <RenameInput initial={node.name} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className="truncate">{node.name}</span>
      )}
      {dropTarget ? (
        <span className="ml-auto shrink-0 text-xs font-medium text-primary">Drop to add</span>
      ) : (
        node.tracks.length > 0 && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={plural(node.tracks.length, "track")}
          >
            <Music className="size-3" />
            {node.tracks.length.toLocaleString()}
          </span>
        )
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function commit() {
    setError(onCommit(draft));
  }

  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        aria-label="Crate name"
        aria-invalid={error ? true : undefined}
        className={`h-6 w-full rounded border bg-background px-1 text-sm outline-none focus-visible:ring-2 ${
          error ? "border-destructive ring-destructive/30" : "border-input ring-ring/50"
        }`}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        // Leaving the field keeps a valid name and drops an invalid one.
        onBlur={() => {
          if (onCommit(draft)) onCancel();
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {error && (
        <span
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 rounded-md border bg-popover px-2 py-1 text-xs text-destructive shadow-md"
        >
          {error}
        </span>
      )}
    </span>
  );
}
