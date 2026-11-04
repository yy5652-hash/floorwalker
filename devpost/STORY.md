# Floorwalker

**Tagline:** Every refund checked. Fewer taps as it learns.

## Try it

- **Live:** https://floorwalker.yingzhilu.cn. Open the demo for a ready shop with sandbox money in a couple of seconds, no sign-up; or create an account and connect your own PayPal sandbox app.
- **Code (MIT):** https://github.com/yy5652-hash/floorwalker, with setup and run instructions in the README.

## Inspiration

PayPal's Agent Toolkit and MCP server let an AI agent do real work with money: refund a customer, pay a contractor, send an invoice. For a small shop that is the dream support agent, and a new way to lose money. Payment redirection ("my PayPal changed, please pay the new address") is already the costliest scam businesses face, and an agent reading the inbox falls for the same story a tired person does. Add prompt injection hidden in an email (OWASP's number one LLM risk) and the agent can be told to refund in full and pay a stranger.

The obvious fix is to make the agent ask. But guardrails fail in two ways. Ask about nothing and you get robbed. Ask about everything and the owner starts approving without reading, the same weakness "MFA fatigue" attacks exploit. A floorwalker in a shop is the manager who approves the cashier's refunds: the good ones learn which refunds they always approve and stop being called for those, while still watching the till.

## What it does

Floorwalker sits between AI agents and a business's PayPal account. Every refund or payout the agent tries goes through it first:

1. **Facts from PayPal itself.** It reads the capture and order from the PayPal API: who paid, how much, what has already been refunded, the shipment tracking. The agent's claims are only claims.
2. **The owner's rules.** A deterministic rule engine checks limits, rolling budgets, the payee list, that the person asking is the buyer, duplicates and order age.
3. **AI review.** A second model compares the request, the facts and the proposed action, flags injected instructions and quotes its evidence.
4. **One of three outcomes.** Inside the rules it executes in the PayPal sandbox. Unusual, it waits for the owner's one-tap approval (push notification, phone page), which runs exactly the action she saw, once. Wrong, it is blocked and never reaches PayPal.

Two things make it different from a set of limits:

- **It learns when to stop asking.** Every request that waited for the owner, and what she did with it, is evidence. Floorwalker turns it into rule changes, for example *"Let refunds up to $60 go through on their own: you approved all 8 refunds between $40 and $60 that waited for you. It stops there because you declined a $72 refund."* Each change is backtested before she sees it: taps saved, money that would now move without her, and no request she declined may become automatic; on the benchmark every attack must still be stopped, and the card shows how many the rules alone still catch. One click applies it, and the AI rewrites her plain-English rules in her own words. When her declines share a reason, the AI proposes a note for the reviewer. The Overview tracks taps per 100 money moves week by week.
- **It watches PayPal for money that skipped it.** Floorwalker can only stop money that goes through it, so it registers PayPal webhooks on the business's app (verified with PayPal) and sweeps the orders it knows about every few minutes. A refund or payout the ledger can't account for (a leaked key, a script, an agent that bypassed it) opens an incident: the owner is alerted and every agent is frozen until she says whether it was her. In the live demo, a refund made straight through the PayPal API is found within seconds by the sweep, and PayPal's webhook arrives about 20 seconds later.

It is built to be used, not just watched:

