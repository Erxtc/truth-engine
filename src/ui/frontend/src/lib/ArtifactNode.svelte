<script lang="ts">
  import type { Artifact } from './types';
  export let art: Artifact;
  export let kids: Record<string, Artifact[]>;
  export let selArtId: string | null;
  export let selectArt: (a: Artifact) => void;
  export let prefix = '';
  export let isLast = true;

  $: connector = prefix ? (isLast ? '└─ ' : '├─ ') : '';
  $: childPfx  = prefix + (isLast ? '   ' : '│  ');
  $: children  = (kids[art.id] ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  $: st = art.status === 'lemma' ? 'lemma' : art.status === 'active' ? 'active' : 'dead';
  $: sc = art.score ?? 0;
  $: scClass = sc >= 80 ? 'hi' : sc >= 60 ? 'mid' : 'lo';
  $: snippet = (art.hypothesisText ?? art.title ?? '').slice(0, 72);
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="art-node" class:sel={art.id === selArtId} on:click={() => selectArt(art)}>
  <div class="art-row">
    <span class="art-prefix">{prefix}{connector}</span>
    <span class="art-badge {st}">{st}</span>
    <span class="art-type">{art.type}</span>
    {#if sc}<span class="art-score {scClass}">{sc}</span>{/if}
  </div>
  {#if snippet}<div class="art-snippet">{snippet}</div>{/if}
</div>

{#each children as child, i}
  <svelte:self
    art={child}
    {kids}
    {selArtId}
    {selectArt}
    prefix={childPfx}
    isLast={i === children.length - 1}
  />
{/each}

<style>
  .art-node {
    padding: 3px 6px; border-radius: 4px; margin-bottom: 2px;
    cursor: pointer; border: 1px solid transparent;
  }
  .art-node:hover { background: var(--bg3); border-color: var(--border); }
  .art-node.sel   { background: var(--bg3); border-color: var(--blue); }
  .art-row    { display: flex; align-items: center; gap: 4px; }
  .art-prefix { font-family: monospace; font-size: 11px; color: var(--text3); white-space: pre; flex-shrink: 0; }
  .art-badge  { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 700; flex-shrink: 0; }
  .art-badge.active { background: #0d1f33; color: var(--blue);  border: 1px solid #1b3a6b; }
  .art-badge.lemma  { background: #0a1f12; color: var(--green); border: 1px solid #1b4026; }
  .art-badge.dead   { background: var(--bg3); color: var(--text3); border: 1px solid var(--border); }
  .art-type   { font-size: 9px; color: var(--text3); }
  .art-score  { font-size: 9px; margin-left: auto; font-variant-numeric: tabular-nums; }
  .art-score.hi  { color: var(--green); font-weight: 700; }
  .art-score.mid { color: var(--blue); }
  .art-score.lo  { color: var(--text3); }
  .art-snippet {
    font-size: 10px; color: var(--text3); line-height: 1.4;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    padding-left: 14px; margin-top: 1px;
  }
</style>
