import { DemoButton } from "./Auth";
import { PlanCards } from "./Settings";
import { Code } from "../components/Management";
import { mcpCommand, refundCurl } from "./Developers";
import {
  Bot,
  Check,
  Clock3,
  ExternalLink,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { Brand } from "../components/UI";
import { ThemeToggle } from "../components/Theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
const github = "https://github.com/yy5652-hash/floorwalker";
export function Landing() {
  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-6 sm:px-8">
        <Brand />
        <nav className="flex items-center gap-2" aria-label="Main navigation">
          <Button variant="ghost" asChild className="hidden sm:inline-flex">
            <a href={github} target="_blank" rel="noreferrer">
              GitHub
              <ExternalLink />
            </a>
          </Button>
          <ThemeToggle />
          <Button asChild size="sm" variant="ghost">
            <a href="/signin">Sign in</a>
          </Button>
          <Button asChild size="sm">
            <a href="/signup">Create account</a>
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-5 sm:px-8">
        <section className="grid items-center gap-12 py-12 md:py-20 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div className="space-y-7">
            <Badge
              variant="outline"
              className="gap-2 px-3 py-1.5 text-xs font-normal"
            >
              <ShieldCheck className="size-3.5 text-allow" />A little trust.
              Clear boundaries.
            </Badge>
            <h1 className="text-5xl leading-[1.08] font-medium tracking-[-.045em] sm:text-6xl">
              Every refund checked.
              <br />
              <span className="text-allow">Fewer taps every week.</span>
            </h1>
            <p className="max-w-xl text-base leading-8 text-muted-foreground">
              Floorwalker sits between AI agents and a business's PayPal account: every refund or payout is checked against PayPal's records and your rules, and it learns from your decisions when it no longer needs to ask you.
            </p>
            <div className="flex flex-wrap gap-3">
              <DemoButton size="lg" />
              <Button size="lg" variant="outline" asChild>
                <a href="#how-it-works">How it works</a>
              </Button>
            </div>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="size-4 text-allow" />
              Your rules. Every payment. Before PayPal.
            </p>
          </div>
          <div
            className="rounded-2xl border bg-muted/40 p-5 sm:p-7"
            aria-label="How Floorwalker routes a payment request"
          >
            <div className="mb-6 flex items-center justify-between">
              <span className="text-[10px] font-medium tracking-[.18em] text-muted-foreground">
                THE FLOORWALKER CHECKPOINT
              </span>
              <ShieldCheck className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-4">
              {[
                {
                  icon: Check,
                  tone: "allow",
                  title: "Within your allowance",
                  description: "Approved automatically",
                  note: "Your agent keeps things moving.",
                },
                {
                  icon: Clock3,
                  tone: "hold",
                  title: "Needs your judgment",
                  description: "Waiting for your approval",
                  note: "Review the checks. Make the call.",
                },
                {
                  icon: ShieldX,
                  tone: "block",
                  title: "Outside your boundaries",
                  description: "Blocked before PayPal",
                  note: "Your rules have the final word.",
                },
              ].map(({ icon: Icon, tone, title, description, note }) => (
                <Card key={tone} className="gap-0 py-0 shadow-xs">
                  <CardContent className="flex items-start gap-4 p-5">
                    <span
                      className={`grid size-10 shrink-0 place-items-center rounded-xl tone-${tone}`}
                    >
                      <Icon className="size-5" />
                    </span>
                    <div className="space-y-1.5">
                      <h2 className="text-sm">{title}</h2>
                      <p className="text-xs font-medium">{description}</p>
                      <p className="text-xs text-muted-foreground">{note}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="mt-6 text-center text-[11px] text-muted-foreground">
              One checkpoint. Three clear outcomes.
            </p>
          </div>
        </section>
        <Separator />
        <section id="how-it-works" className="scroll-mt-8 py-16 md:py-24">
          <div className="mb-10 space-y-4 text-center">
            <p className="text-[10px] font-medium tracking-[.18em] text-muted-foreground">
              HOW IT WORKS
            </p>
            <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
              Let your agents work.
              <br />
              Keep your money on your terms.
            </h2>
            <p className="text-muted-foreground">
              One checkpoint between an agent's idea and a payment.
            </p>
          </div>
          <div className="grid items-stretch gap-4 md:grid-cols-3">
            {[
              {
                icon: Bot,
                title: "Agent",
                description: "Proposes a refund or payout",
                step: "01",
              },
              {
                icon: SlidersHorizontal,
                title: "Floorwalker",
                description: "Rules · PayPal facts · AI review",
                step: "02",
              },
              {
                icon: ShieldCheck,
                title: "PayPal",
                description: "Only the approved action runs",
                step: "03",
              },
            ].map(({ icon: Icon, title, description, step }) => (
              <Card
                key={step}
                className={
                  step === "02"
                    ? "border-emerald-600/30 bg-emerald-500/5 shadow-none"
                    : "shadow-none"
                }
              >
                <CardHeader>
                  <div className="mb-5 flex items-center justify-between">
                    <Icon className="size-6 text-muted-foreground" />
                    <span className="font-mono text-xs text-muted-foreground">
                      {step}
                    </span>
                  </div>
                  <CardTitle className="text-lg">{title}</CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
        <section className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: SlidersHorizontal,
              title: "Limits, allowances and payee lists",
              text: "Set clear boundaries in plain English. Give every agent just enough room to do its job.",
            },
            {
              icon: Smartphone,
              title: "One-tap approvals, even from your phone",
              text: "See who gets paid, why, and what the checks found. Approve, lower the amount, or decline.",
            },
            {
              icon: Sparkles,
              title: "An AI reviewer that cites your rules",
              text: "Get a recommendation grounded in your policy and PayPal facts, with the reason right beside it.",
            },
          ].map(({ icon: Icon, title, text }) => (
            <Card key={title} className="border-0 bg-transparent shadow-none">
              <CardHeader className="px-0">
                <Icon className="mb-4 size-5 text-muted-foreground" />
                <CardTitle className="leading-relaxed">{title}</CardTitle>
                <CardDescription className="mt-2 leading-7">
                  {text}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>
        <section id="developers" className="min-w-0 space-y-6 border-t py-16">
          <div className="max-w-xl space-y-3">
            <p className="text-[10px] font-medium tracking-[.18em] text-muted-foreground">
              BUILT FOR YOUR AGENTS
            </p>
            <h2 className="text-3xl tracking-tight">
              A small integration.
              <br />
              Clear boundaries from day one.
            </h2>
            <p className="text-sm leading-7 text-muted-foreground">
              Send refunds and payouts through a scoped agent key, or connect
              your MCP client over HTTP. Follow every request through the same
              approval workflow.
            </p>
          </div>
          <Code text={refundCurl()} />
          <h3>Or connect Claude Code</h3>
          <Code text={mcpCommand()} />
          <Button asChild variant="outline">
            <a href="/v1/openapi.json">
              Read the OpenAPI specification
              <ExternalLink />
            </a>
          </Button>
        </section>
        <section id="pricing" className="space-y-8 border-t py-16">
          <div className="space-y-3 text-center">
            <p className="text-[10px] font-medium tracking-[.18em] text-muted-foreground">
              A PLAN FOR YOUR WORKSPACE
            </p>
            <h2 className="text-3xl tracking-tight">
              Start small. Make room as you grow.
            </h2>
            <p className="text-sm text-muted-foreground">
              Monthly plans in USD. PayPal sandbox only.
            </p>
          </div>
          <PlanCards />
        </section>
        <div className="my-12 space-y-5 border-y py-8">
          <p className="text-center text-[10px] tracking-widest text-muted-foreground">
            BUILT WITH
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {[
              "PayPal Agent Toolkit",
              "PayPal Orders, Payments & Payouts (sandbox)",
              "Gemini",
              "AG Grid",
              "MCP",
            ].map((name) => (
              <Badge
                key={name}
                variant="outline"
                className="text-xs font-normal"
              >
                {name}
              </Badge>
            ))}
          </div>
        </div>
        <section className="flex flex-col items-center gap-6 py-10 text-center">
          <h2 className="text-3xl font-medium tracking-tight">
            Give your agents room to help.
          </h2>
          <div className="flex flex-wrap justify-center gap-3">
            <DemoButton size="lg" />
            <Button size="lg" variant="outline" asChild>
              <a href="/signup">Create account</a>
            </Button>
          </div>
        </section>
      </main>
      <footer className="mx-auto mt-12 flex max-w-6xl flex-wrap items-center justify-between gap-5 border-t px-5 py-8 text-xs text-muted-foreground sm:px-8">
        <Brand />
        <span>Every refund checked. Fewer taps every week.</span>
        <a
          href={github}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 hover:text-foreground"
        >
          View on GitHub
          <ExternalLink className="size-3" />
        </a>
      </footer>
    </div>
  );
}
