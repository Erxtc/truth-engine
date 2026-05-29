<script lang="ts">
  import PipelineProgress from './PipelineProgress.svelte';
  import MiniStats from './MiniStats.svelte';
  import type { StepPlan } from './types';

  export let stepPlan: StepPlan | null = null;
  export let currentStep: number = 0;
  export let agentName: string = 'idle';
  export let running: boolean = false;
  export let survived: number = 0;
  export let killed: number = 0;
  export let llmCalls: number = 0;
  export let repairs: number = 0;
  export let collapsed: boolean = false;
</script>

<aside class="sidebar" class:collapsed>
  {#if !collapsed}
    <div class="sidebar-content">
      <PipelineProgress {stepPlan} {currentStep} {agentName} {running} />
      <MiniStats {survived} {killed} {llmCalls} {repairs} />
    </div>
  {/if}
  <button class="toggle" on:click={() => collapsed = !collapsed} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      style="transform: rotate({collapsed ? 180 : 0}deg); transition: transform .2s;">
      <path d="M15 18l-6-6 6-6"/>
    </svg>
  </button>
</aside>

<style>
  .sidebar {
    width: 220px; flex-shrink: 0;
    background: var(--bg-surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
    transition: width .2s ease;
    position: relative;
  }
  .sidebar.collapsed { width: 28px; }
  .sidebar-content {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .toggle {
    position: absolute; top: 8px; right: 4px;
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
    z-index: 5;
  }
  .toggle:hover { color: var(--text-secondary); background: var(--bg-elevated); }
  .collapsed .toggle { right: 2px; }
</style>
