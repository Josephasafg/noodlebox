/**
 * Read the project's `.env` before the dev server starts.
 *
 * Settings for the tab-video reader have to exist before it is spawned, and
 * `TABVIDEO_PORT` has to reach Vite's proxy config — which lives in this process,
 * not the service's. So the files are read here as well as in Python
 * (`scripts/tabvideo/env.py`). The duplication is two small parsers rather than
 * one, which is the price of the two halves being in different languages; both
 * are held to the same boring subset so they cannot disagree about a file.
 *
 * `KEY=value`, `#` comments, optional quotes, optional `export `. No
 * interpolation and no shell: a config file that can surprise you is worse than
 * one that cannot express much.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `.env` holds a cluster address and possibly a token, so both are gitignored. */
export const FILENAMES = ['.env', '.env.local']

export function parseEnv(text) {
  const found = {}
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const split = line.indexOf('=')
    if (split <= 0) continue
    const key = line.slice(0, split).trim()
    let value = line.slice(split + 1).trim()
    if (value.length >= 2 && value[0] === value[value.length - 1] && /['"]/.test(value[0])) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) found[key] = value
  }
  return found
}

/** Everything the project's env files set, `.env.local` winning. */
export function readEnv(root = ROOT, onProblem = console.error) {
  const found = {}
  for (const name of FILENAMES) {
    let text
    try {
      text = readFileSync(join(root, name), 'utf8')
    } catch (problem) {
      // Not fatal — none of this is required. But a file that exists and was not
      // read is a setting someone believes is applied.
      if (problem.code !== 'ENOENT') onProblem(`[dev] could not read ${name}: ${problem.message}`)
      continue
    }
    Object.assign(found, parseEnv(text))
  }
  return found
}

/** Fill gaps in the environment; anything already exported wins. */
export function applyEnv(target = process.env, root = ROOT) {
  const applied = {}
  for (const [key, value] of Object.entries(readEnv(root))) {
    if (key in target) continue
    target[key] = value
    applied[key] = value
  }
  return applied
}
