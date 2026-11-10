# YouTube upload

- File: ~/Desktop/PayPal-影片/Floorwalker_20261103_1355_v1_横屏.mp4 (v1, 177.5 s, 1920x1080). Subtitles: ~/Desktop/PayPal-影片/配套材料/Floorwalker_20261103_1355_v1_横屏.srt (English).
- Visibility: **Public** (the rules require the video to be publicly visible on YouTube).
- Audience: not made for kids.

**Title**
Floorwalker: every AI agent refund in PayPal checked, fewer taps as it learns | PayPal AI Hackathon

**Description**
Every refund checked. Fewer taps as it learns.

AI agents can now refund customers and pay people through PayPal. Guardrails for them fail in two ways: ask the owner about everything and she starts approving without reading; ask about nothing and one email can tell the agent to pay a stranger.

Floorwalker sits between AI agents and a business's PayPal account. Every refund or payout is checked against PayPal's own records, the owner's rules and an AI review: it goes through, waits for one-tap approval on her phone, or is blocked before it reaches PayPal. It learns from her decisions which requests she always approves, proposes rule changes backtested on her history and on 80 benchmark attacks, and watches PayPal (webhooks and an order sweep) for money that moved without it.

This video replays recorded live runs against the PayPal sandbox: real refunds and payouts through the PayPal Agent Toolkit and REST APIs, a phone approval, a prompt injection hidden in an email, a hijacked agent that gets frozen, a rule change learned from the owner's decisions, a refund made straight through the PayPal API and caught within seconds, an outside agent calling Floorwalker's API, and FloorwalkerBench: on 198 labelled cases, no guard loses $3,796 to the attacks, giving the model the rules loses $52 on average at 49 owner taps per 100 money moves, Floorwalker loses $0 at 30.

Try it live: https://floorwalker.yingzhilu.cn

Built with the PayPal Agent Toolkit, PayPal Orders, Payments, Payouts, Webhooks and Subscriptions APIs (sandbox), Gemini, DeepSeek (chat), shadcn/ui, AG Grid Enterprise, AG Charts and MCP.
Code: https://github.com/yy5652-hash/floorwalker

Narration: Kokoro-82M (Apache-2.0). Music: "Air on the G String" (J. S. Bach), performed by Golden Cut Reborn, from the YouTube Audio Library. Still images generated with Google Gemini for this video. 3D scenes rendered with three.js (MIT). The product footage is the real app replaying a recorded live run; the demo shop and its people are fictional.
