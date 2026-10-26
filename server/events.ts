import { randomUUID } from "node:crypto";
import { ctx, type Workspace } from "./context.ts";

export const EVENT_TYPES = [
  "action.executed", "action.held", "action.blocked", "action.approved", "action.declined", "action.expired", "action.failed",
  "agent.frozen", "agent.unfrozen", "rules.updated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type AllowanceEvent = { id: string; type: EventType; workspace_id: string; created_at: string; data: unknown };
type Listener = (e: AllowanceEvent, ws: Workspace) => unknown;

const listeners: Listener[] = [];

/** Webhooks, push notifications and Slack subscribe here. */
export function subscribe(l: Listener) {
  listeners.push(l);
}

/** Tells every subscriber; a failing subscriber never affects the money path. */
export function publish(type: EventType, data: unknown) {
  const { ws } = ctx();
  const e: AllowanceEvent = { id: `evt_${randomUUID().replaceAll("-", "")}`, type, workspace_id: ws.id, created_at: new Date().toISOString(), data };
  for (const l of listeners) {
    try {
      Promise.resolve(l(e, ws)).catch((err) => console.error(`event ${type}: ${err?.message ?? err}`));
    } catch (err: any) {
      console.error(`event ${type}: ${err?.message ?? err}`);
    }
  }
}
