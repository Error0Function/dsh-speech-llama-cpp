import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferred, harness, phase, response, turn } from './helpers.ts'

const liveSignal = (): AbortSignal => new AbortController().signal
const options = { timeout: 15_000 }

test('cold start is lazy and concurrent recordings share one serial worker', options, async t => {
  const replies = Array.from({ length: 3 }, () => deferred<Response>())
  const h = await harness(t, { post: (_call, index) => replies[index]!.promise })
  assert.equal(h.worker.snapshot().phase, 'unprepared')
  assert.equal(h.spawned.items.length, 0)
  assert.equal(h.health.items.length, 0)
  const jobs = replies.map(() => h.worker.transcribe(h.input, liveSignal()))
  await h.posts.at(0)
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.posts.items.length, 1)
  for (let index = 0; index < replies.length; index++) {
    replies[index]!.resolve(response(`${index === 2 ? '<asr_text>' : ''}recording ${index}`))
    if (index + 1 < replies.length) {
      await h.posts.at(index + 1)
      assert.equal(h.posts.items.length, index + 2)
      assert.equal(h.spawned.items.length, 1)
    }
  }
  const results = await Promise.all(jobs)
  assert.deepEqual(results.map(result => result.text), ['recording 0', 'recording 1', 'recording 2'])
  assert.equal(h.worker.diagnostics()?.rawText, '<asr_text>recording 2')
  assert.ok(results.every(result => result.audioSeconds === 1 && result.inferenceSeconds >= 0))
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  const body = h.posts.items[0]!.init.body
  assert.ok(body instanceof FormData)
  assert.equal(body.get('model'), 'llama-asr')
  assert.equal(body.get('response_format'), 'json')
  assert.equal(body.get('temperature'), '0')
  assert.equal(body.get('stream'), 'false')
  assert.equal(body.has('max_tokens'), false)
  assert.ok(body.get('file') instanceof Blob)
})

test('a large accepted queue has no plugin pending-work limit', options, async t => {
  const first = deferred<Response>()
  const h = await harness(t, { post: (_call, index) => index === 0 ? first.promise : response(`queued ${index}`) })
  const running = h.worker.transcribe(h.input, liveSignal())
  await h.posts.at(0)
  const queued = Array.from({ length: 64 }, () => h.worker.transcribe(h.input, liveSignal()))
  first.resolve(response('first'))
  const results = await Promise.all([running, ...queued])
  assert.equal(results.length, 65)
  assert.equal(h.posts.items.length, 65)
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
})

test('prepare joins shared startup and cancelling preparation retains recording interest', options, async t => {
  const listening = deferred<Response>()
  const h = await harness(t, { health: () => listening.promise })
  h.worker.prepare()
  h.worker.prepare()
  const health = await h.health.at(0)
  const recording = h.worker.transcribe(h.input, liveSignal())
  await turn()
  await h.worker.cancel()
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  assert.equal(health.signal.aborted, false)
  listening.resolve(new Response('', { status: 200 }))
  assert.equal((await recording).text, 'recognized')
  assert.equal(h.worker.snapshot().phase, 'ready')
})

test('prepare alone can be cancelled and waits for its startup process exit', options, async t => {
  const listening = deferred<Response>()
  const h = await harness(t, { health: () => listening.promise, spawn: child => { child.autoExitOnTerminate = false } })
  h.worker.prepare()
  await h.health.at(0)
  const child = h.spawned.items[0]!
  let settled = false
  const cancelling = h.worker.cancel().then(() => { settled = true })
  await child.terminated.promise
  await turn()
  assert.equal(settled, false)
  child.exit()
  await cancelling
  assert.ok(child.waitCalls > 0)
  assert.notEqual(h.worker.snapshot().phase, 'ready')
})

test('queued cancellation rejects promptly without posting or killing the running worker', options, async t => {
  const reply = deferred<Response>()
  const h = await harness(t, { post: (_call, index) => index === 0 ? reply.promise : response() })
  const running = h.worker.transcribe(h.input, liveSignal())
  await h.posts.at(0)
  const cancelled = new AbortController()
  const queued = h.worker.transcribe(h.input, cancelled.signal)
  const rejected = assert.rejects(queued, /queued cancellation/)
  cancelled.abort(new Error('queued cancellation'))
  await rejected
  assert.equal(h.posts.items.length, 1)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  reply.resolve(response('running survives'))
  assert.equal((await running).text, 'running survives')
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'recognized')
  assert.equal(h.spawned.items.length, 1)
})

