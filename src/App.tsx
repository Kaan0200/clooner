import { FolderPlus, FolderTree, HardDrive, RefreshCw, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

const actions = [
  { icon: HardDrive, label: "Locations" },
  { icon: FolderTree, label: "Collections" },
  { icon: FolderPlus, label: "New crate" },
  { icon: ScanSearch, label: "Scan" },
  { icon: RefreshCw, label: "Sync" },
];

export default function App() {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 gap-2 border-b p-2">
        {actions.map(({ icon: Icon, label }) => (
          <Button
            key={label}
            variant="outline"
            size="icon-lg"
            aria-label={label}
            title={label}
          >
            <Icon />
          </Button>
        ))}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2 text-sm text-muted-foreground">
          {/* Crate tree goes here */}
          No crates yet.
        </div>
      </ScrollArea>
    </div>
  );
}
