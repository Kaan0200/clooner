import { Folder, Music } from "lucide-react";
import { titleOf } from "@/core/m3u";
import { findCrate, type CrateTree } from "@/core/tree";
import type { DragState } from "@/lib/utils";

/** The label that follows the pointer during an in-app drag. */
export function DragGhost({
  drag,
  allowed,
  tree,
}: {
  drag: DragState;
  allowed: boolean;
  tree: CrateTree;
}) {
  const name =
    drag.row.kind === "track" ? titleOf(drag.row.path) : drag.row.node.name;
  const Icon = drag.row.kind === "track" ? Music : Folder;

  let action: string | null = null;
  if (allowed && drag.target) {
    if (drag.target.kind === "root") action = "Make a collection";
    else {
      const to = findCrate(tree, drag.target.id)?.name ?? "";
      action =
        drag.row.kind === "track" && drag.keep
          ? `Add to "${to}"`
          : `Move into "${to}"`;
    }
  }

  return (
    <div
      className="pointer-events-none fixed z-50 flex max-w-64 items-center gap-2 rounded-md border bg-popover px-2 py-1 text-sm shadow-md"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      {action && (
        <span className="shrink-0 text-xs font-medium text-primary">
          {action}
        </span>
      )}
    </div>
  );
}
