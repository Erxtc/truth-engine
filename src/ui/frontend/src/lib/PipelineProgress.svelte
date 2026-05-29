<script lang="ts">
  import type { StepPlan } from './types';

  export let stepPlan: StepPlan | null = null;
  export let currentStep: number = 0;
  export let agentName: string = 'idle';
  export let running: boolean = false;

  $: solved = agentName.toLowerCase().includes('solved');
  $: isRepairing = agentName.toLowerCase().includes('repair');
  $: phase = solved ? 'solved' : !stepPlan ? 'planning' : isRepairing ? 'repairing' : 'running';
</script>

<div class="pipeline">
  <div class="section-label">Pipeline</div>

  <div class="phases">
    <!-- Detect -->
    <div class="phase done">
      <div class="node done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg></div>
      <div class="line done"></div>
      <span class="phase-label">Detect</span>
    </div>

    <!-- Analyze -->
    <div class="phase" class:done={!!stepPlan || solved} class:active={!stepPlan && running}>
      <div class="node" class:done={!!stepPlan || solved} class:active={!stepPlan && running}>
        {#if stepPlan || solved}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
        {:else if running}
          <span class="spinner"></span>
        {:else}
          <span class="num">2</span>
        {/if}
      </div>
      <div class="line" class:done={!!stepPlan || solved}></div>
      <span class="phase-label">Analyze</span>
    </div>

    <!-- Plan -->
    <div class="phase" class:done={!!stepPlan || solved} class:active={running && !stepPlan}>
      <div class="node" class:done={!!stepPlan || solved} class:active={running && !stepPlan}>
        {#if stepPlan || solved}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
        {:else if running && !stepPlan}
          <span class="spinner"></span>
        {:else}
          <span class="num">3</span>
        {/if}
      </div>
      <div class="line" class:done={solved}></div>
      <span class="phase-label">Plan</span>
    </div>

    <!-- Steps (dynamic) -->
    {#if stepPlan}
      {#each stepPlan.steps as step, i}
        {@const done = step.index < currentStep || solved}
        {@const active = step.index === currentStep && !solved}
        <div class="phase" class:done class:active>
          <div class="node" class:done class:active>
            {#if done}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>
            {:else if active}
              <span class="spinner"></span>
            {:else}
              <span class="num">{step.index + 1}</span>
            {/if}
          </div>
          {#if step.index < stepPlan.steps.length - 1}
            <div class="line" class:done={done}></div>
          {/if}
          <span class="phase-label step-label" title={step.goal}>
            {step.goal.length > 28 ? step.goal.slice(0, 28) + '…' : step.goal}
          </span>
        </div>

        <!-- Repair sub-step -->
        {#if active && isRepairing}
          <div class="phase active repair">
            <div class="node active">
              <span class="spinner small"></span>
            </div>
            <span class="phase-label repair-label">Repair</span>
          </div>
        {/if}
      {/each}
    {/if}

    <!-- Solved -->
    {#if solved}
      <div class="phase done">
        <div class="node solved">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--success)" stroke="var(--success)" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5" stroke="var(--bg-surface)" stroke-width="2.5"/>
          </svg>
        </div>
        <span class="phase-label solved-label">Solved</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .pipeline { }
  .section-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .8px; color: var(--text-muted); margin-bottom: 12px;
  }

  .phases { display: flex; flex-direction: column; gap: 0; }
  .phase {
    display: flex; align-items: center; gap: 0;
    position: relative;
    margin-left: 6px;
    min-height: 28px;
  }

  .node {
    width: 20px; height: 20px; border-radius: 50%;
    border: 2px solid var(--border-strong);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; z-index: 1; background: var(--bg-surface);
    color: var(--text-muted);
  }
  .node .num { font-size: 9px; font-weight: 600; }
  .node.done { border-color: var(--success); color: var(--success); background: var(--success-dim); }
  .node.active { border-color: var(--accent); background: var(--accent-dim); }
  .node.solved { border-color: var(--success); background: var(--success-dim); }

  .line {
    width: 2px; height: 18px; background: var(--border-strong);
    position: absolute; left: 9px; top: 20px;
  }
  .line.done { background: var(--success); }

  .spinner {
    width: 10px; height: 10px;
    border: 2px solid var(--border-strong); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  .spinner.small { width: 8px; height: 8px; border-width: 1.5px; }

  .phase-label {
    font-size: 10px; color: var(--text-muted); font-weight: 500;
    margin-left: 10px; white-space: nowrap;
  }
  .phase.active .phase-label { color: var(--text-primary); }
  .phase.done .phase-label { color: var(--text-secondary); }
  .step-label { font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
  .repair-label { color: var(--warning) !important; font-size: 10px; }
  .solved-label { color: var(--success) !important; font-weight: 600; font-size: 11px; }

  .repair { margin-left: 16px; }
</style>
