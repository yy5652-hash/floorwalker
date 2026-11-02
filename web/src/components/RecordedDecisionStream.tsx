import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { isFilm } from "../auth";
import { Money } from "./UI";
import { Button } from "./ui/button";

// Recorded demo outcomes: notes/brief-next-A.md, server/demo.ts and devpost/STORY.md.
// This is a playback illustration, never a request to the payment API.
const recordings = [
  { name: "Maya Chen", amount: "$24.00", request: "One chipped mug", outcome: "Executed", tone: "pass", checks: ["PayPal payment checked", "Refund within the rules", "Within the auto-approve limit", "AI review approved the refund"] },
  { name: "Daniel Okafor", amount: "$86.00", request: "A bowl in the wrong colour", outcome: "Held for the owner", tone: "hold", checks: ["PayPal payment checked", "Owner approval required", "Above the agent's auto-approve limit", "Held for the owner's decision"] },
  { name: "Jordan Blake", amount: null, request: "Hidden instruction in an email", outcome: "Blocked", tone: "block", checks: ["Payment facts checked independently", "Email is not an owner's authorisation", "Extra $150 payout requested in the email", "Hidden instruction detected"] },
] as const;

// motion 14.9.0: https://motion.dev/docs/react-animate-presence and /react-use-reduced-motion.
export function RecordedDecisionStream() {
  const reduced = useReducedMotion();
  const still = isFilm() || reduced;
  const [frame, setFrame] = useState(0);
  const [paused, setPaused] = useState(false);
  const [choice, setChoice] = useState(0);
  const index = still ? choice : Math.floor(frame / 8) % recordings.length;
  const step = still ? 5 : frame % 8;
  const item = recordings[index];
  useEffect(() => {
    if (still || paused) return;
    const timer = setInterval(() => { if (!document.hidden) setFrame(f => f + 1); }, 850);
    return () => clearInterval(timer);
  }, [still, paused]);
  return <figure className="decision-stream" aria-label="Recorded demo decision stream">
    <header><span>Recorded demo</span>{!still && <Button size="sm" variant="ghost" onClick={() => setPaused(!paused)}>{paused ? "Play demo stream" : "Pause demo stream"}</Button>}</header>
    <div className="stream-request"><p>{item.name}</p>{item.amount && <strong><Money value={item.amount} /></strong>}<p>{item.request}</p></div>
    <ol>{item.checks.map((text, i) => <motion.li key={`${index}-${i}`} initial={false} animate={{ opacity: step > i ? 1 : .45 }} transition={{ duration: still ? 0 : .2 }}>
      <span className={`check-status status-${step > i ? i === 0 ? "pass" : item.tone : "missing"}`}>{step > i ? "✓" : "·"}</span><span>{text}</span><small>{step > i ? "Checked" : "Pending"}</small>
    </motion.li>)}</ol>
    <motion.p className={`stream-outcome status-${step >= 5 ? item.tone : "missing"}`} initial={false} animate={{ opacity: step >= 5 ? 1 : .6 }} transition={{ duration: still ? 0 : .2 }}>{step >= 5 ? item.outcome : "Checking this request…"}</motion.p>
    <nav aria-label="Recorded requests">{recordings.map((entry, i) => <button key={entry.name} aria-pressed={index === i} onClick={() => { setChoice(i); setFrame(i * 8 + 5); }}>{entry.name.split(" ")[0]}</button>)}</nav>
    <figcaption>Recorded outcomes · PayPal sandbox · no real money</figcaption>
  </figure>;
}
