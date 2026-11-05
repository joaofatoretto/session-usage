import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bar, compactFitsOpeners, compactLine, daylight, fit, hasContent, parsePlanUsage, resetText, tokens, toUsage } from './register'

const NOW = Date.parse('2026-10-07T12:00:00Z')

/** The engine's own band beneath the plugin: empty. */
const emptyBand = (on: On) => on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))

test('picks the 5-hour and weekly windows', () => {
  expect(
    toUsage(
      [
        { kind: 'five_hour', percentUsed: 32, resetsAt: '2026-10-07T14:15:00Z' },
        { kind: 'seven_day', percentUsed: 41 },
      ],
      { usd: 1.5 },
    ),
  ).toEqual({
    session: { percent: 32, resetsAt: '2026-10-07T14:15:00Z' },
    week: { percent: 41, resetsAt: undefined },
    costUsd: 1.5,
    context: undefined,
  })
})

test('draws the bar in proportion and clamps past 100%', () => {
  expect(bar(25, 8)).toEqual(['━━', '──────'])
  expect(bar(130, 4)).toEqual(['━━━━', ''])
  expect(bar(4, 10)).toEqual(['━', '─────────'])
  expect(bar(0, 4)).toEqual(['', '────'])
})

// Local-time formatting: build the expectations from local Date parts.
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()
const NOON = local(2026, 10, 7, 12, 0) // a Wednesday

test('shows time left and the local reset time', () => {
  expect(resetText(new Date(local(2026, 10, 7, 14, 15)).toISOString(), NOON)).toBe('resets in 2h 15m · 14:15')
  expect(resetText(new Date(local(2026, 10, 7, 12, 40)).toISOString(), NOON)).toBe('resets in 40m · 12:40')
})

test('says tomorrow, or the weekday further out', () => {
  expect(resetText(new Date(local(2026, 10, 8, 1, 5)).toISOString(), NOON)).toBe('resets in 13h 5m · tomorrow 01:05')
  expect(resetText(new Date(local(2026, 10, 10, 15, 0)).toISOString(), NOON)).toBe('resets in 3d 3h · Sat 15:00')
})

test('colors both meters like a day running out', () => {
  expect(daylight(12)).toBe('cyan')
  expect(daylight(50)).toBe('blue')
  expect(daylight(75)).toBe('magenta')
  expect(daylight(90)).toBe('red')
})

test('the short reset style keeps only the time', () => {
  expect(resetText(new Date(local(2026, 10, 7, 14, 15)).toISOString(), NOON, 'short')).toBe('resets 14:15')
  expect(resetText(new Date(local(2026, 10, 10, 15, 0)).toISOString(), NOON, 'short')).toBe('resets Sat 15:00')
})

test('the context column shrinks before it hides', () => {
  const usage = {
    session: { percent: 32, resetsAt: new Date(local(2026, 10, 7, 14, 15)).toISOString() },
    week: { percent: 41 },
    context: { tokens: 84_000, window: 200_000, percent: 42 },
  }
  const wide = fit(usage, NOON, 140)
  expect(wide.layout).toMatchObject({ bar: 14, reset: 'full', context: true })
  expect(wide.columnsNeeded).toBeLessThanOrEqual(140)

  const medium = fit(usage, NOON, 85)
  expect(medium.layout).toMatchObject({ context: true, reset: 'short' })
  expect(medium.columnsNeeded).toBeLessThanOrEqual(85)

  const narrow = fit(usage, NOON, 60)
  expect(narrow.layout.context).toBe(false)
  expect(narrow.context).toBeUndefined()
})

test('shortens token counts', () => {
  expect(tokens(840)).toBe('840')
  expect(tokens(84_200)).toBe('84k')
  expect(tokens(1_000_000)).toBe('1M')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band shows the percentages on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    emptyBand(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 32, resetsAt: '2026-10-07T14:15:00Z' },
        { kind: 'seven_day', percentUsed: 41 },
      ],
      changed: ['rateLimits'],
    })
    const band = await $.ui.mount({
      plugin: 'session-usage',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 140,
        scroll: { offset: 0, bodyRows: 9 },
        view: {},
      },
    })
    expect(await band.find({ text: '   32%' })).toBeDefined()
    expect(await band.find({ text: /^week +41%$/ })).toBeDefined()
    expect(await band.find({ text: /resets in 2h 15m · / })).toBeDefined()
    expect(await band.find({ text: /Clear|Cloudy|Showers|Storm|Compact/ })).toBeUndefined()
    expect(await band.find({ text: /☀|☁|☂|☇|↯/ })).toBeUndefined()
    expect(await band.find({ text: '84k used · 116k left' })).toBeDefined()
  })
}

