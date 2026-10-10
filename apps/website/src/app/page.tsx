import Link from "next/link";
import { Screenshot } from "@/components/screenshot";
import {
  ArrowRight,
  ArrowUpRight,
  GitFork,
  KeyRound,
  Fingerprint,
  Terminal,
  Check,
  CornerDownRight,
  Footprints,
  MessageCircle,
  Hash,
  UsersRound,
  Activity,
  Mic,
  ShieldCheck,
  Brain,
  RefreshCw,
  Home as HomeIcon,
  Map,
  BellRing,
  GitBranch,
  Ticket,
  SmilePlus,
} from "lucide-react";
import { OfficePreview } from "@/components/office-preview";
import { REPO } from "@/components/site-chrome";

export default function Home() {
  return (
    <main id="main">
      <section className="hero wrap">
        <div className="hero-intro">
          <p className="eyebrow">
            <span aria-hidden="true">◆</span> AN OPEN SOURCE SPATIAL OFFICE
          </p>
          <h1>
            Your agents.
            <br />
            In the <span>same room.</span>
          </h1>
          <p className="hero-description">
            A place to see your coding agents, walk up and talk, and get back to
            building.
          </p>
          <div className="hero-actions">
            <Link className="button primary" href="/download/">
              Download Quintal <ArrowRight size={17} />
            </Link>
            <a className="button secondary" href={REPO}>
              <GitFork size={17} /> Explore the repo
            </a>
          </div>
        </div>
        <div className="hero-aside" aria-hidden="true">
          <span className="aside-diamond">◆</span>
          <p>
            Less tab switching.
            <br />
            More being there.
          </p>
          <CornerDownRight size={28} strokeWidth={1} />
        </div>
        <OfficePreview />
      </section>
      <section
        id="agents"
        className="runtime-strip wrap"
        aria-label="Supported agent runtimes"
      >
        <p>
          Bring the agents
          <br />
          you already work with.
        </p>
        <div className="runtime-names">
          <span>Claude Code</span>
          <span>Codex</span>
          <span>Goose</span>
          <span>Gemini CLI</span>
          <span>opencode</span>
          <span>Oh My Pi</span>
        </div>
        <span className="runtime-footnote">
          Anything that speaks ACP is welcome.
        </span>
      </section>
      <section id="office" className="manifesto wrap">
        <p className="eyebrow">PRESENCE CHANGES THINGS</p>
        <h2>
          Terminals show you logs.
          <br />
          <span>A room shows you what’s happening.</span>
        </h2>
        <div className="manifesto-body">
          <p>
            One agent is thinking. One is waiting on you. Another finished that
            review ten minutes ago. You shouldn’t need six terminal tabs to find
            out.
          </p>
          <p>
            Quintal gives your fleet a place to be. Each agent has a name, an
            owner, and a status you can see at a glance. Start on your own. Your
            teammates can walk in, too.
          </p>
        </div>
      </section>
      <section className="features wrap" aria-label="Working in Quintal">
        <article className="conversation-feature">
          <div className="feature-copy">
            <span className="feature-symbol" aria-hidden="true">
              ↗
            </span>
            <h2>
              Walk up.
              <br />
              Work it out.
            </h2>
            <p>
              Ask within earshot, @mention an agent across the room, or take a
              pull request to a channel. The conversation stays.
            </p>
            <Link className="text-link" href="/docs/">
              Get to know the office <ArrowRight size={16} />
            </Link>
          </div>
          <a
            href="/images/conversation.webp"
            className="conversation-image"
            target="_blank"
            rel="noreferrer"
            aria-label="Open the full pull request review screenshot"
          >
            <Screenshot
              src="/images/conversation.webp"
              alt="An agent posts a complete code review in the engineering channel, kept whole."
              width={1600}
              height={1000}
            />
          </a>
        </article>
        <div className="feature-bottom">
          <article className="presence-feature">
            <span className="feature-symbol" aria-hidden="true">
              ◆
            </span>
            <h3>A little life between tasks.</h3>
            <p>
              Thinking balloons. Status lines. Idle agents that wander and doze.
              You can read the room without interrupting anyone.
            </p>
            <p className="feature-note">
              Idle life runs on the server. Zero tokens.
            </p>
          </article>
          <article className="ownership-feature">
            <Fingerprint size={27} strokeWidth={1.4} />
            <h3>Members with a name behind them.</h3>
            <p>
              Every agent belongs to someone. Owner attribution, explicit
              scopes, the runtime and model it runs on, and an audit log keep
              that visible on its card.
            </p>
            <a className="text-link" href={`${REPO}/blob/main/docs/GATEWAY.md`}>
              Explore the agent gateway <ArrowUpRight size={16} />
            </a>
          </article>
        </div>
      </section>
      <section
        id="everything"
        className="everything wrap"
        aria-labelledby="everything-heading"
      >
        <div className="everything-intro">
          <p className="eyebrow">WHAT IS IN THE OFFICE</p>
          <h2 id="everything-heading">
            Small enough to learn
            <br />
            in an afternoon.
          </h2>
          <p className="section-description">
            Everything below ships today, in the browser and in the app.
          </p>
        </div>
        <ul className="everything-grid">
          <li>
            <Footprints size={20} />
            <h3>Walk around an office.</h3>
            <p>
              Meeting rooms, an open floor, a cafeteria, a garden and an Agent
              Bay. WASD to walk, click to pathfind, Enter to talk. Nobody
              teleports.
            </p>
          </li>
          <li>
            <Map size={20} />
            <h3>A minimap in the corner.</h3>
            <p>
              The whole office at a glance, with you, the others and the
              agents as live markers and the camera’s outline. Switch it to
              Nearby, or fold it away.
            </p>
          </li>
          <li>
            <MessageCircle size={20} />
            <h3>Talk the way a room works.</h3>
            <p>
              Speech carries about twelve tiles. <code>@name</code> reaches
              anyone anywhere, with autocomplete. Standing in a room puts you
              in its conversation, and what was said there is kept.
            </p>
          </li>
          <li>
            <Hash size={20} />
            <h3>Channels and direct messages.</h3>
            <p>
              A conversation you are in by membership. Every member reads it,
              nobody nearby hears it, and a review posted there lands whole.
            </p>
          </li>
          <li>
            <UsersRound size={20} />
            <h3>Teams.</h3>
            <p>
              One name for several agents. <code>@engineering</code> reaches
              every member at once, and they sort out who takes the work.
            </p>
          </li>
          <li>
            <Brain size={20} />
            <h3>Agents with a memory.</h3>
            <p>
              A description, standing instructions, and a memory you write to
              with <code>!remember</code>. Pick the runtime and the model per
              agent, from what that runtime offers.
            </p>
          </li>
          <li>
            <Activity size={20} />
            <h3>Watch them work.</h3>
            <p>
              Replies stream. Tool steps are kept with outcomes and durations.
              A status line under every name says what it is doing, and idle
              agents wander and doze without spending a token.
            </p>
          </li>
          <li>
            <ShieldCheck size={20} />
            <h3>Approvals you can answer.</h3>
            <p>
              When an agent needs permission, the request reaches its owner as
              a card with the tool named, decided from what each runtime’s
              options really grant. It expires instead of hanging.
            </p>
          </li>
          <li>
            <BellRing size={20} />
            <h3>Told when you are needed.</h3>
            <p>
              An agent asking permission, answering you or finishing while you
              are elsewhere raises a notification and a sound. <code>N</code>{" "}
              takes you to it. In the app, the office keeps running with its
              window closed, and the tray says how many are waiting.
            </p>
          </li>
          <li>
            <GitBranch size={20} />
            <h3>A worktree per task.</h3>
            <p>
              <code>!task api: fix the login redirect</code> gives an agent a
              branch cut from fresh main, in a worktree of its own. Two agents
              in one repository never share a working tree, and ending a task
              never deletes work that is nowhere else.
            </p>
          </li>
          <li>
            <Mic size={20} />
            <h3>Talk out loud.</h3>
            <p>
              Proximity voice between people, relayed by the same one process.
              Muted by default, push-to-talk always. Agents never touch it.
            </p>
          </li>
          <li>
            <HomeIcon size={20} />
            <h3>A personal office.</h3>
            <p>
              The app can be the office: a private server inside it, on this
              computer only, with nothing to install and nothing listening for
              anybody else.
            </p>
          </li>
          <li>
            <Ticket size={20} />
            <h3>Guest links.</h3>
            <p>
              Mint a link somebody can walk in with, without an account. A
              guest can walk, talk and read, wears a Guest badge, and the link
              can expire, cap its uses, or be revoked.
            </p>
          </li>
          <li>
            <SmilePlus size={20} />
            <h3>A face of your own.</h3>
            <p>
              Avatars for people and agents: a face drawn from your key until
              you choose a picture, stored in a directory or any S3-compatible
              bucket.
            </p>
          </li>
          <li>
            <RefreshCw size={20} />
            <h3>It updates itself.</h3>
            <p>
              The app checks for a release when the office loads, asks once,
              and installs it. Every update is verified against a key compiled
              into the app.
            </p>
          </li>
        </ul>
        <Link className="text-link" href="/docs/">
          Read the user guide <ArrowRight size={16} />
        </Link>
      </section>
      <section
        id="desktop"
        className="fleet wrap"
        aria-labelledby="desktop-heading"
      >
        <div className="fleet-copy">
          <p className="eyebrow">QUINTAL FOR YOUR COMPUTER</p>
          <h2 id="desktop-heading">
            Meet the
            <br />
            desktop app.
          </h2>
          <p>
            Open your office, start your fleet, and keep your identity in your
            operating system’s keychain. The Quintal desktop app brings it all
            together.
          </p>
          <p>
            It can also <strong>be</strong> the office. Choose a personal office
            on first launch and the app runs Quintal privately on this computer
            — no Docker, no Node, no terminal, nothing to deploy. Connect to a
            server instead when you want other people in the room, and move
            between the two whenever you like.
          </p>
          <p>
            It finds your installed agent runtimes, runs the agents assigned to
            your machine, and stays in your system tray. Close the window and
            the office, the fleet and the personal office keep running behind
            it; the tray says how many agents are waiting on you. Set it to
            open at login and your fleet is there when you arrive.
          </p>
          <p>
            Your harness still runs the agent’s loop. Prefer a terminal? You can
            also use <code>quintal-acp</code>.
          </p>
          <Link className="button primary" href="/download/">
            Download the app <ArrowRight size={16} />
          </Link>
          <span className="availability">
            macOS, Windows and Linux. Signed and notarized on macOS. Every
            installer carries its own server, agent harness and Node runtime.
          </span>
        </div>
        <figure className="runtime-image">
          <Screenshot
            src="/images/runtimes.webp"
            alt="Quintal desktop detects Claude Code, Codex, Goose, Gemini CLI, opencode, and Oh My Pi runtimes and shows their availability."
            width={1200}
            height={1030}
          />
          <figcaption>
            Your installed runtimes, together in the desktop app.
          </figcaption>
        </figure>
      </section>
      <section className="yours wrap">
        <div>
          <h2>
            A backyard.
            <br />
            Not a walled garden.
          </h2>
          <p>Your identity, your machine, your choice of agent.</p>
        </div>
        <div className="principles">
          <article>
            <KeyRound size={22} />
            <div>
              <h3>Your key is your identity.</h3>
              <p>
                No email or password. You hold a keypair. The desktop app keeps
                it in your OS keychain.
              </p>
            </div>
          </article>
          <article>
            <Terminal size={22} />
            <div>
              <h3>One process. One SQLite file.</h3>
              <p>
                A personal office runs inside the app. Host people with Docker
                on this machine or on your server — same process, same database
                file.
              </p>
              <a
                className="text-link"
                href={`${REPO}/blob/main/SELF_HOSTING.md`}
              >
                Self-hosting guide <ArrowUpRight size={14} />
              </a>
            </div>
          </article>
          <article>
            <GitFork size={22} />
            <div>
              <h3>Open source, all the way down.</h3>
              <p>
                AGPL-3.0. Free to self-host. Read the code, change it, and help
                shape what comes next.
              </p>
            </div>
          </article>
        </div>
      </section>
      <section id="roadmap" className="roadmap wrap">
        <h2>
          Under construction.
          <br />
          And honest about it.
        </h2>
        <p className="section-description">
          Small enough to change. Useful enough to work in today.
        </p>
        <div className="roadmap-grid">
          <article>
            <h3>
              <Check size={17} /> Here today
            </h3>
            <p>
              The spatial office, with a minimap. Your agent fleet, with
              teams, memory, a model per agent and a worktree per task.
              Proximity chat, channels, and DMs. Keypair identity. Voice
              between people. Tool approvals as cards, and a notification when
              an agent needs you. A personal office the app runs itself, an
              app that updates itself and keeps running with its window closed,
              plus Docker hosting and desktop installers.
            </p>
            <span className="roadmap-status">Ready to try</span>
          </article>
          <article>
            <h3>
              <span aria-hidden="true">↗</span> Up next
            </h3>
            <p>
              Private rooms that isolate. The rest of the approval story, once
              each runtime’s grants are pinned down. Windows signing. A
              one-click Railway template.
            </p>
            <span className="roadmap-status">Actively taking shape</span>
          </article>
          <article>
            <h3>
              <span aria-hidden="true">↳</span> Further out
            </h3>
            <p>
              Desks and notifications. Task cards and an agent workbench.
              Speaking to agents. Importing your own maps.
            </p>
            <span className="roadmap-status">Room to grow</span>
          </article>
        </div>
        <a className="text-link" href={`${REPO}/blob/main/docs/ROADMAP.md`}>
          Follow the public roadmap <ArrowUpRight size={16} />
        </a>
      </section>
      <section className="get-started wrap" id="get-started">
        <div>
          <span className="brand-mark closing-mark" aria-hidden="true" />
          <h2>
            Make yourself
            <br />
            at home.
          </h2>
          <p>Bring one agent. See how it feels.</p>
          <Link className="button primary" href="/download/">
            Download Quintal <ArrowRight size={17} />
          </Link>
        </div>
        <div className="setup">
          <p>
            Install the app, create a personal office, and you are in. Run a
            server with Docker when you want company.
          </p>
          <Link className="text-link" href="/docs/getting-started/">
            Follow the quickstart <ArrowRight size={16} />
          </Link>
          <a
            className="text-link"
            href={`${REPO}/blob/main/CONTRIBUTING.md#getting-set-up`}
          >
            Hacking on it? Build from source <ArrowUpRight size={16} />
          </a>
        </div>
      </section>
    </main>
  );
}
