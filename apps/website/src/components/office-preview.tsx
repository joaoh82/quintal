"use client";
import { useState } from "react";
import { Screenshot } from "@/components/screenshot";
import { ArrowUpRight, Lightbulb, MessageSquare, Users } from "lucide-react";

const views = [
  {
    name: "In the office",
    icon: Users,
    image: "office",
    width: 1600,
    height: 1000,
    alt: "Josh asks Arthur what the harness’s new task_begin tool does, and Arthur answers in a speech bubble from across the Agent Bay, with the minimap in the corner.",
    caption: "Walk up, ask a question. Your agent answers right there.",
  },
  {
    name: "Thinking",
    icon: Lightbulb,
    image: "thinking",
    width: 1600,
    height: 1000,
    alt: "Marvin addressed by name, with a thinking balloon over its head, “thinking” under its nameplate, and the turn running in the chat box.",
    caption:
      "Address an agent by name and watch it think. The balloon, the status line and the steps are all real.",
  },
  {
    name: "In conversation",
    icon: MessageSquare,
    image: "conversation",
    width: 1600,
    height: 1000,
    alt: "The engineering channel with a complete, real code review posted whole by an agent.",
    caption:
      "A real commit. A full review. Kept in the channel where you asked.",
  },
];
export function OfficePreview() {
  const [active, setActive] = useState(0);
  const view = views[active];
  return (
    <div className="office-preview">
      <div className="preview-toolbar">
        <div
          className="preview-tabs"
          role="tablist"
          aria-label="Product screenshots"
        >
          {views.map((item, index) => (
            <button
              key={item.name}
              role="tab"
              id={`view-tab-${index}`}
              aria-selected={active === index}
              aria-controls="office-panel"
              tabIndex={active === index ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const last = views.length - 1;
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : event.key === "ArrowLeft"
                          ? (active + last) % views.length
                          : (active + 1) % views.length;
                  setActive(next);
                  document.getElementById(`view-tab-${next}`)?.focus();
                }
              }}
            >
              <item.icon size={15} aria-hidden="true" />
              {item.name}
            </button>
          ))}
        </div>
        <span className="preview-hint">A little room. Real work.</span>
      </div>
      <div
        id="office-panel"
        role="tabpanel"
        aria-labelledby={`view-tab-${active}`}
        className="preview-image"
      >
        <Screenshot
          src={`/images/${view.image}.webp`}
          alt={view.alt}
          width={view.width}
          height={view.height}
          priority={active === 0}
          sizes="(max-width: 768px) 100vw, 1200px"
        />
      </div>
      <div className="preview-caption">
        <p>{view.caption}</p>
        <a href={`/images/${view.image}.webp`} target="_blank" rel="noreferrer">
          View full size <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
