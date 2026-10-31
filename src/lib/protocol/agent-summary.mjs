import { randomUUID } from 'node:crypto'

// Claude Code's agent_summary fork copies the live transcript and tools, then
// appends this one-shot instruction. Model, max_tokens and tool count therefore
// cannot distinguish it from the agent's main turn.
const SUMMARY_PREFIX =
  'Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.'
const SUMMARY_EXAMPLES = `Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`

function isSummaryInstruction(text) {
  const value = text.trim()
  if (!value.startsWith(SUMMARY_PREFIX) || !value.endsWith(SUMMARY_EXAMPLES)) return false
  const previous = value.slice(SUMMARY_PREFIX.length, -SUMMARY_EXAMPLES.length).trim()
  return previous === '' || /^Previous: [^\r\n]+ — say something NEW\.$/.test(previous)
}

/** Recognize only the current instruction, never quoted history or tool output. */
export function agentSummarySession(body, { officialTraffic = false } = {}) {
  if (!officialTraffic || !Array.isArray(body?.messages)) return null
  // Harness token-budget reminders may follow the actual user instruction.
  let index = body.messages.length - 1
  while (body.messages[index]?.role === 'system') {
    const content = body.messages[index].content
    const blocks = Array.isArray(content) ? content : [content]
    if (
      !blocks.length ||
      !blocks.every((block) => {
        const text = typeof block === 'string' ? block : block?.type === 'text' ? block.text : null
        return typeof text === 'string' && /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(text.trim())
      })
    )
      return null
    index--
  }
  const last = body.messages[index]
  if (last?.role !== 'user') return null
  const content = last.content
  const tail = Array.isArray(content) ? content.at(-1) : content
  const text = typeof tail === 'string' ? tail : tail?.type === 'text' ? tail.text : null
  if (typeof text !== 'string' || !isSummaryInstruction(text)) return null
  // Ephemeral identity: no parent sticky aliases, no reused CLI conversation.
  // A real seat is still reserved, so normal VM concurrency/quota limits apply.
  return randomUUID()
}
