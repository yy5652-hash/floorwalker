# Live end-to-end results

Target: https://floorwalker.43-160-214-187.sslip.io; mode: focused developer recheck

Started: 2026-10-30T23:55:16.042Z; last update: 2026-10-30T23:55:42.107Z. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.

| Check | Result | Seconds | Evidence / limitation |
|---|---|---:|---|
| Anonymous sign-in | PASS | 1.35 | Fresh anonymous identity; cookie retained in memory only |
| Instant demo with simulated history | PASS | 1.65 | 3 paid orders, 6 tickets, 32 history rows |
| Create agent and ephemeral key | PASS | 1.02 | Key created, used and retained only in process memory |
| Agent permission refusal | PASS | 4.30 | Verified |
| Agent permission patch preserves other permissions | FAIL | 1.26 | PATCH {can_payout:true} must preserve existing can_refund:true false !== true  |
| /v1/payouts | PASS | 12.71 | act_34 held and declined |
| MCP tools/list over HTTP | PASS | 0.57 | 6 tools returned |
| MCP tools/call over HTTP | PASS | 1.49 | Verified |
| Revoked key refused | PASS | 0.57 | Verified |
| Cleanup endpoints and keys; freeze agents with history | PASS | 0.56 | Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API |
| Sign out and confirm access refused | PASS | 0.56 | Signed out; /api/state returns 401 |

10 PASS; 1 FAIL.
