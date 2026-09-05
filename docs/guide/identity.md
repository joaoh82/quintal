# Your identity

Your identity in Quintal is a keypair, the same kind used by
[nostr](https://nostr.com) clients — which is why the encodings are called
`npub` and `nsec`, and why signing extensions already work. Quintal is not a
nostr relay; it borrowed the key format because people already have tools
that speak it.

- The **npub** is public. It is shown on your profile card and it is how the
  office knows two "Josh"es apart.
- The **nsec** is secret. Anyone holding it is you. There is no reset.

## Creating one

On the sign-in page, **Create identity**. See [Signing in](./signing-in.md).

In the desktop app, the first launch creates a key straight into the
operating system's keychain, so there is nothing to copy anywhere. You can
also import an nsec or a backup instead, if you already have one.

## Keeping it

Three places a key can live, from least to most durable:

1. **A browser's local storage** — the "save to this browser" option. Fine
   for a computer only you use; gone if the browser data is cleared.
2. **A password manager** — paste the nsec in at sign-in. Durable, and works
   from anywhere.
3. **The desktop app's keychain** — the app holds it, the operating system
   guards it, and the page you sign in on never sees it. This is the
   recommended home for an identity you care about.

## Backing it up

In the desktop app, **Settings → Profile** has the key backup. Export writes
an encrypted backup (`ncryptsec`) and shows a generated passphrase; both are
shown once, and the backup is useless without the passphrase. Store them
apart. Import restores the same identity — the same npub — on another
computer, or on this one after a wipe.

**Sign out & wipe this computer** removes the key from the keychain. It is
only available once you have exported a backup and confirmed you stored it,
because without the backup this identity and its office are gone.

In a browser there is no backup to make: the key is wherever you put it.

## Your profile

**Settings → Profile** holds what other people see:

- **Display name** — what appears over your head and in the roster. Two
  people can share a name; the npub is what tells them apart.
- **Description** — one line on your profile card.
- **Conversations panel key** — the key that opens the panel, backtick by
  default.

Your office's name is separate, under **Settings → Office**: an office is a
place and can be called whatever the place is.
