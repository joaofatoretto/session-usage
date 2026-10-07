import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type { ContextFill, Usage } from '../types'

const usage = atom({ plugin: 'session-usage', key: 'usage' } as const, null)
const now = atom({ plugin: 'session-usage', key: 'now' } as const, 0)
const isMinimized = atom({ plugin: 'session-usage', key: 'isMinimized' } as const, false)
const isBlinking = atom({ plugin: 'session-usage', key: 'isBlinking' } as const, false)

// Clawd without the feet row, so the panel is two rows tall. The eyes are the
// gaps in ▛ and ▜; filling them closes the eyes.
const PET = [' ▐▛███▜▌ ', '▝▜█████▛▘']
const PET_BLINKING = [' ▐█████▌ ', '▝▜█████▛▘']
const BLINK_MS = 150
const MINIMIZED_KEY = 'isMinimized'
const LABEL_WIDTH = 9
// The panel's border and padding, and the minimize button with its gap.
const CHROME = 4 + 3
// The pet and its gap, and the divider with its gaps.
const PET_COLUMNS = PET[0]!.length + 2
const DIVIDER_COLUMNS = 5

export const toUsage = (
  rateLimits: readonly SessionRateLimit[],
  cost: SessionCost | undefined,
  context?: SessionContextUsage,
): Usage => {
  const window = (kind: string) => {
    const limit = rateLimits.find(l => l.kind === kind)
    return limit && { percent: limit.percentUsed, resetsAt: limit.resetsAt }
  }
  return {
    session: window('five_hour'),
    week: window('seven_day'),
    costUsd: cost?.usd,
    context: context && { tokens: context.tokens, window: context.window, percent: context.percent },
  }
}

/**
 * Both meters' colors, as a day running out: morning cyan, afternoon blue,
 * dusk magenta, and the last light red as the limit nears.
 */
export const daylight = (percent: number): string =>
  percent < 50 ? 'cyan' : percent < 75 ? 'blue' : percent < 90 ? 'magenta' : 'red'

export const bar = (percent: number, width: number): [string, string] => {
  // Any use at all shows at least one cell.
  const filled = Math.min(width, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * width)))
  // A heavy colored fill on a thin gray track: they differ in weight and color.
  return ['━'.repeat(filled), '─'.repeat(width - filled)]
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const dayNumber = (d: Date) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000)

/**
 * `full`: "resets in 4h 31m · 20:33"; `short`: "resets 20:33". Either says
 * "tomorrow" or the weekday when the reset is not today.
 */
