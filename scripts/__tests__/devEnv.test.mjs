/**
 * Tests for the dev server's half of reading `.env`.
 *
 * There are two parsers for one file format — this one and
 * `scripts/tabvideo/env.py` — because the two halves that need the settings are
 * in different languages. So what these check is not just that the values arrive
 * but that they arrive the *same way*: the cases here mirror
 * `scripts/tabvideo/tests/test_env.py` one for one, and the two must not drift.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEnv, parseEnv, readEnv } from '../devEnv.mjs'

const dirs = []

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'noodlebox-env-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('reading settings from the project', () => {
  it('reads a plain setting', () => {
    expect(parseEnv('TABVIDEO_VLM_MODEL=Qwen/Qwen2.5-VL-32B-Instruct')).toEqual({
      TABVIDEO_VLM_MODEL: 'Qwen/Qwen2.5-VL-32B-Instruct',
    })
  })

  it('accepts every shape a person actually types', () => {
    // Quotes, an `export` pasted out of a shell, spaces around the equals, and a
    // value containing one. Each is somebody copying a line from the README, and
    // none of them should silently do nothing.
    expect(
      parseEnv(
        [
          '# a comment',
          '',
          '  export TABVIDEO_VLM_URL = http://127.0.0.1:8000/v1  ',
          "TABVIDEO_VLM_KEY='sk-secret'",
          'TABVIDEO_VLM_MODEL="a model"',
          'TABVIDEO_OPAQUE=a=b',
        ].join('\n'),
      ),
    ).toEqual({
      TABVIDEO_VLM_URL: 'http://127.0.0.1:8000/v1',
      TABVIDEO_VLM_KEY: 'sk-secret',
      TABVIDEO_VLM_MODEL: 'a model',
      TABVIDEO_OPAQUE: 'a=b',
    })
  })

  it('skips a line that is not a setting rather than failing', () => {
    // A half-edited file must still start the app; naming falls back to a person.
    expect(parseEnv('nonsense\n=novalue\nTABVIDEO_VLM_MODEL=m\n')).toEqual({
      TABVIDEO_VLM_MODEL: 'm',
    })
  })

  it('lets the local file win, which is where a token belongs', () => {
    const dir = scratch({
      '.env': 'TABVIDEO_VLM_URL=http://shared/v1\nTABVIDEO_VLM_KEY=none\n',
      '.env.local': 'TABVIDEO_VLM_KEY=sk-real\n',
    })
    expect(readEnv(dir)).toEqual({
      TABVIDEO_VLM_URL: 'http://shared/v1',
      TABVIDEO_VLM_KEY: 'sk-real',
    })
  })

  it('leaves a value from the shell alone', () => {
    // Otherwise a one-off run against another endpoint would be quietly ignored.
    const dir = scratch({ '.env': 'TABVIDEO_VLM_URL=http://from-file/v1\nTABVIDEO_VLM_MODEL=m\n' })
    const target = { TABVIDEO_VLM_URL: 'http://from-shell/v1' }
    expect(applyEnv(target, dir)).toEqual({ TABVIDEO_VLM_MODEL: 'm' })
    expect(target.TABVIDEO_VLM_URL).toBe('http://from-shell/v1')
  })

  it('does nothing at all when there is no env file, which is the usual case', () => {
    const target = {}
    expect(applyEnv(target, scratch({}))).toEqual({})
    expect(target).toEqual({})
  })
})
