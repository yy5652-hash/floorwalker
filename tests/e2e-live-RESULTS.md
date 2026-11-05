# Live end-to-end results

Target: https://floorwalker.yingzhilu.cn; mode: full

Started: 2026-11-05T18:07:04.957Z; last update: 2026-11-05T18:09:17.330Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 1.97 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 0.86 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.43 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.18 | 4 paid orders, 7 tickets, 32 history rows |
| Learned changes | PASS | 1.41 | 2 backtested suggestions |
| Apply learned change | PASS | 2.06 | Applied policy version 2 |
| Restore policy | PASS | 0.35 | Restored as version 3 |
| Rules compile and backtest | PASS | 2.82 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 13.96 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 10.92 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 7.01 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 0.52 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 13.77 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 6.66 | payout $180: awaiting_approval |
| Inbox T7 expected outcome | PASS | 12.00 | refund $52: awaiting_approval |
| Approve held inbox request | PASS | 4.17 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.54 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 1.04 | Verified |
| Bypass opens incident | PASS | 5.97 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 17.63 | Server observed verified refund webhook at 2026-11-05T18:08:48.159Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 1.35 | Verified |
| Bad webhook signature changes nothing | PASS | 0.87 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.57 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 4.22 | act_39: $5 held |
| Idempotent retry returns same action | PASS | 0.83 | Verified |
| Approve a different amount | PASS | 2.12 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 2.25 | Verified |
| Agent permission patch preserves other permissions | PASS | 0.35 | Existing refund permission preserved |
| /v1/payouts | PASS | 2.76 | act_41 held and declined |
| MCP tools/list over HTTP | PASS | 0.38 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.95 | Verified |
| Billing checkout link | FAIL | 0.17 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.17 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 2.71 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.34 | 28 chained entries verified |
| CSV export | PASS | 0.17 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.21 | Verified |
| API request-rate quota refusal | PASS | 4.27 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.35 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.53 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.36 | Signed out; /api/state returns 401 |

39 PASS; 2 FAIL.
