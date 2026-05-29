export type EventKind =
  | "llm:start" | "llm:end" | "llm:thinking"
  | "agent:run"
  | "verdict"
  | "artifact:born" | "artifact:killed" | "artifact:survived"
  | "step:advanced"
  | "repair:start" | "repair:done"
  | "insight"
  | "planner:done"
  | "problem:solved"
  | "info";

export interface UIEvent {
  id: number;
  kind: EventKind;
  ts: number;
  ms?: number;
  artifactId?: string;
  msg: string;
  detail?: unknown;
}

let _seq = 0;
const _subs = new Set<(e: UIEvent) => void>();
export const history: UIEvent[] = [];
const MAX_HISTORY = 1000;

export function emit(
  kind: EventKind,
  msg: string,
  extra?: { ms?: number; artifactId?: string; detail?: unknown }
): void {
  const event: UIEvent = { id: ++_seq, kind, ts: Date.now(), msg, ...extra };
  history.push(event);
  if (history.length > MAX_HISTORY) history.shift();
  for (const fn of _subs) {
    try { fn(event); } catch { }
  }
}

export function subscribe(fn: (e: UIEvent) => void): () => void {
  _subs.add(fn);
  return () => _subs.delete(fn);
}
