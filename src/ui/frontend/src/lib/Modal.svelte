<script lang="ts">
  import { fade } from 'svelte/transition';
  export let show: boolean = false;
  export let title: string = '';
</script>

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="backdrop" transition:fade|local={{ duration: 120 }} on:click|self>
    <div class="modal" transition:fade|local={{ duration: 150 }}>
      <div class="header">
        <h3>{title}</h3>
        <button class="close" on:click><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
      </div>
      <div class="body">
        <slot />
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.7);
    backdrop-filter: blur(4px);
    z-index: 100; display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    max-width: 680px; width: 92vw;
    max-height: 82vh; display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,.5);
  }
  .header {
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  }
  h3 {
    font-size: 14px; font-weight: 600; color: var(--text-primary);
    flex: 1;
  }
  .close {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
  }
  .close:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .body { padding: 16px 20px; overflow-y: auto; flex: 1; }
</style>
