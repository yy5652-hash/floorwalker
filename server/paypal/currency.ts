/** Currencies supported by PayPal payments. Names are shown in workspace settings. */
export const PAYPAL_CURRENCIES = {
  AUD: "Australian dollar", BRL: "Brazilian real", CAD: "Canadian dollar", CHF: "Swiss franc",
  CNY: "Chinese renminbi", CZK: "Czech koruna", DKK: "Danish krone", EUR: "Euro",
  GBP: "British pound", HKD: "Hong Kong dollar", HUF: "Hungarian forint", ILS: "Israeli new shekel",
  JPY: "Japanese yen", MYR: "Malaysian ringgit", MXN: "Mexican peso", NOK: "Norwegian krone",
  NZD: "New Zealand dollar", PHP: "Philippine peso", PLN: "Polish złoty", SEK: "Swedish krona",
  SGD: "Singapore dollar", THB: "Thai baht", TWD: "New Taiwan dollar", USD: "US dollar",
} as const;
export function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}
export function currencyCheck(kind: string, currency: string, workspace = "USD") {
  return currency === workspace ? [] : [{ id: "currency", label: "Currency", outcome: "hold" as const,
    detail: `This ${kind} is in ${currency}; your limits are in ${workspace}, so it needs you.` }];
}
export function recordedCurrency(row: { currency?: string }) {
  return row.currency ?? "USD";
}

/** Presentation only: keep the rule engine's recorded inputs and reviewer prompt unchanged. */
export function formatCheckMoney(check: { id: string; detail: string }, currency = "USD", limitsCurrency = currency) {
  let index = 0;
  return check.detail.replace(/\$(-?[\d,]+\.\d{2})/g, (_, amount: string) => {
    const actionAmount = ["capture", "duplicate"].includes(check.id) || (["hard_limit", "auto_limit", "agent_cap"].includes(check.id) && index === 0);
    index++;
    return formatMoney(Number(amount.replaceAll(",", "")), actionAmount ? currency : limitsCurrency);
  });
}
