import { createAuthClient } from "better-auth/react";
import {
  anonymousClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  ownerAc,
  adminAc,
} from "better-auth/plugins/organization/access";
import { passkeyClient } from "@better-auth/passkey/client";

// better-auth / @better-auth/passkey 1.7.14: installed client declarations and
// https://better-auth.com/docs/plugins/{organization,anonymous,passkey}
export const isFilm = () =>
  typeof window !== "undefined" &&
  (window as Window & { __film?: unknown }).__film !== undefined;
const ac = createAccessControl({
  ...defaultStatements,
  ledger: ["approve"],
  rules: ["update"],
  agents: ["manage"],
  developers: ["manage"],
  billing: ["manage"],
} as const);
const operate = {
  ledger: ["approve"],
  rules: ["update"],
  agents: ["manage"],
  developers: ["manage"],
} as const;
const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...operate, billing: ["manage"] }),
  admin: ac.newRole({ ...adminAc.statements, ...operate }),
  approver: ac.newRole({ ledger: ["approve"] }),
  viewer: ac.newRole({}),
};
const makeClient = () =>
  createAuthClient({
    plugins: [
      organizationClient({ ac, roles }),
      anonymousClient(),
      passkeyClient(),
    ],
  });
let client: ReturnType<typeof makeClient> | undefined;
function authClient() {
  if (isFilm())
    throw new Error("Account changes are unavailable during filming.");
  return (client ??= makeClient());
}
async function checked<T>(
  request: Promise<{
    data: T;
    error: { message?: string; status?: number; code?: string } | null;
  }>,
) {
  const result = await request;
  if (result.error) {
    if (
      result.error.status === 402 ||
      result.error.code?.includes("MEMBERSHIP_LIMIT")
    )
      window.dispatchEvent(
        new CustomEvent("allowance:upgrade", { detail: result.error.message }),
      );
    throw new Error(
      result.error.message || "The account request failed. Please try again.",
    );
  }
  return result.data;
}
export type TeamRole = "owner" | "admin" | "approver" | "viewer";
export const account = {
  session: () =>
    isFilm() ? Promise.resolve(null) : checked(authClient().getSession()),
  signIn: (email: string, password: string) =>
    checked(authClient().signIn.email({ email, password })),
  signUp: (name: string, email: string, password: string) =>
    checked(authClient().signUp.email({ name, email, password })),
  passkeySignIn: () => checked(authClient().signIn.passkey()),
  signOut: () => checked(authClient().signOut()),
  organizations: () =>
    isFilm() ? Promise.resolve([]) : checked(authClient().organization.list()),
  setActive: (organizationId: string) =>
    checked(authClient().organization.setActive({ organizationId })),
  createWorkspace: (name: string, slug: string) =>
    checked(authClient().organization.create({ name, slug })),
  rename: (organizationId: string, name: string) =>
    checked(
      authClient().organization.update({ organizationId, data: { name } }),
    ),
  team: (organizationId: string) =>
    checked(
      authClient().organization.getFullOrganization({
        query: { organizationId },
      }),
    ),
  invitation: (id: string) =>
    checked(authClient().organization.getInvitation({ query: { id } })),
  accept: (invitationId: string) =>
    checked(authClient().organization.acceptInvitation({ invitationId })),
  invite: (organizationId: string, email: string, role: TeamRole) =>
    checked(
      authClient().organization.inviteMember({ organizationId, email, role }),
    ),
  cancelInvite: (invitationId: string) =>
    checked(authClient().organization.cancelInvitation({ invitationId })),
  changeRole: (organizationId: string, memberId: string, role: TeamRole) =>
    checked(
      authClient().organization.updateMemberRole({
        organizationId,
        memberId,
        role,
      }),
    ),
  removeMember: (organizationId: string, memberIdOrEmail: string) =>
    checked(
      authClient().organization.removeMember({
        organizationId,
        memberIdOrEmail,
      }),
    ),
  passkeys: () => checked(authClient().passkey.listUserPasskeys()),
  addPasskey: (name = "My passkey") =>
    checked(authClient().passkey.addPasskey({ name })),
  deletePasskey: (id: string) =>
    checked(authClient().passkey.deletePasskey({ id })),
  revokeOtherSessions: () => checked(authClient().revokeOtherSessions()),
};
export async function startDemo() {
  if (!isFilm()) {
    const session = await account.session();
    if (!session) await checked(authClient().signIn.anonymous());
  }
  location.assign("/app");
}
export function safeNext(
  value = new URLSearchParams(location.search).get("next"),
) {
  if (!value) return "/app";
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin &&
      !["/signin", "/signup"].includes(url.pathname)
      ? url.pathname + url.search + url.hash
      : "/app";
  } catch {
    return "/app";
  }
}