test('the minimized line carries both percentages in their colors', () => {
  expect(
    compactLine({ session: { percent: 32 }, context: { tokens: 160_000, window: 200_000, percent: 80 } }),
  ).toEqual([
    { text: 'session ' },
    { text: '32%', color: 'cyan' },
    { text: '  ·  ' },
    { text: 'context ' },
    { text: '80%', color: 'magenta' },
  ])
  expect(compactLine(null)).toEqual([{ text: 'usage after first reply' }])
})

const bandProps = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`minimize shrinks the panel to a card, and is remembered, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    emptyBand(on)
    const saved: Record<string, unknown> = {}
    on('store.get', ($, e) => ({ value: saved[e.key] }))
    on('store.set', ($, e) => {
      saved[e.key] = e.value
      return { value: undefined }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('ui.status', () => ({ value: undefined }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.session.measure({
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 32 }],
      changed: ['rateLimits'],
    })
    const band = await $.ui.mount({ plugin: 'session-usage', surface, component: 'AbovePrompt', props: bandProps })
    expect(await band.find({ text: '▝▜█████▛▘' })).toBeDefined()

    await band.press({ key: 'toggle' })
    expect(await band.find({ text: '■' })).toBeDefined()
    expect(await band.find({ text: '▝▜█████▛▘' })).toBeUndefined()
    expect(await band.find({ text: '42%' })).toBeDefined()
    expect(saved.isMinimized).toBe(true)

    await band.press({ key: 'toggle' })
    expect(await band.find({ text: '■' })).toBeUndefined()
    expect(saved.isMinimized).toBe(false)
  })
}

test('Clawd blinks within 6 to 15 seconds, then opens his eyes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  emptyBand(on)
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
    on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'session-usage',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: bandProps,
  })
  const open = ' ▐▛███▜▌ '
  const closed = ' ▐█████▌ '
  expect(await band.find({ text: open })).toBeDefined()

  await clock.advance(5_900)
  expect(await band.find({ text: open })).toBeDefined()

  let sawClosed = false
  for (let ms = 0; ms < 9_200 && !sawClosed; ms += 50) {
    await clock.advance(50)
    sawClosed = (await band.find({ text: closed })) !== undefined
  }
  expect(sawClosed).toBe(true)

  await clock.advance(1_000)
  expect(await band.find({ text: open })).toBeDefined()
})

test('an empty tree has no content; text and buttons do', () => {
  expect(hasContent(undefined)).toBe(false)
  expect(hasContent({ type: 'Box', props: {} })).toBe(false)
  expect(hasContent({ type: 'Box', props: { children: [{ type: 'Text', props: { children: ' ' } }] } })).toBe(false)
  expect(hasContent({ type: 'Box', props: { children: [{ type: 'Text', props: { children: 'hi' } }] } })).toBe(true)
  expect(hasContent({ type: 'Box', props: { children: [{ type: 'Button', props: { key: 'go', label: 'Go' } }] } })).toBe(true)
})

test('the band gives way to a mod beneath that has something to show', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) =>
    $.ui.resolve(e).Text({ children: 'Blast Radius asks' }),
  )
  const band = await $.ui.mount({ plugin: 'session-usage', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  expect(await band.find({ text: 'Blast Radius asks' })).toBeDefined()
  expect(await band.find({ text: ' ▐▛███▜▌ ' })).toBeUndefined()
})

test("the engine's own empty band does not push the panel aside", () => {
  expect(hasContent({ type: 'engine', ref: 1 })).toBe(false)
  expect(hasContent({ type: 'Box', props: { children: [] } })).toBe(false)
  expect(hasContent({ type: 'Box', props: { children: [{ type: 'Text', props: { children: 'Proceed?' } }] } })).toBe(
    true,
  )
})

test('reads the plan-usage answer as rate-limit windows', () => {
  const text = JSON.stringify({
    five_hour: { utilization: 66.0, resets_at: '2026-10-07T23:29:59.843543+00:00' },
    seven_day: { utilization: 45.04, resets_at: '2026-10-10T02:59:59.843590+00:00' },
    seven_day_opus: null,
  })
  expect(parsePlanUsage(text)).toEqual([
    { kind: 'five_hour', percentUsed: 66, resetsAt: '2026-10-07T23:29:59.843543+00:00' },
    { kind: 'seven_day', percentUsed: 45, resetsAt: '2026-10-10T02:59:59.843590+00:00' },
  ])
  expect(parsePlanUsage('not json')).toEqual([])
  expect(parsePlanUsage('{"five_hour":null}')).toEqual([])
})

test('at launch, with no reply yet, the panel asks the plan-usage endpoint', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  emptyBand(on)
  const asked: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', ($, e) => {
    asked.push(e.url)
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ five_hour: { utilization: 66 }, seven_day: { utilization: 45 } }),
      },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(asked).toEqual(['https://api.anthropic.com/api/oauth/usage'])

  const band = await $.ui.mount({ plugin: 'session-usage', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  expect(await band.find({ text: '   66%' })).toBeDefined()
  expect(await band.find({ text: /^week +45%/ })).toBeDefined()
})

test('the turn-duration line gets a blank row above it', async ($, on) => {
  on('ui.render', { component: 'TurnDuration' }, ($, e) => $.ui.resolve(e).Text({ children: '✻ Worked for 2m 4s' }))
  const line = await $.ui.mount({
    plugin: 'session-usage',
    surface: 'terminal',
    component: 'TurnDuration',
    props: { word: 'Worked', durationMs: 124_000 },
  })
  expect(await line.drawn()).toMatchObject({ type: 'Box', props: { marginTop: 1 } })
  expect(await line.find({ text: '✻ Worked for 2m 4s' })).toBeDefined()
})

test('the openers keep their column while any layout fits beside them', () => {
  const usage = {
    session: { percent: 32, resetsAt: new Date(local(2026, 10, 7, 14, 15)).toISOString() },
    week: { percent: 41 },
    context: { tokens: 84_000, window: 200_000, percent: 42 },
  }
  for (const columns of [140, 100, 85, 75]) {
    const plan = fit(usage, NOON, columns, true)
    expect(plan.openers).toBe(true)
    expect(plan.columnsNeeded).toBeLessThanOrEqual(columns)
  }
  // Too narrow for anything with them: they give way before the panel overflows.
  const cramped = fit(usage, NOON, 60, true)
  expect(cramped.openers).toBe(false)
  // Off WSL there are none.
  expect(fit(usage, NOON, 140).openers).toBe(false)
})

test('the minimized card takes the openers only when they fit', () => {
  const line = compactLine({ session: { percent: 32 }, context: { window: 200_000, percent: 42 } })
  expect(compactFitsOpeners(line, 80)).toBe(true)
  expect(compactFitsOpeners(line, 40)).toBe(false)
})

const startSession = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/home/me/project' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/me/project', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { window: 200_000, tokens: 84_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 32 }],
    changed: ['rateLimits'],
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on WSL, VSCode and Files open the session's folder, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, { WSL_DISTRO_NAME: 'Ubuntu' })
    emptyBand(on)
    const runs: string[][] = []
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      const stdout = e.argv[0] === 'wslpath' ? '\\\\wsl.localhost\\Ubuntu\\home\\me\\project\n' : ''
      // Explorer exits 1 even when it opens the window.
      const exitCode = e.argv[0] === 'explorer.exe' ? 1 : 0
      return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await startSession($, on)
    const band = await $.ui.mount({ plugin: 'session-usage', surface, component: 'AbovePrompt', props: bandProps })

    await band.press({ key: 'vscode' })
    expect(runs).toEqual([['code', '/home/me/project']])

    await band.press({ key: 'files' })
    expect(runs.slice(1)).toEqual([
      ['wslpath', '-w', '/home/me/project'],
      ['explorer.exe', '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'],
    ])
    expect(toasts).toEqual([])

    // Still there when minimized.
    await band.press({ key: 'toggle' })
    expect(await band.find({ key: 'vscode' })).toBeDefined()
  })

  test(`off WSL there are no openers, on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.env(on, {})
    emptyBand(on)
    await startSession($, on)
    const band = await $.ui.mount({ plugin: 'session-usage', surface, component: 'AbovePrompt', props: bandProps })
    expect(await band.find({ key: 'vscode' })).toBeUndefined()
    expect(await band.find({ key: 'files' })).toBeUndefined()
  })
}