test('current request cancellation aborts HTTP but retains the process for queued work', options, async t => {
  const blocked = deferred<Response>()
  const h = await harness(t, { post: (_call, index) => index === 0 ? blocked.promise : response('next') })
  const cancelled = new AbortController()
  const current = h.worker.transcribe(h.input, cancelled.signal)
  const rejected = assert.rejects(current, /current cancellation/)
  const call = await h.posts.at(0)
  const queued = h.worker.transcribe(h.input, liveSignal())
  cancelled.abort(new Error('current cancellation'))
  await rejected
  assert.equal(call.signal.aborted, true)
  assert.equal((await queued).text, 'next')
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
})

test('cancelling a recording during startup preserves another queued recording', options, async t => {
  const listening = deferred<Response>()
  const h = await harness(t, { health: () => listening.promise })
  const cancelled = new AbortController()
  const current = h.worker.transcribe(h.input, cancelled.signal)
  const rejected = assert.rejects(current, /startup cancellation/)
  const call = await h.health.at(0)
  const queued = h.worker.transcribe(h.input, liveSignal())
  cancelled.abort(new Error('startup cancellation'))
  await rejected
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  assert.equal(call.signal.aborted, false)
  listening.resolve(new Response('', { status: 200 }))
  assert.equal((await queued).text, 'recognized')
  assert.equal(h.spawned.items.length, 1)
})

test('a fresh recording during cancelled startup cleanup starts a new worker', options, async t => {
  const listening = deferred<Response>()
  let healthCalls = 0
  const h = await harness(t, {
    health: () => healthCalls++ === 0 ? listening.promise : new Response('', { status: 200 }),
    spawn: (child, index) => { if (index === 0) child.autoExitOnTerminate = false },
  })
  const cancelled = new AbortController()
  const first = h.worker.transcribe(h.input, cancelled.signal)
  const rejected = assert.rejects(first, /cancel first startup/)
  const oldHealth = await h.health.at(0)
  const old = h.spawned.items[0]!
  cancelled.abort(new Error('cancel first startup'))
  await Promise.all([rejected, old.terminated.promise])
  assert.equal(oldHealth.signal.aborted, true)
  const fresh = h.worker.transcribe(h.input, liveSignal())
  await turn()
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.posts.items.length, 0)
  old.exit()
  assert.equal((await fresh).text, 'recognized')
  assert.equal(h.spawned.items.length, 2)
  assert.equal(h.posts.items.length, 1)
  assert.equal(h.spawned.items[1]!.terminateCalls, 0)
})

test('startup process failure is cleaned up and a later request starts afresh', options, async t => {
  const listening = deferred<Response>()
  let firstHealth = true
  const h = await harness(t, { health: () => firstHealth ? listening.promise : new Response('', { status: 200 }) })
  const initial = h.worker.transcribe(h.input, liveSignal())
  const rejected = assert.rejects(initial, /exited|exit|startup|healthy/i)
  await h.health.at(0)
  const first = h.spawned.items[0]!
  first.exit({ exitCode: 9, signal: null })
  await rejected
  assert.ok(first.waitCalls > 0)
  assert.equal(h.posts.items.length, 0)
  assert.deepEqual(h.worker.diagnostics()?.exit, { exitCode: 9, signal: null, stderr: 'fixture stderr', stderrLossy: false })
  firstHealth = false
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'recognized')
  assert.equal(h.spawned.items.length, 2)
})

test('startup deadline terminates and waits for cleanup before rejecting', options, async t => {
  const listening = deferred<Response>()
  const h = await harness(t, { config: { startupTimeoutMs: 250 }, health: () => listening.promise, spawn: child => { child.autoExitOnTerminate = false } })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let settled = false
  const request = h.worker.transcribe(h.input, liveSignal()).finally(() => { settled = true })
  const rejected = assert.rejects(request, /deadline|timeout/i)
  await h.health.at(0)
  const child = h.spawned.items[0]!
  t.mock.timers.tick(250)
  await child.terminated.promise
  await turn()
  assert.equal(settled, false)
  child.exit()
  await rejected
  assert.ok(child.waitCalls > 0)
  assert.equal(h.posts.items.length, 0)
})

