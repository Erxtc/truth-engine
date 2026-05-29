<script lang="ts">
  import StatusBadge from './StatusBadge.svelte';
  import Modal from './Modal.svelte';

  export let problemDescription: string = '';
  export let domain: string = '';
  export let elapsed: string = '0:00';
  export let connStatus: string = 'connecting';

  let showProblem = false;

  function statusLabel(s: string): 'live' | 'idle' | 'reconnecting' | 'offline' {
    if (s === 'live') return 'live';
    if (s === 'connecting' || s === 'reconnecting') return 'reconnecting';
    return 'offline';
  }
</script>

<header>
  <div class="brand">
    <svg class="logo-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 6v6l4 2"/>
    </svg>
    <span class="logo-text">truth-engine</span>
  </div>

  <button class="problem-pill" on:click={() => showProblem = true} title="Click for full description">
    {problemDescription
      ? (problemDescription.length > 100 ? problemDescription.slice(0, 100) + '…' : problemDescription)
      : 'No problem loaded'}
  </button>

  {#if domain}
    <span class="domain-badge">{domain}</span>
  {/if}

  <span class="timer">{elapsed}</span>

  <StatusBadge status={statusLabel(connStatus)} label={connStatus} />
</header>

<Modal show={showProblem} title="Problem Description" on:click={() => showProblem = false}>
  <p>{problemDescription || '—'}</p>
</Modal>

<style>
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 16px; background: var(--bg-surface);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
    height: 44px;
  }
  .brand {
    display: flex; align-items: center; gap: 8px;
    flex-shrink: 0;
  }
  .logo-text {
    font-size: 13px; font-weight: 700; color: var(--text-primary);
    letter-spacing: -0.3px;
  }
  .problem-pill {
    flex: 1; background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 4px 12px;
    font-size: 11px; color: var(--text-secondary); font-family: inherit;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
    transition: border-color .15s;
  }
  .problem-pill:hover { border-color: var(--accent); }
  .domain-badge {
    font-size: 10px; padding: 2px 10px; border-radius: 10px;
    background: var(--accent-dim); color: var(--accent);
    font-weight: 500; white-space: nowrap; flex-shrink: 0;
  }
  .timer {
    font-size: 11px; color: var(--text-muted);
    font-variant-numeric: tabular-nums; flex-shrink: 0;
  }
</style>
