<script lang="ts">
  import { onMount, afterUpdate } from 'svelte';
  import {
    visibleFeed, feedItems, artifacts, runState, agentState,
    stats, filter, selectedArtifact, respStore, type Filter,
  } from './lib/store';
  import { connectSSE, pollState, pollArtifacts, onConnState } from './lib/sse';
  import LlmBlock from './lib/LlmBlock.svelte';
  import JsonView from './lib/JsonView.svelte';
  import ArtifactNode from './lib/ArtifactNode.svelte';
  import type { Artifact, EventItem, FeedItem } from './lib/types';

  // ── Connection state ────────────────────────────────────────────────
  let connStatus = 'connecting';
  onConnState(s => { connStatus = s.status; });

  // ── Elapsed timer ───────────────────────────────────────────────────
  let elapsed = '0:00';
  const startTime = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    elapsed = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  // ── Autoscroll ──────────────────────────────────────────────────────
  let feedEl: HTMLElement;
  let autoScroll = true;
  function onFeedScroll() {
    autoScroll = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  }
  afterUpdate(() => {
    if (autoScroll && feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  });

  // ── Modals ──────────────────────────────────────────────────────────
  let showProblem = false;
  let showResp    = false;
  let respModalText = '';
  let respModalTitle = '';

  function openResp(key: string) {
    respModalText  = $respStore[key] ?? '';
    respModalTitle = key;
    showResp = true;
  }

  // ── Expanded events (click to show detail) ──────────────────────────
  let expanded = new Set<number>();
  function toggleExpand(id: number) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    expanded = expanded;
  }

  // ── Artifact tree ───────────────────────────────────────────────────
  let selArtId: string | null = null;
  function selectArt(a: Artifact) {
    selArtId = a.id;
    selectedArtifact.set(a);
  }

  $: kids  = buildKids($artifacts);
  $: roots = $artifacts.filter(a => !a.parentId);

  function buildKids(arts: Artifact[]) {
    const m: Record<string, Artifact[]> = {};
    for (const a of arts) if (a.parentId) (m[a.parentId] ??= []).push(a);
    return m;
  }

  // ── Derived ─────────────────────────────────────────────────────────
  $: problem    = $runState.problem;
  $: stepPlan   = $runState.stepPlan;
  $: curStep    = $runState.currentStep;
  $: runParams  = $runState.runParams;
  $: curGoal    = stepPlan?.steps?.[curStep]?.goal;
  $: budgetPct  = runParams?.budgetLlmCalls
    ? Math.min(100, Math.round($stats.llmCalls / runParams.budgetLlmCalls * 100))
    : 0;
  $: avgMs      = $stats.llmCalls > 0
    ? fmtMs(Math.round($stats.llmTotalMs / $stats.llmCalls))
    : '—';

  // ── Helpers ─────────────────────────────────────────────────────────
  function fmtMs(ms?: number) {
    if (!ms) return '';
    return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }
  function tsOf(t: number) { return new Date(t).toISOString().slice(11, 19); }

  const KIND_COLOR: Record<string, string> = {
    'artifact:survived': 'var(--green)',  'artifact:killed': 'var(--red)',
    'verdict':           'var(--yellow)', 'step:advanced':   'var(--purple)',
    'planner:done':      'var(--purple)', 'repair:start':    'var(--orange)',
    'repair:done':       'var(--orange)', 'insight':         'var(--cyan)',
    'artifact:born':     'var(--blue)',   'agent:run':       'var(--text3)',
    'problem:solved':    'var(--green)',
  };
  const ICONS: Record<string, string> = {
    'artifact:survived':'✓','artifact:killed':'✗','verdict':'⚖','step:advanced':'▶',
    'repair:start':'🔧','repair:done':'✓','planner:done':'📋','insight':'💡',
    'artifact:born':'◎','problem:solved':'★','agent:run':'→','info':'·',
  };
  const TYPE_LABEL: Record<string, string> = {
    'artifact:survived':'survived','artifact:killed':'killed','verdict':'verdict',
    'step:advanced':'step','repair:start':'repair','repair:done':'repaired',
    'planner:done':'planner','insight':'insight','artifact:born':'born',
    'agent:run':'agent','problem:solved':'solved','info':'info',
  };

  function supMatch(msg: string) {
    return msg.match(/^supervisor: (escalate|pivot|abort) — (.*)/);
  }

  function setFilter(f: string) { filter.set(f as Filter); }
  function feedKey(item: FeedItem) { return item.kind === 'call' ? item.id : item.event.id; }

  function getScore(msg: string): number | null {
    const m = msg.match(/score=(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function getScoreParts(score: number) {
    const bg = score >= 80 ? '#0a1f12' : score >= 60 ? '#1f1a0a' : '#1f0a0a';
    const fg = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)';
    return { bg, fg };
  }

  // Parse event detail for display
  function parseDetail(detail: unknown): unknown {
    if (!detail) return null;
    // Strip large fields already shown in the block
    if (typeof detail === 'object' && detail !== null) {
      const { prompt, responsePreview, thinking, ...rest } = detail as Record<string, unknown>;
      return Object.keys(rest).length ? rest : null;
    }
    return detail;
  }

  onMount(() => {
    connectSSE();
    pollState();
    pollArtifacts();
    const pi = setInterval(pollState, 5000);
    const ai = setInterval(pollArtifacts, 3000);
    return () => { clearInterval(pi); clearInterval(ai); };
  });
</script>

<!-- ── Layout ──────────────────────────────────────────────────────────── -->
<div class="root">

  <!-- Header -->
  <header>
    <span class="logo">⚙ truth-engine</span>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="problem-pill" title="Click for full text" on:click={() => showProblem = true}>
      {problem?.description
        ? (problem.description.length > 110 ? problem.description.slice(0, 110) + '…' : problem.description)
        : 'Loading…'}
    </div>
    <span class="badge">{problem?.domain ?? '—'}</span>
    <span class="badge">{elapsed}</span>
    <span class="badge" class:live={connStatus === 'live'}>
      {#if connStatus === 'live'}● live{:else}{connStatus}…{/if}
    </span>
  </header>

  <!-- Agent bar -->
  <div class="agent-bar">
    {#if $agentState.running}<span class="spinner"></span>{/if}
    <span class="agent-label">agent:</span>
    <span class="agent-name" class:running={$agentState.running}>{$agentState.name}</span>
    {#if runParams?.budgetLlmCalls}
      <span class="badge budget-badge"
        style="margin-left:auto;border-color:{budgetPct>80?'var(--red)':budgetPct>55?'var(--orange)':'var(--border)'};color:{budgetPct>80?'var(--red)':budgetPct>55?'var(--orange)':'var(--text2)'}">
        {budgetPct}% budget
      </span>
    {/if}
  </div>

  <!-- Direction bar -->
  {#if curGoal}
    <div class="dir-bar">
      <span class="dir-step">Step {curStep + 1}{stepPlan ? ` / ${stepPlan.steps.length}` : ''}</span>
      <span class="dir-sep">→</span>
      <span class="dir-goal">{curGoal}</span>
    </div>
  {/if}

  <!-- 3-column grid -->
  <div class="grid">

    <!-- ── LEFT: Config + Plan ─────────────────────────────────────── -->
    <div class="panel">
      <div class="panel-head">Config &amp; Plan</div>
      <div class="panel-body">

        {#if runParams}
          <div class="sec-head">Run Params</div>
          <div class="cfg-grid">
            <div class="cfg-cell"><div class="cfg-lbl">Depth</div><div class="cfg-val">{runParams.maxDepth ?? '—'}</div></div>
            <div class="cfg-cell"><div class="cfg-lbl">Branches</div><div class="cfg-val">{runParams.maxBranches ?? '—'}</div></div>
            <div class="cfg-cell"><div class="cfg-lbl">Critics</div><div class="cfg-val">{runParams.criticCount ?? '—'}</div></div>
            <div class="cfg-cell"><div class="cfg-lbl">Confidence</div><div class="cfg-val">{runParams.requiredConfidence ?? '—'}</div></div>
          </div>
          {#if runParams.budgetLlmCalls}
            <div class="budget-wrap">
              <div class="budget-labels"><span>LLM budget</span><span>{$stats.llmCalls} / {runParams.budgetLlmCalls}</span></div>
              <div class="budget-track"><div class="budget-fill" style="width:{budgetPct}%;background:{budgetPct>80?'var(--red)':budgetPct>55?'var(--orange)':'var(--blue)'}"></div></div>
            </div>
          {/if}
        {/if}

        <div class="sec-head">Stats</div>
        <div class="stat-row"><span class="stat-lbl">✓ Survived</span><span class="stat-val green">{$stats.survived}</span></div>
        <div class="stat-row"><span class="stat-lbl">✗ Killed</span><span class="stat-val red">{$stats.killed}</span></div>
        <div class="stat-row"><span class="stat-lbl">🔧 Repairs</span><span class="stat-val orange">{$stats.repairs}</span></div>
        <div class="stat-row"><span class="stat-lbl">⏱ LLM calls</span><span class="stat-val blue">{$stats.llmCalls}</span></div>
        <div class="stat-row"><span class="stat-lbl">⌀ Avg time</span><span class="stat-val blue">{avgMs}</span></div>

        {#if stepPlan}
          <div class="sec-head" style="margin-top:6px">Step Plan</div>
          {#each stepPlan.steps as step}
            {@const done = step.index < curStep}
            {@const cur  = step.index === curStep}
            <div class="step-item" class:cur class:done>
              <div class="step-num">{done ? '✓' : cur ? '▶' : '○'} Step {step.index}</div>
              <div class="step-goal">{step.goal}</div>
              {#if step.oracle_hint}<div class="step-oracle">{step.oracle_hint}</div>{/if}
            </div>
          {/each}
          {#if stepPlan.rationale}
            <div class="rationale">{stepPlan.rationale}</div>
          {/if}
        {:else}
          <div class="muted">Waiting for planner…</div>
        {/if}

      </div>
    </div>

    <!-- ── CENTER: Feed ────────────────────────────────────────────── -->
    <div class="panel">
      <div class="panel-head">
        Live Activity
        <span class="ev-count">{$feedItems.length} events</span>
        <div class="ftabs">
          {#each ['all','llm','system','artifacts'] as f}
            <button class="ftab" class:on={$filter === f} on:click={() => setFilter(f)}>
              {f}
            </button>
          {/each}
        </div>
      </div>
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="panel-body feed-scroll" bind:this={feedEl} on:scroll={onFeedScroll}>

        {#each $visibleFeed as item (feedKey(item))}

          {#if item.kind === 'call'}
            <LlmBlock block={item} onViewFull={openResp} />

          {:else}
            {@const evItem = item}
            {@const e = evItem.kind === 'event' ? evItem.event : null}
            {#if e}
            {@const sup = supMatch(e.msg)}
            {@const score = getScore(e.msg)}
            {@const detail = parseDetail(e.detail)}

            {#if e.kind === 'problem:solved'}
              <div class="solved-banner">
                <div class="solved-title">★ PROBLEM SOLVED</div>
                <div class="solved-msg">{e.msg}</div>
              </div>

            {:else if sup}
              {@const action = sup[1]}
              <div class="sup-card" data-act={action}>
                <div class="sup-head">
                  <span class="sup-action">
                    {action === 'escalate' ? '⬆ ESCALATE' : action === 'pivot' ? '↻ PIVOT' : '✕ ABORT'}
                  </span>
                  <span class="sup-ts">{tsOf(e.ts)}</span>
                </div>
                <div class="sup-reason">{sup[2]}</div>
              </div>

            {:else}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div class="ev-row" data-k={e.kind}
                class:expandable={!!detail}
                on:click={() => detail && toggleExpand(e.id)}>
                <span class="ev-icon">{ICONS[e.kind] ?? '·'}</span>
                <span class="ev-type" style="color:{KIND_COLOR[e.kind] ?? 'var(--text2)'}">
                  {TYPE_LABEL[e.kind] ?? e.kind}
                </span>
                {#if score !== null}
                  {@const {bg,fg} = getScoreParts(score)}
                  <span class="score-pill" style="background:{bg};color:{fg};border-color:{fg}">{score}</span>
                {/if}
                <span class="ev-msg">{e.msg}</span>
                <span class="ev-ts">{tsOf(e.ts)}</span>
                {#if detail && expanded.has(e.id)}
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div class="ev-detail" on:click|stopPropagation>
                    <JsonView value={detail} />
                  </div>
                {/if}
              </div>
            {/if}
            {/if}
          {/if}

        {/each}

      </div>
      {#if !autoScroll}
        <button class="scroll-btn" on:click={() => { autoScroll = true; feedEl.scrollTop = feedEl.scrollHeight; }}>
          ▼ Resume scroll
        </button>
      {/if}
    </div>

    <!-- ── RIGHT: Artifacts + Inspect ─────────────────────────────── -->
    <div class="panel right-panel">

      <!-- Artifact tree -->
      <div class="art-section">
        <div class="panel-head">
          Artifact Tree
          <span class="ev-count">{$artifacts.length} nodes</span>
        </div>
        <div class="panel-body">
          {#each roots as root, ri}
            <ArtifactNode
              art={root}
              {kids}
              {selArtId}
              {selectArt}
              prefix=""
              isLast={ri === roots.length - 1}
            />
          {/each}
          {#if roots.length === 0}
            <span class="muted">No artifacts yet</span>
          {/if}
        </div>
      </div>

      <!-- Inspect panel -->
      <div class="inspect-section">
        <div class="panel-head">Inspect</div>
        <div class="panel-body">
          {#if $selectedArtifact}
            {@const a = $selectedArtifact}
            {@const sc = a.score ?? 0}
            {@const scColor = sc >= 80 ? 'var(--green)' : sc >= 60 ? 'var(--blue)' : 'var(--text3)'}

            <div class="insp-row">
              <div class="insp-key">ID</div>
              <div class="insp-val mono">{a.id.slice(0, 20)}…</div>
            </div>
            <div class="insp-row">
              <div class="insp-key">Type · Status</div>
              <div class="insp-val">{a.type} · {a.status}</div>
            </div>
            {#if sc}
              <div class="insp-row">
                <div class="insp-key">Score</div>
                <div class="score-bar-row">
                  <div class="score-bar-track">
                    <div class="score-bar-fill" style="width:{sc}%;background:{scColor}"></div>
                  </div>
                  <span class="score-bar-num" style="color:{scColor}">{sc}</span>
                </div>
              </div>
            {/if}
            {#if a.confidenceLevel !== undefined}
              <div class="insp-row">
                <div class="insp-key">Confidence</div>
                <div class="conf-dots">
                  {#each Array(4) as _, i}
                    <div class="conf-dot" class:on={i < a.confidenceLevel} class:hi={i < a.confidenceLevel && i >= 2}></div>
                  {/each}
                </div>
              </div>
            {/if}
            {#if a.hypothesisText}
              <div class="insp-row">
                <div class="insp-key">Hypothesis</div>
                <div class="insp-hyp">{a.hypothesisText}</div>
              </div>
            {/if}
            {#if a.sourceCode}
              <div class="insp-row">
                <div class="insp-key">Source</div>
                <pre class="insp-code">{a.sourceCode.slice(0, 1000)}</pre>
              </div>
            {/if}
          {:else}
            <span class="muted">Click an artifact to inspect</span>
          {/if}
        </div>
      </div>

    </div>

  </div><!-- /grid -->
</div><!-- /root -->

<!-- ── Problem modal ────────────────────────────────────────────────────── -->
{#if showProblem}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-bg" on:click|self={() => showProblem = false}>
    <div class="modal">
      <div class="modal-hdr">
        <span class="modal-ttl">Problem Description</span>
        <button class="modal-close" on:click={() => showProblem = false}>✕</button>
      </div>
      <div class="modal-body">
        <p class="modal-prose">{problem?.description ?? '—'}</p>
      </div>
    </div>
  </div>
{/if}

<!-- ── Response modal ────────────────────────────────────────────────────── -->
{#if showResp}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-bg" on:click|self={() => showResp = false}>
    <div class="modal">
      <div class="modal-hdr">
        <span class="modal-ttl">Full Response</span>
        <button class="modal-close" on:click={() => showResp = false}>✕</button>
      </div>
      <div class="modal-body">
        {#if respModalText}
          {@const parsed = (() => { try { return JSON.parse(respModalText); } catch { return null; } })()}
          {#if parsed !== null}
            <JsonView value={parsed} collapsed={false} />
          {:else}
            <pre class="modal-prose">{respModalText}</pre>
          {/if}
        {:else}
          <span class="muted">—</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- ── Artifact sub-tree (recursive self) ─────────────────────────────── -->
<!-- NOTE: Svelte doesn't allow recursive component refs to itself via <svelte:self> in the way shown above for the art tree.
     Instead we use a helper component below that re-imports App-like. -->

<style>
  /* ── Root layout ────────────────────────────────────────────────────── */
  .root {
    height: 100vh;
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); color: var(--text);
  }

  /* ── Header ──────────────────────────────────────────────────────────── */
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 14px;
    background: var(--bg2); border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .logo { font-size: 14px; font-weight: 700; color: var(--blue); white-space: nowrap; }
  .problem-pill {
    flex: 1; background: var(--bg3); border: 1px solid var(--border);
    border-radius: 5px; padding: 3px 10px; font-size: 11px; color: var(--text2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; transition: border-color .15s;
  }
  .problem-pill:hover { color: var(--text); border-color: var(--blue); }
  .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg3); border: 1px solid var(--border);
    color: var(--text2); white-space: nowrap;
  }
  .badge.live { border-color: var(--green); color: var(--green); }
  .badge.live::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); margin-right: 5px; animation: pulse 2s infinite; }

  /* ── Agent bar ────────────────────────────────────────────────────────── */
  .agent-bar {
    padding: 4px 14px; background: var(--bg3);
    border-bottom: 1px solid var(--border);
    font-size: 11px; display: flex; align-items: center; gap: 8px;
    flex-shrink: 0; min-height: 26px;
  }
  .agent-label { color: var(--text3); text-transform: uppercase; letter-spacing: .5px; }
  .agent-name  { font-weight: 600; color: var(--text3); }
  .agent-name.running { color: var(--cyan); }
  .budget-badge { }
  .spinner {
    width: 10px; height: 10px;
    border: 1.5px solid var(--border); border-top-color: var(--blue);
    border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0;
  }

  /* ── Direction bar ────────────────────────────────────────────────────── */
  .dir-bar {
    padding: 5px 14px; background: #08111e; border-bottom: 1px solid #1b3a5c;
    font-size: 11px; display: flex; align-items: center; gap: 10px;
    flex-shrink: 0;
  }
  .dir-step { color: var(--blue); font-weight: 700; white-space: nowrap; }
  .dir-sep  { color: var(--text3); }
  .dir-goal { color: var(--text2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Grid ─────────────────────────────────────────────────────────────── */
  .grid {
    display: grid; grid-template-columns: 220px 1fr 360px;
    flex: 1; min-height: 0; overflow: hidden;
  }

  /* ── Shared panel ─────────────────────────────────────────────────────── */
  .panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); min-height: 0; }
  .panel:last-child { border-right: none; }
  .panel-head {
    padding: 6px 12px; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .8px; color: var(--text2);
    border-bottom: 1px solid var(--border); background: var(--bg2);
    flex-shrink: 0; display: flex; align-items: center; gap: 6px;
  }
  .panel-body { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
  .ev-count  { color: var(--text3); font-weight: 400; text-transform: none; font-size: 10px; }
  .sec-head  { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: var(--text3); padding: 8px 2px 4px; }
  .muted     { color: var(--text3); font-size: 11px; }

  /* ── Left panel ────────────────────────────────────────────────────────── */
  .cfg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; }
  .cfg-cell { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; }
  .cfg-lbl  { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); }
  .cfg-val  { font-size: 16px; font-weight: 700; color: var(--blue); font-variant-numeric: tabular-nums; }

  .budget-wrap   { margin: 2px 0 10px; }
  .budget-labels { display: flex; justify-content: space-between; font-size: 10px; color: var(--text2); margin-bottom: 3px; }
  .budget-track  { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
  .budget-fill   { height: 100%; border-radius: 2px; transition: width .5s; }

  .stat-row  { display: flex; justify-content: space-between; align-items: center; padding: 3px 2px; }
  .stat-lbl  { color: var(--text2); font-size: 11px; }
  .stat-val  { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-val.green  { color: var(--green); }
  .stat-val.red    { color: var(--red); }
  .stat-val.orange { color: var(--orange); }
  .stat-val.blue   { color: var(--blue); }

  .step-item { padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; border: 1px solid var(--border); background: var(--bg2); }
  .step-item.cur  { border-color: var(--blue); background: #0d1f33; }
  .step-item.done { border-color: var(--green); opacity: .7; }
  .step-num   { font-size: 9px; color: var(--text3); margin-bottom: 2px; }
  .step-goal  { font-size: 11px; font-weight: 500; line-height: 1.4; }
  .step-oracle{ font-size: 10px; color: var(--purple); margin-top: 2px; font-style: italic; }
  .rationale  { font-size: 10px; color: var(--text3); padding: 8px 4px; font-style: italic; line-height: 1.55; }

  /* ── Feed ─────────────────────────────────────────────────────────────── */
  .feed-scroll { display: flex; flex-direction: column; gap: 4px; position: relative; }
  .ftabs { display: flex; gap: 2px; margin-left: auto; }
  .ftab {
    font-size: 10px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
    background: transparent; border: 1px solid transparent;
    color: var(--text3); font-weight: 600; transition: all .15s;
  }
  .ftab:hover { color: var(--text2); border-color: var(--border); }
  .ftab.on    { background: #0d1f33; border-color: var(--blue); color: var(--blue); }

  /* Event rows */
  .ev-row {
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
    padding: 5px 8px; border-radius: 4px;
    border-left: 3px solid var(--border); background: var(--bg2);
  }
  .ev-row.expandable { cursor: pointer; }
  .ev-row.expandable:hover { background: var(--bg3); }
  .ev-row[data-k="artifact:survived"] { border-left-color: var(--green); }
  .ev-row[data-k="artifact:killed"]   { border-left-color: var(--red); }
  .ev-row[data-k="verdict"]           { border-left-color: var(--yellow); }
  .ev-row[data-k="step:advanced"]     { border-left-color: var(--purple); }
  .ev-row[data-k="planner:done"]      { border-left-color: var(--purple); }
  .ev-row[data-k="repair:start"],
  .ev-row[data-k="repair:done"]       { border-left-color: var(--orange); }
  .ev-row[data-k="insight"]           { border-left-color: var(--cyan); }
  .ev-icon { font-size: 12px; flex-shrink: 0; width: 16px; text-align: center; }
  .ev-type { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; width: 68px; flex-shrink: 0; }
  .ev-msg  { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .ev-ts   { font-size: 10px; color: var(--text3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .ev-detail {
    width: 100%; padding: 8px 10px;
    background: var(--bg); border-top: 1px solid var(--border);
    border-radius: 0 0 4px 4px;
  }
  .score-pill {
    font-size: 10px; font-weight: 700; padding: 1px 6px;
    border-radius: 8px; flex-shrink: 0; border: 1px solid transparent;
  }

  /* Supervisor card */
  .sup-card { border-radius: 6px; background: var(--bg2); border: 1px solid var(--border); overflow: hidden; }
  .sup-card[data-act="escalate"] { border-color: var(--orange); }
  .sup-card[data-act="pivot"]    { border-color: var(--purple); }
  .sup-card[data-act="abort"]    { border-color: var(--red); }
  .sup-head { padding: 5px 10px; background: var(--bg3); display: flex; align-items: center; gap: 8px; }
  .sup-action { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
  .sup-card[data-act="escalate"] .sup-action { color: var(--orange); }
  .sup-card[data-act="pivot"]    .sup-action { color: var(--purple); }
  .sup-card[data-act="abort"]    .sup-action { color: var(--red); }
  .sup-ts     { font-size: 10px; color: var(--text3); margin-left: auto; }
  .sup-reason { padding: 6px 10px; font-size: 11px; color: var(--text2); line-height: 1.55; }

  /* Solved */
  .solved-banner { border-radius: 6px; background: #0a1f12; border: 1px solid var(--green); padding: 14px 18px; text-align: center; }
  .solved-title  { font-size: 16px; font-weight: 700; color: var(--green); margin-bottom: 5px; }
  .solved-msg    { font-size: 12px; color: var(--text2); line-height: 1.6; white-space: pre-wrap; }

  /* Scroll-to-bottom button */
  .scroll-btn {
    position: sticky; bottom: 8px; left: 50%; transform: translateX(-50%);
    width: fit-content;
    background: var(--bg3); border: 1px solid var(--border);
    color: var(--text2); font-size: 11px; padding: 5px 14px;
    border-radius: 12px; cursor: pointer; z-index: 10; display: block;
  }
  .scroll-btn:hover { border-color: var(--blue); color: var(--blue); }

  /* ── Right panel ─────────────────────────────────────────────────────── */
  .right-panel { overflow: hidden; }
  .art-section    { flex: 1; min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--border); }
  .inspect-section{ height: 320px; flex-shrink: 0; display: flex; flex-direction: column; }

  /* Inspect */
  .insp-row  { margin-bottom: 8px; }
  .insp-key  { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: var(--text3); margin-bottom: 3px; }
  .insp-val  { font-size: 11px; color: var(--text); line-height: 1.5; }
  .insp-val.mono { font-family: monospace; color: var(--text3); }
  .insp-hyp  { font-size: 11px; color: var(--text2); line-height: 1.6; max-height: 90px; overflow-y: auto; }
  .insp-code {
    font-family: 'Consolas', monospace; font-size: 10px; color: var(--cyan);
    background: var(--bg); padding: 6px 8px; border-radius: 4px;
    max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
    border: 1px solid var(--border); margin-top: 2px;
  }
  .score-bar-row  { display: flex; align-items: center; gap: 7px; }
  .score-bar-track{ flex: 1; height: 5px; background: var(--bg3); border-radius: 3px; overflow: hidden; max-width: 120px; }
  .score-bar-fill { height: 100%; border-radius: 3px; transition: width .4s; }
  .score-bar-num  { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .conf-dots { display: flex; gap: 4px; margin-top: 2px; }
  .conf-dot  { width: 9px; height: 9px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); }
  .conf-dot.on    { background: var(--blue); border-color: var(--blue); }
  .conf-dot.on.hi { background: var(--green); border-color: var(--green); }

  /* ── Modals ────────────────────────────────────────────────────────────── */
  .modal-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,.75);
    z-index: 100; display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; max-width: 720px; width: 92vw;
    max-height: 85vh; display: flex; flex-direction: column;
  }
  .modal-hdr {
    padding: 12px 18px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px; flex-shrink: 0;
  }
  .modal-ttl   { font-size: 13px; font-weight: 700; color: var(--blue); }
  .modal-close {
    margin-left: auto; background: none; border: none;
    color: var(--text2); font-size: 16px; cursor: pointer;
    padding: 2px 6px; border-radius: 3px;
  }
  .modal-close:hover { background: var(--bg3); color: var(--text); }
  .modal-body {
    padding: 16px 20px; overflow-y: auto; flex: 1;
  }
  .modal-prose {
    font-size: 12px; line-height: 1.8; color: var(--text);
    white-space: pre-wrap; word-break: break-word;
    font-family: 'Consolas', monospace;
  }
</style>
