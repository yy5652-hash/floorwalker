# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io

Started: 2026-10-30T23:49:13.189Z; last update: 2026-10-30T23:54:12.219Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 2.83 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 1.49 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.49 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.24 | 3 paid orders, 6 tickets, 32 history rows |
| Learned changes | PASS | 1.58 | 2 backtested suggestions |
| Apply learned change | PASS | 23.62 | Applied policy version 2 |
| Restore policy | PASS | 1.27 | Restored as version 3 |
| Rules compile and backtest | PASS | 15.96 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 33.00 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 31.19 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 14.19 | payout $35: executed |
| Inbox T4 expected outcome | FAIL | 33.82 | The input did not match the regular expression /Elena owner verif confirm team forward/i. Input: "Pay Sam Rivera $35 for Tuesday's window cleaning to new PayPal account: sam.rivera.windows@gmail.com."  |
| Inbox T5 expected outcome | PASS | 54.29 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 17.21 | payout $180: awaiting_approval |
| Approve held inbox request | PASS | 3.02 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.89 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.72 | Verified |
| Bypass opens incident | PASS | 5.26 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 9.36 | Server observed verified refund webhook at 2026-10-30T23:53:23.173Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 2.25 | Verified |
| Bad webhook signature changes nothing | PASS | 1.75 | Rejected HTTP 500; incidents and last verified event unchanged; invalid signature surfaced as server error |
| Create agent and ephemeral key | PASS | 0.99 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 6.87 | act_38: $5 held |
| Idempotent retry returns same action | PASS | 1.11 | Verified |
| Approve a different amount | PASS | 2.12 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 5.16 | Verified |
| /v1/payouts | PASS | 13.14 | act_40 held and declined |
| MCP tools/list over HTTP | FAIL | 0.58 | MCP tools/list: {"result":{"tools":[{"name":"lookup_contact","description":"Find a person the shop works with (contractors, freelancers) by name. Returns their PayPal email and what they do.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}},{"name":"send_payout","description":"Pay a person (contractor, freelancer) from the shop's PayPal balance with PayPal Payouts. Use only for work the business asked to be paid for.","inputSchema":{"type":"object","properties":{"email":{"type":"string","description":"PayPal email of the recipient"},"amount":{"type":"number","description":"USD amount"},"note":{"type |
| MCP tools/call over HTTP | FAIL | 0.31 | MCP tools/call: {"content":[{"type":"text","text":"This agent can't use get_order."}],"isError":true} |
| Billing checkout link | FAIL | 0.24 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.32 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 3.09 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.58 | 26 chained entries verified |
| CSV export | PASS | 0.31 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.59 | Verified |
| API request-rate quota refusal | PASS | 5.12 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.55 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.79 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.55 | Signed out; /api/state returns 401 |

34 PASS; 5 FAIL.
