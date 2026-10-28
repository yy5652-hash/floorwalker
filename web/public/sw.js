/* Push only: authenticated workspace data is never cached for offline use. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

function safeUrl(value, workspaceId, ledgerId) {
  let url;
  try {
    url = new URL(value || "/approve", self.location.origin);
  } catch {
    url = new URL("/approve", self.location.origin);
  }
  if (url.origin !== self.location.origin)
    url = new URL("/approve", self.location.origin);
  if (workspaceId) url.searchParams.set("ws", workspaceId);
  if (ledgerId != null) url.hash = String(ledgerId).replace(/^act_/, "");
  return url.href;
}
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = { body: event.data?.text() };
  }
  const actions = Array.isArray(payload.actions)
    ? payload.actions
        .filter((action) => ["approve", "decline", "open"].includes(action))
        .map((action) => ({
          action,
          title: { approve: "Approve", decline: "Decline", open: "Open" }[
            action
          ],
        }))
    : [];
  event.waitUntil(
    self.registration.showNotification(payload.title || "Floorwalker", {
      body: payload.body || "You have a workspace update.",
      tag: payload.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      actions,
      data: {
        url: safeUrl(payload.url, payload.workspaceId, payload.ledgerId),
        workspaceId: payload.workspaceId,
        ledgerId: payload.ledgerId,
        actions: actions.map((a) => a.action),
      },
    }),
  );
});
async function openPage(url) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const existing = windows.find((client) => client.url === url);
  if (existing) return existing.focus();
  return self.clients.openWindow(url);
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action;
  const url = safeUrl(data.url, data.workspaceId, data.ledgerId);
  event.waitUntil(
    (async () => {
      const id = String(data.ledgerId ?? "").replace(/^act_/, "");
      if (
        !["approve", "decline"].includes(action) ||
        !data.actions?.includes(action) ||
        !/^\d+$/.test(id) ||
        !data.workspaceId
      ) {
        await openPage(url);
        return;
      }
      try {
        const response = await fetch(`/api/ledger/${id}/${action}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "x-workspace": data.workspaceId,
          },
          body: "{}",
        });
        const result = await response.json();
        const failed = !response.ok || result.status === "failed";
        const title = failed
          ? result.code === "step_up"
            ? "Confirm with your passkey"
            : "Action needs your attention"
          : action === "approve"
            ? result.status === "executing"
              ? "Processing in PayPal"
              : "Approved"
            : "Declined";
        await self.registration.showNotification(title, {
          body: failed
            ? result.error || "Open Floorwalker to continue."
            : `Request #${id} · ${action === "approve" ? "Your decision was recorded." : "No payment was made."}`,
          icon: "/icon-192.png",
          tag: `decision-${data.workspaceId}-${id}`,
          data: {
            url,
            workspaceId: data.workspaceId,
            ledgerId: id,
            actions: ["open"],
          },
        });
        for (const client of await self.clients.matchAll({ type: "window" }))
          client.postMessage({
            type: "floorwalker:refresh",
            workspaceId: data.workspaceId,
          });
        if (failed) await openPage(url);
      } catch {
        await self.registration.showNotification(
          "Couldn't confirm your decision",
          {
            body: "Open Floorwalker to check the current request status before trying again.",
            icon: "/icon-192.png",
            data: { url, actions: ["open"] },
          },
        );
        await openPage(url);
      }
    })(),
  );
});
