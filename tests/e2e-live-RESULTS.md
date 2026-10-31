# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io; mode: full

Started: 2026-10-31T02:57:41.768Z; last update: 2026-10-31T03:01:55.268Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 3.13 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 1.75 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.51 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.40 | 3 paid orders, 6 tickets, 32 history rows |
| Learned changes | PASS | 1.54 | 2 backtested suggestions |
| Apply learned change | PASS | 25.39 | Applied policy version 2 |
| Restore policy | PASS | 1.13 | Restored as version 3 |
| Rules compile and backtest | PASS | 21.76 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 18.40 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 27.10 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 14.28 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 1.00 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 33.53 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 30.28 | payout $180: awaiting_approval |
| Approve held inbox request | PASS | 4.22 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.85 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.59 | Verified |
| Bypass opens incident | PASS | 7.17 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 7.04 | Server observed verified refund webhook at 2026-10-31T03:01:02.706Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 1.67 | Verified |
| Bad webhook signature changes nothing | PASS | 1.46 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.73 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 8.31 | act_38: $5 held |
| Idempotent retry returns same action | PASS | 1.21 | Verified |
| Approve a different amount | PASS | 2.27 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 6.49 | Verified |
| Agent permission patch preserves other permissions | PASS | 0.96 | Existing refund permission preserved |
| /v1/payouts | PASS | 13.36 | act_40 held and declined |
| MCP tools/list over HTTP | PASS | 0.68 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.64 | Verified |
| Billing checkout link | FAIL | 0.41 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.23 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 3.28 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.57 | 27 chained entries verified |
| CSV export | PASS | 0.24 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 2.23 | Verified |
| API request-rate quota refusal | PASS | 4.51 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.71 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.81 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.61 | Signed out; /api/state returns 401 |

38 PASS; 2 FAIL.
