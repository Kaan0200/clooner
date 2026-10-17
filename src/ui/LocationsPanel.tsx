import { FolderSync, HardDrive, RefreshCw, Usb, X } from "lucide-react";
import { Button } from "@/ui/atoms/button";
import type { Library } from "@/lib/useLibrary";
import { describeClone, describeSource, syncTitle } from "@/lib/utils";

/**
 * The source and every clone as cards, each with what it holds and when it
 * was last synced. A clone can be synced on its own or forgotten here.
 * Shown under the toolbar while its clones toggle is on.
 */
export function LocationsPanel({ library }: { library: Library }) {
  const { source, sourceStatus, clones, cloneStatus, busy } = library;
  const sourceReady = sourceStatus?.kind === "ready";

  return (
    <div className="flex flex-col gap-2 border-t p-2 text-sm">
      {!source && clones.length === 0 && (
        <div className="text-muted-foreground">
          No locations yet. Add a source, then a clone.
        </div>
      )}

      {source && (
        <LocationCard
          icon={HardDrive}
          kind="Source"
          path={source.path}
          actions={
            <Button
              variant="outline"
              size="sm"
              title="Rescan the source and check every clone"
              onClick={library.rescan}
              disabled={busy || sourceStatus?.kind === "scanning"}
            >
              <RefreshCw />
              <span>Rescan</span>
            </Button>
          }
        >
          {describeSource(sourceStatus)}
        </LocationCard>
      )}

      {clones.map((clone) => {
        const status = cloneStatus[clone.path];
        const canSync = sourceReady && status?.kind === "ready" && !busy;
        return (
          <LocationCard
            key={clone.path}
            icon={Usb}
            kind="Clone"
            path={clone.path}
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  title={syncTitle(sourceReady, status)}
                  disabled={!canSync}
                  onClick={() => library.syncClone(clone.path)}
                >
                  <FolderSync />
                  <span>Sync</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Forget this clone"
                  title="Forget this location (files on disk are kept)"
                  disabled={status?.kind === "working"}
                  onClick={() => library.removeClone(clone.path)}
                >
                  <X />
                </Button>
              </>
            }
          >
            {describeClone(clone, status)}
          </LocationCard>
        );
      })}
    </div>
  );
}

function LocationCard({
  icon: Icon,
  kind,
  path,
  children,
  actions,
}: {
  icon: typeof HardDrive;
  kind: string;
  path: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{kind}</div>
        <div className="truncate text-muted-foreground" title={path}>
          {path}
        </div>
        <div className="text-muted-foreground">{children}</div>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      )}
    </div>
  );
}