for (const failure of [
  { name: 'malformed JSON', make: () => new Response('{ broken'), error: /json|unexpected|property|parse/i },
  { name: 'missing text', make: () => Response.json({ language: 'en' }), error: /text/i },
  { name: 'non-string text', make: () => Response.json({ text: 17 }), error: /text/i },
  { name: 'HTTP failure', make: () => new Response('service unavailable', { status: 503 }), error: /503/ },
]) {
  test(`${failure.name} rejects once and keeps the shared server`, options, async t => {
    const h = await harness(t, { post: (_call, index) => index === 0 ? failure.make() : response('recovered') })
    await assert.rejects(h.worker.transcribe(h.input, liveSignal()), failure.error)
    assert.equal(h.posts.items.length, 1)
    assert.equal(h.spawned.items.length, 1)
    assert.equal(h.spawned.items[0]!.terminateCalls, 0)
    assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'recovered')
    assert.equal(h.spawned.items.length, 1)
  })
}

test('request deadline includes a sleeping server wake and retains its process', options, async t => {
  const waking = deferred<Response>()
  const h = await harness(t, { config: { requestTimeoutMs: 250 }, post: (_call, index) => index === 1 ? waking.promise : response('awake') })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  const request = h.worker.transcribe(h.input, liveSignal())
  const rejected = assert.rejects(request, /deadline|timeout/i)
  const call = await h.posts.at(1)
  t.mock.timers.tick(249)
  assert.equal(call.signal.aborted, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(call.signal.aborted, true)
  assert.equal(h.posts.items.length, 2)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'awake')
  assert.equal(h.spawned.items.length, 1)
})

test('success after native sleep reuses the same HTTP process and request deadline', options, async t => {
  const reload = deferred<Response>()
  const h = await harness(t, { config: { requestTimeoutMs: 900_000 }, post: (_call, index) => index === 1 ? reload.promise : response('warm') })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  t.mock.timers.tick(30_000)
  const waking = h.worker.transcribe(h.input, liveSignal())
  const call = await h.posts.at(1)
  t.mock.timers.tick(30_001)
  assert.equal(call.signal.aborted, false)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  reload.resolve(response('reloaded'))
  assert.equal((await waking).text, 'reloaded')
  assert.equal(h.spawned.items.length, 1)
})

test('process interruption during POST restarts and retries that recording once', options, async t => {
  const interrupted = deferred<Response>()
  const h = await harness(t, { post: (_call, index) => index === 0 ? interrupted.promise : response('retried') })
  const request = h.worker.transcribe(h.input, liveSignal())
  await h.posts.at(0)
  const first = h.spawned.items[0]!
  first.exit({ exitCode: 1, signal: null })
  interrupted.reject(new TypeError('fetch failed after child exit'))
  assert.equal((await request).text, 'retried')
  assert.equal(h.posts.items.length, 2)
  assert.equal(h.spawned.items.length, 2)
  assert.ok(first.waitCalls > 0)
})

test('subprocess provider failure during POST waits for cleanup and does not retry', options, async t => {
  const blocked = deferred<Response>()
  const h = await harness(t, {
    post: () => blocked.promise,
    spawn: child => { child.autoExitOnTerminate = false },
  })
  const failure = new Error('fixture subprocess provider failure')
  const request = h.worker.transcribe(h.input, liveSignal())
  let settled = false
  void request.then(() => { settled = true }, () => { settled = true })
  const rejected = assert.rejects(request, error => error === failure)
  await h.posts.at(0)
  const child = h.spawned.items[0]!
  child.rejectDone(failure)
  await child.waited.promise
  await turn()
  assert.equal(settled, false, 'provider failure must not settle before managed-range cleanup')
  assert.ok(child.terminateCalls > 0)
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.posts.items.length, 1)
  child.finishExit()
  await rejected
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.posts.items.length, 1)
  assert.equal(h.worker.diagnostics()?.exit?.failure, String(failure))
})

