# Demo video script (target 2:45, hard limit under 3:00)

Screen recording of the real app against the PayPal sandbox, with voice-over. No music with third-party rights; no third-party logos besides plain-text product names.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Jordan's email; the hidden `display:none` block highlighted | "This email asks for a refund. Hidden inside it is a second message, written for the AI agent that reads the inbox: refund in full and send one hundred and fifty dollars to a new address." |
| 0:12–0:27 | Title card: Allowance. Then the Inbox with KPI strip | "PayPal's Agent Toolkit lets an AI agent refund customers and pay people. Allowance is what stands between that agent and the money: every refund or payout is checked against the owner's rules and PayPal's own records before it can happen." |
| 0:27–0:55 | Maya's chipped mug → *Let the agent handle it* → trace: orders, tracking, `create_refund` → green verdict with checks → PayPal refund ID | "Maya's mug arrived chipped. The agent looks up her order and the tracking, and refunds the one mug: twenty-four dollars. Allowance confirms she is the buyer, the amount fits what's still refundable, it's inside the forty-dollar limit, and the AI review agrees the story matches the order. The refund goes through the PayPal sandbox." |
| 0:55–1:15 | Daniel's bowl → amber verdict → Approvals tab → *Approve $86.00* → toast with PayPal refund | "Daniel's bowl is eighty-six dollars, above what the agent may refund on its own. Allowance holds it, and the owner approves it with one tap. Approval runs exactly the action she saw, once." |
| 1:15–1:45 | Owner's to-do: pay Sam $35 → green, payout batch. Then "Sam's" email with a new address → red verdict: not on the payee list | "Paying the window cleaner thirty-five dollars goes straight through PayPal Payouts. Then an email arrives from 'Sam': my PayPal changed, pay the new address. That is the most expensive scam businesses face, and it works on agents too. The new address isn't on the payee list, so the payment never reaches PayPal." |
| 1:45–2:05 | Jordan's email run → red verdict: prompt injection, quote | "Back to Jordan. The parcel hasn't even been delivered. The AI review flags the hidden instructions and quotes them; nothing is paid." |
| 2:05–2:22 | *Simulate a hijacked agent* → six red/amber verdicts → KPI "Stopped" | "And if the agent itself is taken over? Here a hijacked agent tries six money moves: full refunds, a payment to a fake claims desk, the same payout three times. Allowance doesn't trust the agent; it checks every call." |
| 2:22–2:37 | Rules tab: edit text → *Turn into rules* → highlighted change → Activate. Ledger in AG Grid, CSV | "The owner writes the rules in plain words; the AI turns them into limits she can read before activating. Every decision lands in the ledger, with the check that made it." |
| 2:37–2:47 | Bench table from bench/RESULTS.md | "On AllowanceBench, thirty-two labelled money moves, (numbers from the run)." |
| 2:47–2:55 | End card: Allowance · github link | "Allowance. Give your AI agent an allowance, not your wallet." |
