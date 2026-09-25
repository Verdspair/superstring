// The project's single token estimator.
//
// It lives in its own module so that everything that has to count the same way can import it
// without dragging in the whole context builder: the web chat budgets (context-builder.ts)
// and the QQ conversation budgets (qq-context-contract.ts) must not disagree about what a
// budget means. The name the wire contract publishes for this estimator is
// `utf8_bytes_plus_message_overhead` (shared/contracts/context-usage.ts), because a message
// carries overhead beyond its text — that part is added by the caller, which knows how many
// messages it is counting.

/** UTF-8 byte length: the project's approximation of model tokens. */
export function estimateTokens(text: string): number {
  return new TextEncoder().encode(text).length;
}