test('a second process interruption exhausts the single retry', options, async t => {
  const replies = [deferred<Response>(), deferred<Response>()]
  const h = await harness(t, { post: (_call, index) => {
    assert.ok(index < 2, 'a recording must not issue a third POST')
    return replies[index]!.promise
  } })
  const request = h.worker.transcribe(h.input, liveSignal())
  const rejected = assert.rejects(request, /fetch failed|exited|interrupted|exit/i)
  for (let index = 0; index < 2; index++) {
    await h.posts.at(index)
    h.spawned.items[index]!.exit({ exitCode: 1, signal: null })
    replies[index]!.reject(new TypeError('fetch failed after child exit'))
  }
  await rejected
  assert.equal(h.posts.items.length, 2)
  assert.equal(h.spawned.items.length, 2)
})

test('an unrelated connection failure is not retried and does not kill the worker', options, async t => {
  const h = await harness(t, { post: (_call, index) => {
    if (index === 0) throw new TypeError('unrelated connection failure')
    return response('later')
  } })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const request = h.worker.transcribe(h.input, liveSignal())
  const rejected = assert.rejects(request, /unrelated connection/)
  await h.posts.at(0)
  await turn()
  t.mock.timers.tick(h.config.graceMs)
  await rejected
  assert.equal(h.posts.items.length, 1)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'later')
  assert.equal(h.spawned.items.length, 1)
})

test('default idle policy exits at twice sleep time and the next recording restarts', options, async t => {
  const h = await harness(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  const first = h.spawned.items[0]!
  assert.equal(h.config.sleepIdleSeconds, 30)
  const sleepIndex = first.spec.argv.indexOf('--sleep-idle-seconds')
  assert.ok(sleepIndex >= 0)
  assert.equal(first.spec.argv[sleepIndex + 1], '30')
  t.mock.timers.tick(59_999)
  assert.equal(first.terminateCalls, 0)
  t.mock.timers.tick(1)
  await first.terminated.promise
  await first.waited.promise
  await phase(h.worker, 'standby')
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'recognized')
  assert.equal(h.spawned.items.length, 2)
})

test('idle retention begins only after running and queued work drain', options, async t => {
  const replies = [deferred<Response>(), deferred<Response>()]
  const h = await harness(t, { config: { sleepIdleSeconds: 1, requestTimeoutMs: 20_000 }, post: (_call, index) => replies[index]!.promise })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const first = h.worker.transcribe(h.input, liveSignal())
  await h.posts.at(0)
  const second = h.worker.transcribe(h.input, liveSignal())
  t.mock.timers.tick(2_000)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  replies[0]!.resolve(response('first'))
  await h.posts.at(1)
  t.mock.timers.tick(2_000)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  replies[1]!.resolve(response('second'))
  await Promise.all([first, second])
  await turn()
  t.mock.timers.tick(1_999)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  t.mock.timers.tick(1)
  await h.spawned.items[0]!.terminated.promise
})

test('new recording admission clears the previous idle timer', options, async t => {
  const second = deferred<Response>()
  const h = await harness(t, { config: { sleepIdleSeconds: 1 }, post: (_call, index) => index === 1 ? second.promise : response() })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  t.mock.timers.tick(1_999)
  const recording = h.worker.transcribe(h.input, liveSignal())
  await h.posts.at(1)
  t.mock.timers.tick(2)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  second.resolve(response())
  await recording
  await turn()
  t.mock.timers.tick(1_999)
  assert.equal(h.spawned.items[0]!.terminateCalls, 0)
  t.mock.timers.tick(1)
  await h.spawned.items[0]!.terminated.promise
})

test('idle process exit joins its managed range before spawning a replacement', options, async t => {
  const h = await harness(t, { spawn: (child, index) => { if (index === 0) child.autoExitOnTerminate = false } })
  await h.worker.transcribe(h.input, liveSignal())
  const old = h.spawned.items[0]!
  old.reportExit({ exitCode: null, signal: 'SIGTERM' })
  const replacement = h.worker.transcribe(h.input, liveSignal())
  const cleanupStartedFirst = await Promise.race([
    old.waited.promise.then(() => true),
    h.spawned.at(1).then(() => false),
  ])
  assert.equal(cleanupStartedFirst, true, 'replacement spawn must wait for the exited process range')
  await turn()
  assert.equal(h.spawned.items.length, 1)
  assert.equal(h.posts.items.length, 1)
  assert.deepEqual(h.worker.diagnostics()?.exit, { exitCode: null, signal: 'SIGTERM', stderr: 'fixture stderr', stderrLossy: false })
  old.finishExit()
  assert.equal((await replacement).text, 'recognized')
  assert.equal(h.spawned.items.length, 2)
  assert.equal(h.posts.items.length, 2)
  assert.equal(h.spawned.items[1]!.terminateCalls, 0)
})

