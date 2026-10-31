# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io; mode: full

Started: 2026-10-31T00:21:00.282Z; last update: 2026-10-31T00:26:38.949Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 2.55 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 1.19 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.47 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.25 | 3 paid orders, 6 tickets, 32 history rows |
| Learned changes | PASS | 1.47 | 2 backtested suggestions |
| Apply learned change | PASS | 13.77 | Applied policy version 2 |
| Restore policy | PASS | 1.20 | Restored as version 3 |
| Rules compile and backtest | PASS | 18.37 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 32.01 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 52.80 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 13.36 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 1.00 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 102.56 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 25.24 | payout $180: awaiting_approval |
| Approve held inbox request | PASS | 3.28 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.96 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.93 | Verified |
| Bypass opens incident | PASS | 7.37 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 9.68 | Server observed verified refund webhook at 2026-10-31T00:25:48.053Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 2.29 | Verified |
| Bad webhook signature changes nothing | PASS | 1.72 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.98 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 8.11 | act_38: $5 held |
| Idempotent retry returns same action | PASS | 1.03 | Verified |
| Approve a different amount | PASS | 2.13 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 6.05 | Verified |
| Agent permission patch preserves other permissions | PASS | 1.05 | Existing refund permission preserved |
| /v1/payouts | PASS | 10.82 | act_40 held and declined |
| MCP tools/list over HTTP | PASS | 0.58 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.55 | Verified |
| Billing checkout link | FAIL | 0.25 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.33 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 3.09 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.59 | 27 chained entries verified |
| CSV export | PASS | 0.33 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.74 | Verified |
| API request-rate quota refusal | PASS | 4.56 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.56 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.81 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.57 | Signed out; /api/state returns 401 |

38 PASS; 2 FAIL.
