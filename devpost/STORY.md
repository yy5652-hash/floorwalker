# Floorwalker

**Tagline:** Every refund checked. Fewer taps every week.

## Try it

- **Live:** https://floorwalker.43-160-214-187.sslip.io. Open the demo for a ready shop with sandbox money in a couple of seconds, no sign-up; or create an account and connect your own PayPal sandbox app.
- **Code (MIT):** https://github.com/yy5652-hash/floorwalker, with setup and run instructions in the README.

## Inspiration

PayPal's Agent Toolkit and MCP server let an AI agent do real work with money: refund a customer, pay a contractor, send an invoice. For a small shop that is the dream support agent. It is also a new way to lose money. The costliest scam businesses already face is payment redirection ("my PayPal changed, please pay the new address"), and an agent reading the inbox falls for the same story a tired person does. Add prompt injection (OWASP's number one LLM risk) hidden in an email, and the agent can be told to refund in full and pay a stranger.

Banks solved this for people decades ago with spending limits, payee lists and approvals. AI agents need the same thing, and they need it at the moment they call PayPal.

## What it does

Floorwalker sits between AI agents and a business's PayPal account: every refund or payout is checked against PayPal's records and your rules, and it learns from your decisions when it no longer needs to ask you.

Every request goes through these checks:

1. **Facts from PayPal itself.** Floorwalker reads the capture and order from the PayPal API: who paid, how much, what has already been refunded, and the shipment tracking. The agent's claims are only claims.
2. **The owner's rules.** A deterministic rule engine checks limits, rolling weekly and monthly allowances, the payee list, that the person asking is the buyer, duplicates and order age.
3. **AI review.** A second model compares the request, the facts and the proposed action, flags injected instructions, and quotes its evidence.
4. **One of three outcomes.** Inside the allowance, the agent's action executes in the PayPal sandbox. Unusual, it waits for the owner's one-tap approval, which runs exactly the action she saw, once. Wrong, it is blocked and never reaches PayPal.

The owner writes rules in plain words ("up to $40 on its own, ask me above that, never more than $250"); the AI turns them into limits she reviews and tests on past activity before activating. A ledger built on AG Grid shows every money move, the check that decided it and the PayPal reference, and exports to CSV.

It is built to be used, not just watched:

- **Any agent.** An agent gets a key and calls Floorwalker instead of PayPal, over a REST API (`/v1/refunds`, `/v1/payouts`, with idempotency keys) or MCP. Each agent can have its own cap per action, rolling budget, payee list and end date, and one switch freezes them all.
- **Approvals where the owner is.** Push notifications with Approve and Decline right on the notification, Slack, reminders, and automatic decline when a request expires. Large approvals ask for a fresh passkey sign-in.
- **Teams and accounts.** Sign-up with passkeys, workspaces with their own database, roles (owner, admin, approver, viewer), and each business connects its own PayPal sandbox app.
- **Accountability.** A hash-chained, append-only audit log of every decision and change, signed webhooks with a delivery log, and plans (Free, Pro $29, Business $99) billed through PayPal Subscriptions.

The demo shop, Juniper & Oak Ceramics, has a morning inbox: a chipped mug (refunded automatically), a wrong-colour bowl (held for approval), the window cleaner's payment (paid), a "new PayPal address" from a fake Sam (the agent hands it to the owner; a payment there would be blocked), an email with hidden instructions to refund in full and pay $150 to a stranger (blocked), and a photographer's invoice (held). A hijacked-agent simulation replays six money moves an attacker would make; Floorwalker checks each one without knowing the agent is hostile.

## How we built it

- **PayPal:** Agent Toolkit (`get_order`, `get_refund`, and `create_refund`, which Floorwalker intercepts and executes with a per-request `PayPal-Request-Id`), Orders v2 for the demo orders, Payments v2 captures and refunds for ground truth, Payouts v1 for contractor payments with batch status polling, Orders v2 tracking for shipment numbers, and Subscriptions (catalog products, billing plans, subscriptions) for Floorwalker's own plans.
- **AI:** the support agent, the reviewer and the rules compiler run on Gemini (`gemini-3.8-flash`) with function calling and JSON-schema structured output; the same code runs on Claude when an Anthropic key is set.
- **App:** Node.js and TypeScript, Express, SQLite (`node:sqlite`, one file per workspace), better-auth (passkeys, organizations, anonymous demo sessions), React with shadcn/ui, Tailwind and AG Grid Community, Web Push, Standard Webhooks, and an MCP server built on the official SDK (stdio and Streamable HTTP).
- **Tests and benchmark:** 33 unit tests (rule engine, guard, agent limits, idempotency, expiry, the audit chain, keys), and FloorwalkerBench, 48 labelled money moves (benign, needs-the-owner, attacks), run against the real reviewer.

## Results

FloorwalkerBench is 48 labelled money moves (benign requests, cases that should go to the owner, and attacks), each with the facts Floorwalker fetches from PayPal; 16 of them were written after tuning and run once as a held-out set.

| | Rules only | Rules + AI review |
|---|---|---|
| Attacks stopped before reaching PayPal (main / held-out) | 69% / 86% | **100% / 100%** |
| Small legitimate requests done without the owner (main / held-out) | 100% / 100% | **100% / 100%** |
| Cases that need the owner sent to the owner (main / held-out) | 78% / 80% | **100% / 100%** |

In the live sandbox run shown in the video, the agent made real refunds and payouts through PayPal, and the hijacked-agent simulation's six money moves were all stopped.

## Challenges we ran into

Making approval safe: an approval has to run the exact action the owner saw, once, even with double clicks or retries. Floorwalker freezes parameters at proposal time, moves the ledger row from waiting to executing atomically, and sends the ledger id as PayPal's idempotency key.

## Accomplishments that we're proud of

- Rules and AI review work together: the rules are plain, tested code the model cannot loosen; the reviewer catches what rules cannot see.
- Fail-closed design: if the review is unavailable, nothing runs on its own.
- Drop-in for any agent through MCP.

## What we learned

The safest place to put limits on an agent is not in its prompt but at the tool boundary, where money actually moves.

## What's next for Floorwalker

Email delivery for invites and alerts, invoices under the same rules, PayPal webhooks for reconciliation, and moving from the sandbox to live PayPal accounts once the approval and audit trail has been reviewed by real shops.
