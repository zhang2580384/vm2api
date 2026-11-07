import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createSseRestorer, publishRedactionForTests } from '../../src/lib/redaction/runtime.mjs'

const tag = '{{R_API_KEY_abcdefghijklmnopqrstuvwxyz}}'
const plain = 'fictional-restored-token'
const context = { principal: 'fictional-key', session: 'fictional-session' }
const line = (event) => `data: ${JSON.stringify(event)}`
const eventOf = (value) => JSON.parse(value.slice(5))
function restorer() {
  publishRedactionForTests({
    enabled: true,
    ready: true,
    policy: {},
    client: {
      async restore({ principal, session, body }) {
        assert.equal(principal, context.principal)
        assert.equal(session, context.session)
        return { body: body.replaceAll(tag, plain) }
      },
    },
  })
  return createSseRestorer(context)
}
afterEach(() => publishRedactionForTests(null))

for (const field of ['text', 'thinking', 'partial_json']) {
  test(`Anthropic split tags restore within their ${field} block`, async () => {
    const restore = restorer()
    const output = []
    for (const piece of [tag.slice(0, 12), tag.slice(12)]) {
      output.push(
        eventOf(await restore.line(line({ type: 'content_block_delta', index: 0, delta: { [field]: piece } }))).delta[
          field
        ],
      )
    }
    assert.equal(output.join(''), plain)
  })
}

test('Responses split text and function arguments keep independent item tails', async () => {
  const restore = restorer()
  const text = []
  const args = []
  for (const piece of [tag.slice(0, 12), tag.slice(12)]) {
    text.push(
      eventOf(
        await restore.line(line({ type: 'response.output_text.delta', item_id: 'fictional-message', delta: piece })),
      ).delta,
    )
    args.push(
      eventOf(
        await restore.line(
          line({ type: 'response.function_call_arguments.delta', item_id: 'fictional-call', delta: piece }),
        ),
      ).delta,
    )
  }
  assert.equal(text.join(''), plain)
  assert.equal(args.join(''), plain)
})

test('Chat split content and tool arguments keep independent choice and tool tails', async () => {
  const restore = restorer()
  const text = []
  const args = []
  for (const piece of [tag.slice(0, 12), tag.slice(12)]) {
    const event = eventOf(
      await restore.line(
        line({
          choices: [
            { index: 0, delta: { content: piece } },
            { index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } },
          ],
        }),
      ),
    )
    text.push(event.choices[0].delta.content)
    args.push(event.choices[1].delta.tool_calls[0].function.arguments)
  }
  assert.equal(text.join(''), plain)
  assert.equal(args.join(''), plain)
})

test('tag fragments from different Responses items cannot restore each other', async () => {
  const restore = restorer()
  const first = eventOf(
    await restore.line(line({ type: 'response.output_text.delta', item_id: 'fictional-a', delta: tag.slice(0, 12) })),
  )
  const second = eventOf(
    await restore.line(line({ type: 'response.output_text.delta', item_id: 'fictional-b', delta: tag.slice(12) })),
  )
  assert.equal(first.delta, '')
  assert.equal(second.delta, tag.slice(12))
  const last = eventOf(
    await restore.line(line({ type: 'response.output_text.delta', item_id: 'fictional-a', delta: tag.slice(12) })),
  )
  assert.equal(last.delta, plain)
})
