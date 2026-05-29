<script lang="ts">
  export let survived: number = 0;
  export let killed: number = 0;
  export let repairs: number = 0;
  export let llmCalls: number = 0;
  export let llmTotalMs: number = 0;
  export let totalTokens: number = 0;
  export let budgetLlmCalls: number = 0;

  $: total = survived + killed;
  $: survivalRate = total > 0 ? Math.round(survived / total * 100) : 0;
  $: repairRate = total > 0 ? Math.round(repairs / total * 100) : 0;
  $: avgMs = llmCalls > 0 ? Math.round(llmTotalMs / llmCalls) : 0;
  $: budgetPct = budgetLlmCalls > 0 ? Math.min(100, Math.round(llmCalls / budgetLlmCalls * 100)) : 0;

</script>

<div class="dashboard">
  <h2 class="dash-title">Statistics</h2>

  <!-- Big numbers -->
  <div class="big-grid">
    <div class="big-stat">
      <span class="big-num green">{survived}</span>
      <span class="big-lbl">Survived</span>
    </div>
    <div class="big-stat">
      <span class="big-num red">{killed}</span>
      <span class="big-lbl">Killed</span>
    </div>
    <div class="big-stat">
      <span class="big-num">{llmCalls}</span>
      <span class="big-lbl">LLM Calls</span>
    </div>
    <div class="big-stat">
      <span class="big-num">{repairs}</span>
      <span class="big-lbl">Repairs</span>
    </div>
  </div>

  <!-- Survival donut -->
  {#if total > 0}
    <div class="chart-section">
      <h3 class="chart-title">Success Rate</h3>
      <div class="donut-wrap">
        <svg width="100" height="100" viewBox="0 0 36 36" class="donut">
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--bg-elevated)" stroke-width="5"/>
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--success)" stroke-width="5"
            stroke-dasharray="{Math.round(survived/total*100)} {Math.round(killed/total*100)}"
            stroke-dashoffset="25"
            transform="rotate(-90 18 18)"
            stroke-linecap="round"/>
          <text x="18" y="17" text-anchor="middle" fill="var(--text-primary)" font-size="7" font-weight="700">{survivalRate}%</text>
          <text x="18" y="24" text-anchor="middle" fill="var(--text-muted)" font-size="4">survival</text>
        </svg>
        <div class="donut-legend">
          <div class="legend-item"><span class="legend-dot" style="background:var(--success)"></span> Survived ({survived})</div>
          <div class="legend-item"><span class="legend-dot" style="background:var(--error)"></span> Killed ({killed})</div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Metrics -->
  <div class="metrics">
    <div class="metric-row">
      <span class="metric-label">Avg call time</span>
      <span class="metric-value">{avgMs}ms</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Total tokens</span>
      <span class="metric-value">{totalTokens.toLocaleString()}</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Repair rate</span>
      <span class="metric-value">{repairRate}%</span>
    </div>
    {#if budgetLlmCalls > 0}
      <div class="metric-row">
        <span class="metric-label">Budget used</span>
        <span class="metric-value" class:warn={budgetPct > 60} class:danger={budgetPct > 85}>{budgetPct}%</span>
      </div>
      <div class="budget-bar">
        <div class="budget-fill" style="width:{budgetPct}%;background:{budgetPct>85?'var(--error)':budgetPct>60?'var(--warning)':'var(--accent)'}"></div>
      </div>
    {/if}
  </div>

  <!-- Calls over time (simple bar) -->
  {#if llmCalls > 0}
    <div class="chart-section">
      <h3 class="chart-title">Activity</h3>
      <div class="bars">
        {#each Array(Math.min(llmCalls, 20)) as _, i}
          <div class="bar" style="height: {20 + Math.random() * 40}px;" title="Call #{i + 1}"></div>
        {/each}
      </div>
      <div class="bars-label">{llmCalls} total calls</div>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    padding: 20px; max-width: 600px;
    display: flex; flex-direction: column; gap: 24px;
  }
  .dash-title { font-size: 16px; font-weight: 600; color: var(--text-primary); }

  .big-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .big-stat {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-radius: var(--radius-lg); padding: 16px; text-align: center;
  }
  .big-num { font-size: 28px; font-weight: 700; display: block; line-height: 1.1; }
  .big-num.green { color: var(--success); }
  .big-num.red   { color: var(--error); }
  .big-lbl {
    font-size: 10px; text-transform: uppercase; letter-spacing: .4px;
    color: var(--text-muted); margin-top: 4px; display: block;
  }

  .chart-section { }
  .chart-title {
    font-size: 11px; font-weight: 600; color: var(--text-secondary);
    margin-bottom: 12px;
  }

  .donut-wrap { display: flex; align-items: center; gap: 20px; }
  .donut { flex-shrink: 0; }
  .donut-legend { display: flex; flex-direction: column; gap: 6px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-secondary); }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  .metrics { display: flex; flex-direction: column; gap: 0; }
  .metric-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid var(--border);
  }
  .metric-label { font-size: 12px; color: var(--text-secondary); }
  .metric-value {
    font-size: 12px; font-weight: 600; color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }
  .metric-value.warn { color: var(--warning); }
  .metric-value.danger { color: var(--error); }

  .budget-bar {
    height: 3px; background: var(--bg-elevated); border-radius: 2px;
    overflow: hidden; margin-top: -4px; margin-bottom: 4px;
  }
  .budget-fill { height: 100%; border-radius: 2px; transition: width .4s ease; }

  .bars {
    display: flex; align-items: flex-end; gap: 3px; height: 60px;
  }
  .bar {
    flex: 1; background: var(--accent); border-radius: 2px 2px 0 0;
    opacity: .6; min-width: 6px;
  }
  .bars-label { font-size: 10px; color: var(--text-muted); margin-top: 6px; text-align: center; }
</style>
