# Signing in

Quintal has no accounts, no email and no passwords. Your identity is a key you
hold, and signing in means proving you hold it. The sign-in page at `/login`
offers every way to do that.

## First time here

Pick **Create identity**. The browser makes a keypair on the spot and shows
you two things:

- your **npub**, the public half — this is who you are to everyone else;
- your **nsec**, the secret half — anyone holding it can be you.

Put the nsec in a password manager now. It is shown once, and nobody can
reset or reissue it, because the office never had it. Then continue: you land
in your own office, named after you (`<name>'s Office`) until you rename it.

**Save this key to this browser** keeps the nsec in the browser's local
storage so you do not have to paste it next time. It is convenient and low
security — leave it off on a shared machine. The desktop app does this
properly, in the operating system's keychain. See
[Your identity](./identity.md).

## Coming back

Depending on where your key lives:

| Where your key is | How to sign in |
| --- | --- |
| The desktop app's keychain | **Continue with this computer's key.** If the page says the keychain is locked, unlock it and try again — do not create a new identity, or you will lose this one. |
| A signing extension (NIP-07) | **Use my signing extension.** The extension signs the challenge; the page never sees your key. |
| A password manager | Paste the nsec into the field and sign in. |
| This browser (saved earlier) | The page recognises it and offers to continue as you. |

Signing in is a short server-issued challenge signed with your key. That
mints an ordinary session, so once you are in, nothing else asks for the key
until the session ends.

## Walking in as a guest

Somebody can hand you a **guest link** (they make it in Settings → Guests).
Opening it puts you in their office as a visitor with a key minted for the
visit — it lives in that tab and nowhere else, and you can trade it for a
real identity later. A guest can walk, talk and read, but not change how the
office works. Links can expire, allow a set number of uses, and be revoked by
whoever made them.

## Which office am I in?

You always have an office of your own. Visiting somebody else's shows their
office in the header with a note that you are visiting, and a way back to
yours. In the desktop app, offices are places you can switch between — see
[The desktop app](../DESKTOP.md#offices).

## If you cannot get in

The sign-in page has a way out of an office you cannot get into: **Open a
different office** lets you point at another instance, because sign-in can
fail for reasons that have nothing to do with your key — a server that is
down, or an address that changed.