- **Any agent.** An agent gets a key and calls Floorwalker instead of PayPal, over a REST API (`/v1/refunds`, `/v1/payouts`, with idempotency keys) or MCP. Each agent can have its own cap per action, rolling budget, payee list and end date, and one switch freezes them all.
- **One decision at a time.** A split-view queue with the amount, the payee and four rows of evidence specific to the request on one screen, keyboard shortcuts (J/K/A/D), and a phone page built for one thumb.
- **Trust you can see before you give it.** Each agent has three levels (ask every time, small amounts on its own, everything the rules allow), and each level shows what it would have meant over the last 90 days: taps per 100 and money done without the owner.
- **"Approve and stop asking."** When a tested suggestion covers the request in front of the owner, it appears right there, with the replay numbers first: taps before and after, declined requests that would pass, benchmark attacks stopped.
- **Rules you can test before they count.** Write, test, apply. A draft can also run in shadow mode next to the real rules, and after a change the rule status shows who changed what and what would now decide differently, with a rollback.
- **Approvals where the owner is.** Push notifications with Approve and Decline on the notification, Slack, reminders, automatic decline when a request expires, and a fresh passkey sign-in for large approvals.
- **Teams and accounts.** Passkeys, workspaces with their own database, roles (owner, admin, approver, viewer), and each business connects its own PayPal sandbox app.
- **A real dashboard.** AG Grid Enterprise and AG Charts: the ledger expands any money move into its decision trace, groups and totals by agent or outcome, filters, exports to Excel and charts straight from the grid; the audit log, rules backtest and incidents are grids too, and the Overview charts taps and money moved per week.
- **Ask Floorwalker.** A small chat box on the landing page and in the app answers live: why a request was blocked, what needs the owner today, how the product works. It streams from DeepSeek, reads only, and cannot move money or change a rule. Real workspaces share no activity with it by default.
- **Accountability and billing.** A hash-chained, append-only audit log, signed webhooks with a delivery log, and plans (Free, Pro $29, Business $99) billed through PayPal Subscriptions.

