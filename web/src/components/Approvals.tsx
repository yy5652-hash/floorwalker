import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ArrowRight, Check, Smartphone, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import {
  agentName,
  amountOf,
  errorMessage,
  money,
  personName,
  post,
  relativeTime,
  type LedgerEntry,
  type PageProps,
} from "../api";
import { Checks, ReviewNote } from "./Verdict";
import { EmptyState, StatusPill } from "./UI";
// qrcode 1.5.4 browser API: https://github.com/soldair/node-qrcode/tree/v1.5.4#todataurltext-options-cberror-url
export function PhoneApproval() {
  const url = `${location.origin}/approve`;
  const [qr, setQr] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, {
      width: 240,
      margin: 4,
      errorCorrectionLevel: "M",
      color: { dark: "#0F172A", light: "#FFFFFF" },
    })
      .then((data) => {
        if (active) setQr(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <a
      className="flex items-center gap-3 rounded-xl border bg-card p-2 pr-4 shadow-xs [&_strong]:flex [&_strong]:items-center [&_strong]:gap-1 [&_strong]:text-xs [&_span]:my-1 [&_span]:block [&_span]:text-xs [&_span]:text-muted-foreground [&_small]:block [&_small]:max-w-48 [&_small]:break-all [&_small]:text-[10px] [&_small]:text-muted-foreground [&_img]:rounded-lg min-w-0"
      href="/approve"
      target="_blank"
      rel="noreferrer"
    >
      {qr ? (
        <img
          src={qr}
          width="78"
          height="78"
          alt="QR code to open approvals on your phone"
        />
      ) : (
        <Smartphone size={34} />
      )}
      <div>
        <strong>
          Approve from your phone <ArrowRight size={13} />
        </strong>
        <span>Scan for one-tap approvals</span>
        <small>{url}</small>
      </div>
    </a>
  );
}
export function ApprovalCard({
  entry,
  state,
  refresh,
  notify,
  compact = false,
}: PageProps & {
  entry: LedgerEntry;
  compact?: boolean;
}) {
  const [other, setOther] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LedgerEntry | null>(null);
  const locked = useRef(false);
  const custom = Number(amount);
  const valid =
    amount.trim() !== "" &&
    Number.isFinite(custom) &&
    custom > 0 &&
    custom <= entry.amount &&
    Math.abs(custom * 100 - Math.round(custom * 100)) < 0.000001;
  async function decide(action: "approve" | "decline", customAmount?: number) {
    if (locked.current || result || entry.status !== "awaiting_approval")
      return;
    locked.current = true;
    setBusy(action);
    setError("");
    try {
      const updated = await post<LedgerEntry>(
        `/api/ledger/${entry.id}/${action}`,
        customAmount === undefined ? undefined : { amount: customAmount },
      );
      setResult(updated);
      notify(
        updated.status === "failed"
          ? `Payment failed: ${updated.error ?? "PayPal could not complete this request."}`
          : action === "decline"
            ? `Declined · ${money(entry.amount)} to ${personName(entry.counterparty)}`
            : updated.status === "approved"
              ? `PayPal ${entry.kind} ${updated.paypal_ref ?? ""} submitted · ${money(amountOf(updated))}`
              : `Request #${entry.id} · processing in PayPal`,
      );
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      notify(errorMessage(e));
      await refresh();
    } finally {
      setBusy(null);
      locked.current = false;
    }
  }
  return (
    <Card
      className={`min-w-0 gap-0 py-0 shadow-xs   approval-card space-y-4 self-start p-5   ${compact ? "compact" : ""}`}
      data-film="approval"
      aria-label={`Request ${entry.id}: ${money(entry.amount)} to ${entry.counterparty ?? "the buyer"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&_time]:ml-auto">
        <span className="flex items-center gap-2 font-medium">
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-current" />
          {agentName(state, entry.agent_id)}
        </span>
        <time dateTime={entry.created_at}>
          {relativeTime(entry.created_at)}
        </time>
        <span className="font-mono text-[10px] text-muted-foreground">
          #{entry.id}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="block text-[10px] font-medium tracking-widest text-muted-foreground">
            {entry.kind === "refund" ? "Refund request" : "Payout request"}
          </span>
          <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
            {money(entry.amount)}
          </div>
        </div>
        <Badge
          className="max-w-full whitespace-normal border-transparent text-[11px] tone-hold"
          variant="secondary"
        >
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-current" />
          Needs you
        </Badge>
      </div>
      <div className="flex flex-col gap-1 [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:font-medium">
        <span>{entry.kind === "refund" ? "Refund to" : "Pay to"}</span>
        <strong>{personName(entry.counterparty)}</strong>
        {entry.counterparty &&
          personName(entry.counterparty) !== entry.counterparty && (
            <small className="text-xs leading-relaxed text-muted-foreground">
              {entry.counterparty}
            </small>
          )}
      </div>
      {entry.justification && (
        <blockquote className="my-3 border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
          “{entry.justification}”
        </blockquote>
      )}
      {compact ? (
        <details className="rounded-lg border p-3 [&>summary]:text-xs [&>summary]:text-muted-foreground [&>div]:mt-3">
          <summary>Review recommendation &amp; checks</summary>
          <ReviewNote review={entry.review} policyId={entry.policy_id} />
          <Checks checks={entry.checks} review={entry.review} />
        </details>
      ) : (
        <>
          <ReviewNote review={entry.review} policyId={entry.policy_id} />
          <Checks checks={entry.checks} review={entry.review} />
        </>
      )}
      {result ? (
        <div className="space-y-3 rounded-lg border p-3">
          <StatusPill status={result.status} />
          {result.error && (
            <p className="mt-3 text-sm text-block break-words">
              {result.error}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 [&>button]:h-auto [&>button]:min-h-10 [&>button]:whitespace-normal">
            <Button
              data-film="approve"
              disabled={!!busy}
              onClick={() => void decide("approve")}
              variant="default"
              type="button"
            >
              <Check size={16} />
              {busy === "approve"
                ? "Approving…"
                : `Approve ${money(entry.amount)}`}
            </Button>
            <Button
              className="text-muted-foreground"
              data-film="decline"
              disabled={!!busy}
              onClick={() => void decide("decline")}
              variant="outline"
              type="button"
            >
              <X size={15} />
              {busy === "decline" ? "Declining…" : "Decline"}
            </Button>
          </div>
          <Button
            className="h-auto justify-start px-0 py-1 text-xs"
            data-film="approve-other"
            disabled={!!busy}
            aria-expanded={other}
            onClick={() => {
              setOther(!other);
              setError("");
            }}
            variant="link"
            type="button"
          >
            {compact ? "Different amount" : "Approve a different amount"}
          </Button>
          {other && (
            <form
              className="space-y-3 rounded-lg border bg-muted/40 p-3 [&_label]:text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) void decide("approve", custom);
              }}
            >
              <Label htmlFor={`amount-${entry.id}`}>
                Amount in USD · up to {money(entry.amount)}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`amount-${entry.id}`}
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max={entry.amount}
                  step="0.01"
                  autoFocus
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
                <Button
                  disabled={!valid || !!busy}
                  variant="default"
                  type="submit"
                >
                  Confirm {valid ? money(custom) : "amount"}
                </Button>
              </div>
              {amount && !valid && (
                <small className="mt-3 text-sm text-block break-words">
                  Enter a positive amount up to {money(entry.amount)}, with at
                  most two decimals.
                </small>
              )}
            </form>
          )}
        </>
      )}
      {error && (
        <p className="mt-3 text-sm text-block break-words" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}
export function Approvals(props: PageProps) {
  const waiting = props.state.ledger.filter(
    (e) => e.status === "awaiting_approval",
  );
  const recent = props.state.ledger
    .filter((e) => e.status === "approved" || e.status === "declined")
    .sort(
      (a, b) =>
        Date.parse(b.decided_at ?? b.created_at) -
        Date.parse(a.decided_at ?? a.created_at),
    )
    .slice(0, 5);
  return (
    <div className="flex flex-col gap-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
        <h2>
          Waiting for your approval{" "}
          <Badge className="tabular-nums" variant="secondary">
            {waiting.length}
          </Badge>
        </h2>
        <span className="text-xs leading-relaxed text-muted-foreground">
          Your decision. Your money.
        </span>
      </div>
      {waiting.length ? (
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
          {waiting.map((entry) => (
            <ApprovalCard key={entry.id} entry={entry} {...props} />
          ))}
        </div>
      ) : (
        <Card className="min-w-0 gap-0 py-0 shadow-xs">
          <EmptyState title="All caught up">
            <p>There are no requests waiting for your approval.</p>
            <a
              href="/app#inbox"
              className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            >
              Go to your inbox <ArrowRight size={14} />
            </a>
          </EmptyState>
        </Card>
      )}
      <Card className="min-w-0 gap-0 py-0 shadow-xs">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>Decided recently</h2>
          <a
            className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            href="/app#ledger"
          >
            View ledger <ArrowRight size={14} />
          </a>
        </CardHeader>
        {recent.length ? (
          recent.map((e) => (
            <a
              className="flex flex-wrap items-center gap-3 border-b px-5 py-4 last:border-0 hover:bg-muted/50 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-1 [&>div]:flex-col [&_strong]:tabular-nums [&_span]:break-words [&>time]:ml-auto"
              key={e.id}
              href={`/app#ledger/${e.id}`}
            >
              <div>
                <strong>{money(amountOf(e))}</strong>
                <span>{e.counterparty}</span>
              </div>
              <StatusPill status={e.status} />
              <time>{relativeTime(e.decided_at)}</time>
            </a>
          ))
        ) : (
          <p className="space-y-4 p-5 text-xs leading-relaxed text-muted-foreground">
            Your approvals and declines will appear here.
          </p>
        )}
      </Card>
    </div>
  );
}
