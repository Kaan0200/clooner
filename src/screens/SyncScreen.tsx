import { FolderSync, HardDrive, Plus, RefreshCw, Usb, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CloneEntry } from "@/core/db";
import type { CloneResult } from "@/lib/library";
import type { SyncSummary } from "@/lib/sync";
import type { CloneStatus, Library, SourceStatus } from "@/lib/useLibrary";

export default function SyncScreen({ library }: { library: Library }) {
  const { source, sourceStatus, clones, cloneStatus, busy, loading, warning, error } = library;
  const sourceReady = sourceStatus?.kind === "ready";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex space-x-2 border-b p-2">
        <Button
          variant="outline"
          size="lg"
          title={source ? "Replace the source library" : "Add Source Location"}
          onClick={library.addSource}
          disabled={busy || loading}
        >
          <Plus />
          <span>{source ? "Change Source" : "Add Source"}</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          title={sourceReady ? "Add Clone Location" : "Add a source first"}
          onClick={library.addClone}
          disabled={busy || !sourceReady}
        >
          <Plus />
          <span>Add A Clone</span>
        </Button>
        <Button
          variant="outline"
          size="lg"
          title="Rescan the source and check every clone"
          onClick={library.rescan}
          disabled={busy || !source || sourceStatus?.kind === "scanning"}
        >
          <RefreshCw />
          <span>Rescan</span>
        </Button>
      </header>

      <div className="flex flex-col gap-2 p-2 text-sm">
        {loading && <div className="text-muted-foreground">Loading…</div>}

        {!loading && !source && clones.length === 0 && (
          <div className="text-muted-foreground">No locations yet.</div>
        )}

        {source && (
          <LocationCard icon={HardDrive} kind="Source" path={source.path}>
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
                    disabled={status?.kind === "syncing"}
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

        {warning && <div className="text-muted-foreground">{warning}</div>}
        {error && <div className="text-destructive">{error}</div>}
      </div>
    </div>
  );
}

function syncTitle(sourceReady: boolean, status: CloneStatus | undefined): string {
  if (!sourceReady) return "The source must be connected to sync";
  switch (status?.kind) {
    case "ready":
      return "Copy every crate's tracks here and write its Serato crates and playlists";
    case "syncing":
      return "Sync in progress";
    case "missing":
      return "The clone isn't connected";
    default:
      return "The clone isn't ready yet";
  }
}

function describeSource(status: SourceStatus | null): string {
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

function describeClone(clone: CloneEntry, status: CloneStatus | undefined): string {
  switch (status?.kind) {
    case "ready":
      return status.summary ? describeSummary(status.summary) : describeAttached(clone, status.result);
    case "syncing":
      return status.progress;
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

function describeAttached(clone: CloneEntry, { existing, folders, tracks }: CloneResult): string {
  const folderText = `${folders.toLocaleString()} folders`;
  if (!existing) return `${folderText} created, never synced`;
  const trackText = tracks === 0 ? "no tracks" : `${tracks.toLocaleString()} tracks`;
  const when = clone.lastSync ? `last synced ${relativeTime(clone.lastSync)}` : "never synced";
  return `${trackText} in ${folderText}, ${when}`;
}

function describeSummary(s: SyncSummary): string {
  const parts = [`${s.copied.toLocaleString()} copied`, `${s.unchanged.toLocaleString()} unchanged`];
  if (s.missing) parts.push(`${s.missing.toLocaleString()} missing from source`);
  if (s.outside) parts.push(`${s.outside.toLocaleString()} outside the library`);
  parts.push(`${s.crates.toLocaleString()} crates written`);
  if (s.orphans) parts.push(`${s.orphans.toLocaleString()} files in no crate`);
  return `Synced ${relativeTime(s.finished)}: ${parts.join(", ")}`;
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
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
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
