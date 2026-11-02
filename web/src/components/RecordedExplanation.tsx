import { money, type FreezeExplanation, type BlockExplanation } from "../api";

export function FreezeReason({ explanation }: { explanation?: FreezeExplanation | null }) {
  if (!explanation) return <div className="freeze-explanation"><strong>Frozen · can't move money</strong><p>The original freeze evidence was not recorded. Review PayPal activity before unfreezing this agent.</p></div>;
  const { check, evidence, next_step } = explanation;
  return <div className="freeze-explanation">
    <strong>Frozen · {check.replaceAll("_", " ")}</strong>
    <dl>
      {evidence.changed_by && <div><dt>Changed by</dt><dd>{evidence.changed_by}</dd></div>}
      {evidence.incident_id != null && <div><dt>Incident</dt><dd>#{evidence.incident_id}</dd></div>}
      {evidence.paypal_ref && <div><dt>PayPal transaction</dt><dd>{evidence.paypal_ref}</dd></div>}
      {evidence.capture_id && <div><dt>Capture</dt><dd>{evidence.capture_id}</dd></div>}
      {evidence.amount != null && <div><dt>Amount</dt><dd>{money(evidence.amount)}</dd></div>}
      {(evidence.seen_at || evidence.at) && <div><dt>{evidence.seen_at ? "Seen at" : "Frozen at"}</dt><dd>{new Date(evidence.seen_at ?? evidence.at!).toLocaleString("en-US")}</dd></div>}
      {(evidence.detected_by || evidence.source) && <div><dt>Source</dt><dd>{evidence.detected_by ?? evidence.source}</dd></div>}
    </dl>
    <p>{next_step}</p>
  </div>;
}

export function BlockReasons({ explanations }: { explanations?: BlockExplanation[] }) {
  if (!explanations?.length) return null;
  return <section className="block-explanations" aria-label="Why this request was blocked">
    <h4>Why it stopped</h4>
    {explanations.map((reason, i) => <div key={`${reason.check}-${i}`}>
      <strong>{reason.rule}</strong>
      <p>{reason.evidence}</p>
      {reason.freeze && <FreezeReason explanation={reason.freeze} />}
      <p><strong>Next step</strong> {reason.next_step}</p>
      {reason.facts && <details><summary>Recorded rule &amp; PayPal evidence</summary><pre>{JSON.stringify(reason.facts, null, 2)}</pre></details>}
    </div>)}
  </section>;
}
