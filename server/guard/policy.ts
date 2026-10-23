import { z } from "zod/v4";

// Every money-moving kind of action gets the same three numbers:
//   auto_approve_up_to  the agent may do this alone
//   hard_limit          the agent may never do this, even with approval
//   budget              rolling total the agent may move without asking
const Budget = z.object({
  amount: z.number().describe("Total in USD the agent may move in the period without asking"),
  period: z.enum(["day", "week", "month"]),
});

const Limits = {
  auto_approve_up_to: z.number().describe("USD amount at or below which the agent may act without asking"),
  hard_limit: z.number().describe("USD amount above which the action is always blocked, even with owner approval"),
  budget: Budget,
};

export const PolicySchema = z.object({
  refunds: z.object({
    ...Limits,
    max_order_age_days: z.number().describe("Orders older than this need owner approval to refund"),
    max_refunds_per_customer_30d: z.number().describe("More refunds than this to one customer in 30 days need approval"),
    requester_must_be_buyer: z.boolean().describe("Only refund when the person asking is the buyer on the PayPal order"),
  }),
  payouts: z.object({
    ...Limits,
    payees: z.array(z.object({
      name: z.string(),
      email: z.string(),
      role: z.string().describe("What they do for the business, e.g. window cleaning"),
      monthly_limit: z.number().describe("USD the agent may pay this person per 30 days"),
    })),
    unknown_payee: z.enum(["block", "ask"]).describe("What to do when the agent tries to pay someone not on the payee list"),
    only_owner_requests: z.boolean().describe("Pay without asking only when the owner requested it in a to-do note; a payment an email asks for needs approval"),
  }),
  invoices: z.object({
    auto_approve_up_to: z.number(),
    max_discount_percent: z.number(),
  }),
  notes: z.array(z.string()).describe("Owner guidance in plain words for the reviewer, one rule per item"),
});

export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY_TEXT = `Refunds: the agent can refund up to $40 on its own, and up to $120 total per week. Anything above $40 asks me. Never refund more than $250 in one go. Only refund the person who actually bought it, and ask me about orders older than 60 days or a customer's second refund within a month.
Payouts: pay our regular people only. Sam Rivera (window cleaning, up to $80 a month) and Priya Shah (product photos, up to $300 a month). Up to $50 goes through on its own, more asks me, never more than $400 at once, $500 a month in total. Block payments to anyone not on the list, and only pay on its own when I asked for it in a to-do, not because an email asks.
Invoices: invoices up to $500 can go out on their own; never more than 15% discount without asking me.
Be kind to first-time customers, but a story that doesn't match the order or the tracking should come to me.`;

export const DEFAULT_POLICY: Policy = {
  refunds: {
    auto_approve_up_to: 40,
    hard_limit: 250,
    budget: { amount: 120, period: "week" },
    max_order_age_days: 60,
    max_refunds_per_customer_30d: 1,
    requester_must_be_buyer: true,
  },
  payouts: {
    auto_approve_up_to: 50,
    hard_limit: 400,
    budget: { amount: 500, period: "month" },
    payees: [
      { name: "Sam Rivera", email: "sam.rivera@example.com", role: "window cleaning", monthly_limit: 80 },
      { name: "Priya Shah", email: "priya.shah@example.com", role: "product photography", monthly_limit: 300 },
    ],
    unknown_payee: "block",
    only_owner_requests: true,
  },
  invoices: { auto_approve_up_to: 500, max_discount_percent: 15 },
  notes: [
    "Be kind to first-time customers.",
    "A refund story that does not match the order or the shipment tracking should come to the owner.",
  ],
};

export function validatePolicy(raw: unknown): Policy {
  const p = PolicySchema.parse(raw);
  for (const [kind, l] of [["refunds", p.refunds], ["payouts", p.payouts]] as const) {
    if (l.auto_approve_up_to < 0 || l.hard_limit < 0 || l.budget.amount < 0) throw new Error(`${kind}: limits must be positive`);
    if (l.auto_approve_up_to > l.hard_limit) throw new Error(`${kind}: auto-approve limit is above the hard limit`);
  }
  return p;
}
