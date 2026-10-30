import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Fingerprint, Plus, ShieldCheck } from "lucide-react";
import { account, isFilm, type TeamRole } from "../auth";
import { api, canManage, isOwner, type PageProps } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Code,
  Confirm,
  Events,
  Field,
  Modal,
  PageTabs,
  Resource,
  Toggle,
  selectClass,
  useResource,
  useTask,
} from "../components/Management";

export const settingsTabs = [
  ["general", "General"],
  ["paypal", "PayPal"],
  ["team", "Team"],
  ["notifications", "Notifications"],
  ["billing", "Billing"],
  ["security", "Security"],
] as const;
type WorkspaceSettings = {
  approval_ttl_hours: number;
  step_up_over: number;
  reminder_after_minutes: number;
  paypal: {
    connected: boolean;
    own: boolean;
    client_id_hint: string | null;
    verified_at: string | null;
    app: { appId: string; payouts: boolean; refunds: boolean } | null;
  };
};
export type NotificationSettings = {
  prefs: {
    push_held: boolean;
    push_blocked: boolean;
    push_reminders: boolean;
    push_executed: boolean;
  };
  devices: { endpoint: string; user_agent: string; created_at: string }[];
};
export type Plan = {
  id: string;
  name: string;
  price: number;
  agents: number | null;
  actionsPerMonth: number | null;
  members: number | null;
  webhooks: number | null;
};
type BillingData = {
  plan: string;
  status: string;
  subscription_id: string | null;
  renews_or_ends_at: string | null;
  limits: Omit<Plan, "id">;
  plans: Plan[];
  usage: {
    agents: number;
    actions_this_month: number;
    members: number;
    webhooks: number;
  };
};
export const publicPlans: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    agents: 3,
    actionsPerMonth: 200,
    members: 3,
    webhooks: 1,
  },
  {
    id: "pro",
    name: "Pro",
    price: 29,
    agents: 20,
    actionsPerMonth: 5000,
    members: 10,
    webhooks: 10,
  },
  {
    id: "business",
    name: "Business",
    price: 99,
    agents: null,
    actionsPerMonth: 50000,
    members: null,
    webhooks: null,
  },
];
const count = (n: number | null) =>
  n == null ? "Unlimited" : n.toLocaleString();
