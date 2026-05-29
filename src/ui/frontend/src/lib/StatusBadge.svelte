<script lang="ts">
  export let status: 'live' | 'idle' | 'reconnecting' | 'offline' = 'idle';
  export let label: string = '';

  const colors: Record<string, string> = {
    live: 'var(--success)',
    idle: 'var(--text-muted)',
    reconnecting: 'var(--warning)',
    offline: 'var(--error)',
  };
</script>

<span class="status-badge" style="--dot-color: {colors[status]};">
  <span class="dot" class:pulse={status === 'live'}></span>
  {#if label}<span class="label">{label}</span>{/if}
</span>

<style>
  .status-badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--text-secondary);
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--dot-color);
    flex-shrink: 0;
  }
  .dot.pulse { animation: pulse 2s ease-in-out infinite; }
  .label { white-space: nowrap; }
</style>
