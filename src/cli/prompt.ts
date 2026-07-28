import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { SelectOption } from './types.js';

// ── ANSI helpers ──────────────────────────────────────────────────

const ESC = '\x1B';
const CSI = `${ESC}[`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ERASE_LINE = `${CSI}2K`;

function moveUp(n: number): string {
  return n > 0 ? `${CSI}${n}A` : '';
}

// ── Color helpers ─────────────────────────────────────────────────

/** ANSI color helpers for CLI output. */
export const c = {
  cyan: (s: string) => `\x1B[36m${s}\x1B[0m`,
  green: (s: string) => `\x1B[32m${s}\x1B[0m`,
  yellow: (s: string) => `\x1B[33m${s}\x1B[0m`,
  red: (s: string) => `\x1B[31m${s}\x1B[0m`,
  bold: (s: string) => `\x1B[1m${s}\x1B[0m`,
  dim: (s: string) => `\x1B[2m${s}\x1B[0m`,
  magenta: (s: string) => `\x1B[35m${s}\x1B[0m`,
};

// ── Scrollable window helper ──────────────────────────────────────

/**
 * Compute which slice of options to render in a scrollable window.
 * Keeps the cursor visible within the window.
 */
export function computeVisibleWindow(
  cursor: number,
  total: number,
  maxVisible: number
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total };
  let start = Math.max(0, cursor - maxVisible + 1);
  let end = start + maxVisible;
  if (end > total) {
    end = total;
    start = end - maxVisible;
  }
  if (cursor < start) {
    start = cursor;
    end = start + maxVisible;
  }
  return { start, end };
}

// ── Line-buffered readline ────────────────────────────────────────
// readline.question() drops lines that arrived between calls because
// it only listens for the NEXT 'line' event.  When piped input
// delivers multiple lines in one chunk (e.g. `printf 'y\n3\n' | …`),
// the second line fires before the second question() is registered.
//
// We solve this with a permanent 'line' listener that pushes into a
// queue.  nextLine() either pops from the queue or awaits the next
// event — no data is ever lost.

let _rl: Interface | null = null;
const _lineBuffer: string[] = [];
let _lineResolver: ((_line: string) => void) | null = null;
let _stdinEnded = false;

function ensureRL(): void {
  if (_rl) return;
  _rl = createInterface({ input: stdin, output: stdout });
  _rl.on('line', (line: string) => {
    if (_lineResolver) {
      const resolve = _lineResolver;
      _lineResolver = null;
      resolve(line);
    } else {
      _lineBuffer.push(line);
    }
  });
  _rl.on('close', () => {
    _rl = null;
    _stdinEnded = true;
    // Resolve any pending prompt with empty string → triggers defaults
    if (_lineResolver) {
      const resolve = _lineResolver;
      _lineResolver = null;
      resolve('');
    }
  });
}

/**
 * Read the next line from stdin, displaying a prompt first.
 * Consumes from the internal buffer when piped input delivered
 * multiple lines in a single chunk.
 */
async function nextLine(prompt: string): Promise<string> {
  // Answers already delivered come first, *then* the ended-stream guard.
  //
  // Piped input arrives in one chunk: the first line settles the pending
  // prompt, the rest queue here, and `close` fires immediately after. Testing
  // `_stdinEnded` before draining the queue therefore threw away every answer
  // but the first and substituted each prompt's default — and `init`'s
  // "Overwrite existing files?" defaults to yes, so `printf 'y\nn\n' |
  // opencastle init` overwrote the files the user had just declined to
  // overwrite, without echoing the `n` it discarded. The comment above the
  // buffer says no data is ever lost.
  if (_lineBuffer.length > 0) {
    stdout.write(prompt);
    const line = _lineBuffer.shift()!;
    // Echo the buffered answer for non-TTY so logs read naturally
    if (!stdin.isTTY) stdout.write(line + '\n');
    return line;
  }

  // Only now: with nothing queued and the stream closed, every further question
  // answers itself with the default. Re-creating a readline interface over an
  // ended stream never emits `close` again, so the promise never settled — the
  // *second* prompt in a non-interactive run hung until node gave up.
  if (_stdinEnded) {
    stdout.write(prompt + '\n');
    return '';
  }
  ensureRL();
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    _lineResolver = resolve;
  });
}

