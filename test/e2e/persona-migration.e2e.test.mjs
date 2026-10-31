import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, seedVm, api, REPO_ROOT } from '../harness.mjs'
import { restorePersonaConfigFile } from '../../src/lib/admin/persona-config-migration.mjs'

test('real routing HTTP saves and restarts retain selected 303 edits and restore the original configuration bytes', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-routing-http-'))
  t.after(() => fs.rmSync(project, { recursive: true, force: true }))
  const file = path.join(project, 'config/routing.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(project, 'vms/active.json'), '{"active_vm":null}')
  const routing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src/config/routing.json')))
  routing.compatibility = {
    ...routing.compatibility,
    persona_preset: 'official_303',
    persona_templates: {
      official_303: [{ type: 'text', text: 'FICTIONAL_SELECTED_303' }],
      official_full: [{ type: 'text', text: 'FICTIONAL_INDEPENDENT_FULL' }],
    },
    persona_env_presets: { official_303: false, official_full: true },
  }
  const original = Buffer.from(JSON.stringify(routing, null, '\t') + '\r\n')
  fs.writeFileSync(file, original)
  let gw = await startGateway({ project })
  try {
    const first = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(first.status, 200, first.text)
    const compat = first.json.data.compatibility
    assert.equal(compat.persona_preset, 'official_full')
    assert.equal(compat.persona_templates.official_full[0].text, 'FICTIONAL_SELECTED_303')
    assert.equal(compat.persona_env_presets.official_full, false)
    const snapshotDir = path.join(project, 'config/.protocol-migrations/official-303-to-full')
    const [id] = fs.readdirSync(snapshotDir)
    assert.deepEqual(fs.readFileSync(path.join(snapshotDir, id, 'routing.json')), original)
    const saved = await api(gw, 'PUT', '/api/panel/routing', { body: { compatibility: compat } })
    assert.equal(saved.status, 200, saved.text)
    await gw.stop()
    gw = await startGateway({ project })
    const restarted = await api(gw, 'GET', '/api/panel/routing')
    assert.equal(restarted.json.data.compatibility.persona_templates.official_full[0].text, 'FICTIONAL_SELECTED_303')
    await gw.stop()
    restorePersonaConfigFile(file, id)
    assert.deepEqual(fs.readFileSync(file), original)
    assert.equal(
      JSON.parse(fs.readFileSync(file)).compatibility.persona_templates.official_full[0].text,
      'FICTIONAL_INDEPENDENT_FULL',
    )
  } finally {
    await gw.stop()
  }
})

for (const mode of ['oauth', 'setup-token', 'apikey']) {
  test(`public and panel count_tokens HTTP retain ${mode} credential dispatch`, async (t) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fictional-count-http-'))
    t.after(() => fs.rmSync(project, { recursive: true, force: true }))
    const vm = seedVm({ project })
    vm.credential_mode = mode
    vm.claude.mode = mode
    if (mode === 'apikey') vm.claude.api_key = 'sk-ant-api03-FICTIONAL_ONLY'
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    const gw = await startGateway({ project })
    try {
      const body = {
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'offline count fixture' }],
      }
      const panel = await api(gw, 'POST', `/api/panel/vms/${vm.id}/count-tokens`, { body })
      const publicResult = await api(gw, 'POST', '/v1/messages/count_tokens', { body })
      if (mode === 'oauth') {
        assert.equal(panel.status, 400, panel.text)
        assert.equal(panel.json.error.code, 'count_tokens_unsupported')
        // OAuth returns the existing account usage view, without invoking official count_tokens.
        assert.equal(publicResult.status, 200, publicResult.text)
        assert.equal(publicResult.json.input_tokens, undefined)
      } else {
        assert.equal(panel.status, 200, panel.text)
        assert.equal(panel.json.data.input_tokens, 8)
        assert.equal(publicResult.status, 200, publicResult.text)
        assert.equal(publicResult.json.input_tokens, 8)
      }
    } finally {
      await gw.stop()
    }
  })
}
