import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { slotHost } from '../vm/slot-host.mjs'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { inspectContainerOrNull } from '../cluster/docker-remote.mjs'
import { slotNetworkForVm } from '../vm/egress.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { mailboxError } from './codex-mailbox-store.mjs'
import { manageMailboxBrowserRuntime } from './mailbox-browser-environment.mjs'
import { acquireBrowserResources } from './mailbox-browser-resources.mjs'

export const PLAYWRIGHT_VERSION = '1.64.1'
export const MAILBOX_BOOTSTRAP = `set -eu
export DEBIAN_FRONTEND=noninteractive
PORTABLE=/home/kincli/.local/share/kin-mailbox
if [ -x "$PORTABLE/venv/bin/python" ] && [ -f "$PORTABLE/portable.json" ]; then
  export KIN_MAILBOX_ROOT="$PORTABLE"
  export PLAYWRIGHT_BROWSERS_PATH="$PORTABLE/browsers"
  export LD_LIBRARY_PATH="$PORTABLE/lib"
  export TMPDIR="$PORTABLE/tmp"
  export XDG_CACHE_HOME="$PORTABLE/cache"
  export XDG_CONFIG_HOME="$PORTABLE/config"
  export FONTCONFIG_FILE="$PORTABLE/fonts.conf"
  mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"
  if [ ! -f "$PORTABLE/display/runtime.py" ] || [ ! -x "$PORTABLE/display/bin/Xvfb" ] || [ ! -x "$PORTABLE/display/bin/xkbcomp" ]; then
    echo '{"event":"stage","stage":"failed","code":"browser_graphical_runtime_missing"}'; exit 1
  fi
  "$PORTABLE/venv/bin/python" -c 'import ctypes,importlib.metadata; nss=ctypes.CDLL("libnss3.so"); assert nss.NSS_NoDB_Init(None)==0; nss.NSS_Shutdown(); from playwright.sync_api import sync_playwright; assert importlib.metadata.version("playwright")=="${PLAYWRIGHT_VERSION}"; p=sync_playwright().start(); b=p.chromium.launch(headless=True,args=["--disable-dev-shm-usage","--disable-background-networking"]); page=b.new_page(); page.set_content("<title>Browser ready</title>"); assert page.title()=="Browser ready"; b.close(); p.stop()' || { echo '{"event":"stage","stage":"failed","code":"browser_launch_failed"}'; exit 1; }
  exit 0
fi
export PLAYWRIGHT_BROWSERS_PATH=/opt/kin-mailbox/browsers
if [ -x /opt/kin-mailbox/venv/bin/python ] && [ -f /opt/kin-mailbox/ready-${PLAYWRIGHT_VERSION} ]; then
  echo '{"event":"stage","stage":"failed","code":"browser_graphical_runtime_missing"}'; exit 1
fi
echo '{"event":"stage","stage":"failed","code":"browser_runtime_unavailable"}'
exit 1
`

