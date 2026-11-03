import { api } from '../api';
import { Modal, Field, useResource } from './Management';
import { type InboxData } from '../pages/InboxSettings';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MessageBody } from "./MessageEvidence";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bot,
  CircleAlert,
  FileText,
  Loader2,
  Mail,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  money,
  relativeTime,
  streamEvents,
  type AgentEvent,
  type PageProps,
  type State,
  type Ticket,
  type Review,
} from "../api";
import { DecisionCard, Verdict } from "./Verdict";
import { EmptyState, StatusPill } from "./UI";
function toolSentence(
  call: Extract<
    AgentEvent,
    {
      type: "tool_call";
    }
  >,
  result:
    | Extract<
        AgentEvent,
        {
          type: "tool_result";
        }
      >
    | undefined,
  ticket?: Ticket,
  currency = "USD",
) {
  const input = call.input ?? {};
  const nested = input.amount && typeof input.amount === "object" ? input.amount as { value?: unknown; currency_code?: unknown } : undefined;
  const value = nested ? nested.value : input.amount;
  const code = typeof nested?.currency_code === "string" ? nested.currency_code : typeof input.currency === "string" ? input.currency : currency;
  const amount = (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value))
    ? money(Number(value), code) : "the requested amount";
  const complete = !!result && !result.isError;
  const email = String(input.email ?? "the customer");
  const customer = ticket?.from_email === email ? ticket.from_name : email;
  switch (call.name) {
    case "find_customer_orders":
      return `${complete ? "Looked up" : "Looking up"} ${customer}'s orders in PayPal`;
    case "get_order":
      return `${complete ? "Read" : "Reading"} order ${String(input.id ?? input.order_id ?? "details")} from PayPal`;
    case "lookup_contact":
      return `${complete ? "Looked up" : "Looking up"} ${String(input.name ?? input.query ?? "the payee")} in contacts`;
    case "get_refund":
      return `${complete ? "Read" : "Reading"} refund details from PayPal`;
    case "create_refund":
      return `Asked to refund ${amount} to the buyer`;
    case "send_payout":
      return `Asked to pay ${amount} to ${String(input.recipientEmail ?? input.recipient_email ?? input.email ?? "the payee")}`;
    default:
      return `${complete ? "Completed" : "Running"} ${call.name.replaceAll("_", " ")}`;
  }
}
function Trace({
  events,
  state,
  ticket,
}: {
  events: AgentEvent[];
  state: State;
  ticket?: Ticket;
}) {
  return (
    <div className="trace space-y-5 pt-3">
      {events.map((event, index) => {
        switch (event.type) {
          case "start":
          case "done":
          case "tool_result":
            return null;
          case "note":
            return (
              <div
                className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground"
                key={index}
              >
                <Sparkles size={15} />
                <p>{event.text}</p>
              </div>
            );
          case "tool_call": {
            const result = events.find(
              (
                e,
              ): e is Extract<
                AgentEvent,
                {
                  type: "tool_result";
                }
              > => e.type === "tool_result" && e.id === event.id,
            );
            return (
              <div
                className={`flex items-start gap-3   ${result?.isError ? "text-block" : ""}`}
                key={index}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted">
                  {event.guarded ? <Send size={16} /> : <Search size={16} />}
                </span>
                <div className="min-w-0 flex-1 space-y-2 [&>strong]:text-xs [&>strong]:font-medium">
                  <strong>
                    {toolSentence(event, result, ticket, state.policy.policy.currency)}
                    {result && !event.guarded && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {result.summary}
                      </span>
                    )}
                  </strong>
                  {result?.isError && (
                    <p className="mt-3 text-sm text-block break-words">
                      {result.summary}
                    </p>
                  )}
                  {typeof event.input?.reason === "string" && (
                    <blockquote className="my-3 border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
                      “{event.input.reason}”
                    </blockquote>
                  )}
                  <details className="rounded-lg border p-3 text-xs text-muted-foreground [&>summary]:text-xs">
                    <summary>Details</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          input: event.input,
                          result: result
                            ? {
                                summary: result.summary,
                                isError: result.isError,
                              }
                            : "Waiting for result",
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              </div>
            );
          }
          case "guard": {
            const entry = state.ledger.find((e) => e.id === event.ledgerId);
            return entry ? (
              <DecisionCard key={index} entry={entry} />
            ) : (
              <Verdict key={index} {...event} />
            );
          }
          case "reply":
            return (
              <div
                className="reply rounded-xl border bg-muted/50 p-4 text-sm leading-relaxed whitespace-pre-wrap"
                key={index}
              >
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Bot size={16} />
                  Agent's reply
                </div>
                {event.text}
              </div>
            );
          case "error":
            return (
              <div
                key={index}
                className="mt-3 text-sm text-block break-words flex items-start gap-2 rounded-lg bg-destructive/10 p-4"
                role="alert"
              >
                <CircleAlert size={16} />
                {event.message}
              </div>
            );
        }
      })}
    </div>
  );
}
export function Inbox({
  state,
  refresh,
  notify,
  attackRequest = 0,
  onRunningChange,
  disabled = false,
}: PageProps & {
  attackRequest?: number;
  onRunningChange?: (running: boolean) => void;
  disabled?: boolean;
}) {
  const inbox = useResource<InboxData>('/api/inbox/settings');
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const controls = <div className="space-y-4 mb-4">
    <div className="flex flex-wrap gap-3"><Button onClick={() => setAddOpen(true)}>Add a message</Button><Button asChild variant="outline"><a href="/app#settings/inbox">Email settings</a></Button></div>
    {inbox.data?.confirmations.map(c => <Card className="p-4" key={c.id}><h2>Confirm your forwarding</h2><p className="text-sm whitespace-pre-wrap">{c.body}</p>{c.confirmation_code && <p>Code: <code>{c.confirmation_code}</code></p>}{c.confirmation_link && <a className="underline" href={c.confirmation_link} target="_blank" rel="noreferrer">Confirm forwarding</a>}</Card>)}
    {!!inbox.data?.skipped.length && <details><summary>Skipped ({inbox.data.skipped.length})</summary><ul>{inbox.data.skipped.map((v, i) => <li key={i}>{v.reason} · {new Date(v.at).toLocaleString("en-US")}</li>)}</ul></details>}
    <Modal title="Add a message" description="Paste a customer email for the Support agent." open={addOpen} onClose={() => { if (!saving) setAddOpen(false); }}>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); setSaving(true); void api<{ticket: Ticket}>('/api/inbox/messages', 'POST', { from_name: f.get('name'), from_email: f.get('email'), subject: f.get('subject'), body: f.get('body') }).then(async r => { setSelected(r.ticket.id); setAddOpen(false); await refresh(); }).catch(e => notify(errorMessage(e))).finally(() => setSaving(false)); }}>
        <Field label="Customer name"><Input name="name" maxLength={200} /></Field><Field label="Customer email"><Input name="email" type="email" required /></Field><Field label="Subject"><Input name="subject" maxLength={1000} required /></Field><Field label="Message"><Textarea name="body" maxLength={200000} required /></Field><Button disabled={saving}>Add message</Button>
      </form>
    </Modal>
  </div>;
  const [selected, setSelected] = useState(state.tickets[0]?.id ?? "");
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const lock = useRef(false);
  const handledAttack = useRef(attackRequest);
  useEffect(() => {
    if (attackRequest !== handledAttack.current) {
      handledAttack.current = attackRequest;
      setSelected("ATTACK");
      void run("/api/attack", "ATTACK");
    }
  }, [attackRequest]);
  const ticket =
    state.tickets.find((t) => t.id === selected && (t as Ticket & { inbound_kind?: string }).inbound_kind !== "confirmation") ?? state.tickets.find(t => (t as Ticket & { inbound_kind?: string }).inbound_kind !== "confirmation");
  const reviews: Review[] = ticket ? [
    ...state.ledger.filter(e => e.ticket_id === ticket.id).flatMap(e => e.review ? [e.review] : []),
    ...(events[ticket.id] ?? []).flatMap(e => e.type === "guard" && e.review ? [e.review] : []),
  ] : [];
  const ready = state.configured.paypal && state.configured.ai && !disabled;
  const agent = state.agents.find(
    (a) => a.id === (ticket?.channel === "task" ? "ops" : "support"),
  );
  const name =
    agent?.name ??
    (ticket?.channel === "task" ? "Back-office agent" : "Support agent");
  async function run(path: string, key: string) {
    if (lock.current || !ready) return;
    lock.current = true;
    onRunningChange?.(true);
    setRunning(key);
    setEvents((m) => ({ ...m, [key]: [] }));
    let ended = false;
    try {
      await streamEvents(path, (event) => {
        setEvents((m) => ({ ...m, [key]: [...(m[key] ?? []), event] }));
        if (event.type === "guard") void refresh();
        if (event.type === "done" || event.type === "error") ended = true;
        if (event.type === "error") notify(event.message);
      });
      if (!ended)
        throw new Error(
          "The agent connection ended early. Check the recorded decisions before running again.",
        );
    } catch (e) {
      const message = errorMessage(e);
      setEvents((m) => ({
        ...m,
        [key]: [...(m[key] ?? []), { type: "error", message }],
      }));
      notify(message);
    } finally {
      lock.current = false;
      onRunningChange?.(false);
      setRunning(null);
      await refresh();
    }
  }
  function past(t: Ticket) {
    return (
      <div className="trace space-y-5 pt-3">
        {state.ledger
          .filter((e) => e.ticket_id === t.id)
          .slice()
          .reverse()
          .map((e) => (
            <DecisionCard key={e.id} entry={e} />
          ))}
        {t.reply && (
          <div className="reply rounded-xl border bg-muted/50 p-4 text-sm leading-relaxed whitespace-pre-wrap">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Bot size={16} />
              Agent's reply
            </div>
            {t.reply}
          </div>
        )}
      </div>
    );
  }
  const messages = state.tickets.filter(t => (t as Ticket & { inbound_kind?: string }).inbound_kind !== "confirmation");
  if (!messages.length)
    return (
      <div>{controls}<Card className="min-w-0 gap-0 py-0 shadow-xs">
        {state.workspace?.demo ? (
          <EmptyState title="Your inbox is ready for its first request">
            <p>Load the demo shop to give your agents something to work on.</p>
            <Button asChild className="mt-4">
              <a href="/app#overview">Load the demo shop</a>
            </Button>
          </EmptyState>
        ) : (
          <EmptyState title="No requests yet">
            <p>
              Forward your support mailbox in Email settings, paste a message here, or connect your help desk with POST /v1/messages.
            </p>
            <Button asChild className="mt-4">
              <a href="/app#developers/quickstart">Open the quickstart</a>
            </Button>
          </EmptyState>
        )}
      </Card></div>
    );
  return (
    <div>{controls}<div className="inbox-layout">
      <Card className="min-w-0 gap-0 overflow-hidden py-0 shadow-xs">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>All messages</h2>
          <Badge variant="secondary">
            {state.tickets.length}
          </Badge>
        </CardHeader>
        <div className="max-h-[340px] overflow-y-auto xl:max-h-[520px]">
          {messages.map((t) => {
            const last = state.ledger.find((e) => e.ticket_id === t.id);
            return (
              <Button
                className={`item h-auto w-full flex-col items-stretch justify-start gap-2 rounded-none border-b px-4 py-4 text-left whitespace-normal last:border-b-0 hover:bg-muted   ${selected !== "ATTACK" && t.id === ticket?.id ? "bg-accent ring-1 ring-inset ring-border" : ""}`}
                key={t.id}
                aria-pressed={selected !== "ATTACK" && t.id === ticket?.id}
                onClick={() => setSelected(t.id)}
                variant="ghost"
                type="button"
              >
                <span className="flex items-center gap-2 text-xs [&>time]:ml-auto [&>time]:text-xs">
                  {t.channel === "task" ? (
                    <FileText size={15} />
                  ) : (
                    <Mail size={15} />
                  )}
                  {t.from_name}
                  <time>{relativeTime(t.received_at)}</time>
                </span>
                <span className="block text-sm font-medium">{t.subject}</span>
                <span className="text-xs text-muted-foreground">
                  {t.channel === "email"
                    ? "Support agent"
                    : "Back-office agent"}
                </span>
                <span className="flex">
                  {last ? (
                    <StatusPill status={last.status} />
                  ) : (
                    <Badge
                      className="max-w-full whitespace-normal border-transparent text-xs bg-muted text-muted-foreground"
                      variant="secondary"
                    >
                      {t.status === "handled" ? "Handled" : "New request"}
                    </Badge>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
        <div className="space-y-3 border-t bg-muted/30 p-4 [&>button]:h-auto [&>button]:min-h-10 [&>button]:w-full [&>button]:whitespace-normal [&>p]:text-xs [&>p]:leading-relaxed [&>p]:text-muted-foreground">
          <Button
            className="text-block hover:bg-destructive/10"
            data-film="hijack"
            disabled={!!running || !ready}
            title={ready ? undefined : "Finish setup to run an agent."}
            onClick={() => {
              setSelected("ATTACK");
              void run("/api/attack", "ATTACK");
            }}
            variant="outline"
            type="button"
          >
            <ShieldAlert size={16} />
            Simulate a hijacked agent
          </Button>
          <p>
            See how your rules respond when an attacker tries to take over an
            agent.
          </p>
        </div>
        {state.workspace?.demo && (
          <div className="space-y-3 border-t bg-muted/30 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              What if an agent skips Floorwalker? Refund straight through PayPal and watch Floorwalker catch it.
            </p>
            <Button asChild variant="outline" className="w-full">
              <a href="/app#watch">Open Watch</a>
            </Button>
          </div>
        )}
      </Card>
      <Card className={`min-w-0 gap-0 py-0 shadow-xs inbox-detail ${selected === "ATTACK" ? "inbox-simulation" : ""}`}>
        {selected === "ATTACK" ? (
          <>
            <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
              <h2>Hijacked Support agent · simulation</h2>
              <Badge
                className="max-w-full whitespace-normal border-transparent text-xs tone-block"
                variant="secondary"
              >
                Simulation
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <Trace state={state} events={events.ATTACK ?? []} />
              {running === "ATTACK" && (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="animate-spin" size={16} />
                  Simulation running…
                </div>
              )}
            </CardContent>
          </>
        ) : (
          ticket && (
            <>
              <section className="inbox-message" aria-label="The message">
              <div className="space-y-3 border-b p-5 [&>h2]:text-xl [&>h2]:tracking-tight [&>p]:text-sm [&_p>span]:block [&_p>span]:break-all [&_p>span]:text-xs [&_p>span]:text-muted-foreground">
                <div className="block text-xs text-muted-foreground">
                  {ticket.channel === "email"
                    ? "Customer email"
                    : "Owner's to-do"}
                </div>
                <h2>{ticket.subject}</h2>
                <p>
                  {ticket.from_name} <span>&lt;{ticket.from_email}&gt;</span>
                </p>
              </div>
              <CardContent className="space-y-4 p-5">
                <MessageBody body={ticket.body} reviews={reviews} />
                {(ticket as Ticket & { attachment_note?: string }).attachment_note && <p className="text-sm">{(ticket as Ticket & { attachment_note?: string }).attachment_note}</p>}
                <div className="flex flex-wrap items-center gap-3 border-y py-4 [&>button]:h-auto [&>button]:min-h-10 [&>button]:whitespace-normal">
                  <Button
                    data-film="run"
                    disabled={!!running || !ready || agent?.status === "frozen"}
                    title={disabled ? "Only owners and admins can run agents." : !ready ? "Connect PayPal and an AI provider first." : agent?.status === "frozen" ? "This agent is frozen." : undefined}
                    onClick={() =>
                      void run(
                        `/api/tickets/${encodeURIComponent(ticket.id)}/run`,
                        ticket.id,
                      )
                    }
                    variant="default"
                    type="button"
                  >
                    {running === ticket.id ? (
                      <Loader2 className="animate-spin" size={16} />
                    ) : (
                      <Sparkles size={16} />
                    )}
                    {running === ticket.id
                      ? `${name} is working…`
                      : `Let the ${name} handle it`}
                  </Button>
                  {agent?.status === "frozen" && (
                    <a
                      className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
                      href="/app#agents"
                    >
                      Unfreeze this agent to continue
                    </a>
                  )}
                  {!ready && (
                    <a
                      className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
                      href="/app#setup"
                    >
                      Finish setup to run your agent
                    </a>
                  )}
                </div>

              </CardContent>
              </section>
              <section className="inbox-agent-result" aria-label="What the agent did">
                <h2>What the agent did</h2>
                {ticket.channel === 'email' && ticket.reply && <div className="flex flex-wrap gap-3 my-3">
                  <Button disabled={sending} onClick={() => { const sent = (ticket as Ticket & { reply_sent_at?: string }).reply_sent_at; if (sent && !window.confirm('This reply was already sent. Send it again?')) return; setSending(true); void api(`/api/inbox/${ticket.id}/reply`, 'POST', { confirm: !!sent }).then(async () => { await refresh(); notify('Reply sent'); }).catch(e => notify(errorMessage(e))).finally(() => setSending(false)); }}>Send reply</Button>
                  <Button variant="outline" onClick={() => void navigator.clipboard.writeText(ticket.reply!).then(() => notify('Copied')).catch(e => notify(errorMessage(e)))}>Copy</Button>
                  {(ticket as Ticket & { reply_sent_at?: string }).reply_sent_at && <p>Reply sent · {new Date((ticket as Ticket & { reply_sent_at: string }).reply_sent_at).toLocaleString("en-US")}</p>}
                </div>}
                {events[ticket.id]?.length ? (
                  <Trace
                    state={state}
                    ticket={ticket}
                    events={events[ticket.id]}
                  />
                ) : (
                  past(ticket)
                )}
                {!events[ticket.id]?.length && !ticket.reply && !state.ledger.some(e => e.ticket_id === ticket.id) && <p className="text-sm text-muted-foreground">No action yet. Let the agent handle this request to see its checks and reply here.</p>}
              </section>
            </>
          )
        )}
      </Card>
    </div></div>
  );
}
