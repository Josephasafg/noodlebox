// src/audio/pitch.ts
// Live pitch detection using the McLeod / autocorrelation method.
// Streams frequency estimates from a microphone via Web Audio.

export interface PitchSample {
  /** Detected fundamental in Hz, or null if no clear pitch. */
  freq: number | null
  /** RMS of the analysis frame (0..1-ish), useful for "is anything playing?" */
  rms: number
  /** Confidence 0..1; we only emit values when reasonably confident. */
  clarity: number
}

export interface PitchStream {
  stop: () => Promise<void>
}

const SAMPLE_RATE_HINT = 44100
const BUFFER_SIZE = 2048
const MIN_RMS = 0.01
const MIN_CLARITY = 0.9

/**
 * Start the mic and call `onSample` ~30×/sec with the latest pitch estimate.
 * Throws if the user denies mic access.
 */
export async function startPitchStream(
  onSample: (s: PitchSample) => void,
): Promise<PitchStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone API not available in this browser.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  })

  const AC = window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC({ sampleRate: SAMPLE_RATE_HINT })
  if (ctx.state === 'suspended') {
    await ctx.resume()
  }

  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = BUFFER_SIZE
  analyser.smoothingTimeConstant = 0
  source.connect(analyser)

  const buf = new Float32Array(analyser.fftSize)
  let raf = 0
  let stopped = false

  const tick = () => {
    if (stopped) return
    analyser.getFloatTimeDomainData(buf)
    const sample = detectPitch(buf, ctx.sampleRate)
    onSample(sample)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    stop: async () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream.getTracks().forEach((t) => t.stop())
      source.disconnect()
      try {
        await ctx.close()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * Autocorrelation pitch detector. Returns frequency in Hz or null if
 * the signal is too quiet or has no clear period.
 *
 * Implementation note: this is a peak-picking ACF detector with parabolic
 * interpolation around the chosen lag. Plenty good for guitar-string tuning
 * (E2≈82 Hz to E5≈660 Hz) without pulling in a worklet.
 */
export function detectPitch(buf: Float32Array, sampleRate: number): PitchSample {
  const n = buf.length

  // RMS gate
  let sumSq = 0
  for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i]
  const rms = Math.sqrt(sumSq / n)
  if (rms < MIN_RMS) return { freq: null, rms, clarity: 0 }

  // Autocorrelation (limited lag range for guitar-relevant frequencies)
  const minFreq = 60   // a hair below low E2 (82.4)
  const maxFreq = 1200 // well above e1 fret 24 stuff
  const minLag = Math.floor(sampleRate / maxFreq)
  const maxLag = Math.floor(sampleRate / minFreq)

  // Compute normalized squared difference (NSDF) lite — close to McLeod
  let bestLag = -1
  let bestVal = 0
  let prevVal = 0
  let positivelySloped = false

  for (let lag = minLag; lag <= maxLag && lag < n - 1; lag++) {
    let acf = 0
    for (let i = 0; i < n - lag; i++) {
      acf += buf[i] * buf[i + lag]
    }
    // Normalize so amplitude doesn't bias us
    let norm = 0
    for (let i = 0; i < n - lag; i++) {
      norm += buf[i] * buf[i] + buf[i + lag] * buf[i + lag]
    }
    const val = norm > 0 ? (2 * acf) / norm : 0

    // Track first significant local peak after the autocorrelation has
    // climbed back up from its zero crossing. Avoids picking lag=0 noise.
    if (val > 0 && val > prevVal) {
      positivelySloped = true
    } else if (positivelySloped && val < prevVal) {
      // local maximum was at (lag-1, prevVal)
      if (prevVal > bestVal) {
        bestVal = prevVal
        bestLag = lag - 1
      }
      positivelySloped = false
      // bail early once we've found a strong peak — saves CPU
      if (bestVal > 0.95) break
    }
    prevVal = val
  }

  if (bestLag < 0 || bestVal < MIN_CLARITY) {
    return { freq: null, rms, clarity: bestVal }
  }

  // Parabolic interpolation around the peak for sub-sample accuracy
  const refinedLag = parabolicInterpolate(buf, bestLag)
  const freq = sampleRate / refinedLag

  if (!isFinite(freq) || freq < minFreq || freq > maxFreq) {
    return { freq: null, rms, clarity: bestVal }
  }
  return { freq, rms, clarity: bestVal }
}

function parabolicInterpolate(buf: Float32Array, lag: number): number {
  // Re-evaluate ACF at lag-1, lag, lag+1 for a tighter peak estimate.
  const acfAt = (l: number) => {
    if (l < 1 || l >= buf.length) return 0
    let sum = 0
    for (let i = 0; i < buf.length - l; i++) sum += buf[i] * buf[i + l]
    return sum
  }
  const a = acfAt(lag - 1)
  const b = acfAt(lag)
  const c = acfAt(lag + 1)
  const denom = a - 2 * b + c
  if (Math.abs(denom) < 1e-9) return lag
  const shift = (0.5 * (a - c)) / denom
  return lag + shift
}
