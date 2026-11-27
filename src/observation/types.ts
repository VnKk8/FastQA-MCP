// Shared contracts of the observation, correlation and quality layers.
// Observations are facts. Associations state how an observation relates to an action and how sure that is.
// Findings are derived candidates: they never claim a confirmed product defect.

export type AssocConfidence = 'direct' | 'inferred' | 'ambiguous' | 'unattributed';

export interface Association {
  actionId?: string;
  candidateActionIds?: string[];
  /** direct = known linkage (the navigation an action asked for); inferred = temporal; never causal proof */
  confidence: AssocConfidence;
  reason: string;
}

export type ObservationKind =
  | 'request' | 'response' | 'request_finished' | 'request_failed'
  | 'console_error' | 'page_error' | 'state_change';

export interface Observation {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  batchId?: string;
  pageId?: string;
  frameId?: string;
  action: Association;
  sequence: number;
  at: string;        // ISO timestamp
  elapsedMs: number; // monotonic, relative to the session start
  kind: ObservationKind;
  data: Record<string, unknown>;
}

export interface BodyInfo {
  state: 'pending' | 'captured' | 'skipped' | 'failed';
  reason?: string;
  bytes?: number;
  /** sanitized JSON, present only when capture was explicitly allowed for this endpoint */
  json?: unknown;
}

/** One network request from start to completion. URLs are sanitized before they are stored here. */
export interface RequestRecord {
  id: string;
  method: string;
  url: string;
  origin: string;
  path: string;
  /** normalized path, e.g. /api/orders/{id} */
  route: string;
  resourceType: string;
  firstParty: boolean;
  /** fetch / xhr / document: counted for pending and coverage */
  tracked: boolean;
  navigation: boolean;
  pageId?: string;
  frameId?: string;
  batchId?: string;
  association: Association;
  startedMs: number;
  responseMs?: number;
  endedMs?: number;
  status?: number;
  contentType?: string;
  failure?: string;
  aborted?: boolean;
  redirectedFrom?: string;
  redirectedTo?: string;
  traceId?: string;
  body?: BodyInfo;
  /** field names and types of a JSON request body, never values (only when capture is allowed) */
  requestShape?: unknown;
  eventIds: string[];
  done: boolean;
}

export interface ActionRecord {
  actionId: string;
  batchId: string;
  index: number;      // 1-based position inside the batch
  do: string;
  label: string;      // redacted, built from the step template
  interactive: boolean;
  pageId?: string;
  startedMs: number;
  /** when the step itself returned; what follows until endedMs is the settle phase */
  executedMs?: number;
  endedMs?: number;
  ok?: boolean;
  inflight: number;   // requests attributed to this action that have no response yet
  requests: number;
}

export interface BatchRecord {
  batchId: string;
  kind: 'open' | 'act' | 'flow';
  scope?: string;
  startedMs: number;
  endedMs?: number;
  ok?: boolean;
  actions: number;
}

export type Severity = 'info' | 'low' | 'medium' | 'high';
export const SEVERITIES: Severity[] = ['info', 'low', 'medium', 'high'];
export const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

export interface Finding {
  schemaVersion: 1;
  id: string;
  ruleId: string;
  ruleVersion: number;
  /** estimated impact, not proof of business impact */
  severity: Severity;
  /** strength of the evidence that this is worth investigating */
  confidence: 'low' | 'medium' | 'high';
  status: 'candidate' | 'expected' | 'suppressed';
  statusReason?: string;
  title: string;
  expected?: string;
  actual: string;
  association: Association;
  batchId?: string;
  scope?: string;
  evidenceIds: string[];
  requestIds: string[];
  fingerprint: string;
  occurrences: number;
  expectedOccurrences: number;
  suppressedOccurrences: number;
  firstSequence: number;
  lastSequence: number;
  firstAt: string;
  lastAt: string;
  /** set when the finding was created after its batch had already returned */
  late?: boolean;
  endpoint?: { method: string; route: string; origin: string; status?: number };
}
