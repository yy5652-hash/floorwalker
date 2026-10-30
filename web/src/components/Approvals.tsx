import { Money } from "./UI";
import { account, isFilm } from "../auth";
import { LearnedRulesNudge } from "./LearnedRules";
import { ApiError, api, canApprove, canManage } from "../api";
import { Modal, Confirm, Resource, useResource } from "./Management";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  relativeTime,
  why,
  type LedgerEntry,
  type PageProps,
} from "../api";
import { Checks, ReviewNote } from "./Verdict";
import { EmptyState, StatusPill } from "./UI";
// qrcode 1.5.4 browser API: https://github.com/soldair/node-qrcode/tree/v1.5.4#todataurltext-options-cberror-url
export function PhoneApproval({ workspaceId }: { workspaceId?: string }) {
  const url = `${location.origin}/approve${workspaceId ? `?ws=${encodeURIComponent(workspaceId)}` : ""}`;
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
      href={url}
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
  const [result, setResult] = useState<LedgerEntry | null>(
    entry.status === "awaiting_approval" ? null : entry,
  );
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [allowPayee, setAllowPayee] = useState(false);
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const [stepUp, setStepUp] = useState<{ amount?: number } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      location.pathname === "/approve" &&
      location.hash.slice(1) === String(entry.id)
    ) {
      document
        .getElementById(String(entry.id))
        ?.scrollIntoView({ block: "start" });
      document.getElementById(String(entry.id))?.focus({ preventScroll: true });
    }
  }, [entry.id]);
  const remaining = entry.expires_at
    ? Math.max(0, Date.parse(entry.expires_at) - Date.now())
    : null;
  const expired = remaining === 0;
  const permitted = canApprove(state);
  const invalidDays =
    allowPayee &&
    (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 90);
  const locked = useRef(false);
  const custom = Number(amount);
  const valid =
    amount.trim() !== "" &&
    Number.isFinite(custom) &&
    custom > 0 &&
    custom <= entry.amount &&
    Math.abs(custom * 100 - Math.round(custom * 100)) < 0.000001;
  async function decide(
    action: "approve" | "decline",
    customAmount?: number,
    retried = false,
  ) {
    if (
      locked.current ||
      result ||
      !permitted ||
      expired ||
      (action === "approve" && invalidDays) ||
      entry.status !== "awaiting_approval"
    )
      return;
    locked.current = true;
    setBusy(action);
    setError("");
    try {
      const body =
        action === "decline"
          ? { reason: reason.trim() || undefined }
          : {
              ...(customAmount === undefined ? {} : { amount: customAmount }),
              ...(allowPayee && entry.kind === "payout"
                ? { allow_payee_days: Number(days) }
                : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            };
      const updated = await api<LedgerEntry>(
        `/api/ledger/${entry.id}/${action}`,
        "POST",
        body,
        undefined,
        state.workspace?.id ? { "x-workspace": state.workspace.id } : undefined,
      );
      setDeclining(false);
      setStepUp(null);
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
      if (
        e instanceof ApiError &&
        e.code === "step_up" &&
        action === "approve" &&
        !retried &&
        !isFilm()
      ) {
        setStepUp({ amount: customAmount });
        return;
      }
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
      id={String(entry.id)}
      tabIndex={-1}
      style={{ scrollMarginTop: 90 }}
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
      {!isFilm() && (
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {
              ({
                inbox: "Inbox",
                api: "API",
                mcp: "MCP",
                history: "Demo history",
              } as const)[entry.source ?? "inbox"]
            }
          </Badge>
          {remaining !== null && (
            <Badge className={expired ? "tone-block" : "tone-hold"}>
              {expired
                ? "Expired"
                : `Expires in ${Math.floor(remaining / 86400000)} d ${Math.floor(remaining / 3600000) % 24} h${remaining < 3600000 ? ` ${Math.ceil(remaining / 60000)} min` : ""}`}
            </Badge>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="block text-xs text-muted-foreground">
            {entry.kind === "refund" ? "Refund request" : "Payout request"}
          </span>
          <div className="approval-amount">
            <Money value={money(entry.amount)} />
          </div>
        </div>
        <Badge
          className="max-w-full whitespace-normal border-transparent text-[11px] tone-hold"
          variant="secondary"
        >
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-current" />
          {entry.status === "awaiting_approval"
            ? "Needs you"
            : "Decision recorded"}
        </Badge>
      </div>
      <div className="approval-payee flex flex-col gap-1 [&>span]:text-xs [&>span]:text-muted-foreground">
        <span>{entry.kind === "refund" ? "Refund to" : "Pay to"}</span>
        <strong>{personName(entry.counterparty)}</strong>
        {entry.counterparty &&
          personName(entry.counterparty) !== entry.counterparty && (
            <small className="text-xs leading-relaxed text-muted-foreground">
              {entry.counterparty}
            </small>
          )}
      </div>
      <p className="approval-reason">{why(entry)}</p>
      <ReviewNote review={entry.review} policyId={entry.policy_id} condensed />
      <details className="approval-checks">
        <summary>Review checks &amp; rule</summary>
        <div>
          {entry.justification && <blockquote className="mb-4">“{entry.justification}”</blockquote>}
          <ReviewNote review={entry.review} policyId={entry.policy_id} />
          <Checks checks={entry.checks} review={entry.review} />
        </div>
      </details>
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
          {!isFilm() && permitted && (
            <div className="space-y-3">
              {entry.kind === "payout" && (
                <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-6">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-emerald-600"
                      checked={allowPayee}
                      disabled={!!busy || !!stepUp}
                      onChange={(e) => setAllowPayee(e.target.checked)}
                    />
                    <span>
                      Also let this agent pay {personName(entry.counterparty)}{" "}
                      on its own for the next {days || "7"} days (up to this
                      amount)
                    </span>
                  </label>
                  {allowPayee && (
                    <p className="mt-2 text-muted-foreground">
                      This payee allowance applies to the workspace payout
                      rules.
                    </p>
                  )}
                  {allowPayee && (
                    <label className="mt-2 flex items-center gap-3">
                      Days
                      <Input
                        className="w-20"
                        type="number"
                        min={1}
                        max={90}
                        value={days}
                        disabled={!!busy || !!stepUp}
                        onChange={(e) => setDays(e.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              <Input
                aria-label="Approval note (optional)"
                placeholder="Approval note (optional)"
                value={note}
                maxLength={500}
                disabled={!!busy || !!stepUp}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
          {!permitted && (
            <p className="text-xs text-muted-foreground">
              An owner, admin or approver can decide this request.
            </p>
          )}
          <div className="approval-actions">
            <Button
              data-film="approve"
              disabled={
                !!busy || !permitted || expired || invalidDays || !!stepUp
              }
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
              disabled={!!busy || !permitted || expired || !!stepUp}
              onClick={() =>
                isFilm() ? void decide("decline") : setDeclining(true)
              }
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
            disabled={
              !!busy || !permitted || expired || invalidDays || !!stepUp
            }
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
                  disabled={
                    !valid ||
                    !!busy ||
                    !permitted ||
                    expired ||
                    invalidDays ||
                    !!stepUp
                  }
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
      <Modal
        title="Decline this request?"
        description={`Decline ${money(entry.amount)} to ${personName(entry.counterparty)}. No payment will be made.`}
        open={declining}
        onClose={() => !busy && setDeclining(false)}
      >
        <label className="space-y-2 text-sm">
          Reason (optional)
          <Textarea
            className="mt-2"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <Button
          variant="destructive"
          disabled={!!busy}
          onClick={() => void decide("decline")}
        >
          Decline request
        </Button>
      </Modal>
      <Sheet
        open={!!stepUp}
        onOpenChange={(v) => {
          if (!v && !authBusy) setStepUp(null);
        }}
      >
        <SheetContent side="bottom" className="mx-auto max-w-lg rounded-t-xl">
          <SheetHeader>
            <SheetTitle>Confirm with your passkey</SheetTitle>
            <SheetDescription>
              This amount needs a fresh sign-in. Confirm your identity to
              approve this request once.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4 pb-6">
            <Button
              className="w-full"
              disabled={authBusy}
              onClick={async () => {
                setAuthBusy(true);
                try {
                  await account.passkeySignIn();
                  if (state.workspace?.id)
                    await account.setActive(state.workspace.id);
                  const amount = stepUp?.amount;
                  setStepUp(null);
                  await decide("approve", amount, true);
                } catch (e) {
                  notify(errorMessage(e));
                } finally {
                  setAuthBusy(false);
                }
              }}
            >
              {authBusy ? "Waiting for your passkey…" : "Confirm with passkey"}
            </Button>
            <Button
              className="w-full"
              variant="outline"
              disabled={authBusy}
              onClick={() => setStepUp(null)}
            >
              Cancel
            </Button>
          </div>
        </SheetContent>
      </Sheet>
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
      <LearnedRulesNudge state={props.state} />
      {!isFilm() && <TemporaryAllowances {...props} />}
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
                {e.decline_reason && (
                  <span className="text-xs text-muted-foreground">
                    Declined: {e.decline_reason}
                  </span>
                )}
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

type Grant = {
  id: number;
  counterparty: string;
  max_amount: number;
  expires_at: string;
  created_by: string;
};
function TemporaryAllowances({ state }: PageProps) {
  const grants = useResource<Grant[]>("/api/grants");
  return (
    <details className="rounded-xl border bg-card p-4">
      <summary className="text-sm">
        Temporary payee allowances{" "}
        {grants.data?.length ? `· ${grants.data.length} active` : ""}
      </summary>
      <div className="mt-4">
        <Resource query={grants}>
          {grants.data?.map((grant) => (
            <div
              key={grant.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t py-3"
            >
              <div className="text-sm">
                <p className="break-all font-medium">
                  {personName(grant.counterparty)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Up to {money(grant.max_amount)} · until{" "}
                  {new Date(grant.expires_at).toLocaleDateString()} · by{" "}
                  {grant.created_by}
                </p>
              </div>
              <Confirm
                disabled={!canManage(state)}
                title="Revoke temporary allowance?"
                description="Future payments to this payee will use the normal workspace rules."
                label="Revoke allowance"
                onConfirm={async () => {
                  await api(`/api/grants/${grant.id}`, "DELETE");
                  await grants.refetch();
                }}
              >
                Revoke
              </Confirm>
            </div>
          ))}
          {!grants.data?.length && (
            <p className="text-sm text-muted-foreground">
              No active allowances. You can grant one while approving a payout.
            </p>
          )}
        </Resource>
      </div>
    </details>
  );
}
