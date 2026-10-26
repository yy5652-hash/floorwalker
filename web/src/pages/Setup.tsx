import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { type PageProps } from "../api";
import { ConnectAgent } from "../components/UI";
export function Setup({
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
