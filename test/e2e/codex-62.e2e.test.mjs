import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import * as zlib from 'node:zlib'
import WebSocket, { WebSocketServer } from 'ws'
import { api, REPO_ROOT, startGateway } from '../harness.mjs'
import { codexKernelHealth } from '../../src/lib/transport/codex-kernel-client.mjs'
import { writeCodexKernelConfig } from '../../src/lib/transport/codex-kernel-supervisor.mjs'

const kernelBin = process.env.KIN_CODEX_TEST_BIN
const models = ['gpt-6.2-astra', 'gpt-6.2-sol']

async function startCodexFixture(t, transport) {
  const pin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'deploy/payload.json'))).files.find(
    (file) => file.path === 'bin/kin-codex-kernel',
  )
  const bytes = fs.readFileSync(kernelBin)
  assert.equal(bytes.length, pin.size)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256)
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codex62-'))
  const vm = {
    id: 'vm-test62',
    family: 'codex',
    platform: 'openai',
    status: 'running',
    schedulable: true,
    has_token: true,
  }
  const slot = path.join(project, 'vms', vm.id)
  fs.mkdirSync(slot, { recursive: true })
  fs.writeFileSync(path.join(project, 'vms/active.json'), JSON.stringify({ active_vm: vm.id }))
  fs.writeFileSync(
    path.join(slot, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [
        {
          id: 'fixture',
          access_token: 'fixture-access',
          chatgpt_account_id: 'fixture-account',
          expires_at: Date.now() + 3_600_000,
        },
      ],
    }),
  )
  const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
  routing.codex.upstream_transport = transport
  routing.codex.model_mappings = { 'fixture-alias': 'gpt-6.2-sol' }
  fs.mkdirSync(path.join(project, 'config'))
  fs.writeFileSync(path.join(project, 'config/routing.json'), JSON.stringify(routing))
  const received = []
  const receiver = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const input = JSON.parse(req.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(raw) : raw)
    const events = respond(input, req.url, 'http')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  function respond(input, url, wire) {
    received.push({ path: url, model: input.model, effort: input.reasoning?.effort, wire })
    const text = `fixture reply for ${input.model}`
    const response = {
      id: 'resp_fixture',
      object: 'response',
      model: input.model,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }
    return [
      { type: 'response.created', response: { id: response.id, model: input.model } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.completed', response },
    ]
  }
  const sockets = new WebSocketServer({ server: receiver })
  sockets.on('connection', (ws, req) =>
    ws.on('message', (data) => {
      const frame = JSON.parse(data)
      for (const event of respond(frame, req.url, 'ws')) ws.send(JSON.stringify(event))
    }),
  )
  let kernel, gateway
  t.after(async () => {
    if (gateway) await gateway.stop()
    if (kernel && kernel.exitCode == null && kernel.signalCode == null) {
      const exited = once(kernel, 'exit')
      kernel.kill('SIGTERM')
      await exited
    }
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    receiver.closeAllConnections()
    if (receiver.listening) await new Promise((resolve) => receiver.close(resolve))
    fs.rmSync(project, { recursive: true, force: true })
  })
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  // Keep endpoint overrides in this fixture only. The gateway attaches to the already listening kernel.
  const { configPath, runDir } = writeCodexKernelConfig(project, vm, { routing, proxyRequired: false })
  const config = JSON.parse(fs.readFileSync(configPath))
  const testConfig = path.join(slot, 'loopback.json')
  fs.writeFileSync(
    testConfig,
    JSON.stringify({
      ...config,
      proxy_url: '',
      proxy_required: false,
      test_endpoints: true,
      custom_base_url: `http://127.0.0.1:${receiver.address().port}`,
    }),
  )
  kernel = spawn(kernelBin, [testConfig], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: project } })
  const exec = { vmId: vm.id, vm: { ...vm, runtime: { worker_run_dir: runDir } } }
  let ready = false
  for (let i = 0; i < 60 && kernel.exitCode == null; i++) {
    if ((await codexKernelHealth(exec, { timeoutMs: 250 })).ok) {
      ready = true
      break
    }
    await delay(50)
  }
  assert.ok(ready, `pinned Codex kernel failed startup (exit ${kernel.exitCode})`)
  gateway = await startGateway({
    project,
    env: { KIN_CRS_MOCK: '0', KIN_DOCKER_BIN: '/bin/false', KIN_CODEX_KERNEL_BIN: kernelBin },
  })
  // Register the synthetic slot after boot. The fixture does not manage any guest containers.
  fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return { gateway, received, pin }
}

