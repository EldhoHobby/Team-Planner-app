// Shown in the content area (the sidebar stays) while a page in the app shell
// loads. Kept subtle because it appears on many navigations: it fades in only
// after ~300 ms, so fast pages never flash it.

export default function AppLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="p-6 duration-300 animate-in fade-in-0 delay-300 fill-mode-both"
    >
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="space-y-4">
        <div className="h-6 w-48 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded-md bg-muted" />
        <div className="space-y-2 pt-2">
          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-full animate-pulse rounded-md bg-muted/70" />
          <div className="h-9 w-full animate-pulse rounded-md bg-muted/50" />
        </div>
      </div>
    </div>
  );
}