// This supervisor lives INSIDE the actual slot. A lost control pipe or cancel
// terminates its child process group, rather than merely killing `docker exec`.
export const SLOT_SUPERVISOR = String.raw`
import json,os,signal,subprocess,sys,threading,time
job=json.loads(sys.stdin.readline())
portable='/home/kincli/.local/share/kin-mailbox'
base=portable if os.path.isfile(portable+'/portable.json') else '/opt/kin-mailbox'
if base==portable:
 os.environ.update(KIN_MAILBOX_ROOT=base,PLAYWRIGHT_BROWSERS_PATH=base+'/browsers',LD_LIBRARY_PATH=base+'/lib',TMPDIR=base+'/tmp',XDG_CACHE_HOME=base+'/cache',XDG_CONFIG_HOME=base+'/config',FONTCONFIG_FILE=base+'/fonts.conf',HOME='/home/kincli')
 for folder in ['tmp','cache','config']:os.makedirs(base+'/'+folder,exist_ok=True)
if job['action']=='prepare':
 cmd=['/bin/sh','-c',job['bootstrap']]
 child=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
 def preparation_events():
  for line in child.stdout:
   try:
    value=json.loads(line)
    if value.get('event')=='stage' and value.get('stage')=='failed' and value.get('code') in ['browser_launch_failed','browser_runtime_unavailable','browser_packages_failed','browser_graphical_runtime_missing']:print(json.dumps(value),flush=True)
   except (ValueError,TypeError):pass
 reader=threading.Thread(target=preparation_events,daemon=True);reader.start()
else:
 child=subprocess.Popen([base+'/venv/bin/python','-u','-c',job['runner']],stdin=subprocess.PIPE,stdout=sys.stdout,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
 child.stdin.write(json.dumps(job['payload'])+'\n');child.stdin.flush()
cancelled=threading.Event()
def stop():
 if child.poll() is not None:return
 cancelled.set()
 try:os.killpg(child.pid,signal.SIGTERM)
 except ProcessLookupError:return
 def hard_stop():
  time.sleep(8)
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 threading.Thread(target=hard_stop,daemon=True).start()
def controls():
 for line in sys.stdin:
  try:
   value=json.loads(line)
   if value.get('cancel'):stop();return
   if child.stdin:child.stdin.write(json.dumps(value)+'\n');child.stdin.flush()
  except (ValueError,BrokenPipeError):pass
 stop()
threading.Thread(target=controls,daemon=True).start()
signal.signal(signal.SIGTERM,lambda *_:stop())
rc=child.wait()
try:os.killpg(child.pid,signal.SIGTERM)
except ProcessLookupError:pass
deadline=time.monotonic()+5
while time.monotonic()<deadline:
 try:os.killpg(child.pid,0)
 except ProcessLookupError:break
 time.sleep(.05)
try:os.killpg(child.pid,signal.SIGKILL)
except ProcessLookupError:pass
if job['action']=='prepare':reader.join(timeout=2)
if job['action']=='prepare':print(json.dumps({'event':'prepared','ok':rc==0}),flush=True)
sys.exit(130 if cancelled.is_set() else (0 if rc==0 else 1))
`

export function stagePortableMailboxRuntime(projectRoot, vm) {
  if (vm.schedulable === false) throw mailboxError('slot_resting', 409)
  if (slotHost(vm).kind !== 'local') return
  const manifestFile = path.join(projectRoot, 'share', 'kin-mailbox-runtime', 'manifest.json')
  if (!fs.existsSync(manifestFile)) return
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const archive = path.join(path.dirname(manifestFile), 'ubuntu24.04-amd64.tar.gz')
  const directory = path.join(projectRoot, 'vms', vm.id, 'cli-home', '.local', 'share', 'kin-mailbox')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(vm.id) || !fs.existsSync(path.join(projectRoot, 'vms', vm.id, 'cli-home')))
    throw mailboxError('browser_runtime_unavailable', 503)
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const owner = fs.statSync(home)
  const ownDirectories = () => {
    for (const name of [path.join(home, '.local'), path.join(home, '.local', 'share')]) {
      fs.mkdirSync(name, { recursive: true, mode: 0o700 })
      if (fs.statSync(name).uid === 0) fs.chownSync(name, owner.uid, owner.gid)
    }
  }
  ownDirectories()
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(directory, 'portable.json'), 'utf8'))
    if (ready.version === PLAYWRIGHT_VERSION && ready.bundle_sha256 === manifest.sha256) {
      if (fs.statSync(directory).uid !== owner.uid)
        execFileSync('chown', ['-R', `${owner.uid}:${owner.gid}`, directory], { stdio: 'ignore', timeout: 30_000 })
      return
    }
  } catch {
    /* Install a verified portable runtime without changing the slot root. */
  }
  const hash = execFileSync('sha256sum', [archive], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  }).split(/\s/)[0]
  if (manifest.version !== PLAYWRIGHT_VERSION || hash !== manifest.sha256)
    throw mailboxError('browser_runtime_invalid', 503)
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
  const temporary = `${directory}.${crypto.randomUUID()}.tmp`
  const previous = `${temporary}.previous`
  const preserved = []
  try {
    fs.mkdirSync(temporary, { mode: 0o700 })
    execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'ignore', timeout: 120_000 })
    const info = JSON.parse(fs.readFileSync(path.join(temporary, 'portable.json'), 'utf8'))
    fs.writeFileSync(path.join(temporary, 'portable.json'), JSON.stringify({ ...info, bundle_sha256: hash }), {
      mode: 0o600,
    })
    for (const name of ['tmp', 'cache', 'config', 'profiles']) fs.mkdirSync(path.join(temporary, name), { mode: 0o700 })
    execFileSync('chown', ['-R', `${owner.uid}:${owner.gid}`, temporary], { stdio: 'ignore', timeout: 30_000 })
    if (fs.existsSync(directory)) {
      // The slot's exclusive job lock prevents browsers from running during an upgrade.
      fs.renameSync(directory, previous)
      for (const name of ['profiles', 'cache', 'config']) {
        if (!fs.existsSync(path.join(previous, name))) continue
        fs.rmdirSync(path.join(temporary, name))
        fs.renameSync(path.join(previous, name), path.join(temporary, name))
        preserved.push(name)
      }
    }
    fs.renameSync(temporary, directory)
  } catch (error) {
    if (fs.existsSync(previous)) {
      for (const name of preserved) fs.renameSync(path.join(temporary, name), path.join(previous, name))
      fs.renameSync(previous, directory)
    }
    throw error
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  fs.rmSync(previous, { recursive: true, force: true })
}

