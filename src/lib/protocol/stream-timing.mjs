function nonempty(value) {
  return typeof value === 'string' && value.length > 0
}

function hasGeneratedContent(block) {
  if (!block || typeof block !== 'object') return false
  if ([block.text, block.thinking, block.refusal].some(nonempty)) return true
  if (block.type === 'redacted_thinking') return nonempty(block.data)
  return (
    (block.type === 'function_call' ||
      block.type === 'custom_tool_call' ||
      String(block.type || '').endsWith('tool_use')) &&
    (nonempty(block.name) || nonempty(block.arguments) || nonempty(block.input))
  )
}

function isGeneratedContentEvent(event) {
  const type = String(event.type || '')
  if (type === 'content_block_delta') {
    const delta = event.delta || {}
    return (
      [delta.text, delta.thinking, delta.partial_json, delta.refusal].some(nonempty) ||
      (delta.type === 'thinking_delta' && Number.isFinite(delta.estimated_tokens) && delta.estimated_tokens > 0)
    )
  }
  if (type === 'content_block_start') return hasGeneratedContent(event.content_block)
  if (type.startsWith('response.') && type.endsWith('.delta')) return nonempty(event.delta)
  if (type === 'response.content_part.added' || type === 'response.content_part.done')
    return hasGeneratedContent(event.part)
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    return (
      hasGeneratedContent(event.item) ||
      (Array.isArray(event.item?.content) && event.item.content.some(hasGeneratedContent))
    )
  }
  return false
}

/**
 * Output usage includes hidden reasoning before visible content. Measure its
 * window from the first upstream protocol event, not TTFT; stop at the terminal
 * event rather than including trailers, downstream conversion or log cleanup.
 */
export function createStreamTiming(startedAt = Date.now()) {
  let firstByteAt = null
  let firstTokenAt = null
  let terminalAt = null
  return {
    observe(event, at = Date.now()) {
      if (!event || typeof event !== 'object') return
      const type = String(event.type || '')
      if (!(type.startsWith('message_') || type.startsWith('content_block_') || type.startsWith('response.'))) return
      if (firstByteAt == null) firstByteAt = at
      if (terminalAt != null) return
      if (firstTokenAt == null && isGeneratedContentEvent(event)) firstTokenAt = at
      if (
        type === 'message_stop' ||
        (type === 'message_delta' && event.delta?.stop_reason) ||
        type === 'response.completed' ||
        type === 'response.done' ||
        type === 'response.incomplete'
      )
        terminalAt = at
    },
    snapshot() {
      const generationMs = firstByteAt != null && terminalAt != null ? terminalAt - firstByteAt : null
      return {
        firstByteAt,
        firstByteMs: firstByteAt == null ? null : Math.max(0, firstByteAt - startedAt),
        firstTokenAt,
        ttftMs: firstTokenAt == null ? null : Math.max(0, firstTokenAt - startedAt),
        generationMs: generationMs != null && generationMs > 0 && firstTokenAt != null ? generationMs : null,
      }
    },
  }
}
