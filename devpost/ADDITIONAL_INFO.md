# Devpost "Additional info" answers (draft, paste by hand)

Fields marked OWNER are personal or attestations: the owner fills them.

**Submitter type / country / Canada province / organization:** Individual / United States / N/A / N/A (filled 2026-11-10).

**Is your project new, or did it exist before Oct 1, 2026?**
New (first commit 2026-10-23, then called Allowance; renamed Floorwalker on 2026-10-29).

**If it existed before, explain…**
N/A

**Explain how your project meets the main technology requirement.**
PayPal is the money path; AI is the decision-maker it guards.
- PayPal Agent Toolkit (`@paypal/agent-toolkit`): the support agent's PayPal tools (`get_order`, `get_refund`, `create_refund`). Floorwalker intercepts `create_refund` and executes it itself with a per-request `PayPal-Request-Id`.
- PayPal REST APIs (sandbox): Orders v2 (demo orders and shipment tracking), Payments v2 captures and refunds (ground truth for every check), Payouts v1 (contractor payments), Webhooks (registration and `verify-webhook-signature`, to catch refunds and payouts made around Floorwalker), Subscriptions (catalog products, billing plans and subscriptions for Floorwalker's own plans).
- Gemini (`gemini-3.8-flash`): the support agent (function calling), the AI reviewer that judges every money move (JSON-schema output, injection flag, verbatim evidence), the rules compiler that turns the owner's plain-language rules into a validated policy, and the learning feature that rewords rules from her decisions. The model never sets a number; learned changes come from the ledger and are backtested in code.
- DeepSeek: the "Ask Floorwalker" chat (streaming), and an automatic stand-in for Gemini when it is unavailable; the app says when it is standing in.
- MCP: Floorwalker exposes its own MCP server so any outside agent calls Floorwalker instead of PayPal directly.

**Which additional sponsor tool(s) did you use?**
AG Grid

**Public code repository URL:**
https://github.com/yy5652-hash/floorwalker

**Working demo URL:**
https://floorwalker.yingzhilu.cn

**Testing instructions or credentials:**
No credentials needed. Open https://floorwalker.yingzhilu.cn and press "Try the live demo": you get your own demo shop in a couple of seconds with real paid orders in the PayPal sandbox, a support inbox and history. Run the inbox items (one hides a prompt injection, one asks to change a payee), approve or decline held requests, open Ledger to expand any money move into its decision trace, and on Watch press "Refund straight through PayPal" to see a refund made around Floorwalker caught within seconds. To test with your own sandbox account, sign in with an email code and connect your PayPal sandbox app under Settings → PayPal. Developers: create an agent key under Developers and call `POST /v1/refunds` or the hosted MCP server at `/v1/mcp` (see the README).

**How would you rate your overall experience integrating PayPal? / why / contact for feedback:** OWNER

**APIMatic experience:** leave empty (not used).

**AG Grid / AG Charts experience:**
AG Grid Enterprise carries every data-heavy screen. The Ledger uses master/detail to expand a money move into its full decision trace (each check, the PayPal facts read, the AI review, who decided), row grouping by agent, outcome or counterparty with aggregated totals, filter and column tool panels, a status bar with sums, Excel/CSV export and integrated charts straight from the grid. The rules backtest, audit log and incidents table are AG Grid too, and AG Charts draws owner taps per 100 money moves and money moved per week on the Overview. Master/detail plus grouping let one table answer both "what happened to this refund" and "how much did each agent move", which kept the app to a few screens. Theming through the Quartz theme params matched our shadcn/ui design in light and dark with little code.

**Attestations (age, eligible jurisdiction, not a sponsor employee):** OWNER

**Which AI tools did you use while working on this project?**
Claude Code (Claude) and OpenAI Codex for writing and reviewing code; Gemini and DeepSeek inside the product; Kokoro-82M for the video narration; Google Gemini for still images in the video. OWNER: confirm or edit.

**Learning outcomes / AI value for your career:** OWNER
