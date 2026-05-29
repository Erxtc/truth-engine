<script lang="ts">
  import type { Artifact } from './types';
  import { fly } from 'svelte/transition';

  export let art: Artifact;
  export let kids: Record<string, Artifact[]>;
  export let selectedId: string | null = null;
  export let select: (a: Artifact) => void = () => {};
  export let depth: number = 0;
  export let isLast: boolean = true;
  export let search: string = '';

  $: children = (kids[art.id] ?? []).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  $: isSelected = selectedId === art.id;

  const statusColors: Record<string, string> = {
    active: 'var(--accent)',
    lemma: 'var(--success)',
    dead: 'var(--text-muted)',
  };
  const statusDot = statusColors[art.status] ?? 'var(--text-muted)';
</script>

<div class="node-wrapper" style="padding-left: {depth * 16}px;" transition:fly|local={{ x: -8, duration: 120 }}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="node-card" class:selected={isSelected} on:click={() => select(art)}>
    <div class="node-left">
      <span class="status-dot" style="background: {statusDot};"></span>
      <div class="node-info">
        <span class="node-type">{art.type}</span>
        {#if art.title || art.hypothesisText}
          <span class="node-text">{(art.title ?? art.hypothesisText ?? '').slice(0, 64)}</span>
        {/if}
      </div>
    </div>
    <div class="node-right">
      {#if art.score}
        <span class="node-score" class:hi={art.score >= 80} class:lo={art.score < 60}>{art.score}</span>
      {/if}
      <span class="node-status" style="color: {statusDot};">{art.status}</span>
    </div>
  </div>

  {#if children.length > 0}
    <div class="children">
      {#each children as child, i}
        <svelte:self art={child} {kids} {selectedId} {select} depth={depth + 1} isLast={i === children.length - 1} {search} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .node-wrapper { padding: 1px 0; }
  .node-card {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 8px; border-radius: var(--radius-md);
    border: 1px solid transparent; cursor: pointer;
    background: var(--bg-surface); gap: 8px;
    transition: all .12s;
    border-left: 2px solid var(--border);
  }
  .node-card:hover { background: var(--bg-elevated); border-color: var(--border); }
  .node-card.selected {
    background: var(--accent-dim); border-color: rgba(59,130,246,.4);
    border-left-color: var(--accent);
  }

  .node-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .node-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .node-type {
    font-size: 10px; font-weight: 600; color: var(--text-secondary);
    text-transform: capitalize;
  }
  .node-text {
    font-size: 10px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .node-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .node-score {
    font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .node-score.hi { color: var(--success); }
  .node-score.lo { color: var(--error); }
  .node-status {
    font-size: 8px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .3px;
  }

  .children {
    position: relative;
  }
</style>
