import { paypal } from "./client.ts";

export type Money = { currency_code: string; value: string };

export const usd = (n: number): Money => ({ currency_code: "USD", value: n.toFixed(2) });

// PayPal's published sandbox test card (developer.paypal.com → Card testing).
const TEST_CARD = { number: "4111111111111111", expiry: "2030-12", security_code: "123" };

export type CustomerOrderInput = {
  customer: { name: string; email: string };
  items: { name: string; sku: string; unit: number; quantity: number }[];
  shipping: number;
  invoiceId: string;
};

/**
 * Creates and captures a real sandbox order for a demo customer, paid with PayPal's
 * published test card, so the support agent has genuine captures to refund.
 */
export async function createPaidCustomerOrder(input: CustomerOrderInput) {
  const itemTotal = input.items.reduce((s, i) => s + i.unit * i.quantity, 0);
  const [given, ...rest] = input.customer.name.split(" ");
  const order = await paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: input.invoiceId,
        invoice_id: input.invoiceId,
        custom_id: input.customer.email,
        description: "Juniper & Oak Ceramics order",
        amount: {
          ...usd(itemTotal + input.shipping),
          breakdown: { item_total: usd(itemTotal), shipping: usd(input.shipping) },
        },
        items: input.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          unit_amount: usd(i.unit),
          quantity: String(i.quantity),
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
    payment_source: {
      card: {
        ...TEST_CARD,
        name: input.customer.name,
        billing_address: { address_line_1: "1 Test St", admin_area_2: "Portland", admin_area_1: "OR", postal_code: "97201", country_code: "US" },
      },
    },
    payer: { email_address: input.customer.email, name: { given_name: given, surname: rest.join(" ") || given } },
  }, { requestId: `seed-${input.invoiceId}` });

  const done = order.status === "COMPLETED" ? order : await paypal("POST", `/v2/checkout/orders/${order.id}/capture`, {}, { requestId: `seed-cap-${input.invoiceId}` });
  const capture = done.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`Order ${order.id} has no capture (status ${done.status})`);
  return { orderId: done.id as string, captureId: capture.id as string, amount: Number(capture.amount.value), createdAt: capture.create_time as string };
}

export async function getOrder(orderId: string) {
  return paypal("GET", `/v2/checkout/orders/${orderId}`);
}

export async function getCapture(captureId: string) {
  return paypal("GET", `/v2/payments/captures/${captureId}`);
}

/** Order that a capture belongs to, read from the capture's HATEOAS "up" link. */
export function orderIdFromCapture(capture: any): string | undefined {
  const up = capture?.links?.find((l: any) => l.rel === "up")?.href as string | undefined;
  return up?.split("/").pop();
}

export async function refundCapture(captureId: string, amount: Money | undefined, note: string, requestId: string) {
  return paypal("POST", `/v2/payments/captures/${captureId}/refund`, {
    ...(amount ? { amount } : {}),
    note_to_payer: note.slice(0, 255),
  }, { requestId });
}

export async function sendPayout(p: { email: string; amount: Money; note: string; batchId: string }) {
  return paypal("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: p.batchId,
      email_subject: "You have a payment from Juniper & Oak",
      email_message: p.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: p.email,
        amount: { currency: p.amount.currency_code, value: p.amount.value },
        note: p.note.slice(0, 4000),
        sender_item_id: p.batchId,
      },
    ],
  }, { requestId: p.batchId });
}

export async function getPayoutBatch(batchId: string) {
  return paypal("GET", `/v1/payments/payouts/${batchId}`);
}

export async function addTracking(p: { captureId: string; trackingNumber: string; carrier: string; status: "SHIPPED" | "DELIVERED" | "IN_PROCESS" }) {
  return paypal("POST", "/v1/shipping/trackers-batch", {
    trackers: [{ transaction_id: p.captureId, tracking_number: p.trackingNumber, status: p.status, carrier: p.carrier }],
  });
}
