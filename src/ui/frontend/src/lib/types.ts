export type EventKind =
  | 'llm:start' | 'llm:end' | 'llm:thinking'
  | 'agent:run' | 'verdict'
  | 'artifact:born' | 'artifact:killed' | 'artifact:survived'
  | 'step:advanced' | 'repair:start' | 'repair:done'
  | 'insight' | 'planner:done' | 'problem:solved' | 'info';

export interface UIEvent {
  id: number;
  kind: EventKind;
  ts: number;
  ms?: number;
  artifactId?: string;
  msg: string;
  detail?: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  type: string;
  status: 'active' | 'lemma' | 'dead' | string;
  score?: number;
  depth?: number;
  parentId?: string;
  hypothesisText?: string;
  title?: string;
  sourceCode?: string;
  confidenceLevel?: number;
}

export interface Step {
  index: number;
  goal: string;
  oracle_hint?: string;
}

export interface StepPlan {
  steps: Step[];
  rationale?: string;
}

export interface RunParams {
  maxDepth?: number;
  maxBranches?: number;
  criticCount?: number;
  requiredConfidence?: number;
  budgetLlmCalls?: number;
}

/** A processed LLM call block — groups llm:start / llm:thinking / llm:end */
export interface CallBlock {
  kind: 'call';
  id: number;
  role: string;
  model: string;
  prompt: string;
  artifactId?: string;
  thinking: string;
  thinkWords: number;
  response: string;
  ms?: number;
  done: boolean;
  ts: number;
}

/** A raw event that appears verbatim in the feed */
export interface EventItem {
  kind: 'event';
  event: UIEvent;
}

export type FeedItem = CallBlock | EventItem;