/** Close the shared readline interface. Call once at command end. */
export function closePrompts(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
    _lineBuffer.length = 0;
    _lineResolver = null;
  }
  // Ensure stdin doesn't keep the event loop alive after all prompts are done.
  // Node.js TTY stdin can remain active even after readline.close() — unref it
  // so the process exits cleanly.
  stdin.pause();
  if (typeof stdin.unref === 'function') stdin.unref();
}

/**
 * Interactive single-choice selection prompt.
 *
 * TTY mode:  arrow-key navigation (↑/↓) with Enter to confirm.
 * Piped mode: falls back to number-based selection for scripts.
 */
export async function select(
  message: string,
  options: SelectOption[]
): Promise<string> {
  if (stdin.isTTY) {
    return selectInteractive(message, options);
  }
  return selectNumbered(message, options);
}

// ── Arrow-key selection (TTY) ─────────────────────────────────────

function renderOptions(
  options: SelectOption[],
  cursor: number,
  lastRenderedLines: number,
  maxVisible: number
): number {
  if (lastRenderedLines > 0) {
    stdout.write(moveUp(lastRenderedLines));
  }

  const { start, end } = computeVisibleWindow(cursor, options.length, maxVisible);
  let lines = 0;

  if (start > 0) {
    stdout.write(`${ERASE_LINE}\r    ${c.dim(`↑ ${start} more above`)}\n`);
    lines++;
  }

  for (let i = start; i < end; i++) {
    const active = i === cursor;
    const marker = active ? '❯' : ' ';
    const hint = options[i].hint ? ` — ${options[i].hint}` : '';
    const label = active
      ? `\x1B[36m${options[i].label}\x1B[0m${hint}`
      : `${options[i].label}${hint}`;
    stdout.write(`${ERASE_LINE}\r    ${marker} ${label}\n`);
    lines++;
  }

  if (end < options.length) {
    stdout.write(`${ERASE_LINE}\r    ${c.dim(`↓ ${options.length - end} more below`)}\n`);
    lines++;
  }

  // Clear leftover lines from previous longer render
  if (lines < lastRenderedLines) {
    stdout.write(`${CSI}J`);
  }

  return lines;
}

function selectInteractive(
  message: string,
  options: SelectOption[]
): Promise<string> {
  return new Promise<string>((resolve) => {
    let cursor = Math.max(0, options.findIndex((o) => o.selected));
    const maxVisible = Math.max(3, Math.min(options.length, (process.stdout.rows || 24) - 4));
    let lastRenderedLines = 0;

    // Pause the readline interface so raw mode can take over
    if (_rl) _rl.pause();

    stdout.write(`\n  ${message}\n\n`);
    stdout.write(HIDE_CURSOR);
    lastRenderedLines = renderOptions(options, cursor, 0, maxVisible);

    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer): void => {
      const key = data.toString();

      // Arrow up or k
      if (key === `${ESC}[A` || key === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        lastRenderedLines = renderOptions(options, cursor, lastRenderedLines, maxVisible);
        return;
      }

      // Arrow down or j
      if (key === `${ESC}[B` || key === 'j') {
        cursor = (cursor + 1) % options.length;
        lastRenderedLines = renderOptions(options, cursor, lastRenderedLines, maxVisible);
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        // Re-render final state with the selected option highlighted
        const { start, end } = computeVisibleWindow(cursor, options.length, maxVisible);
        stdout.write(moveUp(lastRenderedLines));
        for (let i = start; i < end; i++) {
          const active = i === cursor;
          const hint = options[i].hint ? ` — ${options[i].hint}` : '';
          const label = active
            ? `\x1B[36m${options[i].label}\x1B[0m${hint}`
            : `\x1B[2m${options[i].label}${hint}\x1B[0m`;
          const marker = active ? '✔' : ' ';
          stdout.write(`${ERASE_LINE}\r    ${marker} ${label}\n`);
        }
        // Clear leftover lines only when final render has fewer lines
        const finalLines = end - start;
        if (finalLines < lastRenderedLines) {
          stdout.write(`${CSI}J`);
        }
        stdout.write('\n');
        resolve(options[cursor].value);
        return;
      }

      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        stdout.write('\n');
        process.exit(130);
      }
    };

    function cleanup(): void {
      stdin.removeListener('data', onData);
      stdin.pause();
      stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
      // Resume readline for subsequent confirm() calls
      if (_rl) _rl.resume();
    }

    stdin.on('data', onData);
  });
}

