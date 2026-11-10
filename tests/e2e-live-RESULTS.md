# Live end-to-end results

Target: https://floorwalker.yingzhilu.cn; mode: full

Started: 2026-11-10T18:45:17.123Z; last update: 2026-11-10T18:49:01.256Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| / loads with JS asset | PASS | 1.91 | HTML 200 and referenced JS 200 (rendering not checked) |
| /app loads with JS asset | PASS | 0.89 | HTML 200 and referenced JS 200 (rendering not checked) |
| Anonymous sign-in | PASS | 0.51 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 0.18 | 4 paid orders, 7 tickets, 32 history rows |
| Learned changes | PASS | 1.39 | 2 backtested suggestions |
| Apply learned change | PASS | 4.50 | Applied policy version 2 |
| Restore policy | PASS | 0.68 | Restored as version 3 |
| Rules compile and backtest | PASS | 15.55 | 32 past moves replayed; 6 changed |
| Inbox T1 expected outcome | PASS | 23.56 | refund $24: executed |
| Inbox T2 expected outcome | PASS | 20.16 | refund $86: awaiting_approval |
| Inbox T3 expected outcome | PASS | 15.67 | payout $35: executed |
| Inbox T4 expected outcome | PASS | 0.78 | Escalated; 0 money proposals, none executed |
| Inbox T5 expected outcome | PASS | 34.75 | refund $64: blocked |
| Inbox T6 expected outcome | PASS | 20.18 | payout $180: awaiting_approval |
| Inbox T7 expected outcome | PASS | 24.77 | refund $52: awaiting_approval |
| Approve held inbox request | PASS | 3.73 | Request 34 approved with PayPal reference |
| Decline with a reason | PASS | 0.35 | Declined; exact reason persisted |
| Freeze and unfreeze all agents | PASS | 0.86 | Verified |
| Bypass opens incident | PASS | 6.76 | Untracked $25 sandbox refund found; agents frozen |
| PayPal webhook arrives within 90 seconds | PASS | 4.50 | Server observed verified refund webhook at 2026-11-10T18:48:17.276Z; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable |
| Resolve incident and restore agents | PASS | 1.32 | Verified |
| Bad webhook signature changes nothing | PASS | 0.80 | Rejected HTTP 400; incidents and last verified event unchanged |
| Create agent and ephemeral key | PASS | 0.51 | Key created, used and retained only in process memory |
| /v1/refunds held by agent cap | PASS | 7.32 | act_39: $5 held |
| Idempotent retry returns same action | PASS | 0.66 | Verified |
| Approve a different amount | PASS | 2.07 | Requested $5, approved $2 with PayPal reference |
| Agent permission refusal | PASS | 6.26 | Verified |
| Agent permission patch preserves other permissions | PASS | 0.68 | Existing refund permission preserved |
| /v1/payouts | PASS | 12.26 | act_41 held and declined |
| MCP tools/list over HTTP | PASS | 0.34 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.61 | Verified |
| Billing checkout link | FAIL | 0.17 | UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account |
| Plan quota refusal | FAIL | 0.17 | UNAVAILABLE in demo: Business limits; monthly action quota 50000. Not generating 50,000 model/money calls or changing production data to force exhaustion |
| Outgoing webhook create and test delivery | PASS | 2.68 | Test event delivered; attempts 1 |
| Audit log and integrity verification | PASS | 0.33 | 28 chained entries verified |
| CSV export | PASS | 0.17 | Audit CSV includes header and rows |
| Cross-site POST refused | PASS | 1.16 | Verified |
| API request-rate quota refusal | PASS | 2.72 | 429 rate_limited observed (distinct from billing quota) |
| Revoked key refused | PASS | 0.33 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.50 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.36 | Signed out; /api/state returns 401 |

39 PASS; 2 FAIL.
