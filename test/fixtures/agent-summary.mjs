// Claude Code agent_summary instruction. Synthetic transcript; no production data.
export function summaryInstruction(previous = '') {
  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${previous ? `\nPrevious: ${previous} — say something NEW.\n` : ''}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

export function agentBody({ summary = false, previous = '', stream = false } = {}) {
  return {
    model: 'claude-opus-4-6',
    max_tokens: 128000,
    stream,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    metadata: { user_id: JSON.stringify({ device_id: 'test-device', session_id: 'test-parent' }) },
    tools: [{ name: 'Write', input_schema: { type: 'object', properties: { content: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'Write an article about test coverage.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'test-tool', name: 'Write', input: { content: 'Draft' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'test-tool', content: 'File written.' },
          ...(summary ? [{ type: 'text', text: summaryInstruction(previous) }] : []),
        ],
      },
      { role: 'system', content: '<total_tokens>100000 tokens left</total_tokens>' },
    ],
  }
}
