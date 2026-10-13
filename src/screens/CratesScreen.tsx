import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function CratesScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex justify-between border-b p-2">
        <Button variant="outline" size="lg" title="Add crate">
          <Plus />
          <span>Add</span>
        </Button>
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
