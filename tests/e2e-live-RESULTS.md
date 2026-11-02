# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io; mode: full

Started: 2026-11-02T20:53:33.174Z; last update: 2026-11-02T20:56:29.461Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 2.15 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 1.20 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.41 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.24 | 4 paid orders, 7 tickets, 32 history rows |
| Learned changes | PASS | 1.15 | 2 backtested suggestions |
| Apply learned change | PASS | 1.97 | Applied policy version 2 |
| Restore policy | PASS | 0.49 | Restored as version 3 |
| Rules compile and backtest | PASS | 2.54 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 13.86 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 12.20 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 7.98 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 0.60 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 15.71 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 6.41 | payout $180: awaiting_approval |
| Inbox T7 expected outcome | PASS | 10.99 | refund $52: awaiting_approval |
| Approve held inbox request | PASS | 4.49 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.78 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.46 | Verified |
| Bypass opens incident | PASS | 7.17 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 51.92 | Server observed verified refund webhook at 2026-11-02T20:55:56.018Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 2.04 | Verified |
| Bad webhook signature changes nothing | PASS | 1.72 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.87 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 5.03 | act_39: $5 held |
| Idempotent retry returns same action | PASS | 0.97 | Verified |
| Approve a different amount | PASS | 2.03 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 2.08 | Verified |
| Agent permission patch preserves other permissions | PASS | 0.50 | Existing refund permission preserved |
| /v1/payouts | PASS | 2.83 | act_41 held and declined |
| MCP tools/list over HTTP | PASS | 0.49 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.71 | Verified |
| Billing checkout link | FAIL | 0.23 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.24 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 3.00 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.61 | 28 chained entries verified |
| CSV export | PASS | 0.24 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.74 | Verified |
| API request-rate quota refusal | PASS | 4.42 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.56 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.74 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.48 | Signed out; /api/state returns 401 |

39 PASS; 2 FAIL.
