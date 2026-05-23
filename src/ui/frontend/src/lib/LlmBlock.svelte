<script lang="ts">
  import type { CallBlock } from './types';
  import JsonView from './JsonView.svelte';
  import { respStore } from './store';

  export let block: CallBlock;
  export let onViewFull: (key: string) => void;

  let thinkOpen = true;   // open while running, collapses on done
  let respOpen  = true;

  // Auto-collapse thinking and open response when call finishes
  $: if (block.done) thinkOpen = false;

  // Try to parse response as JSON for structured display
  let parsedResp: unknown = null;
  let parseErr = false;
  $: {
    parsedResp = null;
    parseErr = false;
    if (block.response) {
      try { parsedResp = JSON.parse(block.response); }
      catch { parseErr = true; }
    }
  }

  // Scroll thinking box to bottom while it grows
  let thinkEl: HTMLElement;
  $: if (thinkEl && !block.done) thinkEl.scrollTop = thinkEl.scrollHeight;

  function fmtMs(ms?: number) {
    if (!ms) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  const ROLE_COLOR: Record<string, string> = {
    reasoning: 'var(--blue)',
    critic:    'var(--orange)',
    proposer:  'var(--purple)',
    repair:    'var(--orange)',
    judge:     'var(--yellow)',
    planner:   'var(--cyan)',
    llm:       'var(--text2)',
  };

  $: roleColor = ROLE_COLOR[block.role] ?? 'var(--text2)';
  $: respKey   = 'r' + block.id;

  // Detect known response shapes for a richer card view
  $: isParsedObj = parsedResp !== null && typeof parsedResp === 'object' && !Array.isArray(parsedResp);
  $: resp = parsedResp as Record<string, unknown>;

  $: charLabel = block.response
    ? block.response.length.toLocaleString() + ' chars' + (block.response.endsWith('…') ? ' (truncated)' : '')
    : '';
</script>

<div class="block" class:running={!block.done}>
  <!-- Header -->
  <div class="hdr">
    <span class="role" style="color:{roleColor}">{block.role.toUpperCase()}</span>
    {#if block.model}<span class="model">{block.model.slice(0, 34)}</span>{/if}
    {#if block.artifactId}<span class="art">{block.artifactId.slice(0, 10)}</span>{/if}
    <span class="timing">
      {#if !block.done}
        <span class="spinner"></span>running…
      {:else}
        {fmtMs(block.ms)}
        <span class="ts">{new Date(block.ts).toISOString().slice(11,19)}</span>
      {/if}
    </span>
  </div>

  <!-- Prompt preview -->
  {#if block.prompt}
    <div class="prompt">{block.prompt.slice(0, 140)}{block.prompt.length > 140 ? '…' : ''}</div>
  {/if}

  <!-- Thinking -->
  {#if block.thinking || !block.done}
    <div class="section think-section">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="sec-hdr" on:click={() => thinkOpen = !thinkOpen}>
        <span class="sec-icon">💭</span>
        <span class="sec-label think-label">Thinking</span>
        {#if block.thinkWords > 0}
          <span class="sec-meta">{block.thinkWords.toLocaleString()} words</span>
        {/if}
        <span class="sec-toggle">{thinkOpen ? 'collapse ▲' : 'expand ▼'}</span>
      </div>
      {#if thinkOpen}
        <pre class="think-body" bind:this={thinkEl}>{block.thinking || ' '}</pre>
      {/if}
    </div>
  {/if}

  <!-- Response -->
  {#if block.response}
    <div class="section resp-section">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="sec-hdr" on:click={() => respOpen = !respOpen}>
        <span class="sec-icon">📤</span>
        <span class="sec-label resp-label">Response</span>
        <span class="sec-meta">{charLabel}</span>
        <span class="sec-timing">{fmtMs(block.ms)}</span>
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <button class="view-btn" on:click|stopPropagation={() => onViewFull(respKey)}>
          View full ↗
        </button>
      </div>
      {#if respOpen}
        <div class="resp-body">
          {#if isParsedObj}
            <!-- Structured view for parsed JSON objects -->
            <div class="resp-structured">
              {#each Object.entries(resp) as [k, v]}
                <div class="resp-field">
                  <div class="resp-field-key">{k}</div>
                  {#if typeof v === 'string' && v.length > 0}
                    {#if k === 'sourceCode' || k === 'code'}
                      <pre class="resp-code">{v}</pre>
                    {:else if k === 'reasoning' || k === 'critique' || k === 'explanation' || k === 'rationale'}
                      <p class="resp-prose italic">{v}</p>
                    {:else if k === 'hypothesis' || k === 'hypothesisText' || k === 'answer'}
                      <p class="resp-prose bold">{v}</p>
                    {:else if k === 'suggestion' || k === 'goal'}
                      <p class="resp-prose">{v}</p>
                    {:else}
                      <div class="resp-field-val"><JsonView value={v} /></div>
                    {/if}
                  {:else if typeof v === 'number' && (k === 'score' || k === 'confidence')}
                    <div class="resp-score-row">
                      <div class="resp-score-bar">
                        <div class="resp-score-fill" style="width:{Math.min(100,v)}%;background:{v>=80?'var(--green)':v>=60?'var(--blue)':'var(--red)'}"></div>
                      </div>
                      <span class="resp-score-num" style="color:{v>=80?'var(--green)':v>=60?'var(--blue)':'var(--red)'}">{v}</span>
                    </div>
                  {:else if typeof v === 'number' && k === 'confidenceLevel'}
                    <div class="conf-dots">
                      {#each Array(4) as _, i}
                        <div class="conf-dot" class:on={i < v} class:hi={i < v && i >= 2}></div>
                      {/each}
                    </div>
                  {:else}
                    <div class="resp-field-val"><JsonView value={v} /></div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <!-- Fallback: pre-formatted text -->
            <pre class="resp-raw">{block.response}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .block {
    border: 1px solid var(--bg4);
    border-radius: 6px;
    background: var(--bg2);
    overflow: hidden;
  }
  .block.running { border-color: var(--blue); box-shadow: 0 0 0 1px #58a6ff14; }

  /* Header */
  .hdr {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 10px;
    background: var(--bg3);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .role  { font-size: 10px; font-weight: 700; letter-spacing: .5px; }
  .model { font-size: 9px; color: var(--text3); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .art   { font-size: 9px; color: var(--text3); font-family: monospace; background: var(--bg); padding: 1px 5px; border-radius: 3px; }
  .timing { margin-left: auto; font-size: 10px; color: var(--text2); display: flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ts    { font-size: 9px; color: var(--text3); }

  /* Prompt strip */
  .prompt {
    padding: 3px 10px 4px;
    font-size: 10px; color: var(--text3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--border);
    font-style: italic;
  }

  /* Spinner */
  .spinner {
    display: inline-block; width: 8px; height: 8px;
    border: 1.5px solid var(--border); border-top-color: var(--blue);
    border-radius: 50%; animation: spin .7s linear infinite;
  }

  /* Shared section */
  .section { }
  .sec-hdr {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 10px; cursor: pointer; user-select: none;
  }
  .sec-hdr:hover { background: rgba(255,255,255,.03); }
  .sec-icon  { font-size: 11px; }
  .sec-label { font-size: 10px; font-weight: 700; }
  .sec-meta  { font-size: 9px; color: var(--text3); font-variant-numeric: tabular-nums; }
  .sec-timing{ font-size: 9px; color: var(--text3); margin-left: auto; font-variant-numeric: tabular-nums; }
  .sec-toggle{ font-size: 9px; color: var(--text3); margin-left: auto; }

  /* Thinking */
  .think-section { border-bottom: 1px solid var(--think-border); background: var(--think-bg); }
  .think-label   { color: var(--think-text); }
  .think-body {
    padding: 8px 12px 10px;
    font-family: 'Consolas', 'Fira Code', monospace;
    font-size: 11px; line-height: 1.7;
    color: #c4a84e; font-style: italic;
    white-space: pre-wrap; word-break: break-word;
    max-height: 280px; overflow-y: auto;
  }

  /* Response */
  .resp-section { background: var(--resp-bg); }
  .resp-label   { color: var(--resp-text); }
  .resp-section .sec-hdr { border-bottom: 1px solid var(--resp-border); }
  .view-btn {
    font-size: 9px; color: var(--blue); background: none;
    border: 1px solid var(--resp-border); border-radius: 3px;
    padding: 1px 6px; cursor: pointer; flex-shrink: 0;
    transition: border-color .15s;
  }
  .view-btn:hover { border-color: var(--blue); }

  .resp-body { padding: 10px 12px; max-height: 400px; overflow-y: auto; }

  /* Structured response */
  .resp-structured { display: flex; flex-direction: column; gap: 10px; }
  .resp-field { }
  .resp-field-key {
    font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
    color: var(--text3); margin-bottom: 3px;
  }
  .resp-field-val { }
  .resp-prose {
    font-size: 11px; line-height: 1.7; color: var(--text2);
    white-space: pre-wrap; word-break: break-word;
  }
  .resp-prose.italic { font-style: italic; }
  .resp-prose.bold   { color: var(--text); font-weight: 500; }
  .resp-code {
    font-family: 'Consolas', monospace; font-size: 10px; color: var(--cyan);
    background: var(--bg); padding: 8px 10px; border-radius: 4px;
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;
    border: 1px solid var(--border);
  }
  .resp-raw {
    font-family: 'Consolas', monospace; font-size: 11px; color: var(--text2);
    white-space: pre-wrap; word-break: break-word;
    line-height: 1.7;
  }

  /* Score bar */
  .resp-score-row  { display: flex; align-items: center; gap: 8px; }
  .resp-score-bar  { flex: 1; height: 5px; background: var(--bg3); border-radius: 3px; overflow: hidden; max-width: 120px; }
  .resp-score-fill { height: 100%; border-radius: 3px; transition: width .4s; }
  .resp-score-num  { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* Confidence dots */
  .conf-dots { display: flex; gap: 4px; margin-top: 2px; }
  .conf-dot  { width: 9px; height: 9px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); }
  .conf-dot.on   { background: var(--blue); border-color: var(--blue); }
  .conf-dot.on.hi{ background: var(--green); border-color: var(--green); }
</style>
