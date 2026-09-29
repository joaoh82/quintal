# Screenshots

Images used by the root `README.md`, the user guide in `docs/guide/`, and — by
way of the webp set described below — the website. Keep them current: a
screenshot of a version of Quintal that no longer exists is worse than no
screenshot.

| File | What it shows | Used in |
| --- | --- | --- |
| `office.png` | The office with people in it: its owner and two agents in the Agent Bay, the garden through the doors | README |
| `office_with_agent.png` | An agent answering a real question about its repo, from the Agent Bay | README |
| `office-agent-bay.png` | Two agents and their owner in the Agent Bay; roster and the corner chat box with its tabs | guide: features |
| `agent-thinking.png` | An agent addressed with `@name`, thinking: the balloon over its head, the status line, and the working line in the chat box | README, guide: agents |
| `agent-speech-bubble.png` | The same agent answering out loud, in a speech bubble | guide: agents |
| `agent-profile-card.png` | An agent's profile card from the roster: owner, status, scopes, the runtime and model it runs on, Message and Audit log | guide: agents |
| `conversations-panel-channel-review.png` | The conversations panel open on `#engineering`, with an agent's full code review posted whole | README, guide: channels |
| `settings-office.png` | Settings → Office: office name, server name, earshot, walk-up distance, reply reach | guide: features |
| `settings-agents.png` | Settings → Agents: two agents with runtime, model, machine and repo | guide: agents |
| `settings-channels.png` | Settings → Channels: making a channel and its members | guide: channels |
| `desktop-runtimes.png` | The desktop app's Agents tab: the fleet running, and every agent runtime this machine has | README, guide: agents |

A screenshot of an agent should show it doing something a person would
plausibly ask for, with the owner attribution visible. A staged "hello" proves
nothing that a mockup couldn't.

Prefer PNG, and capture at a window size where the UI is legible without
zooming (roughly 1600px wide). Crop out browser chrome. Name the file after
what it shows, not when it was taken.

The current set was captured at a 1600x1000 viewport with a device pixel ratio
of 2, giving 3200x2000 PNGs, through Chrome's DevTools protocol rather than a
screen grab — so there is no browser chrome to crop and no JPEG artefacts on
the pixel art. Hide the Next.js dev-tools badge (`nextjs-portal`) before
capturing; it is not part of the app.

## The website's copies

`apps/website/public/images/` holds webp derivatives, three widths each, that
the site serves directly so static hosting needs no image server:

| Website image | Derived from |
| --- | --- |
| `office.webp` | `office_with_agent.png` |
| `conversation.webp` | `conversations-panel-channel-review.png` |
| `runtimes.webp` | `desktop-runtimes.png` |

Regenerate one after retaking its source, at 1600, 960 and 640 wide:

```sh
for w in 1600 960 640; do
  h=$(( w * 1000 / 1600 ))
  out=apps/website/public/images/office.webp
  [ $w -eq 1600 ] || out=apps/website/public/images/office-$w.webp
  cwebp -q 82 -resize $w $h screenshots/office_with_agent.png -o "$out"
done
```

Keep the aspect ratio in step with the page: `Screenshot` takes explicit
`width`/`height`, `.preview-image` in `globals.css` pins an `aspect-ratio`,
and the Open Graph image in `layout.tsx` declares its own size. A source
retaken at a different shape means changing all three, or the hero is cropped
and social cards are letterboxed.
