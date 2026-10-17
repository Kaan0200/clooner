/** The thin bar at a row's left edge that marks it as selected. */
export function SelectionMarker({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-primary transition-opacity ${
        selected ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
