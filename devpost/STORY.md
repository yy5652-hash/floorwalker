# Allowance

**Tagline:** Give your AI agent an allowance, not your wallet.

## Inspiration

PayPal's Agent Toolkit and MCP server let an AI agent do real work with money: refund a customer, pay a contractor, send an invoice. For a small shop that is the dream support agent. It is also a new way to lose money. The costliest scam businesses already face is payment redirection ("my PayPal changed, please pay the new address"), and an agent reading the inbox falls for the same story a tired person does. Add prompt injection (OWASP's number one LLM risk) hidden in an email, and the agent can be told to refund in full and pay a stranger.

Banks solved this for people decades ago with spending limits, payee lists and approvals. AI agents need the same thing, and they need it at the moment they call PayPal.

## What it does

Allowance sits between an AI agent and a business's PayPal account. Every refund or payout the agent tries goes through it first:

1. **Facts from PayPal itself.** Allowance reads the capture and order from the PayPal API: who paid, how much, what has already been refunded, and the shipment tracking. The agent's claims are only claims.
2. **The owner's rules.** A deterministic rule engine checks limits, rolling weekly and monthly allowances, the payee list, that the person asking is the buyer, duplicates and order age.
3. **AI review.** A second model compares the request, the facts and the proposed action, flags injected instructions, and quotes its evidence.
4. **One of three outcomes.** Inside the allowance, the agent's action executes in the PayPal sandbox. Unusual, it waits for the owner's one-tap approval, which runs exactly the action she saw, once. Wrong, it is blocked and never reaches PayPal.

The owner writes rules in plain words ("up to $40 on its own, ask me above that, never more than $250"); the AI turns them into limits she reviews before activating. A ledger built on AG Grid shows every money move, the check that decided it and the PayPal reference, and exports to CSV. The same guarded tools are available over MCP, so any agent (Claude Desktop, Claude Code, a custom framework) can use PayPal under the owner's rules.

The demo shop, Juniper & Oak Ceramics, has a morning inbox: a chipped mug (refunded automatically), a wrong-colour bowl (held for approval), the window cleaner's payment (paid), a "new PayPal address" from a fake Sam (blocked), an email with hidden instructions to refund in full and pay $150 to a stranger (blocked), and a photographer's invoice (held). A hijacked-agent simulation replays six money moves an attacker would make; Allowance checks each one without knowing the agent is hostile.

## How we built it

- **PayPal:** Agent Toolkit (`get_order`, `get_shipment_tracking`, `get_refund`, and `create_refund`, which Allowance intercepts and executes with the ledger id as `PayPal-Request-Id`), Orders v2 for the demo orders, Payments v2 captures and refunds for ground truth, Payouts v1 for contractor payments with batch status polling, and Shipment Tracking.
- **AI:** the support agent, the reviewer and the rules compiler run on Gemini (`gemini-3.8-flash`) with function calling and JSON-schema structured output; the same code runs on Claude when an Anthropic key is set.
- **App:** Node.js and TypeScript, Express, SQLite (`node:sqlite`), React with AG Grid Community, and an MCP server built on the official SDK.
- **Tests and benchmark:** unit tests for the rule engine and the guard, and AllowanceBench, 32 labelled money moves (benign, needs-the-owner, attacks), run against the real reviewer.

## Challenges we ran into

Making approval safe: an approval has to run the exact action the owner saw, once, even with double clicks or retries. Allowance freezes parameters at proposal time, moves the ledger row from waiting to executing atomically, and sends the ledger id as PayPal's idempotency key.

## Accomplishments that we're proud of

- Rules and AI review work together: the rules are plain, tested code the model cannot loosen; the reviewer catches what rules cannot see.
- Fail-closed design: if the review is unavailable, nothing runs on its own.
- Drop-in for any agent through MCP.

## What we learned

The safest place to put limits on an agent is not in its prompt but at the tool boundary, where money actually moves.

## What's next for Allowance

Per-agent allowances for teams of agents, webhook-driven reconciliation, invoices and subscriptions under the same rules, and a mobile approval flow.
