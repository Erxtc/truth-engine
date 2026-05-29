<script lang="ts">
  import { afterUpdate } from 'svelte';
  import LlmCard from './LlmCard.svelte';
  import JsonView from './JsonView.svelte';
  import type { CallBlock, FeedItem, UIEvent } from './types';

  export let items: FeedItem[];
  export let stepPlan: { steps: { index: number; goal: string }[] } | null = null;
  export let currentStep: number = 0;

  let feedEl: HTMLElement;
  let autoScroll = true;

  function onScroll() {
    if (!feedEl) return;
    autoScroll = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  }
  afterUpdate(() => {
    if (autoScroll && feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });

  function resumeScroll() {
    autoScroll = true;
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }

  // ── Grouped feed logic ──────────────────────────────────────────────
  type GroupedItem =
    | { kind: 'divider'; type: 'agent'; label: string }
    | { kind: 'divider'; type: 'step'; stepNum: number; total: number; goal: string; id: number }
    | { kind: 'call'; block: CallBlock; kids: UIEvent[] }
    | { kind: 'event'; item: UIEvent };

  $: grouped = (() => {
    const blockByArt = new Map<string, CallBlock>();
    const childMap = new Map<number, UIEvent[]>();
    const claimed = new Set<number>();

    for (const item of items) {
      if (item.kind === 'call' && item.artifactId) {
        blockByArt.set(item.artifactId, item);
      }
    }
    for (const item of items) {
      if (item.kind === 'event') {
        const e = item.event;
        if (e.artifactId && blockByArt.has(e.artifactId)) {
          const block = blockByArt.get(e.artifactId)!;
          if (!childMap.has(block.id)) childMap.set(block.id, []);
          childMap.get(block.id)!.push(e);
          claimed.add(e.id);
        }
      }
    }

    const result: GroupedItem[] = [];
    for (const item of items) {
      if (item.kind === 'call') {
        result.push({ kind: 'call', block: item, kids: childMap.get(item.id) ?? [] });
      } else if (item.kind === 'event') {
        const e = item.event;
        if (claimed.has(e.id)) continue;

        if (e.kind === 'agent:run') {
          result.push({ kind: 'divider', type: 'agent', label: agentLabel(e.msg) });
        } else if (e.kind === 'step:advanced') {
          const goal = e.msg.replace(/^Step \d+\s*:?\s*/, '');
          result.push({ kind: 'divider', type: 'step', stepNum: currentStep + 1, total: stepPlan?.steps.length ?? 0, goal, id: e.id });
        } else {
          result.push({ kind: 'event', item: e });
        }
      }
    }
    return result;
  })();

  function agentLabel(name: string): string {
    const map: Record<string, string> = { 'task-agent':'Task Agent', repair:'Repair', supervisor:'Supervise', baseline:'Baseline' };
    return map[name.toLowerCase()] ?? name;
  }

  function groupKey(item: GroupedItem): string {
    if (item.kind === 'call') return 'c' + item.block.id;
    if (item.kind === 'divider') return 'd' + item.type + (item.type === 'step' ? item.id : item.label);
    return 'e' + item.item.id;
  }

  function supMatch(msg: string) {
    return msg.match(/^supervisor: (escalate|pivot|abort) — (.*)/);
  }

  function tsOf(t: number) { return new Date(t).toISOString().slice(11, 19); }

  function evScore(e: UIEvent): number | null {
    if (e.detail && typeof (e.detail as any).score === 'number') return (e.detail as any).score;
    const m = e.msg.match(/score[=:]?\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  function parseDetail(detail: unknown): unknown {
    if (!detail) return null;
    if (typeof detail === 'object' && detail !== null) {
      const { prompt, responsePreview, thinking, ...rest } = detail as Record<string, unknown>;
      return Object.keys(rest).length ? rest : null;
    }
    return detail;
  }

  const EV_ICONS: Record<string, string> = {
    'planner:done':'', 'repair:start':'', 'repair:done':'',
    'insight':'', 'artifact:born':'', 'info':'',
    'artifact:survived':'', 'artifact:killed':'', 'verdict':'',
  };
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="feed" bind:this={feedEl} on:scroll={onScroll}>
  {#if items.length === 0}
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
        </svg>
      </div>
      <p class="empty-text">Waiting for events…</p>
      <p class="empty-hint">Run a problem to see the pipeline in action</p>
    </div>
  {/if}

  {#each grouped as item (groupKey(item))}
    {#if item.kind === 'divider'}
      {#if item.type === 'agent'}
        <div class="divider agent">
          <div class="div-line"></div>
          <span class="div-label agent-label">{item.label}</span>
          <div class="div-line"></div>
        </div>
      {:else}
        <div class="divider step">
          <div class="div-line"></div>
          <span class="step-pill">Step {item.stepNum}{item.total ? ` / ${item.total}` : ''}</span>
          <span class="step-goal-text">{item.goal}</span>
          <div class="div-line"></div>
        </div>
      {/if}

    {:else if item.kind === 'call'}
      <LlmCard block={item.block} kids={item.kids} />

    {:else if item.kind === 'event'}
      {@const e = item.item}
      {@const sup = supMatch(e.msg)}
      {@const sc = evScore(e)}
      {@const detail = parseDetail(e.detail)}

      {#if e.kind === 'problem:solved'}
        <div class="solved-banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/>
          </svg>
          <div class="solved-text">
            <div class="solved-title">Problem Solved</div>
            <div class="solved-msg">{e.msg}</div>
          </div>
        </div>

      {:else if sup}
        {@const action = sup[1]}
        <div class="sup-card" data-act={action}>
          <div class="sup-head">
            <span class="sup-action">
              {action === 'escalate' ? 'Escalate' : action === 'pivot' ? 'Pivot' : 'Abort'}
            </span>
            <span class="sup-ts">{tsOf(e.ts)}</span>
          </div>
          <div class="sup-body">{sup[2]}</div>
        </div>

      {:else}
        <div class="ev-row" data-k={e.kind}>
          <span class="ev-icon">{EV_ICONS[e.kind] ?? ''}</span>
          <span class="ev-kind">{e.kind.replace('artifact:','').replace('planner:','').replace('repair:','')}</span>
          {#if sc !== null}
            <span class="ev-score" style="color:{sc>=80?'var(--success)':sc>=60?'var(--warning)':'var(--error)'}">{sc}</span>
          {/if}
          <span class="ev-msg" class:insight={e.kind === 'insight'}>{e.msg}</span>
          <span class="ev-ts">{tsOf(e.ts)}</span>
          {#if detail}
            <div class="ev-detail">
              <JsonView value={detail} />
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  {/each}
</div>

{#if !autoScroll}
  <button class="scroll-btn" on:click={resumeScroll}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    Resume scroll
  </button>
{/if}

<style>
  .feed {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 8px;
    scroll-behavior: smooth;
  }

  /* Empty state */
  .empty-state { text-align: center; padding: 48px 20px; }
  .empty-icon { margin-bottom: 12px; }
  .empty-text { font-size: 14px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
  .empty-hint { font-size: 11px; color: var(--text-muted); }

  /* Dividers */
  .divider {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 0 6px;
  }
  .div-line { flex: 1; height: 1px; background: var(--border); }
  .div-label { white-space: nowrap; }
  .agent-label {
    font-size: 10px; font-weight: 600; color: var(--accent);
    text-transform: uppercase; letter-spacing: .6px;
  }
  .step-pill {
    font-size: 9px; font-weight: 700; color: var(--accent);
    background: var(--accent-dim); border: 1px solid rgba(59,130,246,.35);
    border-radius: var(--radius-sm); padding: 2px 8px; white-space: nowrap;
  }
  .step-goal-text {
    font-size: 11px; font-weight: 500; color: var(--text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Event rows */
  .ev-row {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
    padding: 6px 10px; border-radius: var(--radius-md);
    background: var(--bg-surface); border: 1px solid var(--border);
    font-size: 10px; animation: fade-in .15s ease;
  }
  .ev-row[data-k="planner:done"] { border-left: 2px solid var(--accent); }
  .ev-row[data-k="insight"] { border-left: 2px solid var(--info); }
  .ev-row[data-k="artifact:born"] { border-left: 2px solid var(--accent); }
  .ev-row[data-k="artifact:survived"] { border-left: 2px solid var(--success); }
  .ev-row[data-k="artifact:killed"] { border-left: 2px solid var(--error); }

  .ev-icon { flex-shrink: 0; width: 14px; text-align: center; font-size: 10px; }
  .ev-kind {
    font-size: 8px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .3px; color: var(--text-muted);
    width: 46px; flex-shrink: 0;
  }
  .ev-msg {
    flex: 1; color: var(--text-muted); min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ev-msg.insight { color: var(--text-secondary); white-space: normal; line-height: 1.5; max-height: 2.8em; }
  .ev-ts { font-size: 9px; color: var(--text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .ev-score {
    font-size: 10px; font-weight: 700; flex-shrink: 0; font-variant-numeric: tabular-nums;
  }
  .ev-detail {
    width: 100%; padding: 8px 12px; margin-top: 4px;
    background: var(--bg-base); border-radius: var(--radius-sm);
    border-top: 1px solid var(--border);
  }

  /* Solved */
  .solved-banner {
    display: flex; align-items: center; gap: 14px;
    padding: 16px 20px; border-radius: var(--radius-lg);
    background: var(--success-dim); border: 1px solid rgba(34,197,94,.35);
    animation: fade-in .3s ease;
  }
  .solved-text { flex: 1; }
  .solved-title { font-size: 16px; font-weight: 700; color: var(--success); margin-bottom: 4px; }
  .solved-msg { font-size: 12px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; }

  /* Supervisor card */
  .sup-card { border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border); }
  .sup-card[data-act="escalate"] { border-color: rgba(245,158,11,.4); }
  .sup-card[data-act="pivot"]    { border-color: rgba(139,92,246,.4); }
  .sup-card[data-act="abort"]    { border-color: rgba(239,68,68,.4); }
  .sup-head {
    padding: 6px 12px; background: var(--bg-elevated);
    display: flex; align-items: center; justify-content: space-between;
  }
  .sup-card[data-act="escalate"] .sup-action { color: var(--warning); }
  .sup-card[data-act="pivot"]    .sup-action { color: var(--purple); }
  .sup-card[data-act="abort"]    .sup-action { color: var(--error); }
  .sup-action { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
  .sup-ts     { font-size: 10px; color: var(--text-muted); }
  .sup-body   { padding: 8px 12px; font-size: 11px; color: var(--text-secondary); line-height: 1.6; }

  /* Scroll resume */
  .scroll-btn {
    position: sticky; bottom: 10px; left: 50%; transform: translateX(-50%);
    width: fit-content; z-index: 10;
    display: flex; align-items: center; gap: 6px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    color: var(--text-secondary); font-size: 11px; font-family: inherit;
    padding: 6px 14px; border-radius: 20px; cursor: pointer;
    box-shadow: 0 2px 12px rgba(0,0,0,.4);
    transition: border-color .15s;
  }
  .scroll-btn:hover { border-color: var(--accent); color: var(--accent); }
</style>
