import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function SyncScreen() {
  return (
    <div className="p-2 text-sm text-muted-foreground">
      <header className="flex space-x-2 border-b p-2">
        <Button variant="outline" size="lg" title="Add Source Location">
          <Plus />
          <span>Add Source</span>
        </Button>
        <Button variant="outline" size="lg" title="Add Source Location">
          <Plus />
          <span>Add A Clone</span>
        </Button>
      </header>
      {/* Locations list, status and Sync button go here */}
      No locations yet.
    </div>
  );
}
