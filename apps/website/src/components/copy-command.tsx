"use client";
import { useState, useEffect, useRef } from "react";
import { Check, Copy } from "lucide-react";
export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState("Copy");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("Copied");
    } catch {
      setStatus("Select text to copy");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("Copy"), 3000);
  }
  return (
    <div className="command-block">
      <pre>
        <code>{command}</code>
      </pre>
      <button onClick={copy} aria-label="Copy setup commands">
        {status === "Copied" ? <Check size={16} /> : <Copy size={16} />}
        <span aria-live="polite">{status}</span>
      </button>
    </div>
  );
}
