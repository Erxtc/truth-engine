import { ingest, artifacts, runState } from './store';
import type { UIEvent } from './types';

export const connState = { status: 'connecting' as 'connecting' | 'live' | 'reconnecting' };

// ── SSE ─────────────────────────────────────────────────────────────────
let connStateCallbacks: Array<(s: typeof connState) => void> = [];
export function onConnState(cb: (s: typeof connState) => void) {
  connStateCallbacks.push(cb);
  return () => { connStateCallbacks = connStateCallbacks.filter(f => f !== cb); };
}

function notifyConn(status: typeof connState.status) {
  connState.status = status;
  connStateCallbacks.forEach(cb => cb(connState));
}

export function connectSSE() {
  const es = new EventSource('/events');
  es.onopen = () => notifyConn('live');
  es.onmessage = ev => {
    try { ingest(JSON.parse(ev.data) as UIEvent); } catch {}
  };
  es.onerror = () => {
    notifyConn('reconnecting');
    es.close();
    setTimeout(connectSSE, 2000);
  };
}

// ── State polling ────────────────────────────────────────────────────────
export async function pollState() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const s = await r.json();
    runState.update(rs => ({
      ...rs,
      problem: s.problem ?? rs.problem,
      runParams: s.runParams ?? rs.runParams,
      stepPlan: s.stepPlan ?? rs.stepPlan,
      currentStep: s.currentStep ?? rs.currentStep,
    }));
  } catch {}
}

export async function pollArtifacts() {
  try {
    const r = await fetch('/api/artifacts');
    if (!r.ok) return;
    artifacts.set(await r.json());
  } catch {}
}
