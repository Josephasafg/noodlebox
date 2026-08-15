/**
 * Start the app and the tab-video extraction service together.
 *
 * The app is a static build with no backend of its own, but reading notation out
 * of a video needs a video decoder and OpenCV. Rather than make that a separate
 * thing to remember, `npm run dev` starts both and Vite proxies `/api` to the
 * service.
 *
 * The service is optional on purpose: everything except importing a video link
 * works without it, so a missing Python or a missing dependency prints how to fix
 * it and leaves the app running.
 */
import { spawn } from 'node:child_process'

const children = []
let shuttingDown = false

function start(name, command, args, { required }) {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
  children.push(child)

  child.on('error', (problem) => {
    if (problem.code === 'ENOENT') {
      console.error(`\n[${name}] ${command} is not installed.`)
    } else {
      console.error(`\n[${name}] could not start: ${problem.message}`)
    }
    if (required) shutdown(1)
    else explainOptional(name)
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (required) {
      shutdown(code ?? (signal ? 1 : 0))
    } else if (code !== 0) {
      console.error(`\n[${name}] stopped with code ${code ?? signal}.`)
      explainOptional(name)
    }
  })
  return child
}

function explainOptional(name) {
  console.error(
    `[${name}] importing a video link will be unavailable; everything else still works.\n` +
      '        to fix: pip install -r scripts/tabvideo/requirements.txt\n',
  )
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0))
}

start('api', process.env.PYTHON ?? 'python3', ['-m', 'scripts.tabvideo.server'], {
  required: false,
})
start('web', 'npx', ['vite', ...process.argv.slice(2)], { required: true })
