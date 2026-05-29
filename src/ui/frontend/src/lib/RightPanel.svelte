<script lang="ts">
  import { fly } from 'svelte/transition';
  import type { Artifact, CallBlock } from './types';
  import ArtifactInspector from './ArtifactInspector.svelte';
  import LlmInspector from './LlmInspector.svelte';

  export let artifact: Artifact | null = null;
  export let llmCall: CallBlock | null = null;
</script>

{#if artifact || llmCall}
  <div class="panel" transition:fly|local={{ x: 320, duration: 200 }}>
    <div class="panel-inner">
      {#if artifact}
        <ArtifactInspector artifact={artifact} />
      {:else if llmCall}
        <LlmInspector call={llmCall} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .panel {
    width: 340px; flex-shrink: 0;
    background: var(--bg-surface); border-left: 1px solid var(--border);
    overflow-y: auto; animation: slide-in .2s ease;
  }
  .panel-inner { padding: 16px; }
</style>