export async function assertMailboxSlotNetwork(vm, { inspect = inspectContainerOrNull } = {}) {
  const host = slotHost(vm)
  if (host.native) throw mailboxError('linux_slot_required')
  const container = await inspect(host.dockerApi(), slotExecContainer(vm))
  if (!container?.State?.Running || container.State.Paused) throw mailboxError('slot_not_running', 409)
  const expected = slotNetworkForVm(vm)
  if (!expected || container.HostConfig?.NetworkMode !== expected) throw mailboxError('slot_egress_mismatch', 409)
  // The runtime lease raises a finite Docker memory budget before execution.
  // Network admission must also allow smaller slots to acquire that budget.
}

export async function runMailboxSlotProcess(
  options,
  { acquire = acquireBrowserResources, manageRuntime = manageMailboxBrowserRuntime } = {},
) {
  // Test adapters provide their own supervisor; resource changes always target
  // the real slot daemon and must never run for an injected child process.
  if (options.spawnImpl && acquire === acquireBrowserResources) return runMailboxProcess(options)
  const release = await acquire(options)
  let result, failure
  try {
    if (options.action === 'prepare') {
      const info = await manageRuntime({ ...options, action: 'status' })
      if (!info.installed || info.needs_upgrade) await manageRuntime({ ...options, action: 'install' })
    }
    result = await runMailboxProcess(options)
  } catch (error) {
    failure = error
  }
  try {
    await release()
  } catch (error) {
    // An authorization code is single-use and short-lived. Preserve it so the
    // service can commit credentials before reporting a separate cleanup issue.
    if (result?.callback) return { ...result, resource_cleanup_error_code: 'browser_resources_failed' }
    if (failure) failure.resource_cleanup_error_code = 'browser_resources_failed'
    else failure = error
  }
  if (failure) throw failure
  return result
}

