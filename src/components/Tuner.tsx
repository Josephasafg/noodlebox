// src/components/Tuner.tsx
//
// Trigger pill + drawer with:
//   - permission splash (mic gated behind a tap)
//   - live mic pitch detection (auto-detects which string is playing)
//   - radial-gauge needle meter (matches mock variant A)
//   - tuning picker on the left
//   - 6-string status row (active = highlighted, in-tune = green)
//   - reference-tone fallback (tap a string to hear it)
//
// Speaks the same visual language as ScaleMenu so the two feel like siblings.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { startPitchStream, type PitchStream, type PitchSample } from '../audio/pitch'
import { playReferenceTone, type ToneHandle } from '../audio/reference-tone'
import {
  TUNINGS,
  nearestString,
  tuningById,
  type TuningDef,
} from '../theory/tuning'
import { Portal } from './Portal'
import styles from './Tuner.module.css'

type Mode = 'idle' | 'requesting' | 'live' | 'denied' | 'reference'

const SMOOTHING = 0.35           // EMA factor on cents (lower = smoother)
const IN_TUNE_CENTS = 5          // ±5¢ counts as in-tune
const STAY_IN_TUNE_MS = 600      // hold within band this long → mark string good
const STRING_GOOD_RESET_MS = 8000 // forget a "good" verdict after this idle