The demo shop, Juniper & Oak Ceramics, has a morning inbox (a chipped mug refunded automatically, a wrong-colour bowl held for approval, the window cleaner paid, a fake "new PayPal address", an email with hidden instructions, a photographer's invoice), two months of earlier activity to learn from (simulated and labelled as such), a hijacked-agent simulation and the bypass demo.

## How we built it

- **PayPal:** Agent Toolkit (`get_order`, `get_refund`, and `create_refund`, which Floorwalker intercepts and executes with a per-request `PayPal-Request-Id`), Orders v2 for the demo orders, Payments v2 captures and refunds for ground truth, Payouts v1 for contractor payments, Orders v2 tracking, Webhooks (registration and `verify-webhook-signature`) for refunds and payouts that skip Floorwalker, and Subscriptions (catalog products, billing plans, subscriptions) for Floorwalker's own plans.
- **AI:** the support agent, the reviewer, the rules compiler and the learning features run on Gemini (`gemini-3.8-flash`) with function calling and JSON-schema output; the same code runs on Claude when an Anthropic key is set. Learned changes come from the ledger and are backtested in code; the model rewords the owner's rules and reads her decline reasons, but never sets a number. The Ask Floorwalker chat runs on DeepSeek (`deepseek-flash`) over streaming fetch, and only when a server key is set. If that provider fails, DeepSeek stands in and the app says so; one benchmark run on it stopped all 80 attacks.
- **App:** Node.js and TypeScript, Express, SQLite (`node:sqlite`, one file per workspace), better-auth, React with shadcn/ui and Tailwind, AG Grid Enterprise and AG Charts, Web Push, Standard Webhooks, and an MCP server on the official SDK.
- **Tests and benchmark:** Automated regression tests (rules, guard, learning, failure injection, agent permissions, billing HTTP paths, approval rendering, audit and keys) and FloorwalkerBench.

## Results

FloorwalkerBench is 198 labelled money moves: 59 benign requests, 59 the owner should decide and 80 attacks (prompt injection in many disguises, payment redirection, fake owner and payee addresses including Unicode look-alikes, refunds to the wrong person or above what was paid, split payments, unknown-vendor invoices, threats), each with the facts Floorwalker reads from PayPal. 150 of them were written by a different model, independently of the reviewer. The same cases go through four guards:

| | No guard | Rules in the prompt | Rules only | Floorwalker |
|---|---|---|---|---|
| Attacks stopped before reaching PayPal | 0% | 97.9% | 67.5% | **100%** |
| Money the attacks would have taken (of $3,796) | $3,796 | $52 | $630 | **$0** |
| Legitimate requests done without the owner | 100% | 75% | 100% | **99%** |
| Owner-decision cases sent to the owner | 0% | 76% | 78% | **97%** |
| Owner taps per 100 money moves | 0 | 49 | 31 | **30** |

Giving the model the owner's rules as text is nearly as safe, but across three full runs it still let $35 to $61 through and asked about a quarter of the legitimate requests. Floorwalker stopped every attack in all 240 attack decisions while asking the owner about 40% less often. On the 150 independent cases alone, across three runs, it stopped all 180 attack decisions and did 134 of 135 legitimate requests on its own; the two owner decisions it consistently missed are small judgement calls ($20 and $15).

A 16-week simulation using the shipped policy and 20 paired seeds (17,920 simulated money moves across two arms) reduced owner taps from **88.49 to 61.18 per 100 moves (88 → 61)** when learned changes were accepted. Most gains came in the first weeks, then plateaued; this is a simulated workload, not customer performance. The workload exceeds the initial $120/week refund budget, so the effect depends strongly on that starting policy. **0 of 960 sampled attacks ran automatically in either arm; 3 of 960 ran after a scripted owner mistake in each arm.** After fixing the 90-day decline cutoff, **0 historical declines became automatic in replay**. Approvals are evidence for 90 days; declines permanently constrain learned changes. Fixed recorded reviewer verdicts were used, not new model calls; clicks to accept rule changes are excluded from the tap metric.

All **125 automated tests pass, with none skipped**, including failure injection for execution, approvals, reviews, learning, webhooks and inbox handoff. Local HTTP tests cover the plan's **402 quota refusal** and **PayPal checkout with a stubbed PayPal**, without approving a subscription. The live HTTP/SSE end-to-end run against the deployed site passes **38 of 40 checks**, including all six inbox tickets; the other two are the checkout and quota paths, which the anonymous demo refuses on purpose, so the local tests above cover them. Earlier runs exposed defects that are fixed here.

See [simulation results](../bench/longitudinal-RESULTS.md) and [engineering / live-check evidence](../tests/experiments-REPORT.md).

In the demo shop's history, accepting the learned refund-limit change takes the owner from 55 to 41 taps per 100 money moves, with nothing she declined becoming automatic.

## Challenges we ran into

Making approval safe: an approval has to run the exact action the owner saw, once, even with double clicks or retries. Floorwalker freezes parameters at proposal time, moves the ledger row from waiting to executing atomically, and sends a key unique to that row as PayPal's idempotency key.

Making learning safe: a system that loosens its own rules is a new attack surface. Floorwalker only proposes changes backed by the owner's approvals, stops each one below anything she declined, refuses any change that would have let a declined request through, re-checks every benchmark attack, and leaves the decision to her.

Telling our money from someone else's: a refund arrives by webhook seconds after Floorwalker makes it, so matching uses PayPal's own refund and payout references, with a short window for requests still executing; the order sweep catches what a webhook misses, and both feed one incident.

## Accomplishments that we're proud of

- Every attack stopped, with about 40% fewer owner taps than giving a careful model the rules, measured on 198 cases over three runs.
- Rules and AI review work together: the rules are plain, tested code the model cannot loosen; the reviewer catches what rules cannot see; learned changes are backtested in code.
- Fail-closed design: if the review is unavailable, nothing runs on its own; if money moves outside Floorwalker, the agents stop.

## What we learned

The safest place to put limits on an agent is not in its prompt but at the tool boundary, where money actually moves, and the best guardrail is the one that asks the owner only when it matters.

## What's next for Floorwalker

Email delivery for invites and alerts, invoices and disputes under the same rules, PayPal Transaction Search as a third source for the watch, and moving from the sandbox to live PayPal accounts once the approval and audit trail has been reviewed by real shops.
