<script lang="ts">
  export let survived: number = 0;
  export let killed: number = 0;
  export let llmCalls: number = 0;
  export let repairs: number = 0;

  $: total = survived + killed;
  $: rate = total > 0 ? Math.round(survived / total * 100) : null;
</script>

<div class="mini-stats">
  <div class="section-label">Stats</div>
  <div class="grid">
    <div class="stat">
      <span class="val green">{survived}</span>
      <span class="lbl">survived</span>
    </div>
    <div class="stat">
      <span class="val red">{killed}</span>
      <span class="lbl">killed</span>
    </div>
    <div class="stat">
      <span class="val">{llmCalls}</span>
      <span class="lbl">calls</span>
    </div>
    <div class="stat">
      <span class="val">{repairs}</span>
      <span class="lbl">repairs</span>
    </div>
  </div>
  {#if rate !== null}
    <div class="rate-bar">
      <div class="rate-track">
        <div class="rate-fill" style="width:{rate}%"></div>
      </div>
      <span class="rate-label">{rate}% survival</span>
    </div>
  {/if}
</div>

<style>
  .mini-stats { }
  .section-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .8px; color: var(--text-muted); margin-bottom: 10px;
  }
  .grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
    margin-bottom: 10px;
  }
  .stat {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px; text-align: center;
  }
  .val {
    font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;
    display: block; line-height: 1.2;
  }
  .val.green { color: var(--success); }
  .val.red   { color: var(--error); }
  .lbl {
    font-size: 9px; text-transform: uppercase; letter-spacing: .3px;
    color: var(--text-muted); display: block; margin-top: 2px;
  }

  .rate-bar { display: flex; align-items: center; gap: 8px; }
  .rate-track {
    flex: 1; height: 3px; background: var(--bg-elevated);
    border-radius: 2px; overflow: hidden;
  }
  .rate-fill {
    height: 100%; border-radius: 2px;
    background: linear-gradient(90deg, var(--success), var(--accent));
    transition: width .5s ease;
  }
  .rate-label { font-size: 9px; color: var(--text-muted); white-space: nowrap; }
</style>