function useLandscapeMobile(): boolean {
  const query = '(max-height: 520px) and (orientation: landscape)'
  const [is, setIs] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setIs(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return is
}

export function Tuner() {
  const [open, setOpen] = useState(false)
  const isLandscape = useLandscapeMobile()
  const [tuningId, setTuningId] = useState<string>('standard')
  const [mode, setMode] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)

  // Live pitch state — held in refs and surfaced via setSample at ~30fps
  const [sample, setSample] = useState<PitchSample>({ freq: null, rms: 0, clarity: 0 })
  const smoothCentsRef = useRef<number | null>(null)
  const inTuneSinceRef = useRef<number | null>(null)
  const goodMapRef = useRef<Map<number, number>>(new Map()) // stringIdx -> timestamp
  const [tickVer, setTickVer] = useState(0) // forces re-render when goodMap changes

  const streamRef = useRef<PitchStream | null>(null)
  const toneRef = useRef<ToneHandle | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const tuning: TuningDef = useMemo(() => tuningById(tuningId), [tuningId])

  // Resolve current detected string + cents
  const reading = useMemo(() => {
    if (!sample.freq) return null
    const r = nearestString(sample.freq, tuning)
    // Smooth cents with an EMA so the needle doesn't jitter
    const prev = smoothCentsRef.current
    const next = prev == null ? r.cents : prev + SMOOTHING * (r.cents - prev)
    smoothCentsRef.current = next
    return { ...r, smoothCents: next }
  }, [sample, tuning])

  // Track "in tune for STAY_IN_TUNE_MS" → mark string good + haptic
  useEffect(() => {
    if (!reading) {
      inTuneSinceRef.current = null
      return
    }
    const inBand = Math.abs(reading.smoothCents) <= IN_TUNE_CENTS
    if (!inBand) {
      inTuneSinceRef.current = null
      return
    }
    if (inTuneSinceRef.current == null) {
      inTuneSinceRef.current = performance.now()
    } else if (performance.now() - inTuneSinceRef.current >= STAY_IN_TUNE_MS) {
      const map = goodMapRef.current
      const prev = map.get(reading.index) ?? 0
      const now = performance.now()
      if (now - prev > 500) {
        map.set(reading.index, now)
        if ('vibrate' in navigator) {
          try { navigator.vibrate(40) } catch { /* ignore */ }
        }
        setTickVer((v) => v + 1)
      }
    }
  }, [reading])

  // Periodically expire "good" verdicts so they don't stick forever
  useEffect(() => {
    if (mode !== 'live') return
    const id = window.setInterval(() => {
      const now = performance.now()
      const map = goodMapRef.current
      let changed = false
      for (const [k, t] of map) {
        if (now - t > STRING_GOOD_RESET_MS) {
          map.delete(k)
          changed = true
        }
      }
      if (changed) setTickVer((v) => v + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [mode])

  // ===== open / close lifecycle
  const closeDrawer = useCallback(async () => {
    setOpen(false)
    if (streamRef.current) {
      await streamRef.current.stop()
      streamRef.current = null
    }
    toneRef.current?.stop()
    toneRef.current = null
    setMode('idle')
    setError(null)
    smoothCentsRef.current = null
    inTuneSinceRef.current = null
    goodMapRef.current.clear()
    setSample({ freq: null, rms: 0, clarity: 0 })
    triggerRef.current?.focus()
  }, [])

  // Esc closes
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void closeDrawer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeDrawer])

  // Cleanup on unmount
  useEffect(() => () => {
    void streamRef.current?.stop()
    toneRef.current?.stop()
  }, [])

  // ===== mic enable
  const enableMic = useCallback(async () => {
    setMode('requesting')
    setError(null)
    try {
      const s = await startPitchStream((pitch) => setSample(pitch))
      streamRef.current = s
      setMode('live')
    } catch (err) {
      console.warn('mic start failed', err)
      setError(
        err instanceof Error
          ? err.message
          : 'Could not access the microphone.',
      )
      setMode('denied')
    }
  }, [])

  const playStringTone = useCallback(async (idx: number) => {
    toneRef.current?.stop()
    try {
      const handle = await playReferenceTone(tuning.strings[idx])
      toneRef.current = handle
    } catch (err) {
      console.warn('reference tone failed', err)
    }
  }, [tuning])

  // ===== render helpers
  const goodSet = useMemo(() => {
    // included so React picks up tickVer changes for the strings row
    void tickVer
    return new Set(goodMapRef.current.keys())
  }, [tickVer])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Open tuner"
      >
        <TuningForkIcon />
        <span className={styles.triggerLabel}>tune</span>
      </button>

      {open && (
        <Portal>
          <div className={styles.scrim} onClick={() => void closeDrawer()} aria-hidden="true" />
          <div
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Guitar tuner"
          >
            <button
              type="button"
              className={styles.close}
              onClick={() => void closeDrawer()}
              aria-label="Close"
            >
              ✕
            </button>

            {isLandscape ? (
              <LandscapeBody
                tuning={tuning}
                mode={mode}
                error={error}
                sample={sample}
                reading={reading}
                goodSet={goodSet}
                onEnable={() => void enableMic()}
                onUseReference={() => setMode('reference')}
                playStringTone={(i) => void playStringTone(i)}
              />
            ) : (
            <>
            {/* LEFT — tuning picker */}
            <div>
              <span className={styles.label}>Tuning</span>
              <div className={styles.tuningList} role="radiogroup" aria-label="Tuning">
                {TUNINGS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={t.id === tuningId}
                    className={`${styles.tuning} ${t.id === tuningId ? styles.tuningOn : ''}`}
                    onClick={() => {
                      setTuningId(t.id)
                      goodMapRef.current.clear()
                      setTickVer((v) => v + 1)
                    }}
                  >
                    <span className={styles.tuningName}>{t.displayName}</span>
                    <span className={styles.tuningNotes}>
                      {t.strings.map((s) => s.name).join(' ')}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* RIGHT — meter or splash */}
            <div className={styles.main}>
              {mode === 'idle' || mode === 'requesting' || mode === 'denied' ? (
                <PermSplash
                  mode={mode}
                  error={error}
                  onEnable={() => void enableMic()}
                  onUseReference={() => setMode('reference')}
                />
              ) : (
                <>
                  <div className={styles.modeRow}>
                    <span>{mode === 'live' ? '● listening' : '· reference tones'}</span>
                    <button
                      type="button"
                      className={styles.modeBtn}
                      onClick={() => {
                        if (mode === 'live') {
                          void streamRef.current?.stop().then(() => {
                            streamRef.current = null
                            setMode('reference')
                          })
                        } else {
                          void enableMic()
                        }
                      }}
                    >
                      {mode === 'live' ? 'switch to reference' : 'use mic instead'}
                    </button>
                  </div>

                  <Gauge cents={reading?.smoothCents ?? 0} active={!!reading} />

                  <div className={styles.readout}>
                    <div className={styles.note}>
                      {reading ? reading.target.name : '—'}
                    </div>
                    <div className={statusClass(reading?.smoothCents)}>
                      {centsLabel(reading?.smoothCents)}
                    </div>
                    <div className={styles.hz}>
                      {sample.freq
                        ? `${sample.freq.toFixed(1)} hz · target ${reading?.target.freq.toFixed(1)}`
                        : 'play any string'}
                    </div>
                  </div>

                  <div className={styles.strings} role="list">
                    {tuning.strings.map((str, i) => {
                      const isActive = mode === 'live' && reading?.index === i
                      const isGood = goodSet.has(i)
                      const cls = `${styles.string} ${isActive ? styles.stringActive : ''} ${
                        isGood ? styles.stringGood : ''
                      }`
                      return (
                        <button
                          key={i}
                          type="button"
                          className={cls}
                          onClick={() => void playStringTone(i)}
                          aria-label={`Play reference tone for ${str.name} (${str.freq.toFixed(1)} Hz)`}
                        >
                          <span className={styles.stringName}>{str.name}</span>
                          <span className={styles.stringHz}>
                            {str.freq.toFixed(0)} Hz
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
            </>
            )}
          </div>
        </Portal>
      )}
    </>
  )
}

/* ============================================================================
   Permission splash
   ========================================================================= */

function PermSplash({
  mode,
  error,
  onEnable,
  onUseReference,
}: {
  mode: Mode
  error: string | null
  onEnable: () => void
  onUseReference: () => void
}) {
  const isDenied = mode === 'denied'
  const isRequesting = mode === 'requesting'

  const title = isDenied
    ? 'Mic blocked'
    : isRequesting
      ? 'Allow mic access'
      : 'Tap to enable mic'

  const body = isDenied
    ? "Mic access was denied. Open your browser’s site settings or the permissions icon in the address bar and re-allow the microphone, then try again."
    : isRequesting
      ? "Look for a permissions prompt in your browser’s address bar (or a system dialog on mobile) and tap “Allow”."
      : "The tuner listens for your guitar through the mic, then auto-detects which string you’re playing. Audio stays on this device."

  return (
    <div className={styles.permWrap}>
      <div className={styles.permIcon} aria-hidden="true">
        <TuningForkIcon size={26} />
      </div>
      <h3 className={styles.permTitle}>{title}</h3>
      <p className={styles.permBody}>{body}</p>
      {!isRequesting && (
        <button type="button" className={styles.permBtn} onClick={onEnable}>
          {isDenied ? 'try again' : 'enable microphone'}
        </button>
      )}
      {isRequesting && (
        <div className={styles.permWaiting} aria-live="polite">
          waiting for permission…
        </div>
      )}
      <button type="button" className={styles.permAlt} onClick={onUseReference}>
        or tune by ear with reference tones
      </button>
      {error && <div className={styles.permError}>{error}</div>}
    </div>
  )
}

/* ============================================================================
   Radial gauge (variant A)
   ========================================================================= */

const W = 400
const H = 200
const CX = 200
const CY = 180
const R = 150

function polar(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) }
}

const ARC_PATH = (() => {
  const start = polar(R, -160)
  const end = polar(R, -20)
  return `M ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${end.x} ${end.y}`
})()

const ZONE_PATH = (() => {
  const span = (IN_TUNE_CENTS / 50) * 70 // angular span at ±IN_TUNE_CENTS
  const a = polar(R - 8, -90 - span)
  const b = polar(R - 8, -90 + span)
  return `M ${a.x} ${a.y} A ${R - 8} ${R - 8} 0 0 1 ${b.x} ${b.y}`
})()

const TICK_LINES = (() => {
  const items: { key: number; x1: number; y1: number; x2: number; y2: number; major: boolean }[] = []
  for (let c = -50; c <= 50; c += 10) {
    const angle = -90 + (c / 50) * 70
    const major = c === 0 || Math.abs(c) === 50
    const inner = polar(R - (major ? 22 : 14), angle)
    const outer = polar(R - 4, angle)
    items.push({ key: c, x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, major })
  }
  return items
})()

function Gauge({ cents, active }: { cents: number; active: boolean }) {
  const clamped = Math.max(-50, Math.min(50, cents))
  const angle = (clamped / 50) * 70
  const status = !active
    ? 'idle'
    : Math.abs(cents) < IN_TUNE_CENTS
      ? 'good'
      : Math.abs(cents) < 20
        ? 'warn'
        : 'bad'

  const color =
    status === 'good' ? 'var(--tune-good)' :
    status === 'warn' ? 'var(--tune-warn)' :
    status === 'bad'  ? 'var(--tune-flat)' :
    'rgba(42,30,58,0.35)'

  const tip = polar(R - 18, -90 + angle)

  return (
    <div className={styles.meterWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.meterSvg} role="img" aria-label="Tuning meter">
        <defs>
          <linearGradient id="tuner-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="var(--tune-flat)" stopOpacity="0.45" />
            <stop offset="50%"  stopColor="var(--tune-good)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--tune-flat)" stopOpacity="0.45" />
          </linearGradient>
        </defs>
        <path d={ARC_PATH} stroke="url(#tuner-arc)" strokeWidth={3} fill="none" strokeLinecap="round" />
        <path d={ZONE_PATH} stroke="var(--tune-good)" strokeWidth={6} fill="none" strokeLinecap="round" opacity={0.7} />
        {TICK_LINES.map((t) => (
          <line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.key === 0 ? 'var(--ink)' : 'rgba(42,30,58,0.25)'}
            strokeWidth={t.major ? 2 : 1} />
        ))}
        {/* needle */}
        <line
          className={styles.needle}
          x1={CX} y1={CY} x2={tip.x} y2={tip.y}
          stroke={color} strokeWidth={3} strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={9} fill={color} />
        <circle cx={CX} cy={CY} r={4} fill="#fff" />
        {/* labels */}
        <text {...labelPos(-160)} textAnchor="middle"
          fontFamily="var(--mono)" fontSize="11" fill="var(--ink-muted)">{'−50¢'}</text>
        <text {...labelPos(-90, -4)} textAnchor="middle"
          fontFamily="var(--mono)" fontSize="11" fill="var(--ink-pill)">0</text>
        <text {...labelPos(-20)} textAnchor="middle"
          fontFamily="var(--mono)" fontSize="11" fill="var(--ink-muted)">{'+50¢'}</text>
      </svg>
    </div>
  )
}

function labelPos(deg: number, dy = 4) {
  const p = polar(R + 14, deg)
  return { x: p.x, y: p.y + dy }
}

/* ============================================================================
   Helpers
   ========================================================================= */

function centsLabel(cents: number | undefined) {
  if (cents == null) return 'play any string'
  const sign = cents > 0 ? '+' : ''
  const abs = Math.abs(cents)
  const verb = abs < IN_TUNE_CENTS ? 'in tune' : cents < 0 ? 'flat' : 'sharp'
  return `${sign}${cents.toFixed(0)}¢ · ${verb}`
}

function statusClass(cents: number | undefined) {
  if (cents == null) return styles.cents
  const abs = Math.abs(cents)
  if (abs < IN_TUNE_CENTS) return `${styles.cents} ${styles.centsGood}`
  if (abs < 20) return `${styles.cents} ${styles.centsWarn}`
  return `${styles.cents} ${styles.centsFlat}`
}

function TuningForkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3v9a3 3 0 0 0 6 0V3" />
      <path d="M12 15v6" />
      <circle cx="12" cy="22" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/* ============================================================================
   Landscape phone layout (full-screen takeover)
   ========================================================================= */

interface Reading {
  index: number
  target: { name: string; freq: number }
  cents: number
  smoothCents: number
}

interface LandscapeBodyProps {
  tuning: TuningDef
  mode: Mode
  error: string | null
  sample: PitchSample
  reading: Reading | null
  goodSet: Set<number>
  onEnable: () => void
  onUseReference: () => void
  playStringTone: (idx: number) => void
}

function LandscapeBody({
  tuning,
  mode,
  error,
  sample,
  reading,
  goodSet,
  onEnable,
  onUseReference,
  playStringTone,
}: LandscapeBodyProps) {
  const showSplash = mode === 'idle' || mode === 'requesting' || mode === 'denied'
  const liveReading = mode === 'live' || mode === 'reference' ? reading : null

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headTitle}>{tuning.displayName}</div>
      </header>

      <div className={styles.body}>
        {showSplash ? (
          <SplashCard
            mode={mode}
            error={error}
            onEnable={onEnable}
            onUseReference={onUseReference}
          />
        ) : (
          <>
            <div className={styles.noteBig}>{liveReading ? liveReading.target.name : '—'}</div>
            <div className={styles.readoutLandscape}>
              <span className={styles.centsBig}>
                {centsValueOnly(liveReading?.smoothCents)}
              </span>
              <span className={styles.freq}>
                {sample.freq && liveReading
                  ? `${sample.freq.toFixed(1)} hz · ${liveReading.target.freq.toFixed(1)}`
                  : 'play a string'}
              </span>
            </div>
            <LinearGauge cents={liveReading?.smoothCents ?? 0} active={!!liveReading} />
            <div className={landscapeStatusClass(liveReading?.smoothCents)}>
              {landscapeStatusText(liveReading?.smoothCents)}
            </div>
          </>
        )}
      </div>

      <div className={styles.stringsRow} role="list">
        {tuning.strings.map((str, i) => {
          const isActive = mode === 'live' && reading?.index === i
          const isGood = goodSet.has(i)
          const cls = [
            styles.stringBtn,
            isActive ? styles.stringBtnActive : '',
            isGood ? styles.stringBtnTuned : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <button
              key={i}
              type="button"
              className={cls}
              onClick={() => playStringTone(i)}
              aria-label={`Play reference tone for ${str.name}`}
            >
              {str.name}
            </button>
          )
        })}
      </div>
    </>
  )
}

function SplashCard({
  mode,
  error,
  onEnable,
  onUseReference,
}: {
  mode: Mode
  error: string | null
  onEnable: () => void
  onUseReference: () => void
}) {
  const isDenied = mode === 'denied'
  const isRequesting = mode === 'requesting'

  let title: ReactNode
  if (isDenied) {
    title = (
      <>
        Mic <span className={styles.splashAccent}>blocked</span>
      </>
    )
  } else if (isRequesting) {
    title = (
      <>
        Allow <span className={styles.splashAccent}>microphone</span>
      </>
    )
  } else {
    title = (
      <>
        Listen with the <span className={styles.splashAccent}>microphone</span>
      </>
    )
  }

  const copy = isDenied
    ? "Mic access was denied. Open your browser's site settings and re-allow the microphone."
    : isRequesting
      ? 'Look for a permissions prompt and tap Allow.'
      : 'The tuner listens through the mic and auto-detects which string you’re playing.'

  return (
    <div className={styles.splash}>
      <div className={styles.splashEyebrow}>Tuner</div>
      <h2 className={styles.splashTitle}>{title}</h2>
      <p className={styles.splashCopy}>{copy}</p>
      {!isRequesting && (
        <button type="button" className={styles.micBtn} onClick={onEnable}>
          {isDenied ? 'Try again' : 'Enable microphone'}
        </button>
      )}
      <div className={styles.splashAlt}>
        or{' '}
        <button type="button" className={styles.splashAltLink} onClick={onUseReference}>
          tune by ear with reference tones
        </button>
      </div>
      {error && <div className={styles.splashError}>{error}</div>}
    </div>
  )
}

function LinearGauge({ cents, active }: { cents: number; active: boolean }) {
  const W = 500
  const H = 48
  const margin = 16
  const trackY = H / 2
  const clamped = Math.max(-50, Math.min(50, cents))
  const ratio = (clamped + 50) / 100
  const markerX = margin + ratio * (W - margin * 2)
  const inTune = Math.abs(cents) < IN_TUNE_CENTS
  const color = !active
    ? 'rgba(42,30,58,0.35)'
    : inTune
      ? 'var(--tune-good)'
      : Math.abs(cents) < 20
        ? 'var(--tune-warn)'
        : 'var(--tune-flat)'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.gauge} role="img" aria-label="Tuning gauge">
      <line
        x1={margin}
        y1={trackY}
        x2={W - margin}
        y2={trackY}
        stroke="rgba(42,30,58,0.18)"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <line
        x1={W / 2 - 18}
        y1={trackY}
        x2={W / 2 + 18}
        y2={trackY}
        stroke="var(--tune-good)"
        strokeWidth={5}
        strokeLinecap="round"
        opacity={0.85}
      />
      <line
        x1={W / 2}
        y1={trackY - 12}
        x2={W / 2}
        y2={trackY + 12}
        stroke="rgba(42,30,58,0.35)"
        strokeWidth={1.5}
      />
      {[-50, -25, 25, 50].map((c) => {
        const r = (c + 50) / 100
        const x = margin + r * (W - margin * 2)
        return (
          <line
            key={c}
            x1={x}
            y1={trackY - 6}
            x2={x}
            y2={trackY + 6}
            stroke="rgba(42,30,58,0.25)"
            strokeWidth={1}
          />
        )
      })}
      {active && (
        <>
          <circle cx={markerX} cy={trackY} r={9} fill={color} opacity={0.25} />
          <circle cx={markerX} cy={trackY} r={5} fill={color} />
        </>
      )}
    </svg>
  )
}

function centsValueOnly(cents: number | undefined): string {
  if (cents == null) return '—'
  const sign = cents > 0 ? '+' : cents < 0 ? '' : ''
  return `${sign}${cents.toFixed(0)}¢`
}

function landscapeStatusText(cents: number | undefined): string {
  if (cents == null) return ''
  const abs = Math.abs(cents)
  if (abs < IN_TUNE_CENTS) return 'In tune'
  return cents < 0 ? 'Flat — tune up' : 'Sharp — tune down'
}

function landscapeStatusClass(cents: number | undefined): string {
  const base = styles.status
  if (cents == null) return base
  const abs = Math.abs(cents)
  if (abs < IN_TUNE_CENTS) return `${base} ${styles.statusGood}`
  if (abs < 20) return `${base} ${styles.statusWarn}`
  return `${base} ${styles.statusFlat}`
}
