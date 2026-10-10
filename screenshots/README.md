# Screenshots

Images used by the root `README.md`, the user guide in `docs/guide/`, and — by
way of the webp set described below — the website. Keep them current: a
screenshot of a version of Quintal that no longer exists is worse than no
screenshot.

| File | What it shows | Used in |
| --- | --- | --- |
| `office.png` | The office with people in it: its owner and two agents in the Agent Bay, the cafeteria corner and the garden through the doors | spare |
| `office_with_agent.png` | Josh asks Arthur what the last commit on the branch changed; Arthur answers in a speech bubble, with Marvin beside him | README, website |
| `office-agent-bay.png` | Both agents and their owner in the Agent Bay; roster and the corner chat box with its tabs | guide: features |
| `agent-thinking.png` | Marvin addressed with `@Marvin`, thinking: the balloon over its head, the status line, the question in a bubble over Josh, and the turn running in the chat box | README, guide: agents, website |
| `agent-speech-bubble.png` | The same agent answering out loud, in a speech bubble, after counting the migrations it was asked about | guide: agents |
| `agent-profile-card.png` | Marvin's profile card from the roster: owner, status, scopes, the runtime and model it runs on, Message and Audit log | guide: agents |
| `conversations-panel-channel-review.png` | The conversations panel open on `#engineering`, with Marvin's full review of a commit posted whole | README, guide: channels, website |
| `settings-office.png` | Settings → Office: office name, server name, earshot, walk-up distance, reply reach, agent parallelism | guide: features |
| `settings-agents.png` | Settings → Agents: four agents with runtime, model, scopes, machine and repo — including one whose runtime never asks for permission | guide: agents |
| `settings-channels.png` | Settings → Channels: making a channel and its members | guide: channels |
| `desktop-runtimes.png` | The desktop app's Agents tab: the fleet running, and every agent runtime this machine has | README, guide: agents |

A screenshot of an agent should show it doing something a person would
plausibly ask for, with the owner attribution visible. A staged "hello" proves
nothing that a mockup couldn't.

Prefer PNG, and capture at a window size where the UI is legible without
zooming (roughly 1600px wide). Crop out browser chrome. Name the file after
what it shows, not when it was taken.

The office and conversation shots were captured at a 1600x1000 viewport with a
device pixel ratio of 2, giving 3200x2000 PNGs, through Chrome's DevTools
protocol rather than a screen grab — so there is no browser chrome to crop and
no JPEG artefacts on the pixel art. Hide the Next.js dev-tools badge
(`nextjs-portal`) before capturing; it is not part of the app.

The current set was taken on 10 October 2026 against `pnpm dev` with the
manifests already at the release version, so the header says the number the
release ships with. Headless Chromium (`chromium --headless=new
--remote-debugging-port=9222 --window-size=1600,1000
--force-device-scale-factor=2`) was driven over the DevTools protocol with
`Emulation.setDeviceMetricsOverride` and `Page.captureScreenshot`; movement
is click-to-walk through `Input.dispatchMouseEvent`, and chat through
`Input.insertText`. Both agents are real sessions — Arthur on Codex, Marvin
on Claude Code — started with `quintal-acp` against the repository, answering
real questions; nothing in a bubble or a channel was typed by hand. Take a
frame every second after asking: an answer bubble stays up for a few seconds
only, and the thinking balloon for less.

The four settings and desktop shots come from the desktop app instead, because
the runtime list, the machine an agent runs on and the running fleet only exist
there. They were taken from a 1280x1040-point window on a 2x display and
cropped to the content, so they are 2x too. Put the app in the **Light** theme
first — the set is light — and crop away the window's title bar. The dev-tools
badge sits in the page's left margin at that width, so a crop that starts at
the content column drops it without hiding anything.

## The website's copies

`apps/website/public/images/` holds webp derivatives, three widths each, that
the site serves directly so static hosting needs no image server:

| Website image | Derived from |
| --- | --- |
| `office.webp` | `office_with_agent.png` |
| `conversation.webp` | `conversations-panel-channel-review.png` |
| `thinking.webp` | `agent-thinking.png` |
| `runtimes.webp` | `desktop-runtimes.png` |

Regenerate one after retaking its source, at 1600, 960 and 640 wide, with
`cwebp` or ImageMagick — either gives the same shape:

```sh
for w in 1600 960 640; do
  h=$(( w * 1000 / 1600 ))
  out=apps/website/public/images/office.webp
  [ $w -eq 1600 ] || out=apps/website/public/images/office-$w.webp
  cwebp -q 82 -resize $w $h screenshots/office_with_agent.png -o "$out"
  # or: magick screenshots/office_with_agent.png -resize ${w}x${h} -quality 82 "$out"
done
```

Keep the aspect ratio in step with the page: `Screenshot` takes explicit
`width`/`height`, `.preview-image` in `globals.css` pins an `aspect-ratio`,
and the Open Graph image in `layout.tsx` declares its own size. A source
retaken at a different shape means changing all three, or the hero is cropped
and social cards are letterboxed.
