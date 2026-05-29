<script lang="ts">
  import type { CallBlock, UIEvent } from './types';
  import JsonView from './JsonView.svelte';
  import { selectedLlmCall } from './store';

  export let block: CallBlock;
  export let kids: UIEvent[] = [];

  function tsOf(t: number) { return new Date(t).toISOString().slice(11, 19); }

  function kidScore(e: UIEvent): number | null {
    if (e.detail && typeof (e.detail as any).score === 'number') return (e.detail as any).score;
    const m = e.msg.match(/score[=:]?\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  }
  function kidDecision(e: UIEvent): string | null {
    if (e.kind !== 'verdict') return null;
    const d = e.detail as any;
    return typeof d?.decision === 'string' ? d.decision : null;
  }
  function kidReason(e: UIEvent): string | null {
    const d = e.detail as any;
    const r = d?.reason ?? d?.critique ?? d?.explanation;
    return typeof r === 'string' && r.length > 0 ? r : null;
  }
  function kidMeta(e: UIEvent): string[] {
    if (e.kind !== 'verdict') return [];
    const d = e.detail as any;
    const tags: string[] = [];
    if (typeof d?.repairs === 'number' && d.repairs > 0) tags.push(`${d.repairs} repairs`);
    if (d?.advances_step) tags.push('advances');
    return tags;
  }

  const KID_COLOR: Record<string, string> = {
    'verdict':'var(--warning)','artifact:born':'var(--accent)','artifact:survived':'var(--success)',
    'artifact:killed':'var(--error)','repair:start':'var(--text-muted)','repair:done':'var(--success)',
  };

  let thinkOpen = true;
  let respOpen = true;
  let promptOpen = false;

  $: if (block.done) thinkOpen = false;

  let parsedResp: unknown = null;
  $: isTruncated = block.response.endsWith('…');
  $: {
    parsedResp = null;
    if (block.response) {
      try { parsedResp = JSON.parse(block.response); } catch {}
    }
  }

  let thinkEl: HTMLElement;
  $: if (thinkEl && !block.done) thinkEl.scrollTop = thinkEl.scrollHeight;

  function fmtMs(ms?: number) {
    if (!ms) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  // Roles currently active in the pipeline
  const ROLE_LABEL: Record<string, string> = {
    repair: 'Repair', supervisor: 'Supervise', 'task-agent': 'Task Agent',
    baseline: 'Baseline', llm: 'LLM',
  };
  const ROLE_COLOR: Record<string, string> = {
    repair: 'var(--warning)', supervisor: 'var(--accent)', 'task-agent': 'var(--accent)',
    baseline: 'var(--info)', llm: 'var(--text-secondary)',
  };

  $: roleColor = ROLE_COLOR[block.role] ?? 'var(--text-secondary)';
  $: roleName = ROLE_LABEL[block.role] ?? block.role.toUpperCase();
  $: isParsedObj = parsedResp !== null && typeof parsedResp === 'object' && !Array.isArray(parsedResp);
  $: resp = parsedResp as Record<string, unknown>;
  $: promptShort = block.prompt.length > 240 ? block.prompt.slice(0, 240) + '…' : block.prompt;
  $: charLabel = block.response
    ? block.response.length.toLocaleString() + ' chars' + (block.response.endsWith('…') ? ' (truncated)' : '')
    : '';
</script>

<div class="card" class:running={!block.done} style="--role-color: {roleColor};">
  <!-- Header -->
  <div class="card-hdr">
    <div class="hdr-left">
      <span class="call-num">#{block.callNum}</span>
      <span class="step-badge">S{block.stepIndex + 1}</span>
      <span class="role-name" style="color: var(--role-color);">{roleName}</span>
      {#if block.model}
        <span class="model-name">{block.model.slice(0, 24)}</span>
      {/if}
    </div>
    <div class="hdr-right">
      {#if !block.done}
        <span class="live-dot"></span>
        <span class="live-text">running</span>
      {:else}
        <span class="timing">{fmtMs(block.ms)}</span>
        <span class="ts">{tsOf(block.ts)}</span>
      {/if}
      {#if block.artifactId}
        <span class="art-id">{block.artifactId.slice(0, 8)}</span>
      {/if}
    </div>
  </div>

  <!-- Prompt -->
  {#if block.prompt}
    <div class="section">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <button class="sec-hdr" on:click={() => promptOpen = !promptOpen}>
        <svg class="sec-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>Prompt</span>
        <span class="sec-hint">{block.prompt.length.toLocaleString()} chars</span>
        <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          style="transform: rotate({promptOpen ? 180 : 0}deg);">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      {#if promptOpen}
        <pre class="prompt-body">{block.prompt}</pre>
      {:else}
        <div class="prompt-peek">{promptShort}</div>
      {/if}
    </div>
  {/if}

  <!-- Thinking -->
  {#if block.thinking || !block.done}
    <div class="section think-sec">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <button class="sec-hdr think-hdr" on:click={() => thinkOpen = !thinkOpen}>
        <svg class="sec-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Thinking</span>
        {#if block.thinkWords > 0}
          <span class="sec-hint">{block.thinkWords.toLocaleString()} words</span>
        {/if}
        <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          style="transform: rotate({thinkOpen ? 180 : 0}deg);">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      {#if thinkOpen}
        <pre class="think-body" bind:this={thinkEl}>{block.thinking || ' '}</pre>
      {/if}
    </div>
  {/if}

  <!-- Response -->
  {#if block.response}
    <div class="section resp-sec">
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <button class="sec-hdr resp-hdr" on:click={() => respOpen = !respOpen}>
        <svg class="sec-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>Response</span>
        <span class="sec-hint">{charLabel}</span>
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <button class="inspect-btn" on:click|stopPropagation={() => selectedLlmCall.set(block)} title="Inspect in panel">Inspect</button>
        <svg class="chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          style="transform: rotate({respOpen ? 180 : 0}deg);">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>
      {#if respOpen}
        <div class="resp-body">
          {#if isTruncated}
            <div class="trunc-notice">Response truncated at 4,000 chars</div>
          {/if}
          {#if isParsedObj}
            <div class="resp-fields">
              {#each Object.entries(resp) as [k, v]}
                <div class="resp-field">
                  <div class="field-key">{k}</div>
                  {#if typeof v === 'string' && v.length > 0}
                    {#if k === 'sourceCode' || k === 'code'}
                      <pre class="field-code">{v}</pre>
                    {:else if k === 'reasoning' || k === 'critique' || k === 'explanation' || k === 'rationale'}
                      <p class="field-prose italic">{v}</p>
                    {:else if k === 'hypothesis' || k === 'hypothesisText' || k === 'answer'}
                      <p class="field-prose bold">{v}</p>
                    {:else if k === 'suggestion' || k === 'goal'}
                      <p class="field-prose">{v}</p>
                    {:else}
                      <div class="field-json"><JsonView value={v} /></div>
                    {/if}
                  {:else if typeof v === 'number' && (k === 'score' || k === 'confidence')}
                    <div class="score-row">
                      <div class="score-track"><div class="score-fill" style="width:{Math.min(100, v)}%;background:{v>=80?'var(--success)':v>=60?'var(--accent)':'var(--error)'}"></div></div>
                      <span class="score-num" style="color:{v>=80?'var(--success)':v>=60?'var(--accent)':'var(--error)'}">{v}</span>
                    </div>
                  {:else if typeof v === 'number' && k === 'confidenceLevel'}
                    <div class="conf-dots">
                      {#each Array(4) as _, i}
                        <div class="conf-dot" class:on={i < v} class:hi={i < v && i >= 2}></div>
                      {/each}
                    </div>
                  {:else}
                    <div class="field-json"><JsonView value={v} /></div>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <pre class="resp-raw">{block.response}</pre>
          {/if}

          {#if block.usage}
            <div class="usage-footer">
              <span class="usage-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> {block.usage.prompt_tokens.toLocaleString()}</span>
              <span class="usage-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> {block.usage.completion_tokens.toLocaleString()}</span>
              <span class="usage-total">{block.usage.total_tokens.toLocaleString()} tokens</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- Child events -->
  {#if kids.length > 0}
    <div class="kids">
      {#each kids as kid}
        {@const sc = kidScore(kid)}
        {@const dec = kidDecision(kid)}
        {@const reason = kidReason(kid)}
        {@const meta = kidMeta(kid)}
        <div class="kid-row">
          <span class="kid-dot" style="background:{KID_COLOR[kid.kind] ?? 'var(--text-muted)'};"></span>
          <span class="kid-kind" style="color:{KID_COLOR[kid.kind] ?? 'var(--text-muted)'}">
            {kid.kind.replace('artifact:','').replace('repair:','')}
          </span>
          {#if sc !== null}
            <span class="kid-score" class:hi={sc >= 80} class:lo={sc < 60}>{sc}</span>
          {/if}
          {#if dec}
            <span class="kid-dec">{dec}</span>
          {/if}
          {#each meta as tag}
            <span class="kid-tag">{tag}</span>
          {/each}
          <span class="kid-msg">{kid.msg}</span>
          <span class="kid-ts">{tsOf(kid.ts)}</span>
          {#if reason}
            <div class="kid-reason">{reason}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--bg-surface); border: 1px solid var(--border);
    border-left: 3px solid var(--role-color);
    border-radius: var(--radius-lg); overflow: hidden;
    transition: border-color .2s, box-shadow .2s;
    animation: fade-in .2s ease;
  }
  .card.running {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px rgba(59,130,246,.1);
  }

  /* Header */
  .card-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: var(--bg-elevated);
    border-bottom: 1px solid var(--border); gap: 8px;
    flex-wrap: wrap;
  }
  .hdr-left { display: flex; align-items: center; gap: 8px; }
  .hdr-right { display: flex; align-items: center; gap: 8px; }

  .call-num { font-size: 10px; font-weight: 600; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .step-badge {
    font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: var(--radius-sm);
    background: var(--accent-dim); color: var(--accent);
  }
  .role-name { font-size: 10px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase; }
  .model-name { font-size: 10px; color: var(--text-muted); }
  .live-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .live-text { font-size: 10px; color: var(--accent); font-weight: 500; }
  .timing { font-size: 10px; color: var(--text-secondary); font-variant-numeric: tabular-nums; font-weight: 500; }
  .ts { font-size: 9px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .art-id {
    font-size: 9px; font-family: var(--mono); color: var(--text-muted);
    background: var(--bg-surface); padding: 2px 6px; border-radius: var(--radius-sm);
  }

  /* Sections */
  .section { }
  .sec-hdr {
    display: flex; align-items: center; gap: 8px;
    width: 100%; padding: 7px 12px; cursor: pointer;
    background: none; border: none; border-bottom: 1px solid var(--border);
    color: var(--text-secondary); font-size: 11px; font-weight: 500;
    font-family: inherit; text-align: left;
    transition: background .1s;
  }
  .sec-hdr:hover { background: rgba(255,255,255,.02); }
  .sec-icon { flex-shrink: 0; color: var(--text-muted); }
  .sec-hint { font-size: 10px; color: var(--text-muted); flex: 1; }
  .chevron { flex-shrink: 0; color: var(--text-muted); transition: transform .15s; }

  /* Prompt */
  .prompt-body {
    padding: 10px 14px; font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 11px; color: var(--text-secondary); line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
    max-height: 180px; overflow-y: auto;
    background: var(--bg-base);
  }
  .prompt-peek {
    padding: 4px 14px 8px; font-size: 10px; color: var(--text-muted);
    font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Thinking */
  .think-sec { background: var(--think-bg); }
  .think-hdr { border-bottom-color: var(--think-border); color: var(--think-text); }
  .think-body {
    padding: 10px 14px;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 11px; line-height: 1.7; color: var(--think-text);
    white-space: pre-wrap; word-break: break-word;
    max-height: 260px; overflow-y: auto; font-style: italic;
  }

  /* Response */
  .resp-sec { background: rgba(59,130,246,.03); }
  .resp-hdr { border-bottom-color: rgba(59,130,246,.15); color: var(--accent); }
  .inspect-btn {
    font-size: 9px; padding: 2px 8px; border-radius: var(--radius-sm);
    background: none; border: 1px solid rgba(59,130,246,.25);
    color: var(--accent); cursor: pointer; font-family: inherit;
    transition: background .15s;
  }
  .inspect-btn:hover { background: var(--accent-dim); }
  .resp-body { padding: 12px 14px; max-height: 380px; overflow-y: auto; }

  .resp-fields { display: flex; flex-direction: column; gap: 12px; }
  .resp-field { }
  .field-key {
    font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
    color: var(--text-muted); margin-bottom: 4px; font-weight: 600;
  }
  .field-prose {
    font-size: 12px; line-height: 1.6; color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-word;
  }
  .field-prose.italic { font-style: italic; }
  .field-prose.bold { color: var(--text-primary); font-weight: 500; }
  .field-code {
    font-family: 'JetBrains Mono', 'Consolas', monospace; font-size: 10px;
    color: var(--info); background: var(--bg-base); padding: 8px 10px;
    border-radius: var(--radius-md); white-space: pre-wrap; word-break: break-word;
    max-height: 180px; overflow-y: auto; border: 1px solid var(--border);
  }
  .field-json { }
  .resp-raw {
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    color: var(--text-secondary); white-space: pre-wrap; word-break: break-word;
    line-height: 1.6;
  }

  .score-row { display: flex; align-items: center; gap: 10px; }
  .score-track { flex: 1; height: 5px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; max-width: 140px; }
  .score-fill { height: 100%; border-radius: 3px; transition: width .4s ease; }
  .score-num { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }

  .conf-dots { display: flex; gap: 4px; margin-top: 2px; }
  .conf-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--bg-elevated); border: 1px solid var(--border); }
  .conf-dot.on { background: var(--accent); border-color: var(--accent); }
  .conf-dot.on.hi { background: var(--success); border-color: var(--success); }

  .trunc-notice {
    font-size: 10px; color: var(--warning); background: var(--warning-dim);
    border: 1px solid rgba(245,158,11,.25); border-radius: var(--radius-sm);
    padding: 6px 10px; margin-bottom: 10px;
  }

  /* Usage */
  .usage-footer {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .usage-pill {
    font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums;
    display: flex; align-items: center; gap: 4px;
    background: var(--bg-elevated); padding: 2px 8px; border-radius: 10px;
  }
  .usage-total { font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; margin-left: auto; }

  /* Kids */
  .kids {
    border-top: 1px solid var(--border); background: var(--bg-base);
    padding: 3px 0;
  }
  .kid-row {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 14px; font-size: 10px; flex-wrap: wrap;
  }
  .kid-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .kid-kind {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .3px; width: 44px; flex-shrink: 0;
  }
  .kid-score {
    font-size: 9px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--text-muted); flex-shrink: 0;
  }
  .kid-score.hi { color: var(--success); }
  .kid-score.lo { color: var(--error); }
  .kid-dec {
    font-size: 9px; font-weight: 600; color: var(--warning);
    text-transform: uppercase; flex-shrink: 0;
  }
  .kid-tag {
    font-size: 8px; color: var(--text-muted); flex-shrink: 0;
    background: var(--bg-elevated); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 1px 5px;
  }
  .kid-msg {
    flex: 1; color: var(--text-muted); min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .kid-ts { font-size: 9px; color: var(--text-muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .kid-reason {
    width: 100%; padding: 3px 0 3px 16px;
    font-size: 9px; color: var(--text-muted); font-style: italic;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  }
</style>
