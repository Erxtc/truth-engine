<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { CallBlock } from './types';
  import JsonView from './JsonView.svelte';

  export let call: CallBlock;

  const dispatch = createEventDispatcher();

  $: parsedResp = (() => {
    if (!call.response) return null;
    try { return JSON.parse(call.response); } catch { return null; }
  })();

  function fmtMs(ms?: number) {
    if (!ms) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }
</script>

<div class="inspector">
  <div class="insp-hdr">
    <h3>LLM Call #{call.callNum}</h3>
    <button class="close-btn" on:click={() => dispatch('close')}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  </div>

  <div class="insp-body">
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-lbl">Role</span>
        <span class="meta-val">{call.role}</span>
      </div>
      <div class="meta-item">
        <span class="meta-lbl">Model</span>
        <span class="meta-val">{call.model || '—'}</span>
      </div>
      <div class="meta-item">
        <span class="meta-lbl">Step</span>
        <span class="meta-val">S{call.stepIndex + 1}</span>
      </div>
      <div class="meta-item">
        <span class="meta-lbl">Duration</span>
        <span class="meta-val">{fmtMs(call.ms) || 'running…'}</span>
      </div>
    </div>

    {#if call.prompt}
      <div class="section">
        <span class="sec-label">Prompt</span>
        <pre class="prompt">{call.prompt}</pre>
      </div>
    {/if}

    {#if call.thinking}
      <div class="section">
        <span class="sec-label">Thinking <span class="hint">({call.thinkWords.toLocaleString()} words)</span></span>
        <pre class="thinking">{call.thinking}</pre>
      </div>
    {/if}

    {#if call.response}
      <div class="section">
        <span class="sec-label">Response <span class="hint">({call.response.length.toLocaleString()} chars)</span></span>
        {#if parsedResp !== null && typeof parsedResp === 'object'}
          <div class="resp-json">
            <JsonView value={parsedResp} collapsed={false} />
          </div>
        {:else}
          <pre class="resp-raw">{call.response}</pre>
        {/if}
      </div>
    {/if}

    {#if call.usage}
      <div class="section">
        <span class="sec-label">Token Usage</span>
        <div class="usage-grid">
          <div class="usage-item">
            <span class="usage-num">{call.usage.prompt_tokens.toLocaleString()}</span>
            <span class="usage-lbl">prompt</span>
          </div>
          <div class="usage-item">
            <span class="usage-num">{call.usage.completion_tokens.toLocaleString()}</span>
            <span class="usage-lbl">completion</span>
          </div>
          <div class="usage-item">
            <span class="usage-num">{call.usage.total_tokens.toLocaleString()}</span>
            <span class="usage-lbl">total</span>
          </div>
        </div>
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

  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .meta-item {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px 10px;
  }
  .meta-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: var(--text-muted); display: block; }
  .meta-val { font-size: 12px; font-weight: 500; margin-top: 2px; display: block; }

  .section { }
  .sec-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .5px; color: var(--text-muted);
    margin-bottom: 8px; display: block;
  }
  .hint { font-weight: 400; text-transform: none; letter-spacing: 0; }

  .prompt, .thinking, .resp-raw {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    line-height: 1.6; padding: 10px 12px;
    background: var(--bg-base); border: 1px solid var(--border);
    border-radius: var(--radius-md);
    white-space: pre-wrap; word-break: break-word;
    max-height: 240px; overflow-y: auto;
    color: var(--text-secondary);
  }
  .thinking {
    background: var(--think-bg); border-color: var(--think-border);
    color: var(--think-text); font-style: italic;
  }
  .resp-json { }

  .usage-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .usage-item {
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-md); padding: 8px; text-align: center;
  }
  .usage-num { font-size: 13px; font-weight: 700; display: block; }
  .usage-lbl { font-size: 8px; text-transform: uppercase; color: var(--text-muted); margin-top: 2px; }
</style>
