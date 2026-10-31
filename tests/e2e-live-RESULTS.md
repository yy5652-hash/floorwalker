# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io; mode: full

Started: 2026-10-31T02:49:57.239Z; last update: 2026-10-31T02:53:33.711Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 2.25 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 1.50 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.51 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.25 | 3 paid orders, 6 tickets, 32 history rows |
| Learned changes | PASS | 1.61 | 2 backtested suggestions |
| Apply learned change | PASS | 7.24 | Applied policy version 2 |
| Restore policy | PASS | 0.99 | Restored as version 3 |
| Rules compile and backtest | PASS | 23.42 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 17.72 | refund $24: executed |
| Inbox T2 expected outcome | FAIL | 21.00 | Expected refund $86 awaiting_approval; observed refund $96 awaiting_approval |
| Inbox T3 expected outcome | PASS | 15.50 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 0.71 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 30.14 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 18.30 | payout $180: awaiting_approval |
| Approve held inbox request | PASS | 2.97 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.81 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.69 | Verified |
| Bypass opens incident | PASS | 7.21 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 7.30 | Server observed verified refund webhook at 2026-10-31T02:52:37.370Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 2.24 | Verified |
| Bad webhook signature changes nothing | PASS | 1.91 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.97 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 9.95 | act_38: $5 held |
| Idempotent retry returns same action | PASS | 1.27 | Verified |
| Approve a different amount | PASS | 2.52 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 5.13 | Verified |
| Agent permission patch preserves other permissions | PASS | 1.05 | Existing refund permission preserved |
| /v1/payouts | PASS | 13.38 | act_40 held and declined |
| MCP tools/list over HTTP | PASS | 0.58 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.52 | Verified |
| Billing checkout link | FAIL | 0.25 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.32 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 3.07 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.56 | 27 chained entries verified |
| CSV export | PASS | 0.32 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.79 | Verified |
| API request-rate quota refusal | PASS | 6.49 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.56 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.89 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.57 | Signed out; /api/state returns 401 |

37 PASS; 3 FAIL.
