// Filter claude stream-json output to human-readable text.
// Reads JSON lines from stdin, writes formatted output to stdout.
// Usage: claude --print --output-format stream-json ... | bun run scripts/stream-filter.ts

const readers = (async () => {
  const decoder = new TextDecoder()
  let buf = ''
  let toolActive = false
  let thinkingActive = false

  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk)
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)

        // Assistant text
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev?.type === 'content_block_delta') {
            const d = ev.delta
            if (d?.type === 'text_delta' && d.text) {
              if (thinkingActive) {
                process.stdout.write('\n')
                thinkingActive = false
              }
              process.stdout.write(d.text)
            }
            if (d?.type === 'thinking_delta' && d.thinking) {
              if (!thinkingActive) process.stdout.write('\n  \x1b[90m')
              thinkingActive = true
              process.stdout.write(d.thinking)
            }
            if (d?.type === 'input_json_delta' && d.partial_json) {
              process.stdout.write(d.partial_json)
            }
          }
          if (ev?.type === 'content_block_start') {
            const cb = ev.content_block
            if (cb?.type === 'tool_use') {
              if (thinkingActive) { process.stdout.write('\x1b[0m\n'); thinkingActive = false }
              toolActive = true
              process.stdout.write(`\n  🔧 \x1b[36m${cb.name}\x1b[0m `)
            }
            if (cb?.type === 'thinking') {
              thinkingActive = true
              process.stdout.write('\n  \x1b[90m')
            }
          }
          if (ev?.type === 'content_block_stop') {
            if (thinkingActive) { process.stdout.write('\x1b[0m\n'); thinkingActive = false }
            if (toolActive) { process.stdout.write('\n'); toolActive = false }
          }
        }

        // Tool results
        if (msg.type === 'user' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block?.type === 'tool_result') {
              const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
              const truncated = content.length > 500 ? content.substring(0, 500) + `\n  ... (${content.length - 500} more chars)` : content
              process.stdout.write(`\n  \x1b[33m→\x1b[0m ${truncated.split('\n').join('\n    ')}\n`)
            }
          }
        }

        // System status
        if (msg.type === 'system' && msg.subtype === 'status') {
          if (msg.status === 'requesting') process.stdout.write('\n  ...\n')
        }

        // Final result
        if (msg.type === 'result') {
          process.stdout.write('\n')
          if (msg.subtype === 'error_during_execution') {
            process.stdout.write(`\n  \x1b[31mERROR: ${msg.errors?.join(', ')}\x1b[0m\n`)
          }
        }

      } catch {
        // Skip unparseable lines
      }
    }
  }
})()

readers.catch(() => {})
