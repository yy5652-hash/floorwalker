import { createAuthClient } from "better-auth/react";
import {
  anonymousClient,
  emailOTPClient,
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
      emailOTPClient(),
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
        new CustomEvent("floorwalker:upgrade", { detail: result.error.message }),
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
  signIn: (email: string, password: string, keepSignedIn = true) =>
    authRequest("/api/auth/sign-in/email", { email, password, keepSignedIn }),
  sendCode: (email: string, type = "sign-in", keepSignedIn = true) => authRequest("/api/auth/email-otp/send-verification-otp", { email, type, keepSignedIn }),
  verifyCode: (email: string, otp: string, keepSignedIn = true) => authRequest("/api/auth/sign-in/email-otp", { email, otp, keepSignedIn }),
  resetPassword: (email: string, otp: string, password: string) => authRequest("/api/auth/email-otp/reset-password", { email, otp, password }),
  setPassword: (newPassword: string) => authRequest("/api/account/set-password", { newPassword }),
  changePassword: (currentPassword: string, newPassword: string) => checked(authClient().changePassword({ currentPassword, newPassword, revokeOtherSessions: true })),
  sendEmailChange: (newEmail: string) => checked(authClient().emailOtp.requestEmailChange({ newEmail })),
  changeEmail: (newEmail: string, otp: string) => checked(authClient().emailOtp.changeEmail({ newEmail, otp })),
  signUp: (name: string, email: string, password: string) =>
    checked(authClient().signUp.email({ name, email, password })),
  passkeySignIn: (keepSignedIn = true) => checked(authClient().signIn.passkey({ fetchOptions: { headers: { "x-floorwalker-keep-signed-in": String(keepSignedIn) } } })),
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
  sessions: () => checked(authClient().listSessions()),
  revokeSession: (token: string) => checked(authClient().revokeSession({ token })),
  hasPassword: async () => (await checked(authClient().listAccounts()))?.some((a) => a.providerId === "credential") ?? false,
  deleteUser: (password?: string) => checked(authClient().deleteUser({ password })),
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

async function authRequest(path: string, body: object) {
  if (isFilm()) throw new Error("Account changes are unavailable during filming.");
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-floorwalker-next": safeNext(), "x-floorwalker-keep-signed-in": String((body as { keepSignedIn?: boolean }).keepSignedIn !== false) }, body: JSON.stringify(body) });
  const data = await response.json();
  if (response.status === 429) throw new Error("Too many attempts. Wait a minute and try again.");
  if (!response.ok) throw new Error(data.message || data.error || "The account request failed.");
  return data;
}
export function rememberEmail(email: string) { try { localStorage.setItem("floorwalker:last-email", email); } catch {} }
export function lastEmail() { try { return localStorage.getItem("floorwalker:last-email") || ""; } catch { return ""; } }
