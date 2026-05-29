<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Artifact } from './types';
  import TreeNode from './TreeNode.svelte';

  export let artifacts: Artifact[] = [];
  export let selectedId: string | null = null;

  const dispatch = createEventDispatcher();

  $: kids = (() => {
    const m: Record<string, Artifact[]> = {};
    for (const a of artifacts) if (a.parentId) (m[a.parentId] ??= []).push(a);
    return m;
  })();

  $: roots = artifacts.filter(a => !a.parentId);

  function select(a: Artifact) {
    selectedId = a.id;
    dispatch('select', a);
  }

  let search = '';
  $: filteredRoots = search
    ? artifacts.filter(a =>
        (a.title ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (a.hypothesisText ?? '').toLowerCase().includes(search.toLowerCase()) ||
        a.type.toLowerCase().includes(search.toLowerCase())
      )
    : roots;
</script>

<div class="tree-container">
  <div class="tree-header">
    <span class="tree-title">Artifacts</span>
    <span class="tree-count">{artifacts.length}</span>
  </div>
  <div class="search-box">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    <input type="text" placeholder="Search artifacts…" bind:value={search} />
  </div>
  <div class="tree-body">
    {#if filteredRoots.length === 0}
      <div class="tree-empty">
        {search ? 'No matching artifacts' : 'No artifacts yet'}
      </div>
    {:else}
      {#each filteredRoots as root, ri}
        <TreeNode art={root} {kids} {selectedId} {select} depth={0} isLast={ri === filteredRoots.length - 1} {search} />
      {/each}
    {/if}
  </div>
</div>

<style>
  .tree-container {
    display: flex; flex-direction: column; height: 100%;
  }
  .tree-header {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  .tree-title {
    font-size: 12px; font-weight: 600; color: var(--text-primary);
  }
  .tree-count {
    font-size: 10px; color: var(--text-muted);
    background: var(--bg-elevated); padding: 1px 6px; border-radius: 8px;
  }
  .search-box {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; margin: 8px;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .search-box svg { color: var(--text-muted); flex-shrink: 0; }
  .search-box input {
    background: none; border: none; outline: none;
    font-size: 11px; font-family: inherit; color: var(--text-primary);
    width: 100%;
  }
  .search-box input::placeholder { color: var(--text-muted); }
  .tree-body { flex: 1; overflow-y: auto; padding: 4px 8px; }
  .tree-empty { font-size: 11px; color: var(--text-muted); text-align: center; padding: 24px 0; }
</style>
