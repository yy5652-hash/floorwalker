import { isFilm } from "./auth";
import { canManage } from "./api";
import { IncidentBanner } from "./components/IncidentBanner";
import { AuthPage } from "./pages/Auth";
import { Developers, developerTabs } from "./pages/Developers";
import { Settings as WorkspaceSettings, settingsTabs } from "./pages/Settings";
import {
  WorkspaceMenu,
  UserMenu,
  UpgradePrompt,
  DemoBanner,
} from "./components/AccountMenu";
import { Modal, useTask } from "./components/Management";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CircleAlert,
  ClipboardCheck,
  Code2,
  FileClock,
  Inbox as InboxIcon,
  LayoutDashboard,
  Radar,
  RefreshCw,
  Search,
  Settings,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Snowflake,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, getState, post, setDirectory } from "./api";
import { ApprovalCard, Approvals, PhoneApproval } from "./components/Approvals";
import { Inbox } from "./components/Inbox";
import { Brand, EmptyState } from "./components/UI";
import { ThemeToggle } from "./components/Theme";
import { Agents } from "./pages/Agents";
import { Landing } from "./pages/Landing";
import { Setup } from "./pages/Setup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

const Ledger = lazy(() =>
  import("./components/Ledger").then((module) => ({ default: module.Ledger })),
);
const Watch = lazy(() =>
  import("./pages/Watch").then((module) => ({ default: module.Watch })),
);
// Pages with grids and charts load on demand, so the inbox and approvals open fast.
const Audit = lazy(() => import("./pages/Audit").then((module) => ({ default: module.Audit })));
const Rules = lazy(() => import("./components/Rules").then((module) => ({ default: module.Rules })));
const Overview = lazy(() => import("./pages/Overview").then((module) => ({ default: module.Overview })));
const pages = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    subtitle: "A clear view of what your agents are doing with your money.",
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: InboxIcon,
    subtitle:
      "Give your agents the next request. Your rules take care of the boundaries.",
  },
  {
    id: "approvals",
    label: "Approvals",
    icon: ClipboardCheck,
    subtitle:
      "Every request is checked before it reaches you. Approving runs exactly this action, once.",
  },
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    subtitle: "A small team, with clear boundaries.",
  },
  {
    id: "rules",
    label: "Rules",
    icon: SlidersHorizontal,
    subtitle:
      "Set the boundaries in your own words. Every money move follows them.",
  },
  {
    id: "ledger",
    label: "Ledger",
    icon: BookOpen,
    subtitle: "Every request, every check, every outcome. All in one place.",
  },
  {
    id: "watch",
    label: "Watch",
    icon: Radar,
    subtitle: "Floorwalker only protects money that goes through it, so it also watches PayPal for money that didn't.",
  },
  {
    id: "setup",
    label: "Setup",
    icon: Settings2,
    subtitle: "From keys to your first governed payment in about two minutes.",
  },
  {
    id: "developers",
    label: "Developers",
    icon: Code2,
    subtitle: "A home for your integrations.",
  },
  {
    id: "audit",
    label: "Audit log",
    icon: FileClock,
    subtitle: "Workspace events and changes.",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    subtitle: "Make this workspace yours.",
  },
];

