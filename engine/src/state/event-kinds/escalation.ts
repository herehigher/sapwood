// Escalation-reconciliation event kinds (#425): the two RECEIPTS the escalation reconciler and
// sweeper write. Deliberately their own (tiny) domain file rather than folded into another —
// they are the vocabulary every `escalation-source:*` kind above resolves THROUGH, and keeping
// them separate means a new escalation source never conflicts with a change to the resolver.
//
// APPEND AT THE END (see run.ts's note on why).
import { defineKinds } from "./types.js";

export const ESCALATION_EVENT_KINDS = defineKinds({
  "escalation-resolved": [],
  "needs-human-swept": [],
});
