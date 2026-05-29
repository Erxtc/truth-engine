<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Filter } from './store';
  export let active: string;
  export let filter: Filter = 'all';

  const dispatch = createEventDispatcher();
  const tabs = [
    { id: 'feed', label: 'Live Feed' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'stats', label: 'Stats' },
  ] as const;

  const filters = [
    { id: 'all' as Filter, label: 'All' },
    { id: 'llm' as Filter, label: 'LLM' },
    { id: 'system' as Filter, label: 'System' },
    { id: 'artifacts' as Filter, label: 'Arts' },
  ];
</script>

<div class="tab-bar">
  <div class="tabs">
    {#each tabs as tab}
      <button
        class="tab"
        class:active={active === tab.id}
        on:click={() => dispatch('tab', tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>
  {#if active === 'feed'}
    <div class="filters">
      {#each filters as f}
        <button
          class="filter-btn"
          class:on={filter === f.id}
          on:click={() => dispatch('filter', f.id)}
        >
          {f.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tab-bar {
    display: flex; align-items: center; padding: 0 12px;
    background: var(--bg-surface); border-bottom: 1px solid var(--border);
    flex-shrink: 0; height: 36px; gap: 0;
  }
  .tabs { display: flex; gap: 0; }
  .tab {
    font-size: 12px; padding: 7px 14px; cursor: pointer;
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-muted); font-weight: 500; font-family: inherit;
    transition: all .15s;
  }
  .tab:hover { color: var(--text-secondary); }
  .tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }

  .filters { display: flex; gap: 2px; margin-left: auto; }
  .filter-btn {
    font-size: 10px; padding: 3px 8px; border-radius: var(--radius-sm);
    cursor: pointer; background: none; border: 1px solid transparent;
    color: var(--text-muted); font-weight: 500; font-family: inherit;
    transition: all .15s;
  }
  .filter-btn:hover { color: var(--text-secondary); border-color: var(--border); }
  .filter-btn.on { background: var(--accent-dim); border-color: rgba(59,130,246,.35); color: var(--accent); }
</style>
