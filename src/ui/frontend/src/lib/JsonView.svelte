<script lang="ts">
  export let value: unknown;
  export let depth = 0;
  export let collapsed = depth > 1;

  $: t =
    value === null            ? 'null'
    : Array.isArray(value)    ? 'array'
    : typeof value === 'object' ? 'object'
    : typeof value;

  $: entries = (t === 'object' ? Object.entries(value as Record<string, unknown>) : []) as [string, unknown][];
  $: items   = t === 'array'  ? (value as unknown[]) : [];
  $: count   = t === 'object' ? entries.length : t === 'array' ? items.length : 0;

  // Long strings get truncation
  const MAX_STR = 300;
  let strExpanded = false;
  $: strVal  = typeof value === 'string' ? value : '';
  $: strShow = !strExpanded && strVal.length > MAX_STR ? strVal.slice(0, MAX_STR) + '…' : strVal;
</script>

{#if t === 'string'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <span class="jstr" on:click|stopPropagation={() => strExpanded = !strExpanded}>
    "{strShow}"
    {#if strVal.length > MAX_STR}
      <button class="str-toggle">{strExpanded ? 'less' : `+${(strVal.length - MAX_STR).toLocaleString()}`}</button>
    {/if}
  </span>

{:else if t === 'number'}
  <span class="jnum">{value}</span>

{:else if t === 'boolean'}
  <span class="jbool">{value ? 'true' : 'false'}</span>

{:else if t === 'null'}
  <span class="jnull">null</span>

{:else if t === 'undefined'}
  <span class="jnull">undefined</span>

{:else if t === 'object'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <span class="jbrace toggle" on:click|stopPropagation={() => collapsed = !collapsed}>
    {#if collapsed}{`{ `}<span class="jcount">{count} key{count !== 1 ? 's' : ''}</span>{` }`}{:else}{'{'}{/if}
  </span>
  {#if !collapsed}
    <div class="jbody">
      {#each entries as [k, v]}
        <div class="jline">
          <span class="jkey">{k}</span><span class="jpunct">: </span>
          <svelte:self value={v} depth={depth + 1} />
        </div>
      {/each}
    </div>
    <span class="jbrace">{'}'}</span>
  {/if}

{:else if t === 'array'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <span class="jbrace toggle" on:click|stopPropagation={() => collapsed = !collapsed}>
    {#if collapsed}{`[ `}<span class="jcount">{count} item{count !== 1 ? 's' : ''}</span>{` ]`}{:else}{'['}{/if}
  </span>
  {#if !collapsed}
    <div class="jbody">
      {#each items as item}
        <div class="jline">
          <svelte:self value={item} depth={depth + 1} />
        </div>
      {/each}
    </div>
    <span class="jbrace">{']'}</span>
  {/if}
{/if}

<style>
  .jstr  { color: #98c379; font-family: 'Consolas', monospace; font-size: 11px; word-break: break-word; cursor: default; }
  .jnum  { color: #d19a66; font-family: 'Consolas', monospace; font-size: 11px; }
  .jbool { color: #e5c07b; font-family: 'Consolas', monospace; font-size: 11px; }
  .jnull { color: #e06c75; font-family: 'Consolas', monospace; font-size: 11px; }
  .jkey  { color: #61afef; font-family: 'Consolas', monospace; font-size: 11px; }
  .jpunct{ color: var(--text3); font-family: 'Consolas', monospace; font-size: 11px; }
  .jbrace{ color: var(--text2); font-family: 'Consolas', monospace; font-size: 11px; }
  .jcount{ color: var(--text3); font-size: 10px; }
  .toggle { cursor: pointer; user-select: none; }
  .toggle:hover { opacity: .75; }
  .jbody {
    padding-left: 16px;
    border-left: 1px solid var(--border);
    margin: 2px 0 2px 4px;
  }
  .jline { padding: 1px 0; display: flex; flex-wrap: wrap; gap: 0; align-items: flex-start; }
  .str-toggle {
    font-size: 9px; color: var(--blue); background: none;
    border: 1px solid var(--border); border-radius: 3px;
    padding: 0 4px; cursor: pointer; margin-left: 4px; vertical-align: middle;
  }
</style>
