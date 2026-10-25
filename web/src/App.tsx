import { ArrowRight, BookOpen, Bot, CheckCircle2, CircleAlert, ClipboardCheck, Inbox as InboxIcon, LayoutDashboard, Loader2, RefreshCw, Settings2, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getState, post, setDirectory, type State } from "./api";
import { ApprovalCard, Approvals, PhoneApproval } from "./components/Approvals";
import { Inbox } from "./components/Inbox";
import { Rules } from "./components/Rules";
import { Brand, EmptyState } from "./components/UI";
import { Agents } from "./pages/Agents";
import { Landing } from "./pages/Landing";
import { Overview } from "./pages/Overview";
import { Setup } from "./pages/Setup";

const Ledger = lazy(() => import("./components/Ledger").then(module => ({ default: module.Ledger })));

const pages = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, subtitle: "A clear view of what your agents are doing with your money." },
  { id: "inbox", label: "Inbox", icon: InboxIcon, subtitle: "Give your agents the next request. Your rules take care of the boundaries." },
  { id: "approvals", label: "Approvals", icon: ClipboardCheck, subtitle: "Every request is checked before it reaches you. Approving runs exactly this action, once." },
  { id: "agents", label: "Agents", icon: Bot, subtitle: "A small team, with clear boundaries." },
  { id: "rules", label: "Rules", icon: SlidersHorizontal, subtitle: "Set the boundaries in your own words. Every money move follows them." },
  { id: "ledger", label: "Ledger", icon: BookOpen, subtitle: "Every request, every check, every outcome. All in one place." },
  { id: "setup", label: "Setup", icon: Settings2, subtitle: "From keys to your first governed payment in about two minutes." },
];
function Workspace({ mobile }: { mobile: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(location.hash.slice(1) || "overview");
  const [toast, setToast] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resetLock = useRef(false);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    try { const data = await getState(next.signal); if (request.current === id) { setDirectory(data); setState(data); setError(""); } }
    catch (e) { if (!next.signal.aborted && request.current === id) setError(errorMessage(e)); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, mobile ? 4000 : 8000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", visible); controller.current?.abort(); clearTimeout(toastTimer.current); };
  }, [mobile, refresh]);
  useEffect(() => {
    const changed = () => { setRoute(location.hash.slice(1) || "overview"); };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const notify = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 6500); }, []);
  async function reset() {
    if (resetLock.current) return;
    resetLock.current = true; setResetting(true);
    try { await post("/api/demo/reset"); setResetKey(k => k + 1); await refresh(); notify("Fresh sandbox orders created. Your demo inbox is ready."); }
    catch (e) { notify(errorMessage(e)); await refresh(); }
    finally { resetLock.current = false; setResetting(false); }
  }
  if (!state) return <div className="loading-screen"><Brand />{error ? <><CircleAlert size={26} className="text-block" /><h2>Couldn't connect to your shop</h2><p role="alert">{error}</p><button className="btn primary" onClick={() => void refresh()}>Try again</button></> : <><Loader2 size={25} className="spin" /><p>Getting your shop ready…</p></>}</div>;
  const props = { state, refresh, notify };
  const waiting = state.ledger.filter(e => e.status === "awaiting_approval");
  const page = pages.find(p => p.id === route.split("/")[0]) ?? pages[0];
  const feedback = <>{error && <div className="connection-error" role="alert"><CircleAlert size={16} />Unable to refresh. Showing the last loaded state.<button className="text-btn" onClick={() => void refresh()}>Retry</button></div>}{toast && <div className="toast" role="status"><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><X size={16} /></button></div>}</>;
  if (mobile) return <div className="mobile-approval"><header className="mobile-header"><Brand /><span className="pill hold">{waiting.length} waiting</span></header><main className="mobile-main"><div className="mobile-intro"><span className="eyebrow">JUNIPER &amp; OAK CERAMICS</span><h1>Your call.</h1><p>Everything checked. Just a decision from you.</p></div>{feedback}{waiting.length ? waiting.map(entry => <ApprovalCard key={entry.id} entry={entry} {...props} />) : <div className="card"><EmptyState title="All caught up ✓"><p>We'll bring the next request here when it needs you.</p></EmptyState></div>}<p className="mobile-footnote"><ShieldCheck size={14} />Your approval runs this action exactly once.</p><a className="text-link" href="/app">Open dashboard <ArrowRight size={14} /></a></main></div>;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar"><Brand /><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{pages.map(({ id, label, icon: Icon }) => <a className={`nav-item ${page.id === id ? "active" : ""}`} href={`/app#${id}`} key={id} data-film={`nav-${id}`} aria-current={page.id === id ? "page" : undefined}><Icon size={18} /><span>{label}</span>{id === "approvals" && state.metrics.waitingCount > 0 && <span className="nav-count">{state.metrics.waitingCount}</span>}</a>)}</nav><div className="sidebar-bottom"><div className="shop"><span className="shop-avatar">J&amp;O</span><div><strong>Juniper &amp; Oak</strong><span>Ceramics</span></div></div><div className="connection"><span className={`dot ${state.configured.paypal ? "on" : ""}`} />PayPal sandbox<span className="sr-only">{state.configured.paypal ? " connected" : " disconnected"}</span></div><div className="connection" title={state.configured.agentModel}><span className={`dot ${state.configured.ai ? "on" : ""}`} /><span>{state.configured.agentModel || "AI not configured"}</span><span className="sr-only">{state.configured.ai ? " ready" : " not ready"}</span></div><button className="btn reset-btn" disabled={resetting || !state.configured.paypal} onClick={() => void reset()}><RefreshCw size={14} className={resetting ? "spin" : ""} />{resetting ? "Creating sandbox orders…" : "Reset demo"}</button><span className="sandbox-note">Demo workspace · sandbox money</span></div></aside>
    <div className="workspace-main"><div className="workspace-top"><span>Juniper &amp; Oak Ceramics <span className="top-divider">/</span> <strong>{page.label}</strong></span><span className="sandbox-badge"><span className="dot on" />Sandbox workspace</span></div><main id="main-content" className="main-content"><header className={`page-header ${page.id === "approvals" ? "approvals-header" : ""}`}><div><span className="eyebrow">{page.id === "overview" ? "YOUR MONEY, IN GOOD HANDS" : "JUNIPER & OAK CERAMICS"}</span><h1>{page.label}</h1><p>{page.subtitle}</p></div>{page.id === "approvals" ? <PhoneApproval /> : page.id === "overview" ? <a className="btn" href="/app#inbox">Open inbox <ArrowRight size={15} /></a> : <span className="page-header-icon"><CheckCircle2 size={16} />Governed by your rules</span>}</header>{feedback}
      {page.id === "overview" && <Overview {...props} reset={() => void reset()} resetting={resetting} />}
      <div hidden={page.id !== "inbox"}><Inbox key={resetKey} {...props} /></div>
      {page.id === "approvals" && <Approvals {...props} />}
      {page.id === "agents" && <Agents {...props} />}
      {page.id === "rules" && <Rules {...props} />}
      {page.id === "ledger" && <Suspense fallback={<div className="card empty">Loading your ledger…</div>}><Ledger state={state} selectedId={route.includes("/") ? Number(route.split("/")[1]) : undefined} /></Suspense>}
      {page.id === "setup" && <Setup {...props} reset={() => void reset()} resetting={resetting} />}
    </main><footer className="workspace-footer"><ShieldCheck size={13} />Give your AI agent an allowance, not your wallet.</footer></div>
  </div>;
}
export function App() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return <Landing />;
  if (path === "/approve") return <Workspace mobile />;
  if (path === "/app") return <Workspace mobile={false} />;
  return <div className="loading-screen"><Brand /><h1>Page not found</h1><a className="btn primary" href="/app">Open your dashboard <ArrowRight size={15} /></a></div>;
}
