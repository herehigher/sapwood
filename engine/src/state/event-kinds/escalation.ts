// Escalation-reconciliation event kinds (#425): the two RECEIPTS the escalation reconciler and
// sweeper write. Deliberately their own (tiny) domain file rather than folded into another —
// they are the vocabulary every `escalation-source:*` kind above resolves THROUGH, and keeping
// them separate means a new escalation source never conflicts with a change to the resolver.
//
// APPEND AT THE END (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const ESCALATION_EVENT_KINDS = defineKinds({
  "escalation-resolved": {
    tags: [],
    meaning:
      "the escalation reconciler observed an open escalation-source's resolution witness (a clear kind, a merge, a PR/issue close) — the durable record of HOW it resolved, before any label is touched.",
    actionability: "routine",
  },
  "needs-human-swept": {
    tags: [],
    meaning:
      "the escalation sweeper removed the needs-human label for a (source, issue) key it proved both engine-applied and resolved by an authorized witness — the latch that stops this key from being swept twice.",
    actionability: "routine",
  },
});