function General({ state, refresh }: PageProps) {
  const settings = useResource<WorkspaceSettings>("/api/settings");
  const { busy, run } = useTask();
  const [name, setName] = useState(state.workspace?.name ?? "");
  const editable = canManage(state);
  return (
    <Resource query={settings}>
      {settings.data && (
        <Card className="max-w-2xl p-6">
          <h2>Workspace details</h2>
          <form
            key={JSON.stringify(settings.data)}
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void run(async () => {
                if (name !== state.workspace?.name) {
                  await account.rename(state.workspace!.id, name.trim());
                  await refresh();
                }
                await api("/api/settings", "PATCH", {
                  approval_ttl_hours: Number(form.get("ttl")),
                  reminder_after_minutes: Number(form.get("reminder")),
                  step_up_over: Number(form.get("step")),
                });
                await settings.refetch();
                await refresh();
              }, "Settings saved");
            }}
          >
            <fieldset disabled={!editable || busy} className="space-y-5">
              <Field label="Workspace name">
                <Input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="Approval expiry (hours)"
                hint="Unanswered approvals expire after this interval."
              >
                <Input
                  name="ttl"
                  type="number"
                  min={1}
                  max={720}
                  required
                  defaultValue={settings.data.approval_ttl_hours}
                />
              </Field>
              <Field
                label="Reminder delay (minutes)"
                hint="Remind teammates about approvals still waiting for a decision."
              >
                <Input
                  name="reminder"
                  type="number"
                  min={5}
                  max={1440}
                  required
                  defaultValue={settings.data.reminder_after_minutes}
                />
              </Field>
              <Field
                label="Step-up amount (USD)"
                hint="Approvals above this amount require a fresh passkey sign-in when the approver has a passkey."
              >
                <Input
                  name="step"
                  type="number"
                  min={0}
                  max={1000000}
                  step="0.01"
                  required
                  defaultValue={settings.data.step_up_over}
                />
              </Field>
              <Button>Save changes</Button>
            </fieldset>
            {!editable && (
              <p className="text-xs text-muted-foreground">
                Only owners and admins can change workspace settings.
              </p>
            )}
          </form>
        </Card>
      )}
    </Resource>
  );
}
function PayPal({ state, refresh }: PageProps) {
  const settings = useResource<WorkspaceSettings>("/api/settings");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const { busy, run } = useTask();
  const editable = canManage(state);
  return (
    <Resource query={settings}>
      {settings.data && (
        <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <h2>PayPal connection</h2>
              <Badge
                className={
                  settings.data.paypal.connected ? "tone-allow" : "tone-hold"
                }
              >
                {settings.data.paypal.connected ? "Connected" : "Not connected"}
              </Badge>
            </div>
            {state.workspace?.demo && (
              <p className="rounded-lg bg-muted p-3 text-sm">
                {settings.data.paypal.own
                  ? "This demo is using your connected sandbox app."
                  : "This demo workspace uses Floorwalker's sandbox app."}
              </p>
            )}
            {settings.data.paypal.own && (
              <div className="space-y-2 text-sm">
                <p>
                  Client ID: <code>{settings.data.paypal.client_id_hint}</code>
                </p>
                <p className="text-xs text-muted-foreground">
                  Verified{" "}
                  {settings.data.paypal.verified_at
                    ? new Date(
                        settings.data.paypal.verified_at,
                      ).toLocaleString()
                    : "—"}
                </p>
                {settings.data.paypal.app && (
                  <div className="flex gap-2">
                    <Badge variant="secondary">
                      Refunds:{" "}
                      {settings.data.paypal.app.refunds
                        ? "available"
                        : "unavailable"}
                    </Badge>
                    <Badge variant="secondary">
                      Payouts:{" "}
                      {settings.data.paypal.app.payouts
                        ? "available"
                        : "unavailable"}
                    </Badge>
                  </div>
                )}
                <Confirm
                  disabled={!editable}
                  title="Disconnect PayPal?"
                  description="Your agents will lose access to this sandbox app. Demo workspaces fall back to Floorwalker's demo app."
                  label="Disconnect"
                  onConfirm={async () => {
                    await api("/api/settings/paypal", "DELETE");
                    await settings.refetch();
                    await refresh();
                  }}
                >
                  Disconnect
                </Confirm>
              </div>
            )}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api("/api/settings/paypal", "POST", {
                    client_id: clientId.trim(),
                    client_secret: secret.trim(),
                  });
                  setClientId("");
                  setSecret("");
                  await settings.refetch();
                  await refresh();
                }, "PayPal sandbox app verified and connected");
              }}
            >
              <fieldset disabled={!editable || busy} className="space-y-4">
                <Field label="Sandbox Client ID">
                  <Input
                    required
                    minLength={10}
                    autoComplete="off"
                    spellCheck={false}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </Field>
                <Field label="Sandbox Client Secret">
                  <Input
                    type="password"
                    required
                    minLength={10}
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </Field>
                <Button>
                  {busy
                    ? "Verifying with PayPal…"
                    : settings.data.paypal.own
                      ? "Replace sandbox app"
                      : "Connect sandbox app"}
                </Button>
              </fieldset>
            </form>
          </Card>
          <Card className="self-start p-6">
            <h2>Bring your own sandbox</h2>
            <ol className="list-decimal space-y-4 pl-5 text-sm leading-6 text-muted-foreground">
              <li>
                Open{" "}
                <a
                  href="https://developer.paypal.com/dashboard/applications/sandbox"
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  developer.paypal.com
                </a>{" "}
                and sign in.
              </li>
              <li>Go to Apps & Credentials → Sandbox.</li>
              <li>
                Create or select an app, then copy its Client ID and Secret
                here.
              </li>
            </ol>
            <div className="flex gap-2 border-t pt-4 text-xs text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" />
              Sandbox only. These credentials cannot move live PayPal money.
            </div>
          </Card>
        </div>
      )}
    </Resource>
  );
}
const roleDescriptions: Record<TeamRole, string> = {
  owner: "Full access, including billing.",
  admin: "Manage agents, integrations, rules and team. No billing.",
  approver: "Review, approve and decline payments.",
  viewer: "Read-only access to workspace activity.",
};
function Team({ state }: PageProps) {
  const id = state.workspace!.id;
  const team = useQuery({
    queryKey: ["team", id],
    queryFn: () => account.team(id),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("approver");
  const [link, setLink] = useState("");
  const { busy, run } = useTask();
  const editable = canManage(state);
  const roles = (
    isOwner(state)
      ? ["owner", "admin", "approver", "viewer"]
      : ["admin", "approver", "viewer"]
  ) as TeamRole[];
  const billing = useResource<BillingData>("/api/billing", editable);
  const full =
    billing.data?.limits.members != null &&
    (team.data?.members.length ?? 0) +
      (team.data?.invitations.filter((i) => i.status === "pending").length ??
        0) >=
      billing.data.limits.members;
  return (
    <div className="space-y-6">
      <Resource query={team}>
        <Card className="overflow-hidden py-0">
          <div className="overflow-x-auto">
            <table className="manage-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {team.data?.members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <strong>{member.user.name}</strong>
                      <span className="block text-xs text-muted-foreground">
                        {member.user.email}
                        {member.userId === state.me?.userId && " · You"}
                      </span>
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${member.user.name}`}
                        className={selectClass}
                        value={member.role}
                        disabled={
                          !editable ||
                          busy ||
                          member.userId === state.me?.userId ||
                          (!isOwner(state) && member.role === "owner")
                        }
                        onChange={(e) => {
                          const value = e.target.value as TeamRole;
                          void run(async () => {
                            await account.changeRole(id, member.id, value);
                            await team.refetch();
                          }, "Role updated");
                        }}
                      >
                        {[...new Set([member.role, ...roles])].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Confirm
                        disabled={
                          !editable ||
                          member.userId === state.me?.userId ||
                          (!isOwner(state) && member.role === "owner")
                        }
                        title="Remove teammate?"
                        description={`${member.user.name} will lose access to this workspace.`}
                        label="Remove member"
                        onConfirm={async () => {
                          await account.removeMember(id, member.id);
                          await team.refetch();
                        }}
                      >
                        Remove
                      </Confirm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </Resource>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2>Invite a teammate</h2>
          <p className="text-sm text-muted-foreground">
            Email delivery isn't enabled yet. Copy the invitation link and share
            it with your teammate.
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const invite = await account.invite(id, email.trim(), role);
                if (!invite)
                  throw new Error("The invitation could not be created.");
                setLink(`${location.origin}/invite/${invite.id}`);
                setEmail("");
                await team.refetch();
              }, "Invitation created");
            }}
          >
            <fieldset className="space-y-4" disabled={!editable || busy}>
              <Field label="Email">
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <select
                  className={selectClass}
                  value={role}
                  onChange={(e) => setRole(e.target.value as TeamRole)}
                >
                  {roles.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Button disabled={full}>Create invitation link</Button>
            </fieldset>
            {full && (
              <p className="text-sm text-muted-foreground">
                Member limit reached, including pending invitations.{" "}
                <a href="/app#settings/billing" className="underline">
                  View upgrade options
                </a>
                .
              </p>
            )}
          </form>
          {link && <Code text={link} label="Copy invitation link" />}
        </Card>
        <Card className="p-6">
          <h2>Roles at a glance</h2>
          {Object.entries(roleDescriptions).map(([r, description]) => (
            <div key={r}>
              <Badge variant="secondary" className="capitalize">
                {r}
              </Badge>
              <p className="mt-2 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </Card>
      </div>
      <Card className="p-6">
        <h2>Pending invitations</h2>
        {team.data?.invitations
          .filter((i) => i.status === "pending")
          .map((invite) => (
            <div key={invite.id} className="space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm break-all">
                  {invite.email}{" "}
                  <Badge variant="secondary">{invite.role}</Badge>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expires {new Date(invite.expiresAt).toLocaleString()}
                  </p>
                </div>
                {editable && (
                  <Confirm
                    title="Cancel invitation?"
                    description={`The invitation for ${invite.email} will no longer work.`}
                    label="Cancel invitation"
                    onConfirm={async () => {
                      await account.cancelInvite(invite.id);
                      await team.refetch();
                    }}
                  >
                    Cancel
                  </Confirm>
                )}
              </div>
              {editable && (
                <Code
                  text={`${location.origin}/invite/${invite.id}`}
                  label="Copy invitation link"
                />
              )}
            </div>
          ))}
        {!team.data?.invitations.some((i) => i.status === "pending") && (
          <p className="text-sm text-muted-foreground">
            No pending invitations. Invite someone above to get started.
          </p>
        )}
      </Card>
    </div>
  );
}
export async function enablePush() {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    throw new Error(
      "Push isn't supported here. On iPhone, add Floorwalker to your Home Screen, then enable push from there.",
    );
  if (Notification.permission === "denied")
    throw new Error(
      "Notifications are blocked. Allow them in this site's browser settings, then try again.",
    );
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Notification permission wasn't granted. You can try again when you're ready.",
    );
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  if (!publicKey)
    throw new Error("Push notifications aren't configured on this server yet.");
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    }));
  await api("/api/push/subscribe", "POST", {
    subscription: subscription.toJSON(),
  });
}
function Notifications({ state }: PageProps) {
  const notifications = useResource<NotificationSettings>(
    "/api/me/notifications",
  );
  const slack = useResource<{ configured: boolean; events: string[] }>(
    "/api/settings/slack",
  );
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[] | null>(null);
  const { busy, run } = useTask();
  const preferences = [
    ["push_held", "Payments needing approval"],
    ["push_blocked", "Blocked requests"],
    ["push_reminders", "Approval reminders"],
    ["push_executed", "Executed payments"],
  ] as const;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card className="p-6">
        <div className="flex items-center gap-2">
          <Bell className="size-5" />
          <h2>Your notifications</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Preferences apply to you in this workspace. Devices belong to your
          account.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await enablePush();
              await notifications.refetch();
            }, "Push enabled on this device")
          }
        >
          Enable push on this device
        </Button>
        <Resource query={notifications}>
          <div className="divide-y">
            {notifications.data &&
              preferences.map(([key, label]) => (
                <Toggle
                  key={key}
                  label={label}
                  checked={notifications.data!.prefs[key]}
                  disabled={busy}
                  onChange={(value) =>
                    void run(async () => {
                      await api("/api/me/notifications", "PATCH", {
                        [key]: value,
                      });
                      await notifications.refetch();
                    })
                  }
                />
              ))}
          </div>
          <h3>Registered devices</h3>
          {notifications.data?.devices.map((device) => (
            <div key={device.endpoint} className="space-y-2 border-t pt-4">
              <p className="break-words text-xs">
                {device.user_agent || "Browser device"}
              </p>
              <p className="text-xs text-muted-foreground">
                Added {new Date(device.created_at).toLocaleString()}
              </p>
              <Confirm
                title="Remove this push device?"
                description="This device will stop receiving notifications from your account."
                label="Remove device"
                onConfirm={async () => {
                  await api("/api/push/subscribe", "DELETE", {
                    endpoint: device.endpoint,
                  });
                  const registration =
                    "serviceWorker" in navigator
                      ? await navigator.serviceWorker.getRegistration()
                      : undefined;
                  const subscription =
                    await registration?.pushManager.getSubscription();
                  if (subscription?.endpoint === device.endpoint)
                    await subscription.unsubscribe();
                  await notifications.refetch();
                }}
              >
                Remove device
              </Confirm>
            </div>
          ))}
          {!notifications.data?.devices.length && (
            <p className="text-sm text-muted-foreground">
              No devices yet. Enable push above to receive approvals here.
            </p>
          )}
        </Resource>
      </Card>
      <Card className="p-6">
        <h2>Slack workspace alerts</h2>
        <Resource query={slack}>
          <Badge
            className={slack.data?.configured ? "tone-allow" : "tone-hold"}
          >
            {slack.data?.configured ? "Connected" : "Not connected"}
          </Badge>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/settings/slack", "PUT", {
                  ...(url ? { url } : {}),
                  events: selectedEvents ?? slack.data?.events ?? [],
                });
                setUrl("");
                setSelectedEvents(null);
                await slack.refetch();
              }, "Slack settings saved");
            }}
          >
            <fieldset
              disabled={!canManage(state) || busy}
              className="space-y-5"
            >
              <Field
                label="Incoming webhook URL"
                hint={
                  slack.data?.configured
                    ? "Leave blank to keep your current webhook."
                    : "Create an incoming webhook in Slack, then paste its URL."
                }
              >
                <Input
                  required={!slack.data?.configured}
                  type="password"
                  autoComplete="off"
                  placeholder="https://hooks.slack.com/services/…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <Events
                options={[
                  "action.held",
                  "action.blocked",
                  "action.executed",
                  "action.expired",
                ]}
                value={selectedEvents ?? slack.data?.events ?? []}
                onChange={setSelectedEvents}
              />
              <Button>Save Slack settings</Button>
            </fieldset>
          </form>
          {slack.data?.configured && (
            <Confirm
              disabled={!canManage(state)}
              title="Disconnect Slack?"
              description="Workspace events will no longer be sent to Slack."
              label="Disconnect Slack"
              onConfirm={async () => {
                await api("/api/settings/slack", "DELETE");
                await slack.refetch();
              }}
            >
              Disconnect Slack
            </Confirm>
          )}
        </Resource>
      </Card>
    </div>
  );
}
export function PlanCards({
  plans = publicPlans,
  current,
  disabled,
  onChoose,
}: {
  plans?: Plan[];
  current?: string;
  disabled?: boolean;
  onChoose?: (id: "pro" | "business") => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {plans.map((plan) => (
        <Card
          key={plan.id}
          className={`relative gap-5 p-6 ${plan.id === "pro" ? "border-primary/40 bg-muted" : ""}`}
        >
          <div className="flex items-center justify-between">
            <h3>{plan.name}</h3>
            {current === plan.id && <Badge variant="secondary">Current</Badge>}
          </div>
          <p>
            <strong className="text-4xl tracking-tight">${plan.price}</strong>
            <span className="text-xs text-muted-foreground"> / month</span>
          </p>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li>{count(plan.agents)} agents</li>
            <li>{count(plan.actionsPerMonth)} actions / month</li>
            <li>{count(plan.members)} members</li>
            <li>{count(plan.webhooks)} webhook endpoints</li>
          </ul>
          {onChoose ? (
            plan.id !== "free" && (
              <Button
                variant={plan.id === "pro" ? "default" : "outline"}
                disabled={disabled || current === plan.id}
                onClick={() => onChoose(plan.id as "pro" | "business")}
              >
                {current === plan.id ? "Current plan" : "Choose " + plan.name}
              </Button>
            )
          ) : (
            <Button asChild variant={plan.id === "pro" ? "default" : "outline"}>
              <a href="/signup">Create account</a>
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}
function Billing({ state, refresh }: PageProps) {
  const billing = useResource<BillingData>("/api/billing");
  const { busy, run } = useTask();
  const [reason, setReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const owner = isOwner(state);
  const checkout = (plan: "pro" | "business") =>
    void run(async () => {
      const result = await api<{ approveUrl: string }>(
        "/api/billing/checkout",
        "POST",
        { plan },
      );
      location.assign(result.approveUrl);
    });
  return (
    <Resource query={billing}>
      {billing.data && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg capitalize">{billing.data.plan} plan</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {billing.data.status || "Active"}
                  {billing.data.renews_or_ends_at &&
                    ` · Renews or ends ${new Date(billing.data.renews_or_ends_at).toLocaleDateString()}`}
                </p>
              </div>
              <Badge variant="outline">Monthly billing</Badge>
            </div>
            {state.workspace?.demo && (
              <p className="rounded-lg bg-muted p-3 text-sm">
                Demo: every feature on.{" "}
                <a
                  className="underline"
                  href={state.me?.anonymous ? "/signup" : "/app#setup"}
                >
                  {state.me?.anonymous
                    ? "Create an account to subscribe."
                    : "Switch to your own workspace to subscribe."}
                </a>
              </p>
            )}
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["agents", "agents", "Agents"],
                  [
                    "actions_this_month",
                    "actionsPerMonth",
                    "Actions this month",
                  ],
                  ["members", "members", "Members"],
                  ["webhooks", "webhooks", "Webhooks"],
                ] as const
              ).map(([usageKey, limitKey, label]) => {
                const used = billing.data!.usage[usageKey];
                const limit = billing.data!.limits[limitKey];
                return (
                  <div key={usageKey} className="space-y-3">
                    <div className="flex justify-between gap-2 text-xs">
                      <span>{label}</span>
                      <strong>
                        {used.toLocaleString()} / {count(limit)}
                      </strong>
                    </div>
                    <Progress
                      aria-label={`${label} usage`}
                      value={
                        limit == null
                          ? 0
                          : Math.min(100, (used / Math.max(limit, 1)) * 100)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </Card>
          <PlanCards
            plans={billing.data.plans}
            current={billing.data.plan}
            disabled={
              busy ||
              !owner ||
              state.workspace?.demo ||
              (!!billing.data.subscription_id &&
                !["CANCELLED", "EXPIRED"].includes(billing.data.status))
            }
            onChoose={checkout}
          />
          {!owner && (
            <p className="text-sm text-muted-foreground">
              Only a workspace owner can change billing.
            </p>
          )}
          {billing.data.subscription_id && (
            <Card className="p-6">
              <h2>Subscription</h2>
              <p className="text-sm text-muted-foreground">
                To choose a different plan, cancel the current subscription
                first. PayPal confirms the resulting access period.
              </p>
              <Button
                variant="outline"
                disabled={!owner || busy || billing.data.status === "CANCELLED"}
                onClick={() => setCancelOpen(true)}
              >
                Cancel subscription
              </Button>
            </Card>
          )}
          <Modal
            title="Cancel your subscription?"
            description="Cancel recurring billing. Check the resulting status and end date after PayPal confirms."
            open={cancelOpen}
            onClose={() => !busy && setCancelOpen(false)}
          >
            <Field label="Reason (optional)">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={128}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setCancelOpen(false)}
              >
                Keep subscription
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/api/billing/cancel", "POST", { reason });
                    setCancelOpen(false);
                    await billing.refetch();
                    await refresh();
                  }, "Subscription cancellation confirmed")
                }
              >
                Cancel subscription
              </Button>
            </div>
          </Modal>
        </div>
      )}
    </Resource>
  );
}
function Security({ state }: PageProps) {
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: account.passkeys,
    enabled: !state.me?.anonymous,
  });
  const [name, setName] = useState("");
  const { busy, run } = useTask();
  if (state.me?.anonymous)
    return (
      <Card className="p-6">
        <h2>Keep your workspace</h2>
        <p className="text-sm text-muted-foreground">
          Create an account before adding passkeys or managing sessions.
        </p>
        <Button asChild>
          <a href="/signup">Create account</a>
        </Button>
      </Card>
    );
  return (
    <div className="max-w-3xl space-y-6">
      <Card className="p-6">
        <div className="flex items-center gap-2">
          <Fingerprint />
          <h2>Passkeys</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in and confirm larger approvals using your fingerprint, face or
          security key.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await account.addPasskey(name || "My passkey");
              setName("");
              await passkeys.refetch();
            }, "Passkey added");
          }}
        >
          <Field label="Passkey name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My laptop"
              maxLength={100}
            />
          </Field>
          <Button disabled={busy}>
            <Plus />
            Add passkey
          </Button>
        </form>
        <Resource query={passkeys}>
          {passkeys.data?.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"
            >
              <div>
                <p className="text-sm font-medium">{key.name || "Passkey"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Created{" "}
                  {key.createdAt
                    ? new Date(key.createdAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <Confirm
                title="Delete passkey?"
                description="You will no longer be able to sign in with this passkey. Your password remains available."
                label="Delete passkey"
                onConfirm={async () => {
                  await account.deletePasskey(key.id);
                  await passkeys.refetch();
                }}
              >
                Delete
              </Confirm>
            </div>
          ))}
          {!passkeys.data?.length && (
            <p className="text-sm text-muted-foreground">
              No passkeys yet. Add one above for faster, stronger sign-in.
            </p>
          )}
        </Resource>
      </Card>
      <Card className="p-6">
        <h2>Sessions</h2>
        <p className="text-sm text-muted-foreground">
          Signed in{" "}
          {state.me?.signedInAt
            ? new Date(state.me.signedInAt).toLocaleString()
            : "on this device"}
          . End every other session while keeping this one open.
        </p>
        <Confirm
          title="Sign out other sessions?"
          description="Your other browsers and devices will need to sign in again."
          label="Sign out other sessions"
          onConfirm={() => account.revokeOtherSessions()}
        >
          Sign out other sessions
        </Confirm>
      </Card>
    </div>
  );
}
export function Settings(props: PageProps & { tab?: string }) {
  const tab = settingsTabs.some(([id]) => id === props.tab)
    ? props.tab!
    : new URLSearchParams(location.search).has("billing")
      ? "billing"
      : "general";
  return (
    <div className="space-y-6">
      <PageTabs base="settings" tabs={settingsTabs} value={tab} />
      {isFilm() ? (
        <Card className="p-6">
          <h2>Workspace settings</h2>
          <p className="text-sm text-muted-foreground">
            Account settings are unavailable during filming.
          </p>
        </Card>
      ) : tab === "general" ? (
        <General {...props} />
      ) : tab === "paypal" ? (
        <PayPal {...props} />
      ) : tab === "team" ? (
        <Team {...props} />
      ) : tab === "notifications" ? (
        <Notifications {...props} />
      ) : tab === "billing" ? (
        <Billing {...props} />
      ) : (
        <Security {...props} />
      )}
    </div>
  );
}