// ── Number-based selection (piped / non-TTY) ──────────────────────

async function selectNumbered(
  message: string,
  options: SelectOption[]
): Promise<string> {
  console.log(`\n  ${message}\n`);
  options.forEach((opt, i) => {
    const hint = opt.hint ? ` — ${opt.hint}` : '';
    console.log(`    ${i + 1}) ${opt.label}${hint}`);
  });

  let choice: SelectOption | undefined;
  while (!choice) {
    const answer = await nextLine(`\n  Select [1-${options.length}]: `);
    // Handle EOF — stdin closed without valid selection
    if (answer === '' && (!_rl || !stdin.isTTY)) {
      console.error('\n  ✗ No input received (stdin closed). Aborting.');
      process.exit(1);
    }
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= options.length) {
      choice = options[num - 1];
    } else {
      console.log(`    Please enter a number between 1 and ${options.length}`);
    }
  }

  return choice.value;
}

/**
 * Yes/No confirmation prompt.
 */
export async function confirm(
  message: string,
  defaultYes = true
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await nextLine(`  ${message} ${hint} `);

  if (!answer.trim()) return defaultYes;
  return answer.trim().toLowerCase().startsWith('y');
}

// ── Multiselect ───────────────────────────────────────────────────

/**
 * Interactive multi-choice selection prompt.
 *
 * TTY mode:  arrow-key navigation (↑/↓), Space to toggle, Enter to confirm.
 * Piped mode: falls back to comma-separated number input.
 *
 * Returns an array of selected values (possibly empty).
 */
export async function multiselect(
  message: string,
  options: SelectOption[]
): Promise<string[]> {
  if (stdin.isTTY) {
    return multiselectInteractive(message, options);
  }
  return multiselectNumbered(message, options);
}

// ── Arrow-key multiselect (TTY) ───────────────────────────────────

function renderMultiselectOptions(
  options: SelectOption[],
  cursor: number,
  selected: Set<number>,
  lastRenderedLines: number,
  maxVisible: number
): number {
  if (lastRenderedLines > 0) {
    stdout.write(moveUp(lastRenderedLines));
  }

  const { start, end } = computeVisibleWindow(cursor, options.length, maxVisible);
  let lines = 0;

  if (start > 0) {
    stdout.write(`${ERASE_LINE}\r    ${c.dim(`↑ ${start} more above`)}\n`);
    lines++;
  }

  for (let i = start; i < end; i++) {
    const active = i === cursor;
    const checked = selected.has(i);
    const checkbox = checked ? `\x1B[32m✔\x1B[0m` : ' ';
    const marker = active ? '❯' : ' ';
    const hint = options[i].hint ? ` ${c.dim('—')} ${c.dim(options[i].hint!)}` : '';
    const label = active
      ? `\x1B[36m${options[i].label}\x1B[0m${hint}`
      : `${options[i].label}${hint}`;
    stdout.write(`${ERASE_LINE}\r    ${marker} [${checkbox}] ${label}\n`);
    lines++;
  }

  if (end < options.length) {
    stdout.write(`${ERASE_LINE}\r    ${c.dim(`↓ ${options.length - end} more below`)}\n`);
    lines++;
  }

  // Clear leftover lines from previous longer render
  if (lines < lastRenderedLines) {
    stdout.write(`${CSI}J`);
  }

  return lines;
}

