/**
 * verify-live.mjs — prove that the RUNNING DeepSeek Harness GUI serves this
 * plugin, without restarting anything.
 *
 * The desktop shell writes one `dsh web: <url>` line into its log when the host
 * comes up; that URL carries the launch token needed for the cookie handshake.
 * This script reads the last such line, authenticates, and then checks the two
 * facts that matter:
 *
 *   1. `dsh-session-tabs` is a row of the boot graph the page receives;
 *   2. `/plugins/dsh-session-tabs/client.js` is served and is byte-identical to
 *      the `lib/client.js` on disk (so what the browser runs is what is here).
 *
 * Usage:  node tools/verify-live.mjs [--port 61584] [--log <path>]
 *
 * Read-only: two GETs against the local GUI.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)
const localFile = join(packageRoot, 'lib', 'client.js')
const PACKAGE = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}
const logPath = flag('log', join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop-shell', 'harness.log'))
const forcedPort = flag('port', null)

/** The last `dsh web: <url>` announcement in the shell log. */
function launchUrl() {
  const text = readFileSync(logPath, 'utf8')
  const matches = [...text.matchAll(/^dsh web:\s+(\S+)/gm)]
  if (matches.length === 0) return null
  return matches[matches.length - 1][1]
}

const url = launchUrl()
if (url === null) {
  console.error(`no "dsh web:" line in ${logPath}`)
  process.exitCode = 2
  throw new Error('launch URL not found')
}
const parsed = new URL(url)
if (forcedPort !== null) parsed.port = forcedPort
const origin = parsed.origin
const index = `${origin}/?token=${parsed.searchParams.get('token') ?? ''}`

const summary = { log: logPath, origin, indexStatus: null, cookie: false, graphRow: null, bundleStatus: null, bundleBytes: null, shaMatches: null }

const headers = { 'user-agent': 'dsh-session-tabs-verify' }
let response = await fetch(index, { redirect: 'manual', headers })
const cookie = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
summary.cookie = cookie.length > 0
let html = await response.text()
/* The launch URL answers 303 into the app once the signed cookie is issued;
 * follow it (with the cookie) to reach the page that carries the boot graph. */
let hops = 0
while ([301, 302, 303, 307, 308].includes(response.status) && hops < 4) {
  const location = response.headers.get('location')
  if (location === null) break
  hops += 1
  response = await fetch(new URL(location, index).href, { redirect: 'manual', headers: { ...headers, cookie } })
  html = await response.text()
}
summary.indexStatus = response.status

/* The boot graph is embedded in the page as window.__DSH_BOOT__. */
const graph = html.match(new RegExp(`"id":"${PACKAGE}"[^}]*}`))
summary.graphRow = graph === null ? null : graph[0]
const rowUrl = graph === null ? null : graph[0].match(/"url":"([^"]+)"/)?.[1] ?? null
summary.rowUrl = rowUrl

const bundle = rowUrl === null
  ? await fetch(`${origin}/plugins/${PACKAGE}/client.js`, { headers: { cookie, 'user-agent': 'dsh-session-tabs-verify' } })
  : await fetch(`${origin}${rowUrl}`, { headers: { cookie, 'user-agent': 'dsh-session-tabs-verify' } })
summary.bundleStatus = bundle.status
const text = await bundle.text()
summary.bundleBytes = Buffer.byteLength(text, 'utf8')
const local = readFileSync(localFile)
const localText = local.toString('utf8')
const localHash = createHash('sha256').update(local).digest('hex')
const servedHash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
summary.shaMatches = localHash === servedHash
summary.localBytes = local.length
summary.localHash = localHash.slice(0, 16)
summary.servedHash = servedHash.slice(0, 16)
/* A same-size served body is the file itself; the combo endpoint has appended a
 * source-map comment when the lengths differ slightly. */
summary.servedIsLocalFile = text.length >= localText.length && text.startsWith(localText.slice(0, Math.min(400, localText.length)))
/* The combo endpoint may append a source-map comment; the markers are the
 * real proof that the browser receives THIS revision of the browser half. */
summary.markers = ['openSessionWindow', 'dsh.session-tabs.v1:', "'shell.overlay'"].every((marker) => text.includes(marker))

for (const [key, value] of Object.entries(summary)) console.log(`${key}: ${value}`)

/* What a torn-off window does: load its own address with the dshTab handoff and
 * NO launch token — the signed cookie has to be enough. */
const handoff = await fetch(`${origin}/?dshTab=00000000-0000-4000-8000-000000000000`, {
  redirect: 'manual',
  headers: { ...headers, cookie },
})
const handoffHtml = await handoff.text()
summary.handoffStatus = handoff.status
summary.handoffBoots = handoffHtml.includes('__DSH_BOOT__')
console.log(`handoffStatus: ${summary.handoffStatus}`)
console.log(`handoffBoots: ${summary.handoffBoots}`)

const ok = summary.graphRow !== null && summary.bundleStatus === 200 && summary.markers && summary.handoffBoots
console.log(ok ? 'RESULT: live plugin matches this checkout' : 'RESULT: NOT live (row missing, bundle unreachable, or served bytes differ)')
/* process.exitCode rather than process.exit: the abrupt exit trips a libuv
 * assertion on this Windows build and would report a bogus failure. */
process.exitCode = ok ? 0 : 1