test('Codex 6.2 catalog and HTTP responses through the pinned Linux kernel', { skip: !kernelBin }, async (t) => {
  const { gateway, received, pin } = await startCodexFixture(t, 'http')
  const catalog = await api(gateway, 'GET', '/v1/models')
  assert.equal(catalog.status, 200, catalog.text)
  for (const model of models) {
    assert.equal(catalog.json.data.find((row) => row.id === model)?.family, 'codex')
    for (const [endpoint, fields] of [
      ['/v1/responses', { input: 'hello', reasoning: { effort: 'ultra' } }],
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'ultra' }],
      ['/v1/completions', { prompt: 'hello', reasoning_effort: 'ultra' }],
    ]) {
      for (const stream of [false, true])
        await t.test(`${model} ${endpoint} ${stream ? 'SSE' : 'JSON'}`, async () => {
          const before = received.length
          const reply = await api(gateway, 'POST', endpoint, { body: { model, ...fields, ...(stream && { stream }) } })
          assert.equal(reply.status, 200, reply.text)
          assert.equal(received.length, before + 1)
          const capture = received[before]
          assert.equal(capture.wire, 'http')
          assert.equal(capture.model, model)
          assert.equal(capture.effort, 'ultra')
          assert.match(capture.path, /\/responses$/)
          const text = `fixture reply for ${model}`
          if (!stream) {
            assert.match(reply.headers.get('content-type'), /application\/json/)
            assert.equal(reply.json.model, model)
            if (endpoint === '/v1/responses') assert.equal(reply.json.output[0].content[0].text, text)
            else if (endpoint === '/v1/chat/completions') assert.equal(reply.json.choices[0].message.content, text)
            else assert.equal(reply.json.choices[0].text, text)
          } else {
            assert.match(reply.headers.get('content-type'), /text\/event-stream/)
            const data = reply.text
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
            const events = data.filter((s) => s !== '[DONE]').map((s) => JSON.parse(s))
            if (endpoint === '/v1/responses') {
              assert.equal(events.find((ev) => ev.type === 'response.completed')?.response.model, model)
              assert.equal(events.find((ev) => ev.type === 'response.output_text.delta')?.delta, text)
            } else {
              assert.equal(data.at(-1), '[DONE]')
              assert.ok(events.length > 0 && events.every((ev) => ev.model === model))
              const chat = endpoint === '/v1/chat/completions'
              assert.equal(events[0].object, chat ? 'chat.completion.chunk' : 'text_completion')
              assert.equal(events.map((ev) => (chat ? ev.choices[0].delta.content : ev.choices[0].text)).join(''), text)
            }
          }
        })
    }
  }
  await t.test('explicit alias reaches Sol and a saved disable stops direct and mapped requests', async () => {
    const target = 'gpt-6.2-sol'
    const send = (model) => api(gateway, 'POST', '/v1/responses', { body: { model, input: 'hello' } })
    const before = received.length
    const mapped = await send('fixture-alias')
    assert.equal(mapped.status, 200, mapped.text)
    assert.equal(received[before]?.model, target)
    const saved = await api(gateway, 'PUT', '/api/panel/model-policy?platform=openai', {
      body: { models: { [target]: { enabled: false } } },
    })
    assert.equal(saved.status, 200, saved.text)
    const listed = await api(gateway, 'GET', '/v1/models')
    assert.ok(listed.json.data.some((model) => model.id === 'gpt-6.2-astra'))
    assert.ok(!listed.json.data.some((model) => model.id === target))
    for (const model of [target, 'fixture-alias']) {
      const denied = await send(model)
      assert.equal(denied.status, 400, denied.text)
      assert.equal(denied.json.error.code, 'model_disabled')
    }
    assert.equal(received.length, before + 1)
  })
  t.diagnostic(`kernel sha256 ${pin.sha256}; received ${received.length} loopback requests`)
})

test('Codex 6.2 Responses WebSocket through the pinned Linux kernel', { skip: !kernelBin }, async (t) => {
  const { gateway, received } = await startCodexFixture(t, 'prefer_websocket')
  for (const model of models)
    await t.test(model, async () => {
      const ws = new WebSocket(gateway.baseUrl.replace('http:', 'ws:') + '/v1/responses', {
        headers: { authorization: `Bearer ${gateway.apiKey}` },
        handshakeTimeout: 5000,
      })
      try {
        await once(ws, 'open')
        const before = received.length
        const events = []
        const terminal = new Promise((resolve, reject) => {
          ws.on('error', reject)
          ws.on('close', () => reject(new Error('websocket closed before completion')))
          ws.on('message', (data) => {
            const event = JSON.parse(data)
            events.push(event)
            if (event.type === 'response.completed') resolve(event.response)
            if (event.type === 'error' || event.type === 'response.failed') reject(new Error(JSON.stringify(event)))
          })
        })
        ws.send(JSON.stringify({ type: 'response.create', model, input: 'hello', reasoning: { effort: 'ultra' } }))
        const timer = setTimeout(() => ws.terminate(), 8000)
        let response
        try {
          response = await terminal
        } finally {
          clearTimeout(timer)
        }
        assert.equal(received.length, before + 1)
        const capture = received[before]
        assert.equal(capture.wire, 'ws')
        assert.equal(capture.model, model)
        assert.equal(capture.effort, 'ultra')
        assert.equal(response.model, model)
        assert.equal(
          events.find((event) => event.type === 'response.output_text.delta')?.delta,
          `fixture reply for ${model}`,
        )
      } finally {
        ws.terminate()
      }
    })
})
