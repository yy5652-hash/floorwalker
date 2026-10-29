# YouTube upload

- File: ~/Desktop/Floorwalker-PayPal-demo.mp4 (under 3 minutes, 1080p). Subtitles: ~/Desktop/Floorwalker-PayPal-demo.srt (English).
- Visibility: **Public** (the rules require the video to be publicly visible on YouTube).
- Audience: not made for kids.

**Title**
Floorwalker: every AI agent refund in PayPal checked, fewer taps every week | PayPal AI Hackathon

**Description**
Every refund checked. Fewer taps every week.

AI agents can now refund customers and pay people through PayPal. Guardrails for them fail in two ways: ask the owner about everything and she starts approving without reading; ask about nothing and one email can tell the agent to pay a stranger.

Floorwalker sits between AI agents and a business's PayPal account. Every refund or payout is checked against PayPal's own records, the owner's rules and an AI review: it goes through, waits for one-tap approval on her phone, or is blocked before it reaches PayPal. It learns from her decisions which requests she always approves, proposes rule changes backtested on her history and on 80 benchmark attacks, and watches PayPal (webhooks and an order sweep) for money that moved without it.

This video replays one recorded live run against the PayPal sandbox: real refunds and payouts through the PayPal Agent Toolkit and REST APIs, a phone approval, a prompt injection hidden in an email, a hijacked agent that gets frozen, a rule change learned from the owner's decisions, a refund made straight through the PayPal API and caught within seconds, an outside agent calling Floorwalker's API, and FloorwalkerBench: on 198 labelled cases, no guard loses $3,796 to the attacks, giving the model the rules loses $35 at 47 owner taps per 100 money moves, Floorwalker loses $0 at 30.

Try it live: https://floorwalker.43-160-214-187.sslip.io

Built with the PayPal Agent Toolkit, PayPal Orders, Payments, Payouts, Webhooks and Subscriptions APIs (sandbox), Gemini, shadcn/ui, AG Grid Enterprise, AG Charts and MCP.
Code: https://github.com/yy5652-hash/floorwalker

Narration: Kokoro-82M (Apache-2.0). Music and sound effects are synthesised for this video; no third-party music.
