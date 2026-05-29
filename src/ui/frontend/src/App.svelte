<script lang="ts">
  import { onMount } from 'svelte';
  import {
    visibleFeed, feedItems, artifacts, runState, agentState,
    stats, filter, selectedArtifact, selectedLlmCall, activeTab,
    type Filter,
  } from './lib/store';
  import { connectSSE, pollState, pollArtifacts, onConnState } from './lib/sse';
  import TopBar from './lib/TopBar.svelte';
  import LeftSidebar from './lib/LeftSidebar.svelte';
  import TabBar from './lib/TabBar.svelte';
  import LiveFeed from './lib/LiveFeed.svelte';
  import ArtifactTree from './lib/ArtifactTree.svelte';
  import StatsDashboard from './lib/StatsDashboard.svelte';
  import RightPanel from './lib/RightPanel.svelte';
  import type { Artifact } from './lib/types';

  // ── Connection & timer ──────────────────────────────────────────────
  let connStatus = 'connecting';
  onConnState(s => { connStatus = s.status; });

  let elapsed = '0:00';
  const startTime = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    elapsed = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  // ── Derived ─────────────────────────────────────────────────────────
  $: problem   = $runState.problem;
  $: stepPlan  = $runState.stepPlan;
  $: curStep   = $runState.currentStep;
  $: runParams = $runState.runParams;

  // ── Handlers ────────────────────────────────────────────────────────
  function handleTab(e: CustomEvent<string>) { activeTab.set(e.detail as 'feed' | 'artifacts' | 'stats'); }
  function handleFilter(e: CustomEvent<string>) { filter.set(e.detail as Filter); }
  function handleArtifactSelect(e: CustomEvent<Artifact>) {
    selectedArtifact.set(e.detail);
    selectedLlmCall.set(null);
  }
  // ── Lifecycle ───────────────────────────────────────────────────────
  onMount(() => {
    connectSSE();
    pollState();
    pollArtifacts();
    const pi = setInterval(pollState, 5000);
    const ai = setInterval(pollArtifacts, 3000);
    return () => { clearInterval(pi); clearInterval(ai); };
  });
</script>

<div class="app-shell">
  <TopBar
    problemDescription={problem?.description ?? ''}
    domain={problem?.domain ?? ''}
    {elapsed}
    {connStatus}
  />

  <div class="main-area">
    <LeftSidebar
      {stepPlan}
      currentStep={curStep}
      agentName={$agentState.name}
      running={$agentState.running}
      survived={$stats.survived}
      killed={$stats.killed}
      llmCalls={$stats.llmCalls}
      repairs={$stats.repairs}
    />

    <div class="center">
      <TabBar
        active={$activeTab}
        filter={$filter}
        on:tab={handleTab}
        on:filter={handleFilter}
      />

      <div class="center-content">
        {#if $activeTab === 'feed'}
          <LiveFeed
            items={$visibleFeed}
            filter={$filter}
            {stepPlan}
            currentStep={curStep}
          />
        {:else if $activeTab === 'artifacts'}
          <ArtifactTree
            artifacts={$artifacts}
            selectedId={$selectedArtifact?.id ?? null}
            on:select={handleArtifactSelect}
          />
        {:else if $activeTab === 'stats'}
          <StatsDashboard
            survived={$stats.survived}
            killed={$stats.killed}
            repairs={$stats.repairs}
            llmCalls={$stats.llmCalls}
            llmTotalMs={$stats.llmTotalMs}
            totalTokens={$stats.totalTokens}
            budgetLlmCalls={runParams?.budgetLlmCalls ?? 0}
          />
        {/if}
      </div>
    </div>

    {#if $selectedArtifact || $selectedLlmCall}
      <RightPanel
        artifact={$selectedArtifact}
        llmCall={$selectedLlmCall}
      />
    {/if}
  </div>
</div>

<style>
  .app-shell {
    height: 100vh; display: flex; flex-direction: column;
    background: var(--bg-base); color: var(--text-primary);
  }

  .main-area {
    flex: 1; min-height: 0; display: flex; overflow: hidden;
  }

  .center {
    flex: 1; min-width: 0; display: flex; flex-direction: column;
  }

  .center-content {
    flex: 1; min-height: 0; display: flex; flex-direction: column;
    overflow: hidden;
  }
</style>
