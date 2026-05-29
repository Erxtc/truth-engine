<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Artifact } from './types';

  export let artifact: Artifact;

  const dispatch = createEventDispatcher();

  $: sc = artifact.score ?? 0;
  $: statusColors: Record<string, string> = {
    active: 'var(--accent)',
    lemma: 'var(--success)',
    dead: 'var(--text-muted)',
  };
  $: dotColor = statusColors[artifact.status] ?? 'var(--text-muted)';
</script>

<div class="inspector">
  <div class="insp-hdr">
    <h3>Artifact Detail</h3>
    <button class="close-btn" on:click={() => dispatch('close')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <div class="insp-body">
    <div class="id-row">
      <span class="id-label">ID</span>
      <code class="id-value">{artifact.id.slice(0, 32)}…</code>
    </div>

    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">Status</span>
        <span class="meta-value" style="color: {dotColor};">
          <span class="dot" style="background: {dotColor};"></span>
          {artifact.status}
        </span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Type</span>
        <span class="meta-value">{artifact.type}</span>
      </div>
      {#if artifact.depth !== undefined}
        <div class="meta-item">
          <span class="meta-label">Depth</span>
          <span class="meta-value">{artifact.depth}</span>
        </div>
      {/if}
      {#if artifact.confidenceLevel !== undefined}
        <div class="meta-item">
          <span class="meta-label">Confidence</span>
          <span class="meta-value">Level {artifact.confidenceLevel}</span>
        </div>
      {/if}
    </div>

    {#if artifact.score}
      <div class="score-section">
        <span class="section-label">Score</span>
        <div class="score-row">
          <div class="score-track">
            <div class="score-fill" style="width:{sc}%;background:{sc>=80?'var(--success)':sc>=60?'var(--accent)':'var(--error)'}"></div>
          </div>
          <span class="score-num" style="color:{sc>=80?'var(--success)':sc>=60?'var(--accent)':'var(--error)'}">{sc}</span>
        </div>
      </div>
    {/if}

    {#if artifact.hypothesisText}
      <div class="hyp-section">
        <span class="section-label">Hypothesis</span>
        <p class="hyp-text">{artifact.hypothesisText}</p>
      </div>
    {/if}

    {#if artifact.title && !artifact.hypothesisText}
      <div class="hyp-section">
        <span class="section-label">Title</span>
        <p class="hyp-text">{artifact.title}</p>
      </div>
    {/if}

    {#if artifact.sourceCode}
      <div class="code-section">
        <span class="section-label">Source Code</span>
        <pre class="code-block">{artifact.sourceCode}</pre>
      </div>
    {/if}
  </div>
</div>

<style>
  .inspector { display: flex; flex-direction: column; height: 100%; }
  .insp-hdr {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 16px;
  }
  h3 { font-size: 13px; font-weight: 600; }
  .close-btn {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; padding: 4px; border-radius: var(--radius-sm);
    display: flex; align-items: center;
  }
  .close-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }

  .insp-body { display: flex; flex-direction: column; gap: 16px; flex: 1; overflow-y: auto; }

  .id-row { }
  .id-label { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-muted); display: block; margin-bottom: 4px; }
  .id-value {
    font-size: 10px; font-family: 'JetBrains Mono', monospace; color: var(--text-muted);
    word-break: break-all;
  }

  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .meta-item {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px 10px;
  }
  .meta-label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: var(--text-muted); display: block; margin-bottom: 4px; }
  .meta-value { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
    color: var(--text-muted); margin-bottom: 8px; display: block; font-weight: 600;
  }

  .score-section { }
  .score-row { display: flex; align-items: center; gap: 10px; }
  .score-track { flex: 1; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
  .score-fill { height: 100%; border-radius: 3px; transition: width .4s ease; }
  .score-num { font-size: 18px; font-weight: 700; }

  .hyp-section { }
  .hyp-text {
    font-size: 12px; line-height: 1.6; color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-word;
  }

  .code-section { }
  .code-block {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    color: var(--info); background: var(--bg-base);
    padding: 10px 12px; border-radius: var(--radius-md);
    border: 1px solid var(--border);
    white-space: pre-wrap; word-break: break-word;
    max-height: 280px; overflow-y: auto; line-height: 1.5;
  }
</style>
