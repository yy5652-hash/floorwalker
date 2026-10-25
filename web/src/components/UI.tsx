import { Check, CheckCircle2, Clock3, Copy, ShieldX } from "lucide-react";
import { useRef, useState } from "react";
import { errorMessage, STATUS_LABEL, statusTone, type LedgerEntry } from "../api";

export function Brand() {
  return <a href="/" className="brand" aria-label="Allowance home"><img src="/favicon.svg" width="30" height="30" alt="" /><span>Allowance</span></a>;
}
export function OutcomeIcon({ status }: { status: LedgerEntry["status"] }) {
  const tone = statusTone(status);
  const Icon = tone === "allow" ? CheckCircle2 : tone === "hold" ? Clock3 : ShieldX;
  return <span className={`outcome-icon ${tone}`}><Icon size={17} /></span>;
}
export function StatusPill({ status }: { status: LedgerEntry["status"] }) {
  return <span className={`pill ${statusTone(status)}`}><span className="tiny-dot" />{STATUS_LABEL[status]}</span>;
}
export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><span className="empty-icon"><CheckCircle2 size={26} /></span><h3>{title}</h3>{children && <div className="empty-description">{children}</div>}</div>;
}
export const MCP_COMMAND = "claude mcp add allowance -- npx tsx server/mcp.ts";
export function ConnectAgent({ notify }: { notify: (s: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch (e) { notify(`Copy failed: ${errorMessage(e)} Select the command to copy it manually.`); }
  }
  return <div className="connect-agent"><h3>Connect another agent</h3><p>Any MCP client gets the same PayPal tools under your rules.</p><div className="command"><code>{MCP_COMMAND}</code><button className="btn icon-btn" aria-label="Copy MCP command" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div></div>;
}