function Navigation({ active, waiting }: { active: string; waiting: number }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {pages.map(({ id, label, icon: Icon }) => (
        <SidebarMenuItem
          key={id}
          className={id === "developers" ? "mt-5 border-t pt-5" : ""}
        >
          <SidebarMenuButton
            asChild
            isActive={active === id}
            tooltip={label}
            className="h-10"
          >
            <a
              href={`/app#${id}`}
              data-film={`nav-${id === "audit" ? "audit-log" : id}`}
              aria-current={active === id ? "page" : undefined}
              onClick={() => setOpenMobile(false)}
            >
              <Icon />
              <span>{label}</span>
            </a>
          </SidebarMenuButton>
          {id === "approvals" && waiting > 0 && (
            <SidebarMenuBadge className="tone-hold top-2.5">
              {waiting}
            </SidebarMenuBadge>
          )}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading workspace">
      <span className="sr-only">Getting your shop ready…</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-2/3" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
function Workspace({ mobile }: { mobile: boolean }) {
  const client = useQueryClient();
  const {
    data: state,
    error,
    refetch,
  } = useQuery({
    queryKey: [
      "state",
      mobile ? new URLSearchParams(location.search).get("ws") : null,
    ],
    queryFn: async ({ signal }) => {
      const data = await getState(signal);
      setDirectory(data);
      return data;
    },
    refetchInterval: (query) =>
      query.state.data?.workspace?.seedStatus === "seeding"
        ? 2000
        : mobile
          ? 4000
          : 8000,
    refetchIntervalInBackground: false,
  });
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["state"] });
  }, [client]);
  const notify = useCallback((message: string) => {
    toast(message);
  }, []);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || isFilm()) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "floorwalker:refresh") void refresh();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [refresh]);
  const [route, setRoute] = useState(location.hash.slice(1) || "overview");
  const [commandOpen, setCommandOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const freezeTask = useTask();
  const [resetting, setResetting] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const resetLock = useRef(false);
  const [attackRequest, setAttackRequest] = useState(0);
  const [agentRunning, setAgentRunning] = useState(false);
  // A demo opens on its inbox, where the story starts; a new workspace without PayPal opens on the
  // getting-started checklist. Either is better than an empty overview.
  const workspaceId = state?.workspace?.id;
  useEffect(() => {
    if (!state || mobile || isFilm() || location.hash.slice(1)) return;
    if (state.workspace?.demo && !state.ledger.length) location.hash = "inbox";
    else if (!state.workspace?.demo && !state.workspace?.paypal.connected) location.hash = "setup";
    // Only when a workspace is first opened, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  useEffect(() => {
    const changed = () => setRoute(location.hash.slice(1) || "overview");
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener("hashchange", changed);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("keydown", keydown);
    };
  }, []);
  async function reset() {
    if (!state || !canManage(state) || (!state.workspace?.demo && !isFilm()))
      return;
    if (resetLock.current || agentRunning) return;
    resetLock.current = true;
    setResetting(true);
    try {
      await post("/api/demo/reset");
      setResetKey((k) => k + 1);
      setAgentRunning(false);
      await refresh();
      notify("Fresh sandbox orders created. Your demo inbox is ready.");
    } catch (e) {
      notify(errorMessage(e));
      await refresh();
    } finally {
      resetLock.current = false;
      setResetting(false);
    }
  }
  if (!state)
    return (
      <main className="mx-auto min-h-svh max-w-5xl space-y-12 px-6 py-12">
        <Brand />
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Couldn't connect to your shop</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(error)}</p>
              <Button variant="outline" onClick={() => void refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <PageSkeleton />
        )}
      </main>
    );
  if (state.workspace?.seedStatus === "seeding" && !isFilm())
    return (
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-6 p-6">
        <Brand />
        <h1 className="text-3xl">Setting up your demo shop</h1>
        <p className="text-sm leading-7 text-muted-foreground">
          Creating paid orders in the PayPal sandbox… This can take a little
          while.
        </p>
        <Skeleton className="h-2 w-full" />
        <p className="text-xs text-muted-foreground" role="status">
          We'll open your workspace when everything is ready.
        </p>
      </main>
    );
  const props = { state, refresh, notify };
  const demo = state.workspace?.demo ?? isFilm();
  const manageable = canManage(state);
  const freezeDialog = (
    <Modal
      title="Freeze all agents?"
      description="Stop every active agent from initiating money movements. Requests already executing may finish. You can unfreeze agents individually."
      open={freezeOpen}
      onClose={() => !freezeTask.busy && setFreezeOpen(false)}
    >
      <Button
        variant="destructive"
        disabled={freezeTask.busy}
        onClick={() =>
          void freezeTask.run(async () => {
            const result = await post<{ frozen: number }>(
              "/api/agents/freeze-all",
            );
            await refresh();
            setFreezeOpen(false);
            notify(`${result.frozen} agents frozen`);
          })
        }
      >
        Freeze all agents
      </Button>
    </Modal>
  );
  const waiting = state.ledger.filter((e) => e.status === "awaiting_approval");
  const focusedEntry = mobile
    ? state.ledger.find(
        (e) => String(e.id) === location.hash.slice(1).replace(/^act_/, ""),
      )
    : undefined;
  const phoneEntries =
    focusedEntry && !waiting.some((e) => e.id === focusedEntry.id)
      ? [focusedEntry, ...waiting]
      : waiting;
  const page =
    pages.find(
      (p) =>
        p.id ===
        (route.split("/")[0] === "audit-log" ? "audit" : route.split("/")[0]),
    ) ?? pages[0];
  const feedback = error && (
    <Alert className="mb-6 tone-hold">
      <CircleAlert />
      <AlertTitle>Unable to refresh</AlertTitle>
      <AlertDescription>
        <span>Showing the last loaded state.</span>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
  const palette = (
    <CommandDialog
      open={commandOpen}
      onOpenChange={setCommandOpen}
      title="Workspace commands"
      description="Navigate or run a demo action."
    >
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>No matching pages or actions.</CommandEmpty>
        <CommandGroup heading="Go to">
          {pages.map(({ id, label, icon: Icon }) => (
            <CommandItem
              key={id}
              onSelect={() => {
                location.hash = id;
                setCommandOpen(false);
              }}
            >
              <Icon />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Settings & developer tabs">
          {[
            ...settingsTabs.map(([id, label]) => [
              `settings/${id}`,
              `Settings · ${label}`,
            ]),
            ...developerTabs.map(([id, label]) => [
              `developers/${id}`,
              `Developers · ${label}`,
            ]),
          ].map(([id, label]) => (
            <CommandItem
              key={id}
              onSelect={() => {
                location.hash = id;
                setCommandOpen(false);
              }}
            >
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            disabled={!manageable || isFilm()}
            onSelect={() => {
              location.hash = "developers/keys/new";
              setCommandOpen(false);
            }}
          >
            Create agent key
          </CommandItem>
          <CommandItem
            disabled={!manageable || isFilm()}
            onSelect={() => {
              location.hash = "settings/team";
              setCommandOpen(false);
            }}
          >
            Invite a teammate
          </CommandItem>
          {demo && (
            <CommandItem
              disabled={
                !manageable ||
                resetting ||
                agentRunning ||
                !state.configured.paypal
              }
              onSelect={() => {
                setCommandOpen(false);
                void reset();
              }}
            >
              <RefreshCw />
              Reset demo
            </CommandItem>
          )}
          <CommandItem
            disabled={
              !manageable ||
              !demo ||
              agentRunning ||
              resetting ||
              !state.configured.paypal ||
              !state.configured.ai
            }
            onSelect={() => {
              setCommandOpen(false);
              location.hash = "inbox";
              setAttackRequest((n) => n + 1);
            }}
          >
            <ShieldAlert />
            Simulate a hijacked agent
          </CommandItem>
          <CommandItem
            disabled={!manageable}
            onSelect={() => {
              setCommandOpen(false);
              setFreezeOpen(true);
            }}
          >
            <Snowflake />
            Freeze all agents
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
  if (mobile)
    return (
      <div className="min-h-svh">
        <DemoBanner state={state} />
        <header className="flex items-center justify-between border-b bg-card px-4 py-4">
          <Brand />
          <div className="flex items-center gap-2">
            <Badge className="tone-hold">{waiting.length} waiting</Badge>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto max-w-lg space-y-6 px-4 py-8">
          <div className="space-y-3">
            <p className="text-xs font-medium tracking-widest text-muted-foreground">
              {state.workspace?.name ?? "JUNIPER & OAK CERAMICS"}
            </p>
            <h1>Your call.</h1>
            <p className="text-muted-foreground">
              Everything checked. Just a decision from you.
            </p>
          </div>
          {feedback}
          <IncidentBanner key={workspaceId} state={state} />
          {phoneEntries.length ? (
            [...phoneEntries]
              .sort(
                (a, b) =>
                  Number(String(b.id) === location.hash.slice(1)) -
                  Number(String(a.id) === location.hash.slice(1)),
              )
              .map((entry) => (
                <ApprovalCard key={entry.id} entry={entry} {...props} />
              ))
          ) : (
            <Card>
              <EmptyState title="All caught up">
                <p>We'll bring the next request here when it needs you.</p>
              </EmptyState>
            </Card>
          )}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" />
            Your approval runs this action exactly once.
          </p>
          <Button asChild variant="outline">
            <a href="/app">
              Open dashboard
              <ArrowRight />
            </a>
          </Button>
        </main>
      </div>
    );
  return (
    <SidebarProvider>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:p-3"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-4 py-6 group-data-[collapsible=icon]:px-2">
          <a
            href="/"
            className="flex items-center gap-2 text-xl font-semibold tracking-tight"
            aria-label="Floorwalker home"
          >
            <img src="/favicon.svg" width="28" height="28" alt="" />
            <span className="group-data-[collapsible=icon]:hidden">
              Floorwalker
            </span>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <nav aria-label="Main navigation">
              <Navigation
                active={page.id}
                waiting={state.metrics.waitingCount}
              />
            </nav>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="p-3">
          <div className="space-y-3 rounded-lg border bg-card p-3 text-xs group-data-[collapsible=icon]:hidden">
            <p className="flex items-center gap-2">
              <span
                className={`size-1.5 rounded-full ${state.configured.paypal ? "bg-emerald-500" : "bg-muted-foreground"}`}
              />
              PayPal sandbox ·{" "}
              {state.configured.paypal ? "connected" : "disconnected"}
            </p>
            <p
              className="truncate text-muted-foreground"
              title={state.configured.agentModel}
            >
              {state.configured.ai
                ? state.configured.agentModel
                : "AI not configured"}
            </p>
            {demo && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={
                  !manageable ||
                  resetting ||
                  agentRunning ||
                  !state.configured.paypal
                }
                onClick={() => void reset()}
              >
                <RefreshCw className={resetting ? "animate-spin" : ""} />
                {resetting ? "Creating orders…" : "Reset demo"}
              </Button>
            )}
            <p className="text-center text-[10px] text-muted-foreground">
              {demo
                ? "Demo workspace · sandbox money"
                : `${state.workspace?.plan ?? "Free"} plan · sandbox money`}
            </p>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-16 min-w-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur md:gap-4 md:px-8">
          <SidebarTrigger />
          <Separator orientation="vertical" className="!h-5" />
          <Breadcrumb className="hidden md:block">
            <BreadcrumbList>
              <BreadcrumbItem>Workspace</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{page.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <WorkspaceMenu state={state} />
          <Button
            variant="outline"
            size="sm"
            className="hidden gap-3 lg:flex"
            onClick={() => setCommandOpen(true)}
          >
            <Search className="size-3" />
            Search
            <kbd className="text-[10px] text-muted-foreground">⌘K / Ctrl K</kbd>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open command palette"
            onClick={() => setCommandOpen(true)}
          >
            <Search />
          </Button>
          <ThemeToggle />
          <UserMenu state={state} />
        </header>
        <DemoBanner state={state} />
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1440px] flex-1 space-y-7 p-4 outline-none sm:p-6 lg:p-8"
        >
          <header className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-2xl space-y-2">
              <p className="text-[10px] font-medium tracking-[.18em] text-muted-foreground">
                {page.id === "overview"
                  ? "YOUR MONEY, IN GOOD HANDS"
                  : (state.workspace?.name ?? "JUNIPER & OAK CERAMICS")}
              </p>
              <h1>{page.id === "watch" ? "PayPal watch" : page.label}</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {page.subtitle}
              </p>
            </div>
            {page.id === "approvals" ? (
              <PhoneApproval workspaceId={state.workspace?.id} />
            ) : page.id === "overview" ? (
              <Button asChild variant="outline">
                <a href="/app#inbox">
                  Open inbox
                  <ArrowRight />
                </a>
              </Button>
            ) : (
              <Badge variant="outline" className="gap-1.5 py-1.5">
                <ShieldCheck className="size-3 text-allow" />
                Governed by your rules
              </Badge>
            )}
          </header>
          {feedback}
          {["overview", "inbox", "approvals", "agents", "watch"].includes(page.id) && (
            <IncidentBanner key={workspaceId} state={state} />
          )}
          {state.workspace?.seedStatus?.startsWith("failed:") && (
            <Alert variant="destructive">
              <AlertTitle>Demo setup needs attention</AlertTitle>
              <AlertDescription>
                {state.workspace.seedStatus.slice(7)}
                <Button
                  variant="outline"
                  disabled={resetting || !manageable}
                  onClick={() => void reset()}
                >
                  Retry demo setup
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {page.id === "overview" && (
            <Suspense fallback={<PageSkeleton />}>
              <Overview
                {...props}
                reset={() => void reset()}
                resetting={resetting}
              />
            </Suspense>
          )}
          <div hidden={page.id !== "inbox"}>
            <Inbox
              key={`${state.workspace?.id ?? "film"}-${resetKey}`}
              {...props}
              attackRequest={attackRequest}
              onRunningChange={setAgentRunning}
              disabled={resetting || !manageable}
            />
          </div>
          {page.id === "approvals" && <Approvals {...props} />}
          {page.id === "agents" && <Agents {...props} />}
          {page.id === "rules" && (
            <Suspense fallback={<PageSkeleton />}>
              <Rules {...props} />
            </Suspense>
          )}
          {page.id === "watch" && (
            <Suspense fallback={<PageSkeleton />}>
              <Watch key={workspaceId} state={state} />
            </Suspense>
          )}
          {page.id === "ledger" && (
            <Suspense fallback={<PageSkeleton />}>
              <Ledger
                state={state}
                selectedId={
                  route.includes("/") ? Number(route.split("/")[1]) : undefined
                }
              />
            </Suspense>
          )}
          {page.id === "setup" && (
            <Setup
              {...props}
              reset={() => void reset()}
              resetting={resetting}
            />
          )}
          {page.id === "developers" && (
            <Developers
              key={state.workspace?.id}
              {...props}
              tab={route.split("/")[1]}
            />
          )}
          {page.id === "audit" && (
            <Suspense fallback={<PageSkeleton />}>
              <Audit key={state.workspace?.id} />
            </Suspense>
          )}
          {page.id === "settings" && (
            <WorkspaceSettings
              key={state.workspace?.id}
              {...props}
              tab={route.split("/")[1]}
            />
          )}
        </main>
        <footer className="flex items-center justify-center gap-2 px-4 py-6 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3" />
          Every refund checked. Fewer taps every week.
        </footer>
      </SidebarInset>
      {palette}
      {freezeDialog}
    </SidebarProvider>
  );
}
function Routes() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/signin" || path === "/signup")
    return <AuthPage signup={path === "/signup"} />;
  if (path.startsWith("/invite/"))
    return <AuthPage invitationId={decodeURIComponent(path.slice(8))} />;
  if (path === "/") return <Landing />;
  if (path === "/approve") return <Workspace mobile />;
  if (path === "/app") return <Workspace mobile={false} />;
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <Brand />
      <h1>Page not found</h1>
      <Button asChild>
        <a href="/app">
          Open your dashboard
          <ArrowRight />
        </a>
      </Button>
    </main>
  );
}

export function App() {
  useEffect(() => {
    const billing = new URLSearchParams(location.search).get("billing");
    if (billing) {
      billing === "ok"
        ? toast.success("Subscription confirmed. Your plan is ready.")
        : toast.error(billing);
      const url = new URL(location.href);
      url.searchParams.delete("billing");
      url.hash = "settings/billing";
      history.replaceState(null, "", url);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  }, []);
  return (
    <>
      <Routes />
      <UpgradePrompt />
    </>
  );
}
