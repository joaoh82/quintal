/**
 * What each release brought, newest first. Add the new version at the top
 * when you cut a release. If you forget, the changelog page still shows the
 * current version and links to its GitHub release notes.
 */
export interface Release {
  /** Without the `v`: `0.15.0`. */
  version: string;
  /** The tag's date, `YYYY-MM-DD`. */
  date: string;
  /** One line on what the release is about. */
  summary: string;
  changes: string[];
}

export const RELEASES: Release[] = [
  {
    version: "0.17.0",
    date: "2026-10-31",
    summary: "Deploy to Render or your own VM, and claim a fresh server with a link.",
    changes: [
      "A fresh server no longer goes to whoever signs in first. It prints a single-use link in its log, and whoever opens it and signs in runs the office. Lost it? pnpm admin claim prints a new one. Or name the admin up front with QUINTAL_OWNER.",
      "Deploy to Render in one click: one service with a disk, nothing to fill in.",
      "compose.vm.yml runs Quintal on any VM with your domain, with HTTPS through Caddy.",
      "Signing in from the wrong address now says which address the server expects and which setting to change.",
      "Agent replies render as Markdown in the chat, and long replies split between blocks instead of mid-sentence.",
      "A Codex tool call that answered now shows as succeeded.",
    ],
  },
  {
    version: "0.16.0",
    date: "2026-10-29",
    summary: "Who's reviewing what, and every pull request at a glance.",
    changes: [
      "A pull request handed to one of your agents for review says which agent on the Pull requests tab, with who asked and when.",
      "Hover a pull request's number or title for its full title, branches, author, reviewers, merge and review state and every check by name, with a link to GitHub. Click the title to keep it open.",
      "The website has a changelog, and shows the current version at the top of every page.",
    ],
  },
  {
    version: "0.15.0",
    date: "2026-10-29",
    summary: "Every pull request in one place, and agents that review them.",
    changes: [
      "The Pull requests tab lists every pull request in the repositories on the office's GitHub list, whoever opened it, alongside your agents' own.",
      "Filter pull requests by status, author (a GitHub login or an agent) and project.",
      "Review on any open pull request asks one of your agents to review it. The request lands in your DM with the agent, which leaves its review on GitHub and reports back. It never approves or merges unless you ask.",
      "Each agent on the Agents tab has a History of what it worked on before: branches, notes, pull requests and how they ended.",
      "Alt+B (Option+B on a Mac) opens the board from anywhere, even while you're typing in the chat.",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-10-29",
    summary: "The office board.",
    changes: [
      "An office board: notes on post-its or in columns, open, in progress and done. Walk up to the noticeboard in the lobby and press E, click it, or press B.",
      "Hand a note to one of your agents. It's briefed in your DM, and the note follows its branch and pull request to done.",
      "Agents read and write the board themselves, with board_list, board_get, board_create and board_update.",
      "The Agents tab shows every agent, here or not. The Pull requests tab shows the office's ledger of agents' work.",
      "Give the office a GitHub token to see checks, mergeability and reviews on the board, and to merge or close from it.",
      "Up and Down bring back lines you sent in the chat.",
      "quintal-acp runs as a service on a headless machine, so a fleet stays up.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-10-25",
    summary: "Cursor joins the runtimes.",
    changes: ["Cursor can run an agent, next to the runtimes already supported."],
  },
  {
    version: "0.12.0",
    date: "2026-10-25",
    summary: "A review command out of the box.",
    changes: ["New offices start with a !review command ready to use."],
  },
  {
    version: "0.11.0",
    date: "2026-10-24",
    summary: "Updates from settings.",
    changes: [
      "The desktop app checks for updates from its settings, without restarting.",
      "An office command's instructions can run to 16,000 characters.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-10-24",
    summary: "Office commands.",
    changes: ["Office commands with a standing brief, like !review @engineering <link>, aimed at a person, an agent or a team."],
  },
  {
    version: "0.9.0",
    date: "2026-10-23",
    summary: "MCP servers for agents.",
    changes: [
      "Give an agent MCP servers from its settings card.",
      "Reload an agent's tools without losing the conversation.",
      "The Linux desktop app runs the office on Wayland.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-10-20",
    summary: "Tasks on the office card.",
    changes: [
      "An agent's office card shows its task, branch and pull request.",
      "The website walks first-time visitors through the personal office.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-10-10",
    summary: "Worktrees, a minimap and alerts.",
    changes: [
      "A git worktree per task: !task and task_begin cut a branch from fresh main, and cleanup keeps unpushed work.",
      "The desktop office keeps running when its window closes, and tells you when an agent needs you.",
      "A live minimap with a nearby view.",
      "Smoother movement when the server's positions arrive late.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-09-29",
    summary: "A personal office, and a new look.",
    changes: [
      "The desktop app can run a personal office itself, private to your computer, as well as connect to a server.",
      "The office was remade on the Shared World art pack.",
      "Office cards say what each agent runs on, and when its runtime never asks for permission.",
      "Tool approvals follow what each runtime actually does, and never offer a looser option.",
      "Fixes up to 0.6.4 made the release builds and the personal office reliable on macOS, Windows and Linux.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-09-24",
    summary: "Update fixes.",
    changes: ["Each macOS update package has a name of its own, so both architectures update correctly."],
  },
  {
    version: "0.4.0",
    date: "2026-09-24",
    summary: "Approvals as cards.",
    changes: ["An agent's tool approvals appear in front of its owner as cards, and survive the agent reconnecting."],
  },
  {
    version: "0.3.0",
    date: "2026-09-22",
    summary: "Self-updating desktop app.",
    changes: [
      "The desktop app checks for updates at launch, asks once, then installs and restarts.",
      "Every screen with room for it says which version you're running.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-09-19",
    summary: "Live agent activity.",
    changes: [
      "Watch an agent's public activity stream live, per conversation, at the level of detail you choose.",
      "Agents find worktrees and folders that group repositories.",
      "Host tokens are kept per office.",
      "The website gained an installer download page and Docker-first setup.",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-14",
    summary: "The first release.",
    changes: [
      "A 2D office you walk around with others, with nearby chat and @-addressing.",
      "AI agents as first-class members, bridged in from real coding harnesses a fleet at a time.",
      "Agents walk, set their own status and answer ! commands.",
      "Define a fleet in the office and it boots on your machine.",
      "Desktop apps for macOS, Windows and Linux. 0.1.1 and 0.1.2 fixed the installers and signed the macOS builds.",
    ],
  },
];
