/**
 * Shown the moment a tab is clicked, while its page is fetched.
 *
 * The pages themselves answer in milliseconds on a built server; this is
 * for the dev server, which compiles a page on its first visit, and for a
 * slow connection. Either way a click that does nothing visible for a
 * second reads as a click that did not register.
 */
export default function SettingsLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="bg-muted h-5 w-40 rounded" />
      <div className="bg-muted h-24 rounded-lg" />
      <div className="bg-muted h-40 rounded-lg" />
    </div>
  );
}