function runMailboxProcess({
  projectRoot,
  vm,
  action,
  payload,
  signal,
  onStage,
  onControl,
  onEvent,
  onCheckpoint,
  onCallback,
  spawnImpl = spawn,
}) {
  if (signal?.aborted) return Promise.reject(mailboxError('login_cancelled', 409))
  const host = slotHost(vm)
  const user = !isKvmRuntime(vm) ? host.execUser(vm) : '0'
  const argv = slotExecArgv(vm, ['python3', '-u', '-c', SLOT_SUPERVISOR], { user, interactive: true })
  const job =
    action === 'prepare'
      ? { action, bootstrap: MAILBOX_BOOTSTRAP }
      : {
          action,
          runner: fs.readFileSync(
            path.join(
              projectRoot,
              'scripts',
              payload?.native ? 'mailbox-native-browser.py' : 'codex-mailbox-browser.py',
            ),
            'utf8',
          ),
          payload: {
            ...payload,
            // Slot configuration wins over request bodies and the control-plane
            // environment. Missing legacy fields are resolved INSIDE the slot.
            slot_environment: {
              locale: String(vm.locale || vm.fingerprint?.locale || '').trim(),
              timezone: String(vm.timezone || vm.fingerprint?.timezone || '').trim(),
              proxy_mode: 'slot_network',
            },
          },
        }
  return new Promise((resolve, reject) => {
    const child = spawnImpl('docker', argv, { env: host.dockerEnv() || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '',
      callback = '',
      callbackTask = Promise.resolve(),
      result = null,
      errorCode = '',
      finished = false,
      prepared = false,
      killTimer = null
    const send = (value) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n')
    }
    const abort = () => {
      send({ cancel: true })
      if (!killTimer) {
        killTimer = setTimeout(() => {
          child.stdin.destroy()
          child.kill('SIGTERM')
        }, 15_000)
        killTimer.unref?.()
      }
    }
    // Manual remote windows belong to the operator. Authorization windows keep
    // their login timeout until credentials have actually been committed.
    const timer =
      action === 'remote' && payload?.keep_open
        ? null
        : setTimeout(
            abort,
            action === 'prepare' ? 15 * 60_000 : ['remote', 'register'].includes(action) ? 31 * 60_000 : 520_000,
          )
    timer?.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
    onControl?.(send)
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {}) // Never log browser URLs, passwords or tokens.
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 8_000_000) {
        errorCode = 'invalid_browser_output'
        abort()
        buffer = ''
        return
      }
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.event === 'stage' && /^[a-z_]{1,60}$/.test(event.stage || '')) {
          if (event.stage === 'failed' && /^[a-z_]{1,60}$/.test(event.code || '')) errorCode = event.code
          onStage?.(event.stage)
        }
        if (event.event === 'callback' && typeof event.callback_url === 'string' && !callback) {
          callback = event.callback_url
          if (onCallback) {
            callbackTask = Promise.resolve()
              .then(() => onCallback({ callback, native: payload?.native === true }))
              .then(() => {
                if (payload?.keep_open) clearTimeout(timer)
              })
              .catch((error) => {
                errorCode = /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_login_failed'
                abort()
                throw mailboxError(errorCode, 502)
              })
            callbackTask.catch(() => {})
          }
        }
        if (event.event === 'prepared') prepared = event.ok === true
        if (event.event === 'result' && ['session', 'subscription', 'register'].includes(action)) result = event.data
        if (event.event === 'registration_checkpoint' && action === 'register') {
          try {
            if (!onCheckpoint) throw mailboxError('registration_checkpoint_failed', 503)
            onCheckpoint(event.data)
            send({ registration_checkpoint_saved: true })
          } catch {
            errorCode = 'registration_checkpoint_failed'
            abort()
          }
        }
        if (event.event === 'rpc' && /^[a-f0-9-]{36}$/.test(event.id || '')) onEvent?.(event)
      }
    })
    const complete = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (!child.stdin.destroyed) child.stdin.end()
      error ? reject(error) : resolve(value)
    }
    child.on('error', () => complete(mailboxError('slot_exec_failed', 502)))
    child.on('close', async (code) => {
      try {
        await callbackTask
      } catch (error) {
        return complete(error)
      }
      if (signal?.aborted || code === 130) return complete(mailboxError('login_cancelled', 409))
      if (code !== 0)
        return complete(
          mailboxError(errorCode || (action === 'prepare' ? 'browser_prepare_failed' : 'browser_login_failed'), 502),
        )
      if (action === 'prepare')
        return prepared ? complete(null, { ok: true }) : complete(mailboxError('browser_prepare_failed', 502))
      if (action === 'remote') return complete(null, { ok: true })
      if (errorCode) return complete(mailboxError(errorCode, 502))
      if (['session', 'subscription', 'register'].includes(action))
        return result ? complete(null, result) : complete(mailboxError('browser_result_missing', 502))
      callback
        ? complete(null, { callback, native: payload?.native === true })
        : complete(mailboxError('oauth_callback_missing', 502))
    })
    send(job)
    if (signal?.aborted) abort()
  })
}
