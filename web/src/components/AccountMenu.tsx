import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  Fingerprint,
  LogOut,
  Plus,
  Settings,
} from "lucide-react";
import { account, isFilm } from "../auth";
import { type State, roleOf } from "../api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, Modal, useTask } from "./Management";

export function WorkspaceMenu({ state }: { state: State }) {
  const client = useQueryClient();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: account.organizations,
    enabled: !isFilm(),
  });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const { busy, run } = useTask();
  async function activate(id: string) {
    await client.cancelQueries();
    await account.setActive(id);
    // Discard cached workspace data before rendering another organization's private data.
    client.removeQueries({
      predicate: (q) => q.queryKey[0] !== "organizations",
    });
    await client.invalidateQueries();
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            disabled={busy}
            className="ml-auto min-w-0 max-w-[200px] flex-1 shrink gap-1 lg:max-w-none lg:flex-none lg:shrink-0 px-2 text-xs"
          >
            <span className="truncate">
              {state.workspace?.name ?? "Juniper & Oak Ceramics"}
              {(state.workspace?.demo || isFilm()) && " · Demo"}
            </span>
            <ChevronsUpDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[320px]">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {organizations.error && (
            <DropdownMenuItem onSelect={() => void organizations.refetch()}>
              Unable to load · Retry
            </DropdownMenuItem>
          )}
          {organizations.data?.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => void run(() => activate(org.id))}
            >
              <span className="truncate">{org.name}</span>
              {org.id === state.workspace?.id && <Check className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={isFilm()} onSelect={() => setOpen(true)}>
            <Plus />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Modal
        title="New workspace"
        description="A separate space for your agents, PayPal app and team."
        open={open}
        onClose={() => !busy && setOpen(false)}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const slug = `${
                name
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-|-$/g, "")
                  .slice(0, 40) || "workspace"
              }-${crypto.randomUUID().slice(0, 8)}`;
              const org = await account.createWorkspace(name.trim(), slug);
              if (org) await activate(org.id);
              setOpen(false);
              setName("");
            });
          }}
        >
          <Field label="Workspace name">
            <Input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button
            disabled={busy || !name.trim()}
            title={name.trim() ? undefined : "Give the workspace a name first."}
          >
            Create workspace
          </Button>
        </form>
      </Modal>
    </>
  );
}
export function UserMenu({ state }: { state: State }) {
  const { busy, run } = useTask();
  // A passkey prompt can stay open for a long time; it must not lock the menu (and Sign out) while it waits.
  const passkey = useTask();
  const name = state.me?.name ?? "Demo owner";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          disabled={busy}
          variant="ghost"
          size="icon"
          aria-label="Your account menu"
        >
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">
              {name
                .split(/\s+/)
                .slice(0, 2)
                .map((s) => s[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-2">
          <p>{name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">
            {state.me?.anonymous ? "Demo account" : state.me?.email}
          </p>
          <Badge variant="secondary">{roleOf(state)}</Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={isFilm() || state.me?.anonymous || passkey.busy}
          title={state.me?.anonymous ? "Create an account first. Passkeys belong to accounts, not to the demo." : undefined}
          onSelect={() => void passkey.run(() => account.addPasskey(), "Passkey added")}
        >
          <Fingerprint />
          {passkey.busy ? "Waiting for your device…" : state.me?.anonymous ? "Add a passkey (needs an account)" : "Add a passkey"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="/app#settings">
            <Settings />
            Settings
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isFilm()}
          onSelect={() =>
            void run(async () => {
              await account.signOut();
              location.assign("/signin");
            })
          }
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function UpgradePrompt() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const listener = (e: Event) =>
      setMessage(
        (e as CustomEvent<string>).detail ||
          "This workspace has reached its plan limit.",
      );
    window.addEventListener("floorwalker:upgrade", listener);
    return () => window.removeEventListener("floorwalker:upgrade", listener);
  }, []);
  return (
    <Modal
      title="Room to grow"
      description={message}
      open={!!message}
      onClose={() => setMessage("")}
    >
      <p className="text-sm text-muted-foreground">
        An owner can change the plan in Billing. Your existing work is saved.
      </p>
      <Button asChild onClick={() => setMessage("")}>
        <a href="/app#settings/billing">View plans & usage</a>
      </Button>
    </Modal>
  );
}
export function DemoBanner({ state }: { state: State }) {
  return state.me?.anonymous || isFilm() ? (
    <div className="demo-banner">
      <span>Explore Floorwalker <span aria-hidden="true">·</span> PayPal sandbox</span><span>Demo history is simulated. <span className="hidden sm:inline">No real money moves.</span></span>
      <a href="/signup" className="font-semibold underline underline-offset-4">
        Create an account to keep it.
      </a>
    </div>
  ) : null;
}
