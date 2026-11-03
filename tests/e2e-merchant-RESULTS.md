# Fresh merchant end-to-end results

Target: http://localhost:18999
Started: 2026-11-03T21:27:35.896Z
Updated: 2026-11-03T21:27:56.616Z

HTTP functional checks with real PayPal sandbox refunds. Shop and ledger remain for inspection.

| Step | Result | Seconds | Evidence |
|---|---|---:|---|
| Sign up with an outbox email code and name the shop | PASS | 0.12 | Verified |
| Connect the PayPal sandbox app through Settings | PASS | 0.72 | Verified |
| Create a paid order on the same sandbox app | PASS | 8.58 | Verified |
| Customer email arrives through Postmark and appears in the inbox | PASS | 0.02 | Verified |
| Create an agent and key; request a refund above the limit | PASS | 3.44 | Verified |
| Approval email GET is inert; POST executes with a PayPal refund id | PASS | 3.29 | Verified |
| A second refund under the limit executes automatically | PASS | 4.54 | Verified |
| Revoke the test agent key | PASS | 0.01 | Verified |

8 PASS; 0 FAIL.
