# Fresh merchant end-to-end results

Target: http://localhost:18999
Started: 2026-11-03T22:11:39.426Z
Updated: 2026-11-03T22:12:00.452Z

HTTP functional checks with real PayPal sandbox refunds. Shop and ledger remain for inspection.

| Step | Result | Seconds | Evidence |
|---|---|---:|---|
| Sign up with an outbox email code and name the shop | PASS | 0.10 | Verified |
| Connect the PayPal sandbox app through Settings | PASS | 0.67 | Verified |
| Create a paid order on the same sandbox app | PASS | 7.44 | Verified |
| Customer email arrives through Postmark and appears in the inbox | PASS | 0.01 | Verified |
| Create an agent and key; request a refund above the limit | PASS | 3.83 | Verified |
| Approval email GET is inert; POST executes with a PayPal refund id | PASS | 4.42 | Verified |
| A second refund under the limit executes automatically | PASS | 4.53 | Verified |
| Revoke the test agent key | PASS | 0.01 | Verified |

8 PASS; 0 FAIL.
