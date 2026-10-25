import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { type PageProps } from "../api";
import { ConnectAgent } from "../components/UI";

export function Setup({ state, notify, reset, resetting }: PageProps & { reset: () => void; resetting: boolean }) {
  const items = [
    { label: "PayPal sandbox connected", ready: state.configured.paypal, detail: state.configured.paypal ? "Ready for sandbox refunds and payouts." : "Add your PayPal sandbox credentials to the server configuration." },
    { label: "AI model ready", ready: state.configured.ai, detail: state.configured.ai ? `${state.configured.provider ?? "AI"} · ${state.configured.agentModel} · reviewer ${state.configured.reviewModel}` : "Add an AI provider key to the server configuration." },
    { label: "Rules in place", ready: !!state.policy.id, detail: `Policy v${state.policy.id} checks every money move.`, href: "/app#rules", action: "Review rules" },
    { label: "Agents", ready: state.agents.length > 0, detail: `${state.agents.length} agents connected to your shop.`, href: "/app#agents", action: "Manage agents" },
    { label: "Demo shop loaded", ready: state.tickets.length > 0, detail: state.tickets.length ? `${state.tickets.length} inbox items · ${state.orders.length} sandbox orders` : "Create sandbox orders and a fresh inbox for Juniper & Oak Ceramics.", demo: true },
  ];
  return <div className="setup-content"><section className="card setup-checklist"><div className="card-h"><h2>A little setup. A lot of peace of mind.</h2><span className="pill neutral">{items.filter(i => i.ready).length} / {items.length} ready</span></div>{items.map(item => <div className="setup-row" key={item.label}>{item.ready ? <CheckCircle2 className="text-allow" size={23} /> : <Circle className="text-muted" size={23} />}<div><h3>{item.label}</h3><p>{item.detail}</p></div>{item.href && <a href={item.href} className="text-link">{item.action}<ArrowRight size={14} /></a>}{item.demo && !item.ready && <button className="btn primary" onClick={reset} disabled={resetting || !state.configured.paypal}>{resetting ? "Creating sandbox orders…" : "Load demo shop"}</button>}</div>)}</section><section className="card card-b"><span className="eyebrow">Connect your own agent over MCP</span><ConnectAgent notify={notify} /></section></div>;
}
