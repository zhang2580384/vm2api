import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

test('fetch and repin a kernel from its own component release', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'payload-tags-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const manifest = path.join(dir, 'manifest.json')
  const files = [
    { path: 'bin/old', asset: 'old' },
    { path: 'bin/codex', asset: 'codex', repo: 'other/fixture', release: 'component' },
  ].map((row) => ({ ...row, size: row.asset.length, sha256: createHash('sha256').update(row.asset).digest('hex') }))
  await fs.writeFile(manifest, JSON.stringify({ repo: 'example/fixture', release: 'base', files }))
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const row = files.find((row) => req.url === `/${row.release || 'base'}/${row.asset}`)
    if (!row) res.writeHead(404)
    res.end(row?.asset)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const fetchPayload = (...args) =>
    run(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../../scripts/fetch-payload.mjs'),
        '--manifest',
        manifest,
        '--dest',
        dir,
        ...args,
      ],
      {
        env: { ...process.env, VM2API_PAYLOAD_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      },
    )
  await fetchPayload()
  await fetchPayload('--check')
  assert.deepEqual(requests, ['/base/old', '/component/codex'])
  await fetchPayload('--pin', 'repacked')
  const pinned = JSON.parse(await fs.readFile(manifest, 'utf8'))
  assert.equal(pinned.release, 'repacked')
  assert.ok(pinned.files.every((file) => !Object.hasOwn(file, 'release') && !Object.hasOwn(file, 'repo')))
  assert.deepEqual(
    pinned.files.map((file) => file.sha256),
    files.map((file) => file.sha256),
  )
})
