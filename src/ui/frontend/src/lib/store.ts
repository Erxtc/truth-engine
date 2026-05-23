import { writable, derived, get } from 'svelte/store';
import type {
  UIEvent, Artifact, StepPlan, RunParams,
  CallBlock, FeedItem,
} from './types';

// ── Feed (ordered list of call blocks + raw events) ────────────────────
export const feedItems = writable<FeedItem[]>([]);

// Stack of in-progress call blocks (top = most recent)
const openCallStack: CallBlock[] = [];

// ── Artifacts ──────────────────────────────────────────────────────────
export const artifacts = writable<Artifact[]>([]);
export const selectedArtifact = writable<Artifact | null>(null);

// ── Run state (polled from /api/state) ─────────────────────────────────
export const runState = writable<{
  problem: { id?: string; domain?: string; description?: string } | null;
  runParams: RunParams | null;
  stepPlan: StepPlan | null;
  currentStep: number;
}>({ problem: null, runParams: null, stepPlan: null, currentStep: 0 });

// ── Agent banner ────────────────────────────────────────────────────────
export const agentState = writable<{ name: string; running: boolean }>({
  name: 'idle', running: false,
});

// ── Stats ───────────────────────────────────────────────────────────────
export const stats = writable({
  survived: 0, killed: 0, repairs: 0,
  llmCalls: 0, llmTotalMs: 0,
});

// ── Event filter ────────────────────────────────────────────────────────
export type Filter = 'all' | 'llm' | 'system' | 'artifacts';
export const filter = writable<Filter>('all');

// ── Derived: filtered feed ──────────────────────────────────────────────
const SYSTEM_KINDS = new Set([
  'agent:run','step:advanced','planner:done',
  'repair:start','repair:done','insight','info','problem:solved',
]);
const ARTIFACT_KINDS = new Set([
  'artifact:born','artifact:survived','artifact:killed','verdict',
]);

export const visibleFeed = derived([feedItems, filter], ([$feed, $f]) => {
  if ($f === 'all') return $feed;
  if ($f === 'llm') return $feed.filter(i => i.kind === 'call');
  if ($f === 'system') return $feed.filter(
    i => i.kind === 'event' && SYSTEM_KINDS.has(i.event.kind)
  );
  return $feed.filter(
    i => i.kind === 'event' && ARTIFACT_KINDS.has(i.event.kind)
  );
});

// ── Full response store (key → text, for modal) ─────────────────────────
export const respStore = writable<Record<string, string>>({});

// ── Event ingestion ─────────────────────────────────────────────────────
export function ingest(e: UIEvent) {
  stats.update(s => {
    if (e.kind === 'artifact:survived') s.survived++;
    if (e.kind === 'artifact:killed')   s.killed++;
    if (e.kind === 'repair:start')      s.repairs++;
    if (e.kind === 'llm:start')         s.llmCalls++;
    if (e.kind === 'llm:end' && e.ms)  { s.llmTotalMs += e.ms; }
    return s;
  });

  if (e.kind === 'agent:run')      agentState.set({ name: e.msg, running: true });
  if (e.kind === 'problem:solved') agentState.set({ name: 'SOLVED ✓', running: false });

  if (e.kind === 'llm:start') {
    agentState.set({ name: (e.detail?.role as string ?? 'llm').toUpperCase(), running: true });
    const block: CallBlock = {
      kind: 'call',
      id: e.id,
      role: (e.detail?.role as string) ?? 'llm',
      model: (e.detail?.model as string) ?? '',
      prompt: (e.detail?.prompt as string) ?? e.msg,
      artifactId: e.artifactId,
      thinking: '',
      thinkWords: 0,
      response: '',
      ms: undefined,
      done: false,
      ts: e.ts,
    };
    openCallStack.push(block);
    feedItems.update(f => [...f, block]);
    return;
  }

  if (e.kind === 'llm:thinking') {
    const top = openCallStack[openCallStack.length - 1];
    if (top) {
      const chunk = (e.detail?.thinking as string) ?? e.msg ?? '';
      top.thinking += chunk;
      top.thinkWords = top.thinking.trim().split(/\s+/).filter(Boolean).length;
      // Trigger reactivity by replacing the array with same contents
      feedItems.update(f => f);
    }
    return;
  }

  if (e.kind === 'llm:end') {
    const top = openCallStack.pop();
    if (top) {
      top.done = true;
      top.ms = e.ms;
      top.response = (e.detail?.responsePreview as string) ?? '';
      // Store full response for modal
      respStore.update(s => ({ ...s, ['r' + top.id]: top.response }));
      feedItems.update(f => f);
    }
    const stillOpen = openCallStack.length > 0;
    if (!stillOpen) agentState.update(s => ({ ...s, running: false, name: 'idle' }));
    return;
  }

  if (e.kind === 'step:advanced') {
    const m = e.msg.match(/(\d+)/);
    if (m) {
      runState.update(s => ({ ...s, currentStep: Math.max(0, parseInt(m[1]) - 1) }));
    }
  }

  feedItems.update(f => [...f, { kind: 'event', event: e }]);
}
