import { config } from "./config.ts";
import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import { auth, can, latestWorkspaceOf, type Permission } from "./auth.ts";
import { inWorkspace } from "./context.ts";
import { core, openWorkspace, workspaceRow } from "./workspaces.ts";

export type Me = {
  userId: string;
  name: string;
  email: string;
  role: string;
  anonymous: boolean;
  workspaceId: string;
  sessionId: string;
  /** When this session signed in; a recent passkey sign-in counts as step-up for large approvals. */
  signedInAt: number;
  /** One of the server's operators (FLOORWALKER_ADMIN_EMAILS): sees the sign-in statistics. */
  admin?: boolean;
};

declare global {
  namespace Express {
    interface Request {
      me?: Me;
    }
  }
}

/** Resolves the signed-in person and their active workspace; everything after runs inside that workspace. */
export async function signedIn(req: Request, res: Response, next: NextFunction) {
  const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!s) return void res.status(401).json({ error: "Sign in to continue.", code: "signin" });
  const roleIn = (id: string | null | undefined) =>
    id ? (core.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?").get(id, s.user.id) as { role: string } | undefined) : undefined;
  // A notification action names its workspace, which may not be the one this browser has open.
  const named = req.header("x-workspace");
  let wsId: string | null = named || s.session.activeOrganizationId || null;
  let member = roleIn(wsId);
  if (named && (!member || !workspaceRow(named))) return void res.status(403).json({ error: "You're not a member of that workspace.", code: "forbidden" });
  if (!member || !workspaceRow(wsId!)) {
    // A session started before its workspace existed (sign-up), or one whose workspace was left: open the latest one.
    wsId = latestWorkspaceOf(s.user.id);
    member = roleIn(wsId);
    if (!wsId || !member) return void res.status(409).json({ error: "You're not in a workspace yet.", code: "workspace" });
    if (wsId) core.prepare("UPDATE session SET activeOrganizationId = ? WHERE id = ?").run(wsId, s.session.id);
  }
  if (!wsId || !member) return void res.status(409).json({ error: "You're not in a workspace yet.", code: "workspace" });
  const name = s.user.name || s.user.email;
  req.me = {
    userId: s.user.id,
    name,
    email: s.user.email,
    role: member.role,
    anonymous: Boolean((s.user as any).isAnonymous),
    workspaceId: wsId,
    sessionId: s.session.id,
    signedInAt: new Date(s.session.createdAt).getTime(),
    admin: !(s.user as any).isAnonymous && config.adminEmails.includes(s.user.email.toLowerCase()),
  };
  inWorkspace(openWorkspace(wsId), { kind: "user", id: s.user.id, name, role: member.role, ip: req.ip }, () => next());
}

/** Lets the request through only if the member's role grants the permission. */
export const need = (permission: Permission) => (req: Request, res: Response, next: NextFunction) => {
  if (can(req.me?.role, permission)) return next();
  res.status(403).json({ error: "Your role doesn't allow this. Ask an owner or admin of this workspace.", code: "forbidden" });
};

/** Turns a thrown error into a 400 with its message (the messages are written for the owner). */
export const handle = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e: any) {
    if (!res.headersSent) res.status(e.status ?? 400).json({ error: e.message, code: e.code });
  }
};

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}
