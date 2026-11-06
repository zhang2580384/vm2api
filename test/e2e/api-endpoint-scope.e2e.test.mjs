import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, REPO_ROOT } from '../harness.mjs'
const evidence = []
test.after(() => {
  if (process.env.KIN_PROTOCOL_EVIDENCE_DIR)
    fs.writeFileSync(
      path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'api048-http.json'),
      JSON.stringify(evidence, null, 2),
    )
})

test('API endpoint protocol scopes, official catalogs and public cache schema over HTTP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api048-'))
  // Gateway startup writes its public configuration snapshot under src/config.
  // Keep the checked-out source read-only, including in the native CI container.
  const sourceRoot = path.join(root, 'source')
  fs.mkdirSync(sourceRoot)
  for (const directory of ['src', 'scripts', 'deploy', 'docker']) {
    fs.cpSync(path.join(REPO_ROOT, directory), path.join(sourceRoot, directory), { recursive: true })
  }
  for (const file of ['VERSION', 'package.json']) {
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(sourceRoot, file))
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'dir')
  const socket = path.join(root, 'api.sock')
  const captures = []
  const kernel = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const env = JSON.parse(Buffer.concat(chunks))
    captures.push(env)
    const body = JSON.parse(env.body || '{}')
    res.setHeader('content-type', 'text/event-stream')
    const events = env.headers.authorization
      ? [
          { type: 'response.created', response: { id: 'resp_fixture', model: body.model } },
          { type: 'response.output_text.delta', delta: 'FICTIONAL_OK', output_index: 0, content_index: 0 },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fixture',
              status: 'completed',
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FICTIONAL_OK' }] },
              ],
              usage: { input_tokens: 2, output_tokens: 1 },
            },
          },
        ]
      : [
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              usage: { input_tokens: 2, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'FICTIONAL_OK' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise((resolve) => kernel.listen(socket, resolve))
  let gw
  try {
    gw = await startGateway({ sourceRoot, readyMs: 60000, env: { KIN_API_KERNEL_SOCK: socket } })
    const call = async (method, url, opts) => {
      const result = await api(gw, method, url, opts)
      evidence.push({
        method,
        url,
        status: result.status,
        response: result.json || result.text,
        transport_count: captures.length,
      })
      return result
    }
    for (const protocol of ['anthropic', 'openai']) {
      const saved = await call('POST', '/api/panel/api-endpoints', {
        body: {
          kind: 'custom',
          protocol,
          base_url: `https://${protocol}.invalid`,
          models: [{ name: protocol === 'anthropic' ? 'claude-fixture' : 'gpt-fixture' }],
          api_key_entries: [{ api_key: `FICTIONAL_${protocol}` }],
        },
      })
      assert.equal(saved.status, 201, saved.text)
    }
    const keys = {}
    for (const group of ['anthropic', 'openai']) {
      const created = await call('POST', '/api/panel/api-keys', {
        body: {
          name: `fictional-${group}`,
          category: 'api',
          group_type: group,
          allowed_vms: ['vm-unavailable-fictional'],
          vm_pool_id: 'pool_00000000',
        },
      })
      assert.equal(created.status, 201, created.text)
      keys[group] = { authorization: `Bearer ${created.json.item.key}` }
      assert.equal(created.json.item.vm_pool_id, null)
      const allowed = created.json.item.allowed_vms
      assert.deepEqual(Array.isArray(allowed) ? allowed : JSON.parse(allowed || '[]'), [])
    }
    await t.test('both model aliases list only the key protocol', async () => {
      for (const group of ['anthropic', 'openai']) {
        for (const url of ['/models', '/v1/models']) {
          const listed = await call('GET', url, { headers: keys[group] })
          assert.equal(listed.status, 200, listed.text)
          assert.deepEqual(
            listed.json.data.map((x) => x.id),
            [group === 'anthropic' ? 'claude-fixture' : 'gpt-fixture'],
          )
        }
      }
    })
    await t.test('cross-protocol models are rejected before the API hop', async () => {
      for (const group of ['anthropic', 'openai']) {
        const before = captures.length
        const result = await call('POST', '/v1/messages', {
          headers: keys[group],
          body: {
            model: group === 'anthropic' ? 'gpt-fixture' : 'claude-fixture',
            max_tokens: 32,
            messages: [{ role: 'user', content: 'FICTIONAL_REQUEST' }],
            stream: false,
          },
        })
        assert.equal(result.status, 404, result.text)
        assert.equal(captures.length, before)
      }
    })
    await t.test('Anthropic API cache fields are sanitized while TTL and caller content remain', async () => {
      const marker = { type: 'ephemeral', ttl: '5m', scope: 'global', invalid_field: 'FICTIONAL_EXTRA' }
      const body = {
        model: 'claude-fixture',
        max_tokens: 32,
        stream: false,
        cache_control: marker,
        system: [{ type: 'text', text: 'FICTIONAL_SYSTEM', cache_control: marker }],
        tools: [
          {
            name: 'read_probe',
            description: 'FICTIONAL_TOOL',
            input_schema: { type: 'object', properties: {} },
            cache_control: marker,
          },
        ],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'FICTIONAL_USER', cache_control: marker }] }],
      }
      const before = captures.length
      const result = await call('POST', '/v1/messages', { headers: keys.anthropic, body })
      assert.equal(result.status, 200, result.text)
      assert.equal(captures.length, before + 1)
      const sent = JSON.parse(captures.at(-1).body)
      evidence.push({ phase: 'actual API-kernel envelope; mock kernel transport', sent })
      const expected = { type: 'ephemeral', ttl: '5m' }
      assert.deepEqual(sent.cache_control, expected)
      const systemMarkers = sent.system.filter((block) => block.cache_control)
      assert.ok(systemMarkers.length > 0)
      for (const block of systemMarkers) assert.deepEqual(block.cache_control, expected)
      assert.deepEqual(sent.tools[0].cache_control, expected)
      const user = sent.messages[0].content.find((block) => block.text === 'FICTIONAL_USER')
      assert.deepEqual(user.cache_control, expected)
      assert.match(JSON.stringify(sent.messages), /FICTIONAL_SYSTEM/)
      assert.equal(user.text, 'FICTIONAL_USER')
      assert.equal(sent.tools[0].name, 'mcp__read_probe')
      assert.equal(sent.tools[0].description, 'FICTIONAL_TOOL')
    })
    await t.test('OAuth scope still requires real VM membership', async () => {
      const result = await call('POST', '/api/panel/api-keys', {
        body: {
          name: 'fictional-oauth-invalid',
          category: 'oauth',
          group_type: 'anthropic',
          allowed_vms: [],
        },
      })
      assert.equal(result.status, 400, result.text)
    })
    await t.test('official endpoints serve policy models absent from their saved models', async () => {
      for (const [kind, protocol, model, url] of [
        ['claude', 'anthropic', 'claude-sonnet-5-5', '/v1/messages'],
        ['openai', 'openai', 'gpt-6-sol', '/v1/responses'],
      ]) {
        const saved = await call('POST', '/api/panel/api-endpoints', {
          body: {
            kind,
            protocol,
            models: [],
            api_key_entries: [{ api_key: `FICTIONAL_OFFICIAL_${kind}` }],
          },
        })
        assert.equal(saved.status, 201, saved.text)
        const listed = await call('GET', '/models', { headers: keys[protocol] })
        assert.equal(listed.status, 200, listed.text)
        assert.ok(
          listed.json.data.some((x) => x.id === model),
          model,
        )
        const before = captures.length
        const result = await call('POST', url, {
          headers: keys[protocol],
          body:
            protocol === 'anthropic'
              ? { model, max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'FICTIONAL_OFFICIAL' }] }
              : { model, max_output_tokens: 32, stream: false, input: 'FICTIONAL_OFFICIAL' },
        })
        assert.equal(result.status, 200, result.text)
        assert.equal(captures.length, before + 1)
        assert.equal(JSON.parse(captures.at(-1).body).model, model)
      }
    })
  } finally {
    evidence.push({
      captures,
      boundary:
        'real gateway HTTP and API-kernel envelope, fictional Unix-socket kernel; no API ELF or real remote endpoint',
    })
    await gw?.stop()
    kernel.closeAllConnections()
    await new Promise((resolve) => kernel.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