test('the idle timer belonging to an exited worker cannot kill its replacement', options, async t => {
  const h = await harness(t, { config: { sleepIdleSeconds: 1 } })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  t.mock.timers.tick(1_000)
  h.spawned.items[0]!.exit({ exitCode: 1, signal: null })
  await phase(h.worker, 'standby')
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  const replacement = h.spawned.items[1]!
  t.mock.timers.tick(1_000)
  await turn()
  assert.equal(replacement.terminateCalls, 0)
  t.mock.timers.tick(999)
  assert.equal(replacement.terminateCalls, 0)
  t.mock.timers.tick(1)
  await replacement.terminated.promise
})

test('sleep zero omits native sleep and never schedules immediate idle destruction', options, async t => {
  const h = await harness(t, { config: { sleepIdleSeconds: 0 } })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  const child = h.spawned.items[0]!
  assert.equal(child.spec.argv.includes('--sleep-idle-seconds'), false)
  t.mock.timers.tick(0)
  await turn()
  assert.equal(child.terminateCalls, 0)
  t.mock.timers.tick(10_000_000)
  await turn()
  assert.equal(child.terminateCalls, 0)
  assert.equal((await h.worker.transcribe(h.input, liveSignal())).text, 'recognized')
  assert.equal(h.spawned.items.length, 1)
})

test('dispose cancels accepted requests, joins them, and awaits managed-range quiescence', options, async t => {
  const blocked = deferred<Response>()
  const h = await harness(t, { post: () => blocked.promise, spawn: child => { child.autoExitOnTerminate = false } })
  const current = h.worker.transcribe(h.input, liveSignal())
  const rejectedCurrent = assert.rejects(current, /disposed|cancel/i)
  const call = await h.posts.at(0)
  const queued = h.worker.transcribe(h.input, liveSignal())
  const rejectedQueued = assert.rejects(queued, /disposed|cancel/i)
  const child = h.spawned.items[0]!
  let disposed = false
  const disposing = h.worker.dispose().then(() => { disposed = true })
  await Promise.all([rejectedCurrent, rejectedQueued, child.terminated.promise])
  assert.equal(call.signal.aborted, true)
  assert.equal(h.posts.items.length, 1)
  assert.equal(disposed, false)
  child.reportExit({ exitCode: 0, signal: null })
  await turn()
  assert.equal(disposed, false, 'command outcome alone does not prove the process range is empty')
  child.finishExit()
  await disposing
  assert.ok(child.waitCalls > 0)
  await assert.rejects(async () => await h.worker.transcribe(h.input, liveSignal()), /disposed|cancel/i)
  assert.equal(h.spawned.items.length, 1)
})

test('dispose during startup aborts health and waits for the spawned process', options, async t => {
  const listening = deferred<Response>()
  const h = await harness(t, { health: () => listening.promise, spawn: child => { child.autoExitOnTerminate = false } })
  h.worker.prepare()
  const call = await h.health.at(0)
  const child = h.spawned.items[0]!
  let disposed = false
  const disposing = h.worker.dispose().then(() => { disposed = true })
  await child.terminated.promise
  await turn()
  assert.equal(call.signal.aborted, true)
  assert.equal(disposed, false)
  child.exit()
  await disposing
  assert.ok(child.waitCalls > 0)
  assert.notEqual(h.worker.snapshot().phase, 'ready')
})

test('dispose clears idle work and prevents later state notifications', options, async t => {
  const h = await harness(t, { config: { sleepIdleSeconds: 1 } })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let notifications = 0
  h.worker.subscribe(() => { notifications++ })
  await h.worker.transcribe(h.input, liveSignal())
  await turn()
  const child = h.spawned.items[0]!
  await h.worker.dispose()
  const countAfterDispose = notifications
  const terminationsAfterDispose = child.terminateCalls
  t.mock.timers.tick(20_000)
  await turn()
  assert.equal(notifications, countAfterDispose)
  assert.equal(child.terminateCalls, terminationsAfterDispose)
  assert.equal(h.spawned.items.length, 1)
})
