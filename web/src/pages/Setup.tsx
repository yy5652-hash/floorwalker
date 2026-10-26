import { useQuery } from "@tanstack/react-query";
import { account, isFilm } from "../auth";
import { canManage } from "../api";
import { useResource } from "../components/Management";
import { type AgentKey } from "./Developers";
import { type NotificationSettings } from "./Settings";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { type PageProps } from "../api";
import { ConnectAgent } from "../components/UI";
function LegacySetup({
  state,
  notify,
  reset,
  resetting,
}: PageProps & {
  reset: () => void;
  resetting: boolean;
}) {
  const items = [
    {
      label: "PayPal sandbox connected",
      ready: state.configured.paypal,
      detail: state.configured.paypal
        ? "Ready for sandbox refunds and payouts."
        : "Add your PayPal sandbox credentials to the server configuration.",
    },
    {
      label: "AI model ready",
      ready: state.configured.ai,
      detail: state.configured.ai
        ? `${state.configured.provider ?? "AI"} · ${state.configured.agentModel} · reviewer ${state.configured.reviewModel}`
        : "Add an AI provider key to the server configuration.",
    },
    {
      label: "Rules in place",
      ready: !!state.policy.id,
      detail: `Policy v${state.policy.id} checks every money move.`,
      href: "/app#rules",
      action: "Review rules",
    },
    {
      label: "Agents",
      ready: state.agents.length > 0,
      detail: `${state.agents.length} agents connected to your shop.`,
      href: "/app#agents",
      action: "Manage agents",
    },
    {
      label: "Demo shop loaded",
      ready: state.tickets.length > 0,
      detail: state.tickets.length
        ? `${state.tickets.length} inbox items · ${state.orders.length} sandbox orders`
        : "Create sandbox orders and a fresh inbox for Juniper & Oak Ceramics.",
      demo: true,
    },
  ];
  return (
    <div className="max-w-4xl space-y-6">
      <Card className="min-w-0 gap-0 py-0 shadow-xs setup-checklist">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>A little setup. A lot of peace of mind.</h2>
          <Badge
            className="max-w-full whitespace-normal border-transparent text-[11px] bg-muted text-muted-foreground"
            variant="secondary"
          >
            {items.filter((i) => i.ready).length} / {items.length} ready
          </Badge>
        </CardHeader>
        {items.map((item) => (
          <div
            className="flex flex-wrap items-start gap-4 border-b p-5 last:border-0 [&>div]:min-w-0 [&>div]:flex-1 [&>div]:basis-44 [&_p]:mt-1 [&_p]:break-words [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-muted-foreground"
            key={item.label}
          >
            {item.ready ? (
              <CheckCircle2 className="text-allow" size={23} />
            ) : (
              <Circle className="text-muted-foreground" size={23} />
            )}
            <div>
              <h3>{item.label}</h3>
              <p>{item.detail}</p>
            </div>
            {item.href && (
              <a
                href={item.href}
                className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
              >
                {item.action}
                <ArrowRight size={14} />
              </a>
            )}
            {item.demo && !item.ready && (
              <Button
                onClick={reset}
                disabled={resetting || !state.configured.paypal}
                variant="default"
                type="button"
              >
                {resetting ? "Creating sandbox orders…" : "Load demo shop"}
              </Button>
            )}
          </div>
        ))}
      </Card>
      <Card className="min-w-0 gap-0 py-0 shadow-xs space-y-4 p-5">
        <span className="block text-[10px] font-medium tracking-widest text-muted-foreground">
          Connect your own agent over MCP
        </span>
        <ConnectAgent notify={notify} />
      </Card>
    </div>
  );
}

export function Setup(
  props: PageProps & { reset: () => void; resetting: boolean },
) {
  return isFilm() ? <LegacySetup {...props} /> : <Checklist {...props} />;
}
function Checklist({ state }: PageProps) {
  const manageable = canManage(state);
  const keys = useResource<AgentKey[]>("/api/keys", manageable);
  const notifications = useResource<NotificationSettings>(
    "/api/me/notifications",
  );
  const team = useQuery({
    queryKey: ["team", state.workspace?.id],
    queryFn: () => account.team(state.workspace!.id),
    enabled: !!state.workspace,
  });
  const items = [
    {
      label: "Connect PayPal",
      ready: state.workspace?.paypal.connected,
      detail: "Use your own PayPal sandbox app.",
      href: "settings/paypal",
      action: "Connect PayPal",
    },
    {
      label: "Create an agent",
      ready: state.agents.length > 0,
      detail: "Give it a job, permissions and a spending limit.",
      href: "agents",
      action: "Manage agents",
    },
    {
      label: "Create an agent key",
      ready: keys.data?.some(
        (k) =>
          !k.revoked_at &&
          (!k.expires_at || Date.parse(k.expires_at) > Date.now()),
      ),
      detail: manageable
        ? "Connect your agent securely over the API or MCP."
        : "Ask an administrator to issue your agent a key.",
      href: "developers/keys",
      action: "Create a key",
    },
    {
      label: "Set your rules",
      ready: state.policy.id > 1,
      detail:
        state.policy.id > 1
          ? `Policy v${state.policy.id} is active.`
          : "Review the starter policy and activate your own rules.",
      href: "rules",
      action: "Review rules",
    },
    {
      label: "Turn on push",
      ready:
        !!notifications.data?.devices.length &&
        !!notifications.data?.prefs.push_held,
      detail: "Receive requests that need your decision.",
      href: "settings/notifications",
      action: "Enable push",
    },
    {
      label: "Invite a teammate",
      ready:
        (team.data?.members.length ?? 0) > 1 ||
        team.data?.invitations.some(
          (i) =>
            i.status === "pending" &&
            new Date(i.expiresAt).getTime() > Date.now(),
        ),
      detail: "Share an invitation link with someone you trust.",
      href: "settings/team",
      action: "Invite teammate",
    },
  ];
  return (
    <div className="max-w-4xl space-y-6">
      <Card className="setup-checklist gap-0 overflow-hidden py-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <h2>Your workspace, ready for work.</h2>
          <Badge variant="secondary">
            {items.filter((i) => i.ready).length} / 6 ready
          </Badge>
        </CardHeader>
        {items.map((item) => (
          <div
            key={item.label}
            className="flex flex-wrap items-center gap-4 border-b p-5 last:border-0"
          >
            {item.ready ? (
              <CheckCircle2 className="size-6 text-allow" />
            ) : (
              <Circle className="size-6 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 basis-44">
              <h3>{item.label}</h3>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                {item.detail}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <a href={`/app#${item.href}`}>
                {item.action}
                <ArrowRight />
              </a>
            </Button>
          </div>
        ))}
      </Card>
      {(keys.error || notifications.error || team.error) && (
        <p role="alert" className="text-sm text-destructive">
          Some checklist statuses couldn't be loaded. Open the relevant page to
          retry.
        </p>
      )}
      <Card className="p-6">
        <h2>Start with one sandbox request</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Use the quickstart to request a refund or payout, then follow its
          decision in the ledger.
        </p>
        <Button variant="outline" asChild>
          <a href="/app#developers/quickstart">
            Open quickstart
            <ArrowRight />
          </a>
        </Button>
      </Card>
    </div>
  );
}
