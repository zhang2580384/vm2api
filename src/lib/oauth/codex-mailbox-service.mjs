import crypto from 'node:crypto'
import { getVm, patchVmRecord, clearUnschedulable } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts, upsertCodexAccount, codexAccessExpiresAt } from '../vm/codex-slot.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { clearOpenAIAccountHold } from '../pool/openai-account-runtime.mjs'
import { invalidateLiveCredentialCache } from '../admin/panel-live-credentials.mjs'
import { openaiIdentityFromOauthTokens } from './openai-jwt.mjs'
import { ensureCodexCredential } from './codex-credential-refresh.mjs'
import { generateCodexAuthUrl, exchangeCodexAuthCode, discardCodexAuthSession } from './codex-oauth.mjs'
import { createMailboxStore, mailboxError, normalizeLoginEmail, normalizeTotpSecret } from './codex-mailbox-store.mjs'
import { createRegistrationStore } from './codex-registration-store.mjs'
import { assertMailboxSlotNetwork, runMailboxSlotProcess } from './codex-mailbox-runtime.mjs'
import { mailboxAuthFailure, clearMailboxAuthFailure } from './codex-mailbox-events.mjs'
import { manageMailboxBrowserRuntime } from './mailbox-browser-environment.mjs'

const instances = new Map()
const NEEDS_ATTENTION = new Set([
  'captcha_required',
  'microsoft_mfa_required',
  'mailbox_password_rejected',
  'mailbox_account_locked',
  'microsoft_login_needs_attention',
  'openai_email_code_unavailable',
  'email_code_rejected',
  'openai_password_rejected',
  'totp_rejected',
  'existing_account_or_phone_required',
  'authorized_email_mismatch',
  'mailbox_decryption_failed',
])

