import { ArrowRight, Check, ExternalLink } from "lucide-react";
import { DemoButton } from "./Auth";
import { publicPlans } from "./Settings";
import { Code } from "../components/Management";
import { mcpCommand, refundCurl } from "./Developers";
import { Brand, Money } from "../components/UI";
import { ThemeToggle } from "../components/Theme";
import { Button } from "@/components/ui/button";
const github = "https://github.com/yy5652-hash/floorwalker";
const benchmark = [
  ["No guard", "$3,796", "0", "100%"],
  ["Rules in the prompt", "$35", "47", "75%"],
  ["Rules only", "$630", "31", "100%"],
  ["Floorwalker", "$0", "30", "100%"],
];
export function Landing() {
  return <div className="landing">
    <header className="site-nav">
      <Brand />
      <nav aria-label="Main navigation">
        <a className="desktop-link" href="#how-it-works">How it works</a>
        <a className="desktop-link" href="#benchmark">Benchmark</a>
        <a className="desktop-link" href="#pricing">Pricing</a>
        <ThemeToggle />
        <a href="/signin">Sign in</a>
        <Button asChild className="desktop-link"><a href="/signup">Get started <ArrowRight /></a></Button>
      </nav>
    </header>
    <main>
      <section className="site-hero">
        <div className="hero-copy">
          <h1>Every refund checked.<br /> <span>Fewer taps every week.</span></h1>
          <div className="hero-intro">
            <p>AI agents can now move money in PayPal. Give them a shop manager who checks every move—and learns when to stop asking you.</p>
            <DemoButton size="lg" />
            <p className="hero-disclosure">PayPal sandbox. No real money.</p>
          </div>
        </div>
        <figure className="product-window">
          <div className="product-caption"><span><span className="live-dot" /> Your money, in view.</span><span>Juniper &amp; Oak · demo shop</span></div>
          <picture className="product-desktop">
            <img className="preview-light" src="/product-overview.webp" width="1440" height="880" alt="Floorwalker overview showing money moved, requests waiting for the owner, and weekly activity from the recorded demo." fetchPriority="high" />
            <img className="preview-dark" src="/product-overview-dark.webp" width="1440" height="880" alt="Floorwalker overview in dark mode, from the recorded demo." />
          </picture>
          <img className="product-phone" src="/product-approval.webp" width="390" height="844" alt="A real demo refund request for $86 to Daniel Okafor, with checks and approval actions." />
          <figcaption>Recorded demo · earlier activity is simulated, not sent to PayPal.</figcaption>
        </figure>
      </section>
      <section id="how-it-works" className="guard-story site-section">
        <div><p className="section-index">01 / A better boundary</p><h2>Trust the work.<br /> Check the money.</h2></div>
        <div className="guard-explanation">
          <div className="failure-pair">
            <div><h3>Ask about everything.</h3><p>The owner starts rubber-stamping.</p></div>
            <div><h3>Ask about nothing.</h3><p>One malicious email can take the money.</p></div>
          </div>
          <p className="guard-answer">Floorwalker checks every refund and payout against <strong>PayPal’s records, your rules and an AI review.</strong> Only the approved action runs.</p>
          <div className="outcome-key"><span className="status-label tone-allow">Done</span><span className="status-label tone-hold">Waiting for you</span><span className="status-label tone-block">Blocked</span></div>
        </div>
      </section>
      <section className="learning-story site-section">
        <div className="learning-copy"><p className="section-index">02 / Less asking. Same boundaries.</p><h2>Your decisions<br /> make it smarter.</h2><p>Keep approving the same kind of refund? Floorwalker suggests a rule change, tests it on your history, and leaves the final say to you.</p><a href="/app#rules">See the reasoning <ArrowRight size={16} /></a></div>
        <div className="learning-proof"><span>From the recorded demo</span><div className="learning-figure">53 <span>→</span> 42</div><p>owner taps per 100 money moves</p><div className="learning-boundary"><Check size={16} /><span>Your declines still define the boundary.</span></div></div>
      </section>
      <section className="watch-story site-section">
        <p className="section-index">03 / Even when an agent goes around you</p>
        <h2>Watching the door<br /> money left through.</h2>
        <p>Floorwalker watches PayPal for money that skipped its checks. It flags the move and can freeze your agents while you decide what happened.</p>
        <a href="/app#watch">Explore PayPal watch <ArrowRight size={16} /></a>
      </section>
      <section id="benchmark" className="benchmark-section site-section">
        <div className="section-heading"><div><p className="section-index">Tested, not taken on trust</p><h2>What got through?</h2></div><p>198 labelled cases. 80 attacks attempting $3,796.<br /> 150 cases written by a different model, independently of the reviewer.</p></div>
        <div className="benchmark-scroll" tabIndex={0} aria-label="Benchmark comparison">
          <table className="benchmark-table"><thead><tr><th scope="col">Approach</th><th scope="col">Money taken</th><th scope="col">Owner taps<br /> <small>per 100 moves</small></th><th scope="col">Legitimate requests<br /> <small>done without the owner</small></th></tr></thead><tbody>
            {benchmark.map(([name, loss, taps, legitimate]) => <tr key={name} className={name === "Floorwalker" ? "benchmark-winner" : ""}><th scope="row">{name}</th><td>{loss}</td><td>{taps}</td><td>{legitimate}</td></tr>)}
          </tbody></table>
        </div>
        <p className="benchmark-note">FloorwalkerBench · controlled evaluation, not a guarantee of future results. <a href={`${github}/tree/main/bench`} target="_blank" rel="noreferrer">Inspect the benchmark <ExternalLink size={12} /></a></p>
      </section>
      <section id="developers" className="developer-story site-section">
        <div><h2>Your agent.<br /> Our checkpoint.</h2><p>Bring your own agent over REST or MCP. Refunds and payouts follow the same rules and approval flow.</p><a href="/v1/openapi.json">OpenAPI specification <ArrowRight size={16} /></a></div>
        <div className="integration-code"><div className="integration-label">Connect over MCP</div><Code text={mcpCommand()} /><details><summary>Or send a refund with REST</summary><Code text={refundCurl()} /></details></div>
      </section>
      <section id="pricing" className="pricing-section site-section">
        <div className="section-heading"><h2>A little help.<br /> Room to grow.</h2><p>Monthly plans in USD.<br /> PayPal sandbox only.</p></div>
        <div className="pricing-plans">{publicPlans.map(plan => <article key={plan.id} className={plan.id === "pro" ? "plan featured-plan" : "plan"}>
          <div><h3>{plan.name}</h3><div className="plan-price"><Money value={`$${plan.price}`} /><small>/ month</small></div></div>
          <p>{plan.agents === null ? "Unlimited" : plan.agents} agents · {plan.actionsPerMonth?.toLocaleString()} actions<br /> {plan.members === null ? "Unlimited" : plan.members} team members · {plan.webhooks === null ? "Unlimited" : plan.webhooks} webhooks</p>
          <Button asChild variant={plan.id === "pro" ? "default" : "outline"}><a href="/signup">Get started <ArrowRight /></a></Button>
        </article>)}</div>
      </section>
    </main>
    <footer className="site-footer"><Brand /><p>Every refund checked. Fewer taps every week.</p><a href={github} target="_blank" rel="noreferrer">GitHub <ExternalLink size={14} /></a></footer>
  </div>;
}
