/**
 * What a run prints while it runs.
 *
 * Permanent lines (a task started, finished, failed) scroll as usual. On a
 * terminal one more line sits under them and is redrawn in place — what is
 * running, what is queued, how far along, how long, how much — so a 30-minute
 * task is not 30 minutes of silence. Piped or in CI there is no status line,
 * only the permanent lines, so logs stay plain text.
 */

export interface ProgressStream {
  write(chunk: string): boolean | void
  isTTY?: boolean
  columns?: number
}

export interface Progress {
  /** Print a permanent line (indentation included by the caller). */
  line(text: string): void
  /** Set what the status line shows; called again on every redraw. */
  setStatus(render: (() => string) | null): void
  /** Redraw the status line now. */
  refresh(): void
  /** Clear the status line and stop the ticker. */
  stop(): void
}

const CLEAR_LINE = '\r\x1b[2K'

// Escape sequences take no columns; measure the text a person sees.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

function fitToWidth(text: string, columns: number | undefined): string {
  const width = Math.max(20, (columns ?? 100) - 1)
  const visible = text.replace(ANSI, '')
  if (visible.length <= width) return text
  return visible.slice(0, width - 1) + '…'
}

export function createProgress(
  opts: { stream?: ProgressStream; tty?: boolean; tickMs?: number } = {},
): Progress {
  const stream: ProgressStream = opts.stream ?? process.stdout
  const tty = opts.tty ?? Boolean(stream.isTTY)
  let render: (() => string) | null = null
  let shown = false
  let timer: ReturnType<typeof setInterval> | null = null

  function clear(): void {
    if (shown) {
      stream.write(CLEAR_LINE)
      shown = false
    }
  }

  function draw(): void {
    if (!tty || !render) return
    let text: string
    try {
      text = render()
    } catch {
      return
    }
    stream.write(CLEAR_LINE + fitToWidth(text, stream.columns))
    shown = true
  }

  return {
    line(text: string) {
      clear()
      stream.write(text + '\n')
      draw()
    },
    setStatus(next) {
      render = next
      if (!tty) return
      if (next && !timer) {
        timer = setInterval(draw, opts.tickMs ?? 1000)
        timer.unref?.()
      }
      if (!next) {
        if (timer) clearInterval(timer)
        timer = null
        clear()
      } else {
        draw()
      }
    },
    refresh() {
      draw()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      render = null
      clear()
    },
  }
}

/** First non-empty line of a failure, trimmed to something that fits after a task id. */
export function firstLine(text: string | null | undefined, max = 160): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** `$0.84`, or `$0.84 (est.)` when any part of it was estimated. */
export function formatCost(usd: number | null | undefined, estimated: boolean): string | null {
  if (usd == null) return null
  // Below a cent two decimals would print $0.00 for real spend.
  const text = usd === 0 || usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
  return estimated ? `${text} (est.)` : text
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
