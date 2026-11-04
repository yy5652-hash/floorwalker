# Fresh merchant end-to-end results

Target: http://localhost:18999
Started: 2026-11-04T01:16:14.991Z
Updated: 2026-11-04T01:16:34.586Z

HTTP functional checks with real PayPal sandbox refunds. Shop and ledger remain for inspection.

| Step | Result | Seconds | Evidence |
|---|---|---:|---|
| Sign up with an outbox email code and name the shop | PASS | 0.12 | Verified |
| Connect the PayPal sandbox app through Settings | PASS | 0.23 | Verified |
| Create a paid order on the same sandbox app | PASS | 7.14 | Verified |
| Customer email arrives through the Resend webhook and appears in the inbox | PASS | 0.02 | Verified |
| Create an agent and key; request a refund above the limit | PASS | 3.29 | Verified |
| Approval email GET is inert; POST executes with a PayPal refund id | PASS | 3.41 | Verified |
| A second refund under the limit executes automatically | PASS | 5.38 | Verified |
| Revoke the test agent key | PASS | 0.01 | Verified |

8 PASS; 0 FAIL.
