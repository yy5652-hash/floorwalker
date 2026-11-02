import { Money } from "./UI";
import { account, isFilm } from "../auth";
import { useLearnedRules } from "../hooks/use-learned-rules";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ApprovalEvidence } from "./ApprovalEvidence";
import type { LearnedRules, Simulation } from "../api";
type LearnedChange = LearnedRules["changes"][number];
export type ApprovalCommand = { id: number; action: "approve" | "decline"; serial: number };
function typingOrDialog(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="combobox"]') || !!document.querySelector('[role="dialog"], [role="alertdialog"]');
}
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
import { StatusPill } from "./UI";
// qrcode 1.5.4 browser API: https://github.com/soldair/node-qrcode/tree/v1.5.4#todataurltext-options-cberror-url
export function PhoneApproval({ workspaceId }: { workspaceId?: string }) {
  const url = `${location.origin}/approve${workspaceId ? `?ws=${encodeURIComponent(workspaceId)}` : ""}`;
  const [qr, setQr] = useState("");
  const [open, setOpen] = useState(false);
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
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}><Smartphone size={16} />Approve from your phone</Button>
    <Modal title="Approve from your phone" description="Scan the code or open this link on your phone. Sign in to the same workspace." open={open} onClose={() => setOpen(false)}>
    <a
      className="flex items-center gap-3 rounded-xl border bg-card p-2 pr-4 shadow-xs [&_strong]:flex [&_strong]:items-center [&_strong]:gap-1 [&_strong]:text-xs [&_span]:my-1 [&_span]:block [&_span]:text-xs [&_span]:text-muted-foreground [&_small]:block [&_small]:max-w-48 [&_small]:break-all [&_small]:text-xs [&_small]:text-muted-foreground [&_img]:rounded-lg min-w-0"
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
    </Modal>
  </>;
}
export function ApprovalCard({
  entry,
  state,
  refresh,
  notify,
  compact = false,
  suggestion,
  command,
  onDecided,
  onBusyChange,
  onCommandHandled,
}: PageProps & {
  entry: LedgerEntry;
  compact?: boolean;
  suggestion?: LearnedChange;
  command?: ApprovalCommand | null;
  onDecided?: (entry: LedgerEntry, message?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onCommandHandled?: (serial: number) => void;
}) {
  const [other, setOther] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState("");
  const [freezeRefusal, setFreezeRefusal] = useState(false);
  const [result, setResult] = useState<LedgerEntry | null>(
    entry.status === "awaiting_approval" ? null : entry,
  );
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [allowPayee, setAllowPayee] = useState(false);
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const [learning, setLearning] = useState(false);
  const [stepUp, setStepUp] = useState<{ amount?: number; change?: LearnedChange } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (isFilm()) return;
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
  const agent = state.agents.find((a) => a.id === entry.agent_id);
  const frozen = entry.status === "awaiting_approval" && (agent?.status === "frozen" || freezeRefusal);
  useEffect(() => { setFreezeRefusal(false); }, [agent?.status, state]);
  const conclusion = frozen
    ? "This agent is frozen; unfreeze it before approving this request."
    : expired ? "This request has expired and can no longer be approved."
    : entry.checks.length || entry.review ? why(entry) : "This request is waiting for your decision; no checks were recorded.";
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
    change?: LearnedChange,
  ) {
    if (
      locked.current ||
      result ||
      !permitted ||
      (change && !canManage(state)) ||
      expired ||
      (action === "approve" && (invalidDays || frozen)) ||
      entry.status !== "awaiting_approval"
    )
      return;
    locked.current = true;
    setBusy(action);
    onBusyChange?.(true);
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
      let learningMessage: string | undefined;
      if (change) {
        if (updated.status === "approved" || updated.status === "executed" || updated.status === "executing") {
          try {
            await api("/api/rules/learned/apply", "POST", { id: change.id }, undefined,
              state.workspace?.id ? { "x-workspace": state.workspace.id } : undefined);
            learningMessage = "Request approved. Suggested rule change applied.";
          } catch (e) {
            learningMessage = `Request approved, but the rule change could not be confirmed: ${errorMessage(e)} Open Rules to review the current suggestions.`;
          }
        } else learningMessage = `Approval did not complete (${updated.status}). The rule change was not applied.`;
        setLearning(false);
        notify(learningMessage);
      }
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
      onDecided?.(updated, learningMessage);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_frozen") {
        setFreezeRefusal(true);
        setStepUp(null);
        setLearning(false);
        notify(change ? "Approval blocked: this agent is frozen. The rule change was not applied." : "Approval blocked: this agent is frozen.");
        await refresh();
        return;
      }
      if (
        e instanceof ApiError &&
        e.code === "step_up" &&
        action === "approve" &&
        !retried &&
        !isFilm()
      ) {
        setLearning(false);
        setStepUp({ amount: customAmount, change });
        return;
      }
      const message = change ? `Approval was not confirmed; the rule change was not requested: ${errorMessage(e)}` : errorMessage(e);
      setError(message);
      notify(message);
      await refresh();
    } finally {
      setBusy(null);
      onBusyChange?.(false);
      locked.current = false;
    }
  }
  const lastCommand = useRef(0);
  useEffect(() => {
    if (!command || command.id !== entry.id || command.serial === lastCommand.current) return;
    lastCommand.current = command.serial;
    onCommandHandled?.(command.serial);
    if (busy || declining || learning || stepUp || other) return;
    if (command.action === "approve") void decide("approve");
    else if (permitted && !expired && !result) setDeclining(true);
  }, [command]);
  return (
    <Card
      className={`approval-card ${compact ? "compact" : ""}`}
      id={String(entry.id)}
      tabIndex={-1}
      style={{ scrollMarginTop: 90 }}
      data-film="approval"
      aria-label={`Request ${entry.id}: ${money(entry.amount)} to ${entry.counterparty ?? "the buyer"}`}
    >
      <div className="approval-body">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground [&_time]:ml-auto">
        <span className="flex items-center gap-2 font-medium">
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-current" />
          {agentName(state, entry.agent_id)}
        </span>
        <time dateTime={entry.created_at}>
          {relativeTime(entry.created_at)}
        </time>
        <span className="font-mono text-xs text-muted-foreground">
          #{entry.id}
        </span>
      </div>
      <div className="approval-heading">
        <div><span className="text-xs text-muted-foreground">{entry.kind === "refund" ? "Refund request" : "Payout request"}</span><div className="approval-amount"><Money value={money(entry.amount)} /></div></div>
        <div className="approval-payee"><strong>{personName(entry.counterparty)}</strong><span className="check-status status-hold">{entry.status === "awaiting_approval" ? frozen ? "Blocked by freeze" : "Needs you" : "Decision recorded"}</span></div>
      </div>
      <p className="approval-reason">{conclusion.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || conclusion}</p>
      <ApprovalEvidence entry={entry} />
      <details className="approval-checks">
        <summary>Review checks &amp; rule</summary>
        <div>
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
          {entry.counterparty && <p className="text-xs break-all">Recipient: {entry.counterparty}</p>}
          {entry.justification && <blockquote className="mb-4">“{entry.justification}”</blockquote>}
          <p className="text-xs">Recorded rule outcome: {entry.checks.some(c => !["ai_review", "injection"].includes(c.id) && c.outcome === "block") ? "Blocked" : entry.checks.some(c => !["ai_review", "injection"].includes(c.id) && c.outcome === "hold") ? "Needs you" : entry.checks.some(c => !["ai_review", "injection"].includes(c.id)) ? "Passed" : "Not recorded"}{entry.policy_id != null ? ` · policy v${entry.policy_id}` : ""}</p>
          <ReviewNote review={entry.review} policyId={entry.policy_id} />
          <Checks checks={entry.checks} review={entry.review} />
        </div>
      </details>
      {frozen && (
        <p className="rounded-lg border p-3 text-sm tone-hold" role="status">
          This agent is frozen; unfreeze it first. This request is still waiting for approval.
        </p>
      )}
          {!isFilm() && permitted && (
            <details className="approval-options"><summary>Approval note &amp; payee options</summary>
            <div className="space-y-3 pt-3">
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
            </div></details>
          )}
      </div>
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
        <div className="approval-actionbar">
          {!permitted && (
            <p className="text-xs text-muted-foreground">
              An owner, admin or approver can decide this request.
            </p>
          )}
          <div className="approval-actions">
            <Button
              data-film="approve"
              disabled={
                !!busy || !permitted || expired || frozen || invalidDays || !!stepUp
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
              !!busy || !permitted || expired || frozen || invalidDays || !!stepUp
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
          {suggestion && canManage(state) && <Button variant="link" className="learn-approve" disabled={!!busy || expired || frozen || !!stepUp || invalidDays} onClick={() => setLearning(true)}>Approve and stop asking about these</Button>}
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
                    frozen ||
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
        </div>
      )}
      <Modal title="Approve and update your rules?" description="Approve this request first, then apply this tested suggestion. These are two separate actions." open={learning} onClose={() => !busy && setLearning(false)}>
        {suggestion && <div className="space-y-4 text-sm">
          <h3>{suggestion.title}</h3><p>{suggestion.evidence}</p>
          {suggestion.boundary && <p>{suggestion.boundary}</p>}
          <dl className="learning-backtest">
            <div><dt>Taps per 100 moves</dt><dd>{suggestion.impact.tapsPer100.before} → {suggestion.impact.tapsPer100.after}</dd></div>
            <div><dt>Taps saved in replay</dt><dd>{suggestion.impact.tapsSaved}</dd></div>
            <div><dt>Declined requests that would pass</dt><dd>{suggestion.impact.declinedLetThrough}</dd></div>
            <div><dt>Benchmark attacks stopped</dt><dd>{suggestion.impact.bench ? `${suggestion.impact.bench.stopped} / ${suggestion.impact.bench.attacks}` : "Not available"}</dd></div>
          </dl>
          <p>Future requests still go through PayPal checks, limits and AI review. This replay uses recorded evidence, not a guarantee.</p>
          {error && <p role="alert">{error}</p>}
          <Button disabled={!!busy || !!stepUp || frozen || expired || invalidDays} onClick={() => void decide("approve", undefined, false, suggestion)}>{busy ? "Approving…" : "Confirm approval and rule change"}</Button>
        </div>}
      </Modal>
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
                  const { amount, change } = stepUp ?? {};
                  setStepUp(null);
                  await decide("approve", amount, true, change);
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
export function Approvals(props: PageProps & {
  command?: ApprovalCommand | null;
  onSelection?: (id: number | null) => void;
  onCommandHandled?: () => void;
  initialId?: number;
}) {
  const waiting = props.state.ledger.filter(e => e.status === "awaiting_approval");
  const [selectedId, setSelectedId] = useState<number | null>(props.initialId ?? null);
  const [decided, setDecided] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [message, setMessage] = useState("");
  const [keyboardCommand, setKeyboardCommand] = useState<ApprovalCommand | null>(null);
  const serial = useRef(0);
  const handledCommand = useRef(0);
  useEffect(() => () => { props.onCommandHandled?.(); props.onSelection?.(null); }, []);
  const pendingCommand = [props.command, keyboardCommand].filter((c): c is ApprovalCommand => !!c && c.serial > handledCommand.current).sort((a, b) => b.serial - a.serial)[0] ?? null;
  const list = waiting.filter(e => !decided.includes(e.id));
  const selected = list.find(e => e.id === selectedId) ?? list[0];
  const reduced = useReducedMotion();
  const still = isFilm() || reduced;
  const learned = useLearnedRules(props.state);
  // Replay the actual draft against this request, rather than guessing coverage from the title.
  const coverage = useQuery({
    queryKey: ["approval-coverage", props.state.workspace?.id, props.state.policy.id, selected?.id, selected?.status, selected?.checks, learned.data?.changes],
    enabled: !!selected && canManage(props.state) && !!learned.data?.changes.length && !isFilm(),
    retry: false,
    queryFn: async ({ signal }) => {
      for (const change of learned.data?.changes ?? []) {
        const simulation = await api<Simulation>("/api/policy/simulate", "POST", { policy: change.draft }, signal);
        // Some older replay implementations do not preserve agent cap/budget checks.
        const agentHold = selected?.checks.some(c => c.id.startsWith("agent") && c.outcome !== "pass");
        if (!agentHold && simulation.rows.some(r => r.id === selected?.id && r.before === "hold" && r.after === "allow")) return change;
      }
      return null;
    },
  });
  useEffect(() => { props.onSelection?.(selected?.id ?? null); }, [selected?.id, props.onSelection]);
  useEffect(() => {
    if (props.initialId) setSelectedId(props.initialId);
  }, [props.initialId]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || busy || typingOrDialog(event.target)) return;
      const key = event.key.toLowerCase();
      if (!["j", "k", "a", "d", "?"].includes(key)) return;
      event.preventDefault();
      if (key === "?") { setShortcuts(true); return; }
      if (!selected) return;
      if (key === "j" || key === "k") {
        const index = list.findIndex(e => e.id === selected.id);
        setSelectedId(list[Math.max(0, Math.min(list.length - 1, index + (key === "j" ? 1 : -1)))].id);
      } else setKeyboardCommand({ id: selected.id, action: key === "a" ? "approve" : "decline", serial: Date.now() + ++serial.current });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [selected, list, busy]);
  const recent = props.state.ledger.filter(e => e.status === "approved" || e.status === "declined")
    .sort((a, b) => Date.parse(b.decided_at ?? b.created_at) - Date.parse(a.decided_at ?? a.created_at)).slice(0, 5);
  return <div className="approvals-page">
    {message && <p className="decision-feedback" role="status">{message}</p>}
    <div className="approval-queue-heading"><h2>Waiting for your approval <span>{list.length}</span></h2><Button variant="ghost" size="sm" onClick={() => setShortcuts(true)}>Keyboard shortcuts <kbd>?</kbd></Button></div>
    {list.length ? <div className="approval-workspace">
      <nav className="approval-queue" aria-label="Approval queue">
        {list.map((entry, index) => <button key={entry.id} type="button" disabled={busy} aria-current={selected?.id === entry.id ? "true" : undefined} onClick={() => setSelectedId(entry.id)}>
          <span>{agentName(props.state, entry.agent_id)} <time dateTime={entry.created_at}>{relativeTime(entry.created_at)}</time></span>
          <strong><Money value={money(entry.amount)} /></strong><span>{personName(entry.counterparty)}</span><small>Request {index + 1} of {list.length} · #{entry.id}</small>
        </button>)}
      </nav>
      <div className="approval-detail">
        <div className="approval-mobile-nav"><Button variant="outline" size="sm" disabled={busy || selected?.id === list[0]?.id} onClick={() => setSelectedId(list[Math.max(0, list.findIndex(e => e.id === selected?.id) - 1)].id)}>Previous request</Button><span>{list.findIndex(e => e.id === selected?.id) + 1} / {list.length}</span><Button variant="outline" size="sm" disabled={busy || selected?.id === list.at(-1)?.id} onClick={() => setSelectedId(list[Math.min(list.length - 1, list.findIndex(e => e.id === selected?.id) + 1)].id)}>Next request</Button></div>
        <AnimatePresence initial={false} mode="wait">
          {selected && <motion.div key={selected.id} initial={false} animate={{ opacity: 1, x: 0 }} exit={still ? {} : { opacity: 0, x: -20 }} transition={{ duration: still ? 0 : .18 }}>
            <ApprovalCard {...props} entry={selected} suggestion={coverage.data ?? undefined} command={pendingCommand} onCommandHandled={serial => { handledCommand.current = serial; setKeyboardCommand(null); props.onCommandHandled?.(); }} onBusyChange={setBusy} onDecided={(entry, note) => {
              const index = list.findIndex(e => e.id === entry.id);
              setSelectedId(list[index + 1]?.id ?? list[index - 1]?.id ?? null);
              setDecided(ids => [...ids, entry.id]);
              setMessage(note ?? `Request #${entry.id}: ${entry.status === "approved" ? "Approved" : entry.status === "declined" ? "Declined" : entry.status}. ${entry.error ?? ""}`);
            }} />
          </motion.div>}
        </AnimatePresence>
      </div>
    </div> : <section className="queue-empty"><h2>All caught up</h2><p>There are no requests waiting for your approval.</p>
      {learned.data?.summary && <p><strong className="chart-number">{learned.data.summary.per100}</strong> taps per 100 money moves over the last {learned.data.summary.days} days ({learned.data.summary.taps} taps across {learned.data.summary.moves} moves).</p>}
      {learned.isPending && <p role="status">Loading your taps summary…</p>}
      {learned.isError && <p>Couldn't load the taps summary.</p>}
      <a href="/app#inbox">Go to your inbox <ArrowRight size={14} /></a>
    </section>}
    {!!learned.data?.changes.length && <Button asChild variant="outline" className="self-start"><a href="/app#rules">See suggestions</a></Button>}
    {!isFilm() && <TemporaryAllowances {...props} />}
    <Modal title="Approval shortcuts" description="Available outside text fields and dialogs." open={shortcuts} onClose={() => setShortcuts(false)}><dl className="learning-backtest"><div><dt>Next / previous request</dt><dd>J / K</dd></div><div><dt>Approve selected request</dt><dd>A</dd></div><div><dt>Open decline dialog</dt><dd>D</dd></div><div><dt>Show shortcuts</dt><dd>?</dd></div><div><dt>Command palette</dt><dd>⌘K / Ctrl K</dd></div></dl></Modal>
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
              className="flex flex-wrap items-center gap-3 border-b px-5 py-4 last:border-0 hover:bg-muted/50 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-1 [&>div]:flex-col [&_span]:break-words [&>time]:ml-auto"
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
    </div>;
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
                done="Allowance revoked"
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
