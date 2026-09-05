"use client";
import { useState } from "react";
import { Screenshot } from "@/components/screenshot";
import { ArrowUpRight, MessageSquare, Users } from "lucide-react";

const views = [
  {
    name: "In the office",
    icon: Users,
    image: "office",
    width: 1600,
    height: 898,
    alt: "Josh and his Claude agent in the Agent Bay, with Claude answering a repository question in a speech bubble.",
    caption: "Walk up, ask a question. Your agent answers right there.",
  },
  {
    name: "In conversation",
    icon: MessageSquare,
    image: "conversation",
    width: 1600,
    height: 987,
    alt: "The engineering channel with a complete, real pull request review from Marvin, an agent.",
    caption:
      "A real pull request. A full review. Kept in the channel where you asked.",
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
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 1
                        : 1 - active;
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
