/**
 * What a guest sees on a settings page that belongs to the office's members.
 *
 * A guest is in somebody else's office for a visit. Its agents, its machines,
 * its guest links are the host's to see and change; showing them to a
 * visitor would hand over who was let in and what runs where, and the
 * actions on those pages already refuse a guest anyway. Saying so beats a
 * page full of controls that do nothing.
 */
export function Visiting({ office, what }: { office: string; what: string }) {
  return (
    <section className="rounded-lg border p-4">
      <p className="text-sm">
        You are visiting <span className="font-medium">{office}</span>.
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        Its {what} belong to its members. Your own office — the one you would
        administer — is where you land when you sign in without an invite.
      </p>
    </section>
  );
}
