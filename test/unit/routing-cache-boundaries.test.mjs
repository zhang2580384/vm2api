import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  VM_READ_CACHE_MAX_ENTRIES,
  invalidateReadCache,
  invalidateVmSlotReadCache,
  readJsonParsedCached,
} from '../../src/lib/vm/vm-file.mjs'

function withParseCount(callback) {
  const native = JSON.parse
  let calls = 0
  JSON.parse = (...args) => {
    calls++
    return native(...args)
  }
  try {
    callback(() => calls)
  } finally {
    JSON.parse = native
    invalidateReadCache()
  }
}

test('parsed routing cache has a finite LRU capacity and keeps recent entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-routing-lru-'))
  try {
    invalidateReadCache()
    const files = Array.from({ length: VM_READ_CACHE_MAX_ENTRIES + 1 }, (_, i) => path.join(dir, `${i}.json`))
    files.forEach((file, i) => fs.writeFileSync(file, JSON.stringify({ fictional: i })))
    withParseCount((count) => {
      for (const file of files) readJsonParsedCached(file)
      assert.equal(count(), files.length)
      assert.equal(readJsonParsedCached(files.at(-1)).fictional, files.length - 1)
      assert.equal(count(), files.length, 'recent parse should be reused')
      assert.equal(readJsonParsedCached(files[0]).fictional, 0)
      assert.equal(count(), files.length + 1, 'evicted first path must be parsed again')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('slot invalidation drops both text and parsed nested file entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-routing-slot-'))
  const home = path.join(dir, 'vms', 'fictional-slot')
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'routing.json')
  fs.writeFileSync(file, '{"fictional":true}')
  try {
    withParseCount((count) => {
      assert.equal(readJsonParsedCached(file).fictional, true)
      assert.equal(count(), 1)
      invalidateVmSlotReadCache(dir, 'fictional-slot')
      assert.equal(readJsonParsedCached(file).fictional, true)
      assert.equal(count(), 2, 'slot removal must invalidate parsed state too')
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('KIN_VM_READ_CACHE_MS=0 disables parsed memoization as well as text caching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-routing-disabled-'))
  const file = path.join(dir, 'routing.json')
  fs.writeFileSync(file, '{"fictional":true}')
  try {
    const script = `
      import assert from 'node:assert/strict'
      import { readJsonParsedCached } from ${JSON.stringify(new URL('../../src/lib/vm/vm-file.mjs', import.meta.url).href)}
      const native = JSON.parse
      let count = 0
      JSON.parse = (...args) => { count++; return native(...args) }
      const a = readJsonParsedCached(process.argv[1])
      a.fictional = 'mutated'
      assert.equal(readJsonParsedCached(process.argv[1]).fictional, true)
      assert.equal(count, 2, 'disabled parse cache must parse each read')
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', script, file], {
      env: { ...process.env, KIN_VM_READ_CACHE_MS: '0' },
      stdio: 'pipe',
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
