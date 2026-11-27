// Plain-language explanations of findings, written by fastqa itself (deterministic, no model): what was observed, how it
// relates to an action, what it may mean, and one safe next check. The agent can pass these on as they are; it never has
// to reconstruct the meaning of a finding from raw HTTP data. Text and structured results use the same explanation.
import type { Association, Finding } from '../observation/types.js';

export interface Explanation {
  /** how the finding relates to an action, in words that never overstate a temporal link */
  relation: string;
  /** what it may mean for the person or the data; always marked as not verified */
  impact: string;
  /** one check that is safe to run next: read-only, and never "submit again" */
  next: string;
}

const READ = /^(GET|HEAD|OPTIONS)$/;

/** How sure the link between an observation and an action is, in plain words. */
export function relationOf(a: Association, describe: (a: Association) => string): string {
  switch (a.confidence) {
    case 'direct': return `requested by ${describe(a).replace(/ \(direct\)$/, '')}`;
    case 'inferred': return `likely from ${describe(a).replace(/ \(inferred\)$/, '')} (by timing, not proven)`;
    case 'ambiguous': return `could be from ${describe(a).replace(/ \(ambiguous\)$/, '')}; not attributed`;
    default: return 'not tied to any action (background or page-initiated)';
  }
}

/** The explanation of one finding. `describe` names an action ("A-3 click \"Save\"") from its association. */
export function explain(f: Finding, describe: (a: Association) => string): Explanation {
  const relation = relationOf(f.association, describe);
  const ep = f.endpoint;
  const call = ep ? `${ep.method} ${ep.route}` : 'the call';
  const write = !!ep && !READ.test(ep.method);
  const noResubmit = 'without submitting it again';
  switch (f.ruleId) {
    case 'NET-5XX':
      return write
        ? { relation, impact: `the server failed ${call}; what it should have saved or sent may be missing (not verified)`, next: `check the resulting state (the record, message or email it should create) ${noResubmit}` }
        : { relation, impact: `the server failed to deliver ${call}; the page may show incomplete or stale data (not verified)`, next: 'check whether the page shows complete data; reading it again is safe' };
    case 'NET-4XX':
      return { relation, impact: `the server refused ${call}; expected only in a negative test (not verified)`, next: `if this was a negative test, assert it with expect_request; otherwise compare the inputs with what the endpoint accepts` };
    case 'NET-FAIL':
      return { relation, impact: `${call} got no response (network, CORS or blocked request); its effect is unknown`, next: 'read the error in evidence {finding} before retrying anything' };
    case 'JS-EXCEPTION':
      return { relation, impact: 'an uncaught error can stop a handler half way; the feature may not have completed (not verified)', next: 'check that the feature still did what it should, and read the stack in evidence {finding}' };
    case 'CONSOLE-ERROR':
      return { relation, impact: 'the page logged an error; often harmless, sometimes the only trace of a failure', next: 'read the message in evidence {finding} and treat it as low priority unless it matches a symptom' };
    case 'SILENT-FAILURE':
      return { relation, impact: 'the submission failed and the person was not told: they may believe it worked', next: `look for any message on the page; if there is none, this is missing error feedback. Check the data ${noResubmit}` };
    case 'FALSE-SUCCESS':
      return { relation, impact: 'the person was told it worked although a submission failed: data may be missing (not verified)', next: `check whether the data was really saved ${noResubmit}` };
    case 'FALSE-FAILURE':
      return { relation, impact: 'the person was told it failed although every call succeeded at HTTP level; they may retry and create a duplicate (not verified)', next: `check whether the operation took effect (the record exists) before trying again; HTTP 2xx alone does not prove it` };
    case 'PARTIAL-SUCCESS':
      return { relation, impact: 'part of the operation was kept and part was not: data may be inconsistent (not verified)', next: `check which parts were saved ${noResubmit}` };
    case 'DUPLICATE-SUBMIT':
      return { relation, impact: 'the same submission was sent more than once: it may have created duplicates (not verified)', next: `check for duplicate records ${noResubmit}` };
    case 'DEAD-CLICK':
      return { relation, impact: 'the control did nothing visible; it may be broken, or it may need a precondition', next: 'check whether the control should be disabled here or is missing its handler; one more click is safe only if it does not submit anything' };
    case 'STUCK-LOADING':
      return { relation, impact: 'the page still shows it is loading although its calls finished; the person may wait forever', next: 'take a snapshot once more to see whether the indicator clears' };
    case 'BROKEN-IMAGE':
      return { relation, impact: 'an image could not be shown although it arrived (wrong type or corrupt file)', next: 'open evidence {view:"network"} for the image URL and check its content type' };
    case 'STATE-INVARIANT':
      return { relation, impact: 'the page did not show what the configured rule expects after this response', next: 'take a snapshot and compare it with the rule in .fastqa/config.json' };
    case 'BUSINESS-ERROR':
      return { relation, impact: 'the response broke a configured business rule although its status looked fine', next: 'read the response in evidence {finding, details:true}' };
    case 'PERF-SLOW': case 'PERF-BASELINE': case 'PERF-CALLS':
      return { relation, impact: 'a performance limit was exceeded; one slow sample can be noise', next: 'repeat the read-only part once, or record a baseline, before reporting it' };
    default:
      return { relation, impact: 'a documented contract or rule did not hold for this response (not verified further)', next: 'read the details in evidence {finding}' };
  }
}
