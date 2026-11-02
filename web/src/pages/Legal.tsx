import { Brand } from "../components/UI";
import { ThemeToggle } from "../components/Theme";
const issues = "https://github.com/yy5652-hash/floorwalker/issues";

/** Product disclosures based on the shipped sandbox implementation, not live-service terms. */
export function Legal({ page }: { page: "privacy" | "terms" }) {
  return <div className="legal-page">
    <header><Brand /><ThemeToggle /></header>
    <main>
      <p className="section-index">Floorwalker · PayPal sandbox only</p>
      <h1>{page === "privacy" ? "Privacy" : "Terms of use"}</h1>
      <p className="legal-intro">This is a sandbox prototype. Refunds, payouts and subscriptions use PayPal sandbox accounts. No real money moves.</p>
      {page === "privacy" ? <>
        <section><h2>What is stored</h2><p>The server stores your account name and email, sign-in sessions and passkey records, workspace membership and roles. Workspace data includes agents, rules and versions, connected sandbox configuration, requests and inbox messages, PayPal records, the money-movement ledger, approvals and decline reasons, AI reviews, incidents and an audit log. Notification and integration settings are stored when you configure them.</p><p>These records support sign-in, checks, replay, learning and the activity history. Data lives in server-side databases; your browser keeps preferences such as theme. Chat history is held in page memory during the conversation. For questions about retention or deletion, use the contact below.</p></section>
        <section><h2>Where data goes</h2><p>PayPal sandbox receives the credentials and request details needed to read sandbox records and execute sandbox payments or subscriptions. The configured AI provider, Google Gemini or Anthropic Claude, receives the request content, relevant payment facts and rules needed for agent work, review and rule suggestions. When the server operator turns on the fallback, DeepSeek receives the same data whenever that provider is unavailable. The hosted service has it on.</p><p>Ask Floorwalker sends your chat messages to DeepSeek when that assistant is enabled. Real workspaces do not share workspace activity with the assistant by default. If activity sharing is enabled, it can receive limited recent ledger, agent, rule and incident context. The demo shares its demo activity. The assistant cannot move money or edit rules.</p><p>If you enable Slack alerts, browser push or outbound webhooks, the configured destination receives the relevant notification or event. Those services handle data under their own policies.</p></section>
        <section><h2>Your choices and contact</h2><p>Use test data and sandbox credentials. Do not put confidential customer information into the demo or chat. You can change integrations and assistant activity sharing in workspace settings.</p><p>For privacy questions or a data request, start at <a href={issues}>GitHub issues</a>. Issues are public: describe the request without posting credentials, payment details or personal information.</p></section>
      </> : <>
        <section><h2>Use test accounts and test data</h2><p>Use Floorwalker only with PayPal sandbox accounts you are authorised to access. Do not connect real payment credentials, use the service for live transactions, or submit another person's confidential information. Keep agent keys private and assign appropriate workspace roles.</p></section>
        <section><h2>What an approval does</h2><p>Approving a request submits that recorded action for execution in PayPal sandbox, subject to the server's checks. Applying a learned suggestion changes workspace rules for future requests. Review the evidence and backtest before confirming. An AI recommendation can be wrong; benchmark and simulated results do not guarantee future outcomes.</p><p>Floorwalker checks activity routed through it. Its PayPal watch can detect some activity outside that route and freeze agents, but it cannot prevent or account for every action made elsewhere.</p></section>
        <section><h2>Plans and availability</h2><p>Displayed plans and subscription checkout are sandbox demonstrations. At the monthly checked-action limit, new agent actions are refused. Floorwalker does not add per-action overage charges. The prototype may change or be unavailable; do not rely on it for live business operations or as your only copy of records.</p></section>
        <section><h2>Contact and source</h2><p>Report a problem through <a href={issues}>GitHub issues</a>, without posting secrets or personal data. The source is available under the <a href="https://github.com/yy5652-hash/floorwalker/blob/main/LICENSE">MIT licence</a>.</p></section>
      </>}
    </main>
    <footer><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href={issues}>Contact</a></footer>
  </div>;
}
