import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { createHandleProtocol } = await import(`${root}/src/lib/protocol/handle-protocol.mjs`)
const { createRespond, readBody } = await import(`${root}/src/lib/http/respond.mjs`)
const { openDatabase, closeDatabase } = await import(`${root}/src/lib/db/database.mjs`)
const { resetOpenAIAccountRuntime } = await import(`${root}/src/lib/pool/openai-account-runtime.mjs`)
const { writeCodexKernelConfig, stopCodexKernel, finishCodexRecycle } = await import(
  `${root}/src/lib/transport/codex-kernel-supervisor.mjs`
)
const { createHash } = await import('node:crypto')
process.env.KIN_CODEX_KERNEL_BIN ||= `${root}/bin/kin-codex-kernel`
const binary = fs.readFileSync(process.env.KIN_CODEX_KERNEL_BIN)
const digest = createHash('sha256').update(binary).digest('hex')
assert.equal(digest, 'afdb433ebf3c719eb8596e09ca6493e8f769af1aab136426e82cbcd54c9bdc4a')
const evidence = []
openDatabase({ dbPath: ':memory:' })
test.after(() => {
  closeDatabase()
  if (process.env.KIN_PROTOCOL_EVIDENCE_DIR)
    fs.writeFileSync(
      path.join(process.env.KIN_PROTOCOL_EVIDENCE_DIR, 'codex-history-native.json'),
      JSON.stringify(evidence, null, 2),
    )
})
for (const stream of [false, true]) {
  for (const blocks of [false, true]) {
    test(`HTTP Messages through exact Codex ELF history: stream=${stream}, blocks=${blocks}`, async () => {
      resetOpenAIAccountRuntime()
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'history835-'))
      fs.mkdirSync(path.join(project, 'vms/vm-fictional'), { recursive: true })
      fs.writeFileSync(
        path.join(project, 'vms/vm-fictional.json'),
        JSON.stringify({
          id: 'vm-fictional',
          platform: 'openai',
          family: 'codex',
          status: 'running',
          schedulable: true,
          has_token: true,
        }),
      )
      fs.writeFileSync(
        path.join(project, 'vms/vm-fictional/codex-credentials.json'),
        JSON.stringify({
          accounts: [
            {
              id: 'fictional',
              access_token: 'FICTIONAL_ACCESS',
              refresh_token: 'FICTIONAL_REFRESH',
              chatgpt_account_id: 'FICTIONAL_ACCOUNT',
            },
          ],
        }),
      )
      const routing = {
        codex: { enabled: true, upstream_transport: 'http' },
        compatibility: {},
        pool: { fallback_wait_timeout_ms: 1000 },
      }
      const routingFile = path.join(project, 'routing.json')
      fs.writeFileSync(routingFile, JSON.stringify(routing))
      const cfg = {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1048576, upstream_timeout_ms: 2000 },
        paths: { project, data: project },
      }
      const captures = []
      const logs = []
      const receiver = http.createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let bytes = Buffer.concat(chunks)
        if (req.headers['content-encoding'] === 'zstd') {
          if (zlib.zstdDecompressSync) bytes = zlib.zstdDecompressSync(bytes)
          else
            bytes = execFileSync(
              'python3',
              [
                '-c',
                `import ctypes,sys
b=sys.stdin.buffer.read()
z=ctypes.CDLL('libzstd.so.1')
z.ZSTD_getFrameContentSize.restype=ctypes.c_ulonglong
z.ZSTD_getFrameContentSize.argtypes=[ctypes.c_char_p,ctypes.c_size_t]
n=z.ZSTD_getFrameContentSize(b,len(b))
assert n<134217728,n
out=ctypes.create_string_buffer(n)
z.ZSTD_decompress.restype=ctypes.c_size_t
written=z.ZSTD_decompress(out,n,b,len(b))
assert written==n,(written,n)
sys.stdout.buffer.write(out.raw)`,
              ],
              { input: bytes, maxBuffer: 134217728 },
            )
        }
        const raw = bytes.toString()
        captures.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) })
        res.setHeader('content-type', 'text/event-stream')
        const events = [
          { type: 'response.created', response: { id: 'resp_fictional', model: 'gpt-6.1-sol' } },
          { type: 'response.output_text.delta', delta: 'FICTIONAL_OK', output_index: 0, content_index: 0 },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fictional',
              status: 'completed',
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FICTIONAL_OK' }] },
              ],
              usage: { input_tokens: 2, output_tokens: 1 },
            },
          },
        ]
        res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
      })
      await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve))
      const base = `http://127.0.0.1:${receiver.address().port}`
      let kernelConfig
      const handler = createHandleProtocol({
        ...createRespond(cfg),
        readBody,
        cfg,
        requireAuth: () => true,
        requestLog: {
          start: () => ({ request_id: 'fictional835', capture_outbound: true }),
          finish: (_c, b) => logs.push(b),
        },
        stats: { errors: 0, requests: 0, by_route: {} },
        groupsRepo: { rateMultiplier: () => 1 },
        routingConfigPath: routingFile,
        routingConfig: routing,
        getRoutingConfig: () => routing,
        apiKeyStore: {},
        accountQuota: {},
        stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
        codexOps: {
          writeCodexKernelConfig(projectRoot, vm, opts) {
            const paths = writeCodexKernelConfig(projectRoot, vm, { ...opts, proxyUrl: '', proxyRequired: false })
            kernelConfig = JSON.parse(fs.readFileSync(paths.configPath))
            Object.assign(kernelConfig, {
              test_endpoints: true,
              custom_base_url: base,
              proxy_url: '',
              proxy_required: false,
            })
            fs.writeFileSync(paths.configPath, JSON.stringify(kernelConfig))
            return paths
          },
        },
      })
      const server = http.createServer((req, res) => {
        req.apiKeyKind = 'master'
        handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((e) => {
          res.statusCode = 500
          res.end(String(e.stack))
        })
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const request = {
          model: 'gpt-6.1-sol',
          max_tokens: 64,
          stream,
          messages: [
            { role: 'user', content: 'FICTIONAL_READ' },
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call_fictional', name: 'read_probe', input: { path: 'fictional.txt', n: 2 } },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_fictional',
                  content: blocks ? [{ type: 'text', text: 'FICTIONAL_TOOL_RESULT' }] : 'FICTIONAL_TOOL_RESULT',
                },
              ],
            },
          ],
        }
        const result = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'fictional-test' },
          body: JSON.stringify(request),
        })
        const response = await result.text()
        evidence.push({
          stream,
          blocks,
          request,
          status: result.status,
          response,
          captures,
          logs,
          kernel: {
            sha256: digest,
            exact_elf: true,
            config: { ...kernelConfig, internal_token: 'REDACTED_FICTIONAL_TOKEN' },
            local_receiver: base,
          },
        })
        assert.equal(result.status, 200, response)
        assert.equal(captures.length, 1)
        const input = captures[0].body.input
        const index = input.findIndex((item) => item.type === 'function_call')
        assert.ok(index >= 0)
        assert.deepEqual(input.slice(index), [
          {
            type: 'function_call',
            call_id: 'call_fictional',
            name: 'read_probe',
            arguments: '{"path":"fictional.txt","n":2}',
          },
          { type: 'function_call_output', call_id: 'call_fictional', output: 'FICTIONAL_TOOL_RESULT' },
        ])
        assert.match(response, /FICTIONAL_OK/)
      } finally {
        const child = stopCodexKernel('vm-fictional')
        await finishCodexRecycle(child)
        receiver.closeAllConnections()
        await new Promise((resolve) => receiver.close(resolve))
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  }
}
