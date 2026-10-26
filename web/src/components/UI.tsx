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
      className="inline-flex items-center gap-2 text-xl font-semibold tracking-tight"
      aria-label="Allowance home"
    >
      <img src="/favicon.svg" width="28" height="28" alt="" />
      <span>Allowance</span>
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
    <Badge
      variant="secondary"
      className={`max-w-full gap-1.5 whitespace-normal border-transparent text-[11px] tone-${statusTone(status)}`}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {STATUS_LABEL[status]}
    </Badge>
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
export const MCP_COMMAND = isFilm() ? "claude mcp add allowance -- npx tsx server/mcp.ts" : `claude mcp add --transport http allowance ${location.origin}/v1/mcp --header "Authorization: Bearer <key>"`;
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