function multiselectInteractive(
  message: string,
  options: SelectOption[]
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let cursor = 0;
    const selected = new Set<number>();
    const maxVisible = Math.max(3, Math.min(options.length, (process.stdout.rows || 24) - 4));
    let lastRenderedLines = 0;
    // Pre-select options marked as selected
    for (let i = 0; i < options.length; i++) {
      if (options[i].selected) selected.add(i);
    }

    if (_rl) _rl.pause();

    stdout.write(`\n  ${message} ${c.dim('(↑/↓ navigate, Space toggle, Enter confirm)')}\n\n`);
    stdout.write(HIDE_CURSOR);
    lastRenderedLines = renderMultiselectOptions(options, cursor, selected, 0, maxVisible);

    stdin.setRawMode(true);
    stdin.resume();

    const onData = (data: Buffer): void => {
      const key = data.toString();

      // Arrow up or k
      if (key === `${ESC}[A` || key === 'k') {
        cursor = (cursor - 1 + options.length) % options.length;
        lastRenderedLines = renderMultiselectOptions(options, cursor, selected, lastRenderedLines, maxVisible);
        return;
      }

      // Arrow down or j
      if (key === `${ESC}[B` || key === 'j') {
        cursor = (cursor + 1) % options.length;
        lastRenderedLines = renderMultiselectOptions(options, cursor, selected, lastRenderedLines, maxVisible);
        return;
      }

      // Space — toggle selection
      if (key === ' ') {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        lastRenderedLines = renderMultiselectOptions(options, cursor, selected, lastRenderedLines, maxVisible);
        return;
      }

      // Enter — confirm
      if (key === '\r' || key === '\n') {
        cleanup();
        // Final render
        const { start, end } = computeVisibleWindow(cursor, options.length, maxVisible);
        stdout.write(moveUp(lastRenderedLines));
        for (let i = start; i < end; i++) {
          const checked = selected.has(i);
          const hint = options[i].hint ? ` ${c.dim('—')} ${c.dim(options[i].hint!)}` : '';
          const checkbox = checked ? `\x1B[32m✔\x1B[0m` : ' ';
          const label = checked
            ? `\x1B[36m${options[i].label}\x1B[0m${hint}`
            : `\x1B[2m${options[i].label}${hint}\x1B[0m`;
          stdout.write(`${ERASE_LINE}\r      [${checkbox}] ${label}\n`);
        }
        // Clear leftover lines only when final render has fewer lines
        const finalLines = end - start;
        if (finalLines < lastRenderedLines) {
          stdout.write(`${CSI}J`);
        }
        stdout.write('\n');
        resolve(Array.from(selected).sort().map(i => options[i].value));
        return;
      }

      // Ctrl+C
      if (key === '\x03') {
        cleanup();
        stdout.write('\n');
        process.exit(130);
      }
    };

    function cleanup(): void {
      stdin.removeListener('data', onData);
      stdin.pause();
      stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
      if (_rl) _rl.resume();
    }

    stdin.on('data', onData);
  });
}

// ── Number-based multiselect (piped / non-TTY) ────────────────────

async function multiselectNumbered(
  message: string,
  options: SelectOption[]
): Promise<string[]> {
  console.log(`\n  ${message}\n`);
  options.forEach((opt, i) => {
    const hint = opt.hint ? ` — ${opt.hint}` : '';
    console.log(`    ${i + 1}) ${opt.label}${hint}`);
  });

  const preselected = options
    .map((opt, i) => (opt.selected ? i + 1 : null))
    .filter((n): n is number => n !== null);
  const defaultHint = preselected.length > 0 ? preselected.join(',') : 'none';
  const answer = await nextLine(`\n  Select [comma-separated, e.g. 1,3] or Enter for ${defaultHint}: `);
  if (!answer.trim()) {
    return preselected.map(n => options[n - 1].value);
  }

  const nums = answer.split(',').map(s => parseInt(s.trim(), 10));
  const result: string[] = [];
  for (const num of nums) {
    if (num >= 1 && num <= options.length) {
      result.push(options[num - 1].value);
    }
  }
  return result;
}