export function createCodexMailboxService({
  projectRoot,
  store = createMailboxStore(projectRoot),
  registrations = createRegistrationStore(projectRoot),
  getSlot = (id) => getVm(projectRoot, id),
  accountFor = (id) => readCodexAccounts(projectRoot, id)[0] || {},
  checkNetwork = assertMailboxSlotNetwork,
  runSlot = runMailboxSlotProcess,
  manageRuntime = manageMailboxBrowserRuntime,
  now = Date.now,
  generate = generateCodexAuthUrl,
  exchange = exchangeCodexAuthCode,
  refresh = (id, force) => ensureCodexCredential(projectRoot, id, { force }),
  commit = null,
  onAuthorized = () => {},
} = {}) {
  const jobs = new Map()
  const transientStates = new Map()
  const runtimeStates = new Map()
  const identityKey = (email) =>
    crypto
      .createHash('sha256')
      .update(String(email || '').toLowerCase())
      .digest('hex')
  let timer = null,
    guard = null,
    ticking = false,
    stopped = false,
    snapshotPaused = false
  const readSlot = (id) => {
    const vm = getSlot(id)
    if (!vm || !isCodexVm(vm)) throw mailboxError('codex_slot_required', 404)
    return vm
  }
  const availableSlot = (id) => {
    const vm = readSlot(id)
    if (!['running', 'ok', 'paused'].includes(vm.status) || vm.runtime?.stopped === true)
      throw mailboxError('slot_not_running', 409)
    if (!hasBoundExit(vm.proxy)) throw mailboxError('proxy_required', 409)
    return vm
  }
  const enabledSlot = (id) => {
    const vm = readSlot(id)
    if (vm.schedulable === false) throw mailboxError('slot_resting', 409)
    return availableSlot(id)
  }
  const jobSlot = (id) => {
    const job = jobs.get(id)
    if (!job?.allowResting) return enabledSlot(id)
    const vm = availableSlot(id)
    // A task explicitly started while resting may finish without enabling
    // scheduling. Once scheduling is enabled, disabling it cancels as usual.
    if (vm.schedulable !== false) job.allowResting = false
    return vm
  }
  const publicState = (id) => {
    const config = store.summary(id)
    let state = jobs.get(id)?.state || transientStates.get(id) || store.state(id)
    if (state?.running && !jobs.has(id)) {
      state = {
        ...state,
        running: false,
        status: 'interrupted',
        stage: 'interrupted',
        error_code: 'service_restarted',
        finished_at: new Date(now()).toISOString(),
        next_attempt_at: now() + 60_000,
      }
      store.writeState(id, state)
    }
    const savedSubscription = store.subscription(id)
    const subscription =
      savedSubscription?.account_key === identityKey(store.read(id)?.email || accountFor(id).email)
        ? savedSubscription
        : null
    return {
      ...config,
      registration: registrations.summary(id),
      subscription: subscription
        ? { enabled: subscription.enabled, checked_at: subscription.checked_at, period_end: subscription.period_end }
        : null,
      browser: {
        active: jobs.has(id) && !jobs.get(id)?.maintenance,
        ready: !!jobs.get(id)?.send,
        remote: jobs.get(id)?.remote === true,
        native: jobs.get(id)?.native === true,
        retained: jobs.get(id)?.authorized === true && jobs.get(id)?.native === true && !!jobs.get(id)?.send,
      },
      state: state || { running: false, status: 'idle', stage: 'idle' },
    }
  }
  const update = (id, patch) => {
    const value = { ...(jobs.get(id)?.state || transientStates.get(id) || store.state(id) || {}), ...patch }
    if (jobs.has(id)) jobs.get(id).state = value
    if (store.read(id)) {
      store.writeState(id, value)
      transientStates.delete(id)
    } else transientStates.set(id, value)
    return value
  }
  const stillAllowed = (id, revision, signal) => {
    if (signal.aborted) throw mailboxError('login_cancelled', 409)
    const vm = jobSlot(id)
    if (store.read(id)?.revision !== revision) throw mailboxError('mailbox_config_changed', 409)
    return vm
  }
  async function commitAccount(id, tokens, expectedEmail, { automatic = false } = {}) {
    const identity = openaiIdentityFromOauthTokens(tokens)
    if (String(identity.email || '').toLowerCase() !== expectedEmail)
      throw mailboxError('authorized_email_mismatch', 409)
    if (!tokens.access_token || !tokens.refresh_token) throw mailboxError('oauth_tokens_missing', 502)
    if (commit) return commit(id, tokens)
    const saved = upsertCodexAccount(projectRoot, id, tokens, { replaceCredentials: true })
    patchVmRecord(projectRoot, id, (vm) => {
      vm.codex = {
        ...(vm.codex || {}),
        has_access: true,
        has_refresh: !!saved.refresh_token,
        email: saved.email || null,
        chatgpt_account_id: saved.chatgpt_account_id || null,
        expires_at: saved.expires_at || null,
      }
      delete vm.codex.refresh_error
      delete vm.codex.refresh_error_at
      vm.refresh_error = null
      vm.refresh_status = null
      return vm
    })
    // Successful explicit authorization repairs credential parks only. It must
    // not enable an operator-disabled slot or clear proxy/maintenance failures.
    if (!automatic) {
      clearUnschedulable(projectRoot, id, {
        by: 'credential_import',
        only: [
          'no_credential',
          'oauth_cleared',
          'oauth_revoked',
          'oauth_invalid_grant',
          'oauth_no_refresh',
          'oauth_expired',
          'credential_refresh_failed',
          'credential_blocked',
        ],
      })
    }
    clearOpenAIAccountHold(id)
    invalidateLiveCredentialCache()
  }
  async function execute(id, entry, login) {
    const { controller } = entry
    let sessionId = ''
    try {
      let vm = stillAllowed(id, login.revision, controller.signal)
      await checkNetwork(vm)
      update(id, { stage: 'preparing_browser' })
      await runSlot({ projectRoot, vm, action: 'prepare', signal: controller.signal })
      vm = stillAllowed(id, login.revision, controller.signal)
      await checkNetwork(vm)
      const auth = generate({ vmId: id, proxyUrl: hostProxyUrlForVm(vm), installationId: vm.installation_id || vm.id })
      sessionId = auth.session_id
      const outer = new URL(auth.auth_url)
      const inner = outer.searchParams.get('authorize_url')
      const state = new URL(inner || outer).searchParams.get('state')
      if (!state) throw mailboxError('oauth_state_missing', 500)
      const authorize = async (response) => {
        if (entry.authorized) return
        vm = stillAllowed(id, login.revision, controller.signal)
        const callback = new URL(response.callback)
        if (
          callback.origin !== 'http://localhost:1455' ||
          callback.pathname !== '/auth/callback' ||
          callback.searchParams.get('state') !== state
        )
          throw mailboxError('oauth_state_mismatch', 409)
        update(id, { stage: 'exchanging_code' })
        const tokens = await exchange({ sessionId, code: response.callback, vmId: id, proxyUrl: hostProxyUrlForVm(vm) })
        stillAllowed(id, login.revision, controller.signal)
        await commitAccount(id, tokens, login.email, { automatic: entry.automatic })
        store.arm(id)
        // Arming rotates the binding revision. The retained browser still owns
        // this same account, and must not be cancelled by its own revision change.
        entry.revision = store.read(id).revision
        entry.authorized = true
        clearMailboxAuthFailure(projectRoot, id)
        update(id, {
          running: false,
          stage: 'completed',
          status: 'succeeded',
          error_code: null,
          browser_error_code: null,
          cleanup_error_code: response.resource_cleanup_error_code || null,
          last_success_at: new Date(now()).toISOString(),
          finished_at: new Date(now()).toISOString(),
          failures: 0,
          next_attempt_at: null,
        })
        discardCodexAuthSession(sessionId)
        sessionId = ''
        try {
          await onAuthorized(id)
        } catch {
          /* Credential commit has already succeeded. */
        }
      }
      update(id, { stage: 'opening_browser' })
      const response = await runSlot({
        projectRoot,
        vm,
        action: 'login',
        signal: controller.signal,
        payload: {
          email: login.email,
          password: login.password,
          mode: login.mode || 'microsoft_mailbox',
          totp_secret: login.totp_secret,
          auth_url: auth.auth_url,
          state,
          native: entry.native === true,
          keep_open: entry.native === true && !entry.automatic,
        },
        onStage: (stage) => {
          if (!entry.authorized) update(id, { stage })
        },
        onCallback: entry.native === true && !entry.automatic ? authorize : undefined,
        onControl: (send) => {
          entry.send = send
        },
        onEvent: (event) => receive(entry, event),
      })
      entry.send = null
      await authorize(response)
      if (response.resource_cleanup_error_code) update(id, { cleanup_error_code: response.resource_cleanup_error_code })
    } catch (error) {
      const code = /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_login_failed'
      if (entry.authorized) {
        // Closing a retained window, or a later browser failure, cannot erase
        // an authorization that was already committed successfully.
        update(id, {
          running: false,
          stage: 'completed',
          status: 'succeeded',
          error_code: null,
          browser_error_code: controller.signal.aborted ? null : code,
          cleanup_error_code: error.resource_cleanup_error_code || null,
        })
        return
      }
      const previous = store.state(id) || {}
      const failures = (previous.failures || 0) + 1
      const attention = NEEDS_ATTENTION.has(code)
      update(id, {
        running: false,
        stage: code === 'slot_resting' || controller.signal.aborted ? 'cancelled' : 'failed',
        status: attention
          ? 'needs_attention'
          : controller.signal.aborted || code === 'slot_resting'
            ? 'cancelled'
            : 'failed',
        error_code: code,
        failures,
        finished_at: new Date(now()).toISOString(),
        next_attempt_at: attention ? null : now() + Math.min(3600_000, 300_000 * 2 ** Math.min(failures - 1, 4)),
      })
    } finally {
      if (sessionId) discardCodexAuthSession(sessionId)
      entry.send = null
      closeRequests(entry)
      jobs.delete(id)
    }
  }
  function start(id, { automatic = false } = {}) {
    if (stopped || snapshotPaused) throw mailboxError('service_stopped', 409)
    if (jobs.has(id)) {
      if (jobs.get(id).remote || jobs.get(id).maintenance || jobs.get(id).registration)
        throw mailboxError('mailbox_login_busy', 409)
      return publicState(id)
    }
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const login = store.read(id)
    if (!login) throw mailboxError('mailbox_not_configured', 409)
    const current = automatic ? enabledSlot(id) : availableSlot(id)
    const controller = new AbortController()
    const entry = {
      controller,
      send: null,
      promise: null,
      pending: new Map(),
      revision: login.revision,
      automatic,
      native: !automatic,
      allowResting: !automatic && current.schedulable === false,
    }
    jobs.set(id, entry)
    update(id, {
      running: true,
      job_id: crypto.randomUUID(),
      status: 'running',
      stage: 'queued',
      automatic,
      error_code: null,
      browser_error_code: null,
      cleanup_error_code: null,
      started_at: new Date(now()).toISOString(),
      finished_at: null,
    })
    entry.promise = Promise.resolve().then(() => execute(id, entry, login))
    return publicState(id)
  }
  function emptyRegistrationSlot(id, revision, signal) {
    if (signal.aborted) throw mailboxError('login_cancelled', 409)
    const vm = jobs.has(id) ? jobSlot(id) : availableSlot(id)
    const account = accountFor(id)
    if (store.read(id) || account.access_token || account.refresh_token || account.email)
      throw mailboxError('registration_empty_slot_required', 409)
    if (store.read(id)?.revision !== revision) throw mailboxError('mailbox_config_changed', 409)
    return vm
  }
  function register(id, input, owner) {
    if (stopped || snapshotPaused) throw mailboxError('service_stopped', 409)
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    if (!owner?.id) throw mailboxError('credential_owner_required', 403)
    const email = normalizeLoginEmail(input)
    emptyRegistrationSlot(id, undefined, new AbortController().signal)
    let draft = registrations.read(id, owner)
    if (draft && draft.email !== email && draft.phase !== 'draft')
      throw mailboxError('registration_recovery_pending', 409)
    if (
      store.pool.list({ id: draft?.owner || owner.id }).some((record) => {
        if (record.email !== email || record.id === draft?.credential_id) return false
        if (draft?.phase === 'mfa_verified') {
          const saved = store.pool.read(record.id, { id: draft.owner })
          if (saved.password === draft.password && saved.totp_secret === draft.totp_secret) return false
        }
        return true
      })
    )
      throw mailboxError('registration_email_exists', 409)
    if (!draft || draft.email !== email) {
      // Fixed character classes plus 192 random bits; no batch delimiters.
      draft = registrations.save(id, {
        email,
        password: `Aa9!${crypto.randomBytes(24).toString('hex')}`,
        owner: owner.id,
        phase: 'draft',
        created_at: new Date(now()).toISOString(),
      })
    }
    const entry = {
      registration: true,
      native: false,
      allowResting: readSlot(id).schedulable === false,
      controller: new AbortController(),
      pending: new Map(),
      send: null,
      revision: undefined,
    }
    jobs.set(id, entry)
    update(id, {
      running: true,
      status: 'running',
      stage: 'preparing_browser',
      automatic: false,
      job_id: crypto.randomUUID(),
      error_code: null,
      started_at: new Date(now()).toISOString(),
      finished_at: null,
      next_attempt_at: null,
    })
    entry.promise = Promise.resolve().then(async () => {
      try {
        let vm = emptyRegistrationSlot(id, entry.revision, entry.controller.signal)
        if (['mfa_verified', 'pooled'].includes(draft.phase) && draft.password_verified !== true)
          throw mailboxError('registration_password_unconfirmed', 409)
        if (!['mfa_verified', 'pooled'].includes(draft.phase)) {
          await checkNetwork(vm)
          await runSlot({ projectRoot, vm, action: 'prepare', signal: entry.controller.signal })
          vm = emptyRegistrationSlot(id, entry.revision, entry.controller.signal)
          await checkNetwork(vm)
          const result = await runSlot({
            projectRoot,
            vm,
            action: 'register',
            signal: entry.controller.signal,
            payload: {
              operation: 'register',
              email,
              password: draft.password,
              registration_phase: draft.phase,
              password_verified: draft.password_verified === true,
              totp_secret: draft.totp_secret || '',
            },
            onStage: (stage) => update(id, { stage }),
            onControl: (send) => {
              entry.send = send
            },
            onEvent: (event) => receive(entry, event),
            onCheckpoint: (data) => {
              emptyRegistrationSlot(id, entry.revision, entry.controller.signal)
              if (normalizeLoginEmail(data?.email) !== email) throw mailboxError('authorized_email_mismatch', 409)
              const transitions = {
                draft: ['submitted'],
                submitted: ['account_created'],
                account_created: ['password_submitted', 'password_set'],
                password_submitted: ['password_submitted', 'password_set'],
                password_set: ['totp_pending'],
                totp_pending: draft.password_verified === true ? ['totp_pending'] : ['password_submitted'],
              }
              if (!transitions[draft.phase]?.includes(data.phase))
                throw mailboxError('registration_checkpoint_failed', 409)
              if (data.phase === 'password_set' && data.password_verified !== true)
                throw mailboxError('registration_password_unconfirmed', 409)
              const secret = data.phase === 'totp_pending' ? normalizeTotpSecret(data.totp_secret) : draft.totp_secret
              draft = registrations.save(id, {
                ...draft,
                phase: data.phase,
                password_verified: data.phase === 'password_set' || draft.password_verified === true,
                totp_secret: secret,
              })
            },
          })
          entry.send = null
          emptyRegistrationSlot(id, entry.revision, entry.controller.signal)
          if (normalizeLoginEmail(result?.email) !== email) throw mailboxError('authorized_email_mismatch', 409)
          if (result?.password_verified !== true || draft.password_verified !== true)
            throw mailboxError('registration_password_unconfirmed', 409)
          if (
            result?.totp_verified !== true ||
            draft.phase !== 'totp_pending' ||
            normalizeTotpSecret(result.totp_secret) !== draft.totp_secret
          )
            throw mailboxError('registration_mfa_unconfirmed', 409)
          draft = registrations.save(id, { ...draft, phase: 'mfa_verified' })
        }
        emptyRegistrationSlot(id, entry.revision, entry.controller.signal)
        const credentialOwner = { id: draft.owner }
        let credentialId = draft.credential_id
        if (credentialId) {
          const record = store.pool.read(credentialId, credentialOwner)
          if (record.email !== email || record.password !== draft.password || record.totp_secret !== draft.totp_secret)
            throw mailboxError('mailbox_config_changed', 409)
        } else {
          credentialId = store.pool.createRegistered(draft, credentialOwner).id
          draft = registrations.save(id, { ...draft, phase: 'pooled', credential_id: credentialId })
        }
        // No await between the empty-slot check, binding, and revision update.
        // OAuth failure retains the confirmed credentials for a manual retry.
        store.bind(id, credentialId, credentialOwner)
        entry.revision = store.read(id).revision
        entry.native = true
        update(id, { stage: 'registration_authorizing' })
        await execute(id, entry, store.read(id))
      } catch (error) {
        const code = /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_registration_failed'
        update(id, {
          running: false,
          status: entry.controller.signal.aborted ? 'cancelled' : 'needs_attention',
          stage: entry.controller.signal.aborted ? 'cancelled' : 'failed',
          error_code: code,
          finished_at: new Date(now()).toISOString(),
          next_attempt_at: null,
        })
      } finally {
        entry.send = null
        closeRequests(entry)
        jobs.delete(id)
      }
    })
    return publicState(id)
  }
  const cancel = (id) => {
    jobs.get(id)?.controller.abort()
    return publicState(id)
  }
  function closeRequests(entry) {
    for (const pending of entry.pending?.values() || []) {
      clearTimeout(pending.timer)
      pending.reject(mailboxError('browser_closed', 409))
    }
    entry.pending?.clear()
  }
  function receive(entry, event) {
    const pending = entry.pending?.get(event.id)
    if (!pending) return
    clearTimeout(pending.timer)
    entry.pending.delete(event.id)
    if (entry.controller.signal.aborted) return pending.reject(mailboxError('slot_resting', 409))
    event.ok
      ? pending.resolve(event.data)
      : pending.reject(
          mailboxError(
            /^[a-z_]{1,60}$/.test(event.error_code || '') ? event.error_code : 'browser_control_failed',
            409,
          ),
        )
  }
  function control(id, body) {
    jobSlot(id)
    const entry = jobs.get(id)
    if (!entry?.send) throw mailboxError('browser_not_ready', 409)
    if (entry.controller.signal.aborted) throw mailboxError('browser_closed', 409)
    const allowed = [
      'frame',
      'takeover',
      'resume',
      'session',
      'tab',
      'navigate',
      'click',
      'wheel',
      'key',
      'text',
      'clipboard',
      'reload',
      'back',
    ]
    if (!allowed.includes(body?.op) || JSON.stringify(body).length > 12_000)
      throw mailboxError('invalid_browser_operation')
    const fields = {
      tab: ['index'],
      navigate: ['url'],
      click: ['x', 'y', 'button'],
      wheel: ['x', 'y'],
      key: ['key'],
      text: ['text'],
    }
    if (Object.keys(body).some((key) => key !== 'op' && !(fields[body.op] || []).includes(key)))
      throw mailboxError('invalid_browser_operation')
    if (entry.pending.size >= 4) throw mailboxError('browser_control_busy', 409)
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => {
        entry.pending.delete(requestId)
        reject(mailboxError('browser_control_timeout', 504))
      }, 40_000)
      timer.unref?.()
      entry.pending.set(requestId, { resolve, reject, timer })
      entry.send({ ...body, id: requestId })
    })
  }
  function remote(id) {
    if (stopped || snapshotPaused) throw mailboxError('service_stopped', 409)
    if (jobs.get(id)?.maintenance) throw mailboxError('mailbox_login_busy', 409)
    if (jobs.has(id)) {
      jobSlot(id)
      return publicState(id)
    }
    const vm = availableSlot(id)
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const entry = {
      controller: new AbortController(),
      pending: new Map(),
      send: null,
      remote: true,
      native: true,
      allowResting: vm.schedulable === false,
      revision: store.read(id)?.revision,
    }
    jobs.set(id, entry)
    update(id, {
      running: true,
      status: 'running',
      stage: 'preparing_browser',
      error_code: null,
      browser_error_code: null,
      cleanup_error_code: null,
    })
    entry.promise = Promise.resolve().then(async () => {
      try {
        await checkNetwork(vm)
        await runSlot({ projectRoot, vm, action: 'prepare', signal: entry.controller.signal })
        const current = jobSlot(id)
        if (entry.controller.signal.aborted) throw mailboxError('login_cancelled', 409)
        await checkNetwork(current)
        const email = store.read(id)?.email || accountFor(id).email || ''
        await runSlot({
          projectRoot,
          vm: current,
          action: 'remote',
          signal: entry.controller.signal,
          payload: { remote: true, native: true, keep_open: true, email, profile_id: id },
          onStage: (stage) => update(id, { stage }),
          onControl: (send) => {
            entry.send = send
          },
          onEvent: (event) => receive(entry, event),
        })
      } catch (error) {
        update(id, { error_code: /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_control_failed' })
      } finally {
        update(id, { running: false, status: 'idle', stage: 'idle' })
        closeRequests(entry)
        jobs.delete(id)
      }
    })
    return publicState(id)
  }
  async function browserTask(id, operation, options = {}) {
    if (stopped || snapshotPaused) throw mailboxError('service_stopped', 409)
    const vm = enabledSlot(id)
    if (operation === 'session' && jobs.has(id)) return control(id, { op: 'session' })
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const entry = {
      controller: new AbortController(),
      pending: new Map(),
      send: null,
      revision: store.read(id)?.revision,
    }
    const email = store.read(id)?.email || accountFor(id).email || ''
    if (!email) throw mailboxError('mailbox_not_configured', 409)
    jobs.set(id, entry)
    update(id, {
      running: true,
      status: 'running',
      stage: operation === 'session' ? 'exporting_session' : 'checking_subscription',
      error_code: null,
    })
    entry.promise = Promise.resolve().then(async () => {
      try {
        await checkNetwork(vm)
        update(id, { stage: 'preparing_browser' })
        await runSlot({ projectRoot, vm, action: 'prepare', signal: entry.controller.signal })
        const current = stillAllowed(id, entry.revision, entry.controller.signal)
        await checkNetwork(current)
        update(id, { stage: operation === 'session' ? 'exporting_session' : 'checking_subscription' })
        const result = await runSlot({
          projectRoot,
          vm: current,
          action: operation,
          signal: entry.controller.signal,
          payload: { operation, email, profile_id: id, ...options },
        })
        stillAllowed(id, entry.revision, entry.controller.signal)
        if ((store.read(id)?.email || accountFor(id).email || '') !== email)
          throw mailboxError('mailbox_config_changed', 409)
        if (operation === 'subscription') {
          if (
            typeof result?.enabled !== 'boolean' ||
            !Number.isFinite(Date.parse(result.period_end)) ||
            Date.parse(result.period_end) <= now() ||
            (typeof options.enabled === 'boolean' && result.enabled !== options.enabled)
          )
            throw mailboxError('subscription_verification_failed', 502)
          const verified = {
            enabled: result.enabled,
            period_end: result.period_end,
            checked_at: new Date(now()).toISOString(),
            account_key: identityKey(email),
          }
          store.saveSubscription(id, verified)
          return { enabled: verified.enabled, period_end: verified.period_end, checked_at: verified.checked_at }
        }
        if (!result?.accessToken) throw mailboxError('session_not_authenticated', 409)
        if (String(result.user?.email || '').toLowerCase() !== email.toLowerCase())
          throw mailboxError('authorized_email_mismatch', 409)
        return result
      } catch (error) {
        if (operation === 'subscription' && typeof options.enabled === 'boolean') store.clearSubscription(id)
        update(id, { error_code: /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_control_failed' })
        throw error
      } finally {
        update(id, { running: false, status: 'idle', stage: 'idle' })
        closeRequests(entry)
        jobs.delete(id)
      }
    })
    return entry.promise
  }
  async function tick() {
    if (ticking || stopped || snapshotPaused) return
    ticking = true
    try {
      for (const id of store.ids()) {
        try {
          const login = store.read(id),
            vm = getSlot(id)
          if (stopped) break
          if (
            !login?.auto_reauthorize ||
            login.login_armed === false ||
            !vm ||
            !isCodexVm(vm) ||
            vm.schedulable === false ||
            !['running', 'ok'].includes(vm.status)
          )
            continue
          const state = publicState(id).state
          if (jobs.size || state.status === 'needs_attention' || Number(state.next_attempt_at || 0) > now()) continue
          const account = accountFor(id)
          const failed = mailboxAuthFailure(projectRoot, id)
          const expiry = codexAccessExpiresAt(account)
          if (!failed && !account.refresh_error && account.access_token && (!expiry || expiry > now() + 10 * 60_000))
            continue
          if (account.refresh_token && !account.refresh_error) {
            // Prefer normal grant rotation before opening a browser.
            const refreshed = await refresh(id, !!failed)
            if (stopped) break
            enabledSlot(id)
            if (refreshed.ok) {
              clearMailboxAuthFailure(projectRoot, id)
              continue
            }
            if (refreshed.refresh_class !== 'fatal' && refreshed.refresh_class !== 'unsupported') continue
          }
          start(id, { automatic: true })
          break
        } catch {
          /* One bad configuration must not touch or block other slots. */
        }
      }
    } finally {
      ticking = false
    }
  }
  const runtimeSlot = (id) => {
    if (stopped || snapshotPaused) throw mailboxError('service_stopped', 409)
    const vm = readSlot(id)
    if (!['running', 'ok', 'paused'].includes(vm.status) || vm.runtime?.stopped === true)
      throw mailboxError('slot_not_running', 409)
    return vm
  }
  async function runtimeStatus(id) {
    const vm = runtimeSlot(id)
    if (jobs.get(id)?.maintenance) return runtimeStates.get(id)
    const info = await manageRuntime({ projectRoot, vm, action: 'status' })
    // A maintenance job may have started while the read-only probe was in flight.
    if (jobs.get(id)?.maintenance) return runtimeStates.get(id)
    const state = { ...runtimeStates.get(id), ...info, running: false }
    runtimeStates.set(id, state)
    return state
  }
  function runtime(id, action) {
    if (!['install', 'uninstall'].includes(action)) throw mailboxError('invalid_browser_operation')
    const vm = runtimeSlot(id)
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const entry = { maintenance: true, controller: new AbortController(), pending: new Map() }
    jobs.set(id, entry)
    const updateRuntime = (patch) => runtimeStates.set(id, { ...runtimeStates.get(id), ...patch })
    updateRuntime({
      running: true,
      stage: action === 'install' ? 'detecting_browser_os' : 'uninstalling_browser',
      error_code: null,
    })
    entry.promise = Promise.resolve().then(async () => {
      try {
        runtimeSlot(id)
        const info = await manageRuntime({
          projectRoot,
          vm,
          action,
          signal: entry.controller.signal,
          onStage: (stage) => updateRuntime({ stage }),
        })
        updateRuntime({
          ...info,
          stage: action === 'install' ? 'browser_runtime_installed' : 'browser_runtime_removed',
        })
      } catch (error) {
        updateRuntime({
          stage: 'failed',
          error_code: /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_runtime_operation_failed',
        })
      } finally {
        updateRuntime({ running: false })
        jobs.delete(id)
      }
    })
    return runtimeStates.get(id)
  }
  const guardJobs = () => {
    for (const [id, job] of jobs) {
      try {
        if (job.maintenance) {
          runtimeSlot(id)
          continue
        }
        jobSlot(id)
        if (store.read(id)?.revision !== job.revision) job.controller.abort()
      } catch {
        job.controller.abort()
      }
    }
  }
  return {
    get busy() {
      return jobs.size > 0 || ticking
    },
    beginSnapshot() {
      if (jobs.size || ticking)
        throw Object.assign(new Error('浏览器任务正在执行，请关闭登录或接管窗口后再备份'), {
          code: 'backup_browser_busy',
        })
      snapshotPaused = true
    },
    endSnapshot() {
      snapshotPaused = false
    },
    resetAfterRestore() {
      transientStates.clear()
      runtimeStates.clear()
    },
    status(id) {
      readSlot(id)
      return publicState(id)
    },
    save(id, body) {
      readSlot(id)
      if (jobs.has(id)) throw mailboxError('mailbox_login_busy', 409)
      store.save(id, body)
      update(id, {
        running: false,
        status: 'idle',
        stage: 'idle',
        error_code: null,
        failures: 0,
        next_attempt_at: null,
      })
      return publicState(id)
    },
    start,
    register,
    registrationReveal(id, owner) {
      readSlot(id)
      if (!owner?.id) throw mailboxError('credential_owner_required', 403)
      const draft = registrations.read(id, owner)
      if (!draft) throw mailboxError('registration_not_found', 404)
      return {
        email: draft.email,
        password: draft.password,
        totp_secret: draft.totp_secret || '',
        password_verified: draft.password_verified === true,
        mfa_verified: draft.password_verified === true && ['mfa_verified', 'pooled'].includes(draft.phase),
      }
    },
    cancel,
    tick,
    remote,
    control,
    runtime,
    runtimeStatus,
    session(id) {
      return browserTask(id, 'session')
    },
    subscription(id, body = {}) {
      if (body.enabled != null && typeof body.enabled !== 'boolean') throw mailboxError('invalid_subscription_setting')
      return browserTask(id, 'subscription', body.enabled == null ? {} : { enabled: body.enabled })
    },
    poolList(owner, visibleIds) {
      const visible = new Set(visibleIds)
      const bindings = new Map()
      for (const id of store.ids()) {
        if (!visible.has(id)) continue
        try {
          const credentialId = store.summary(id).credential_id
          if (credentialId) bindings.set(credentialId, [...(bindings.get(credentialId) || []), id])
        } catch {
          /* A corrupt slot configuration must not reveal or block another record. */
        }
      }
      return store.pool.list(owner).map((record) => ({ ...record, bound_vm_ids: bindings.get(record.id) || [] }))
    },
    poolImport(text, owner) {
      return store.pool.import(text, owner)
    },
    poolReveal(credentialId, owner) {
      const record = store.pool.read(credentialId, owner)
      return {
        email: record.email,
        password: record.password,
        totp_secret: record.totp_secret || '',
        mode: record.mode,
      }
    },
    poolRemove(credentialId, owner) {
      store.pool.read(credentialId, owner)
      if (store.ids().some((id) => store.summary(id).credential_id === credentialId))
        throw mailboxError('credential_bound', 409)
      store.pool.remove(credentialId, owner)
    },
    bind(id, credentialId, owner) {
      readSlot(id)
      if (jobs.has(id)) throw mailboxError('mailbox_login_busy', 409)
      store.pool.read(credentialId, owner)
      if (store.ids().some((other) => other !== id && store.summary(other).credential_id === credentialId))
        throw mailboxError('credential_bound_elsewhere', 409)
      store.bind(id, credentialId, owner)
      update(id, {
        running: false,
        status: 'idle',
        stage: 'waiting_manual_login',
        error_code: null,
        failures: 0,
        next_attempt_at: null,
      })
      clearMailboxAuthFailure(projectRoot, id)
      return publicState(id)
    },
    verificationCode(id, code) {
      const job = jobs.get(id)
      if (
        !job?.send ||
        ![
          'waiting_mfa',
          'registration_email_code',
          'registration_password_email_code',
          'registration_mfa_email_code',
        ].includes(job.state?.stage)
      )
        throw mailboxError('no_verification_pending', 409)
      if (job.controller.signal.aborted) throw mailboxError('browser_closed', 409)
      jobSlot(id)
      if (!/^[A-Za-z0-9-]{4,12}$/.test(String(code || ''))) throw mailboxError('invalid_verification_code')
      job.send({ verification_code: String(code) })
      return publicState(id)
    },
    remove(id) {
      jobs.get(id)?.controller.abort()
      store.remove(id)
      transientStates.delete(id)
      clearMailboxAuthFailure(projectRoot, id)
    },
    startMonitor() {
      if (timer) return
      stopped = false
      timer = setInterval(() => {
        void tick().catch(() => {})
      }, 30_000)
      timer.unref?.()
      guard = setInterval(guardJobs, 2000)
      guard.unref?.()
      queueMicrotask(() => {
        void tick().catch(() => {})
      })
    },
    guardJobs,
    stop() {
      stopped = true
      clearInterval(timer)
      clearInterval(guard)
      timer = null
      guard = null
      for (const job of jobs.values()) job.controller.abort()
    },
    async settle() {
      await Promise.all([...jobs.values()].map((job) => job.promise))
    },
  }
}

export function codexMailboxService(projectRoot) {
  if (!instances.has(projectRoot)) instances.set(projectRoot, createCodexMailboxService({ projectRoot }))
  return instances.get(projectRoot)
}
