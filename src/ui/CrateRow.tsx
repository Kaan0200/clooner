import {
  ChevronRight,
  Folder,
  FolderOpen,
  ListMusic,
  Music,
} from "lucide-react";
import { Button } from "@/ui/atoms/button";
import { hasContents, type TreeRow } from "@/core/tree";
import { INDENT_PX, rowBackground } from "@/lib/utils";
import { RenameInput } from "./RenameInput";
import { SelectionMarker } from "./SelectionMarker";

interface CrateRowProps {
  row: Extract<TreeRow, { kind: "crate" }>;
  selected: boolean;
  expanded: boolean;
  editing: boolean;
  /** Something is being dragged over this row right now. */
  dropTarget: boolean;
  /** Files are being dragged over the window. */
  dragging: boolean;
  /** This row is the one being dragged. */
  beingDragged: boolean;
  /** Tooltip for the playlist button: what it does, or why it is disabled. */
  playlistTitle: string;
  playlistEnabled: boolean;
  /** The crate's total length, ready to show, and its tooltip. */
  length: { text: string; title: string };
  onSelect: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
  onOpenPlaylist: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

export function CrateRow({
  row,
  selected,
  expanded,
  editing,
  dropTarget,
  dragging,
  beingDragged,
  playlistTitle,
  playlistEnabled,
  length,
  onSelect,
  onToggle,
  onEdit,
  onCommit,
  onCancel,
  onOpenPlaylist,
  onPointerDown,
}: CrateRowProps) {
  const { node, depth } = row;
  const expandable = hasContents(node);
  const Icon = expanded && expandable ? FolderOpen : Folder;

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
      data-row-key={node.id}
      data-crate-id={node.id}
      data-drop-target={dropTarget || undefined}
      className={`group/row relative flex h-8 cursor-default items-center gap-1 rounded-md pr-1 text-sm transition-colors select-none ${rowBackground(dropTarget, dragging, selected)} ${
        beingDragged ? "opacity-40" : ""
      }`}
      style={{ paddingLeft: 4 + depth * INDENT_PX }}
      onClick={onSelect}
      onDoubleClick={onEdit}
      onPointerDown={onPointerDown}
    >
      <SelectionMarker selected={selected} />
      {expandable ? (
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
      <Icon
        className={`size-4 shrink-0 ${dropTarget ? "text-primary" : "text-muted-foreground"}`}
      />
      {editing ? (
        <RenameInput
          initial={node.name}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      ) : (
        <span className="truncate">{node.name}</span>
      )}

      {dropTarget ? (
        <span className="ml-auto shrink-0 pr-1 text-xs font-medium text-primary">
          Drop here
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {node.tracks.length > 0 && (
            <span
              className="flex items-center gap-1 pr-1 text-xs tabular-nums text-muted-foreground"
              title={length.title}
            >
              <Music className="size-3" />
              {node.tracks.length.toLocaleString()}
              {length.text && (
                <span className="text-muted-foreground/70">
                  · {length.text}
                </span>
              )}
            </span>
          )}
          {/* Row actions: shown on hover or when the row is selected. */}
          <span
            className={`flex items-center gap-0.5 transition-opacity group-hover/row:opacity-100 ${
              selected ? "opacity-100" : "opacity-0"
            }`}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label="Open as playlist"
              title={playlistTitle}
              disabled={!playlistEnabled}
              onClick={onOpenPlaylist}
            >
              <ListMusic />
            </Button>
          </span>
        </span>
      )}
    </div>
  );
}
