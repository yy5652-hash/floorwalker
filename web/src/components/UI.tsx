import { isFilm } from "../auth";
import { Check, CheckCircle2, Clock3, Copy, ShieldX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  STATUS_LABEL,
  statusTone,
  type LedgerEntry,
} from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";

export function Brand() {
  return (
    <a
      href="/"
      className="brand-mark"
      aria-label="Floorwalker home"
    >
      <img src="/favicon.svg" width="28" height="28" alt="" />
      <span>Floorwalker</span>
    </a>
  );
}
export function OutcomeIcon({ status }: { status: LedgerEntry["status"] }) {
  const tone = statusTone(status);
  const Icon =
    tone === "allow" ? CheckCircle2 : tone === "hold" ? Clock3 : ShieldX;
  return (
    <span
      className={`grid size-9 shrink-0 place-items-center rounded-full tone-${tone}`}
    >
      <Icon className="size-4" />
    </span>
  );
}
export function StatusPill({ status }: { status: LedgerEntry["status"] }) {
  return (
    <span className={`status-label tone-${statusTone(status)}`}>{STATUS_LABEL[status]}</span>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircle2 />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}
export const MCP_COMMAND = isFilm() ? "claude mcp add floorwalker -- npx tsx server/mcp.ts" : `claude mcp add --transport http floorwalker ${location.origin}/v1/mcp --header "Authorization: Bearer <key>"`;
export function ConnectAgent({ notify }: { notify: (s: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      notify(
        `Copy failed: ${errorMessage(e)} Select the command to copy it manually.`,
      );
    }
  }
  return (
    <div className="space-y-3">
      <h3>Connect another agent</h3>
      <p className="text-sm text-muted-foreground">
        Any MCP client gets the same PayPal tools under your rules.
      </p>
      <div className="flex items-start gap-3 rounded-lg border bg-muted/50 p-3">
        <code className="min-w-0 flex-1 self-center break-all leading-6">
          {MCP_COMMAND}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy MCP command"
          onClick={copy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

export function Money({ value }: { value: string }) {
  const match = value.match(/^(.*)(\.\d{2})$/);
  return <span className="money">{match ? <>{match[1]}<span className="money-cents">{match[2]}</span></> : value}</span>;
}