export const resetText = (
  resetsAt: string | undefined,
  at: number,
  style: 'full' | 'short' = 'full',
): string => {
  if (!resetsAt) return ''
  const when = new Date(Date.parse(resetsAt))
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const dayGap = dayNumber(when) - dayNumber(new Date(at))
  const day = dayGap <= 0 ? '' : dayGap === 1 ? 'tomorrow ' : `${DAYS[when.getDay()]} `
  if (style === 'short') return `resets ${day}${clock}`

  const minutes = Math.max(0, Math.round((when.getTime() - at) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60)
  const left =
    days > 0 ? `${days}d ${hours % 24}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `resets in ${left} · ${day}${clock}`
}

export const tokens = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

/** One run of text: dim gray unless it names a color. */
export type Segment = { text: string; color?: string }
export type Line = Segment[]

export type Layout = {
  bar: number
  contextBar: number
  reset: 'full' | 'short'
  context: boolean
}

// Widest first. Each step gives up a little so the context column stays as
// long as anything of it fits.
const LAYOUTS: readonly Layout[] = [
  { bar: 14, contextBar: 10, reset: 'full', context: true },
  { bar: 10, contextBar: 8, reset: 'full', context: true },
  { bar: 10, contextBar: 8, reset: 'short', context: true },
  { bar: 8, contextBar: 6, reset: 'short', context: true },
  { bar: 10, contextBar: 0, reset: 'full', context: false },
  { bar: 8, contextBar: 0, reset: 'short', context: false },
  { bar: 6, contextBar: 0, reset: 'short', context: false },
]

const percentText = (percent: number) => `  ${String(Math.round(percent)).padStart(3)}%`

const limitLines = (current: Usage | null, at: number, layout: Layout): Line[] => {
  const session = current?.session
  const week = current?.week
  if (!session && !week) {
    const idle =
      current?.costUsd !== undefined
        ? `session cost  $${current.costUsd.toFixed(2)}`
        : 'usage unavailable'
    return [[{ text: idle }]]
  }

  const lines: Line[] = []
  if (session) {
    const [filled, empty] = bar(session.percent, layout.bar)
    const reset = resetText(session.resetsAt, at, layout.reset)
    lines.push([
      { text: 'session'.padEnd(LABEL_WIDTH) },
      { text: filled, color: daylight(session.percent) },
      { text: empty },
      { text: percentText(session.percent), color: 'text' },
      { text: reset ? `  ${reset}` : '' },
    ])
  }
  if (week) {
    // The weekly limit stays quiet: one gray line, no bar.
    const reset = resetText(week.resetsAt, at, layout.reset)
    lines.push([{ text: `${'week'.padEnd(LABEL_WIDTH)}${Math.round(week.percent)}%${reset ? `  ${reset}` : ''}` }])
  }
  return lines
}

const contextPercent = (context: ContextFill) =>
  context.percent ?? (context.tokens !== undefined ? (context.tokens / context.window) * 100 : undefined)

const contextLines = (context: ContextFill, layout: Layout): Line[] => {
  const percent = contextPercent(context)
  const head: Line = [{ text: 'context  ' }]
  if (percent === undefined) {
    head.push({ text: `${tokens(context.window)} window` })
  } else {
    const [filled, empty] = bar(percent, layout.contextBar)
    const color = daylight(percent)
    head.push(
      { text: filled, color },
      { text: empty },
      { text: percentText(percent), color: 'text' },
    )
  }
  const left =
    context.tokens !== undefined
      ? `${tokens(context.tokens)} used · ${tokens(Math.max(0, context.window - context.tokens))} left`
      : 'nothing used yet'
  return [head, [{ text: left }]]
}

const width = (lines: Line[]) => Math.max(0, ...lines.map(line => line.reduce((n, s) => n + s.text.length, 0)))

/** The widest layout whose panel fits `columns`, with the lines it draws. */
export const fit = (current: Usage | null, at: number, columns: number) => {
  const context = current?.context
  const plans = LAYOUTS.filter(layout => !layout.context || context !== undefined).map(layout => {
    const limits = limitLines(current, at, layout)
    const side = layout.context && context ? contextLines(context, layout) : undefined
    const columnsNeeded =
      CHROME + PET_COLUMNS + width(limits) + (side ? DIVIDER_COLUMNS + width(side) : 0)
    return { layout, limits, context: side, columnsNeeded }
  })
  return plans.find(plan => plan.columnsNeeded <= columns) ?? plans[plans.length - 1]!
}

const PLAN_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * The plan-usage endpoint's answer as rate-limit windows: `five_hour` and
 * `seven_day`, each `{ utilization, resets_at }`. Anything unreadable is none.
 */
export const parsePlanUsage = (text: string): SessionRateLimit[] => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  const windows: SessionRateLimit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const window = (body as Record<string, unknown> | null)?.[kind] as
      | { utilization?: unknown; resets_at?: unknown }
      | null
      | undefined
    if (typeof window?.utilization !== 'number') continue
    windows.push({
      kind,
      percentUsed: Math.round(window.utilization * 10) / 10,
      resetsAt: typeof window.resets_at === 'string' ? window.resets_at : undefined,
    })
  }
  return windows
}

/**
 * The session's limits before any reply has reported them: asked of the
 * plan-usage endpoint (what /usage reads) with the session's own login. The
 * engine sets the credential; the mod never sees it. None without a login.
 */
async function fetchPlanUsage($: EngineInterface): Promise<SessionRateLimit[]> {
  try {
    const grant = await $.session.authorize()
    if (grant?.kind !== 'bearer') return []
    const response = await $.http.fetch(PLAN_USAGE_URL, {
      auth: grant.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    return response.ok ? parsePlanUsage(response.text) : []
  } catch {
    return []
  }
}

async function remember(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  cost: SessionCost | undefined,
  context: SessionContextUsage,
) {
  const at = await $.clock.now()
  await update($, usage, () => toUsage(rateLimits, cost, context))
  await update($, now, () => at)
}

/** The minimized card's one line: the session and context percentages, in their colors. */
export const compactLine = (current: Usage | null): Line => {
  const session = current?.session
  const percent = current?.context && contextPercent(current.context)
  const line: Line = []
  if (session) {
    line.push({ text: 'session ' }, { text: `${Math.round(session.percent)}%`, color: daylight(session.percent) })
  }
  if (percent !== undefined) {
    if (line.length > 0) line.push({ text: '  ·  ' })
    line.push({ text: 'context ' }, { text: `${Math.round(percent)}%`, color: daylight(percent) })
  }
  return line.length > 0 ? line : [{ text: 'usage after first reply' }]
}

/**
 * Whether a band tree draws anything: text, a button or another leaf. The
 * engine's own band is empty, so an empty Box or Text means no mod beneath
 * wants the band.
 */
export const hasContent = (node: unknown): boolean => {
  if (node === null || node === undefined || typeof node === 'boolean') return false
  if (typeof node === 'string') return node.trim() !== ''
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some(hasContent)
  if (typeof node !== 'object') return false
  const element = node as { type?: unknown; props?: { children?: unknown }; children?: unknown }
  // The engine's own band comes back as an opaque `{ type: 'engine' }`
  // reference, and it draws nothing there of its own.
  if (element.type === 'engine') return false
  if (element.type !== 'Box' && element.type !== 'Text') return true
  return hasContent(element.props?.children ?? element.children)
}

/** Next blink in 6 to 15 seconds; now and then a double blink, as people do. */
function scheduleBlink($: EngineInterface) {
  $.clock.after(6000 + Math.random() * 9000, async () => {
    const blinks = Math.random() < 0.2 ? 2 : 1
    for (let i = 0; i < blinks; i++) {
      await update($, isBlinking, () => true)
      await $.clock.sleep(BLINK_MS)
      await update($, isBlinking, () => false)
      if (i < blinks - 1) await $.clock.sleep(BLINK_MS)
    }
    scheduleBlink($)
  })
}

async function toggleMinimized($: EngineInterface) {
  await update($, isMinimized, value => !value)
  await $.store.set(MINIMIZED_KEY, await read($, isMinimized))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Clear the status-line entry the first version of this mod pinned.
    $.ui.status(undefined)
    const current = await $.session.usage()
    // At launch no reply has reported the limits yet: ask for them directly.
    const rateLimits = current.rateLimits.length > 0 ? current.rateLimits : await fetchPlanUsage($)
    await remember($, rateLimits, current.cost, current.context)
    const wasMinimized = (await $.store.get(MINIMIZED_KEY)) === true
    await update($, isMinimized, () => wasMinimized)
    scheduleBlink($)
    // Keep the "resets in" countdown fresh.
    $.clock.every(60_000, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await remember($, e.rateLimits, e.cost, e.context)
    return next(e)
  })

  // Not the panel: a row of breathing room between a reply's last line and
  // the "✻ Worked for 2m 4s" line that closes the turn.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" marginTop={1}>
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // The band holds one tree: when a mod beneath has something to show (Blast
    // Radius asking about a risky command, say), it takes the band until done.
    const below = await next(e)
    if (hasContent(below)) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, usage)

    const draw = (key: string, lines: Line[]) =>
      lines.map((line, i) => (
        <Box key={`${key}${i}`} flexDirection="row">
          {line.map((segment, j) =>
            segment.color ? (
              <Text key={`${key}${i}-${j}`} color={segment.color}>
                {segment.text}
              </Text>
            ) : (
              <Text key={`${key}${i}-${j}`} dimColor>
                {segment.text}
              </Text>
            ),
          )}
        </Box>
      ))

    if (await read($, isMinimized)) {
      // A card that hugs its one line: a little orange square, the two
      // percentages, and the button to open the panel again.
      return (
        <Box flexDirection="row">
          <Box key="card" flexDirection="row" borderStyle="round" borderDimColor paddingX={1} gap={2}>
            <Text key="pet" color="claude">
              ■
            </Text>
            {draw('compact', [compactLine(current)])}
            <Button key="toggle" label="+" plain dimColor onPress={() => toggleMinimized($)} />
          </Box>
        </Box>
      )
    }

    const plan = fit(current, await read($, now), e.props.bodyColumns)
    const pet = (await read($, isBlinking)) ? PET_BLINKING : PET

    return (
      <Box
        key="panel"
        flexDirection="row"
        alignItems="center"
        borderStyle="round"
        borderDimColor
        paddingX={1}
        gap={2}
        width={e.props.bodyColumns}
      >
        <Box key="pet" flexDirection="column">
          {pet.map((line, i) => (
            <Text key={`pet${i}`} color="claude">
              {line}
            </Text>
          ))}
        </Box>
        <Box key="limits" flexDirection="column" flexGrow={1}>
          {draw('limit', plan.limits)}
        </Box>
        {plan.context && (
          <Box key="divider" flexDirection="column">
            {PET.map((_, i) => (
              <Text key={`div${i}`} dimColor>
                │
              </Text>
            ))}
          </Box>
        )}
        {plan.context && (
          <Box key="context" flexDirection="column">
            {draw('context', plan.context)}
          </Box>
        )}
        <Button key="toggle" label="−" plain dimColor onPress={() => toggleMinimized($)} />
      </Box>
    )
  })
}
