/**
 * audit-public.mjs — the pre-publish gate.
 *
 * Two scopes, because the payload and the development tools are held to
 * different standards:
 *
 *   payload — what a user actually installs (`index.js`, `cordis.patch.yml`,
 *             `package.json`, `lib/**`). No personal data, and none of the
 *             APIs a tab strip has no business using: no network, no code or
 *             HTML injection, no clipboard, no cookies.
 *   repo    — everything that would be published. No personal paths, e-mail
 *             addresses, tokens or keys, in code or in docs.
 *
 * Two rule classes inside the payload:
 *
 *   hard       — never acceptable anywhere in the payload; any hit fails.
 *   declarable — legitimate for THIS plugin but only where it is declared in
 *                DECLARED below with an exact count and a reason. Each declared
 *                hit is printed with its reason; one hit more than declared is
 *                a failure, one hit less is reported as a stale declaration.
 *
 * Findings are printed with a redacted excerpt; the process exits non-zero when
 * anything is found, so this can gate a release. The script names the patterns
 * it forbids, so it excludes itself from the scan.
 *
 * Usage:  node tools/audit-public.mjs [--root <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`)
	return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}
const root = flag('root', packageRoot)

/** Files that make up the installed payload; `lib/**` is added on top. */
const PAYLOAD = ['index.js', 'cordis.patch.yml', 'package.json']
const isPayloadFile = (file) => PAYLOAD.includes(file) || file.startsWith('lib/')

/** Kept local by `.gitignore`; the working-tree fallback skips it too. */
const LOCAL_ONLY = new Set(['HANDOFF.md'])

/** Text extensions worth scanning. */
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.ts'])

/**
 * Patterns that must never appear in the payload: any single hit fails.
 * A tab strip talks to the client's own services, nothing else.
 */
const HARD = [
	{ name: 'eval', pattern: /\beval\b/g },
	{ name: 'new Function', pattern: /\bnew\s+Function\b/g },
	{ name: 'document.write', pattern: /\bdocument\.write\b/g },
	{ name: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/g },
	{ name: 'innerHTML assignment', pattern: /\.innerHTML\s*=/g },
	{ name: 'document.cookie', pattern: /\bdocument\.cookie\b/g },
	{ name: 'clipboard API', pattern: /navigator\.clipboard/g },
	{ name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/g },
	{ name: 'WebSocket', pattern: /\bWebSocket\b/g },
	{ name: 'EventSource', pattern: /\bEventSource\b/g },
	{ name: 'sendBeacon', pattern: /\bsendBeacon\b/g },
	{ name: 'fetch', pattern: /\bfetch\b/g }
]

/**
 * Patterns the payload may use only where DECLARED says so, with the exact
 * number of expected hits and the reason they are there.
 */
const DECLARABLE = [
	{ rule: 'storage', pattern: /\b(?:localStorage|sessionStorage|indexedDB)\s*\./g },
	{ rule: 'dynamic import', pattern: /\bimport\s*\(/g }
]

/**
 * The declared base of the payload, counted from the source.
 *
 * The storage hits are the whole point of this plugin: which tabs a window has
 * is per-window state — `sessionStorage` carries the window's own id and
 * `localStorage` the tab list filed behind it — and without it two windows
 * cannot be told apart, cannot restore their tabs after a reload and cannot
 * hand a torn-off tab over to its own window. Nothing leaves the page: the
 * plugin never touches the network (the hard rules above prove that on every
 * run), and these keys hold Session ids, titles and a tab order — no content.
 */
const DECLARED = [
	{
		file: 'lib/client.js',
		rule: 'storage',
		count: 10,
		reason: 'window id + that window\'s tab list are per-window state; without it windows cannot be told apart and a reload cannot restore its tabs. No external network access.'
	}
]

/** Personal data, forbidden in both scopes. */
const PERSONAL = [
	{ name: 'Windows user path', pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/g },
	{ name: 'POSIX /Users/<name>/ path', pattern: /\/Users\/[A-Za-z0-9._-]+\//g },
	{ name: 'POSIX /home/<name>/ path', pattern: /\/home\/[A-Za-z0-9._-]+\//g },
	{ name: 'e-mail address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
	{ name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
	{ name: 'OpenAI-style key', pattern: /sk-[A-Za-z0-9_-]{16,}/g },
	{ name: 'bearer credential', pattern: /Bearer\s+[A-Za-z0-9._-]{12,}/g },
	{ name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
	{ name: 'assigned secret', pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s]{6,}["']/gi }
]

/** Every file the repository would publish. */
function trackedFiles() {
	try {
		const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return out.split('\0').filter((value) => value !== '')
	} catch (error) {
		console.log('note: not a git repository yet — scanning the working tree')
		return null
	}
}

/** Fallback listing when the directory is not a git repository yet. */
function walk(directory, found = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === '.git' || entry.name === 'node_modules') continue
		if (LOCAL_ONLY.has(entry.name)) continue
		const path = join(directory, entry.name)
		if (entry.isDirectory()) walk(path, found)
		else found.push(relative(root, path).split(sep).join('/'))
	}
	return found
}

/** Redact a finding so the report itself leaks nothing. */
function redact(text) {
	const clean = text.trim()
	return clean.length <= 12 ? clean : `${clean.slice(0, 6)}…${clean.slice(-3)}`
}

/** The declared entry for a file + rule, if the payload declares one. */
function declarationFor(file, rule) {
	return DECLARED.find((entry) => entry.file === file && entry.rule === rule) ?? null
}

const files = trackedFiles() ?? walk(root)
const findings = []
const declaredHits = []
const notes = []

/** Line number of a match inside its file. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** Scan one file for one rule set. */
function scanFile(file, rules, scope) {
	const path = join(root, file)
	if (!existsSync(path) || statSync(path).isDirectory()) return
	if (!TEXT.has(extname(file))) return
	if (file.endsWith('tools/audit-public.mjs')) return
	const text = readFileSync(path, 'utf8')
	const lines = text.split('\n')
	for (const rule of rules) {
		for (const match of text.matchAll(rule.pattern)) {
			const line = lineOf(text, match.index)
			findings.push({ file, line, scope, rule: `${scope === 'payload' ? 'hard: ' : ''}${rule.name}`, excerpt: redact(lines[line - 1] ?? match[0]) })
		}
	}
}

/**
 * Scan the payload for a declarable rule: hits inside the declared count are
 * reported with their reason, hits beyond it become findings.
 */
function scanDeclarable(file) {
	const path = join(root, file)
	if (!existsSync(path) || statSync(path).isDirectory()) return
	const text = readFileSync(path, 'utf8')
	for (const rule of DECLARABLE) {
		const matches = [...text.matchAll(rule.pattern)]
		const declared = declarationFor(file, rule.rule)
		const allowed = declared === null ? 0 : declared.count
		matches.forEach((match, index) => {
			if (index < allowed) {
				declaredHits.push({
					file,
					line: lineOf(text, match.index),
					rule: rule.rule,
					index: index + 1,
					count: allowed,
					reason: declared.reason
				})
			} else {
				findings.push({
					file,
					line: lineOf(text, match.index),
					scope: 'payload',
					rule: declared === null ? `undeclared: ${rule.rule}` : `undeclared: ${rule.rule} beyond ${allowed}`,
					excerpt: redact(text.split('\n')[lineOf(text, match.index) - 1] ?? match[0])
				})
			}
		})
		if (declared !== null && matches.length < declared.count) {
			notes.push(`${file}: ${matches.length} ${rule.rule} hit(s), ${declared.count} declared — the declaration is stale, lower it`)
		}
	}
}

/* The payload exists and is what the manifest says it is. */
for (const file of PAYLOAD) {
	if (!existsSync(join(root, file))) findings.push({ file, line: 0, scope: 'payload', rule: 'expected payload file is missing', excerpt: file })
}
if (!existsSync(join(root, 'lib'))) findings.push({ file: 'lib/', line: 0, scope: 'payload', rule: 'expected payload directory is missing', excerpt: 'lib/' })

for (const file of files) {
	const payload = isPayloadFile(file)
	/* Personal data is forbidden everywhere; the payload rules only in the payload. */
	scanFile(file, PERSONAL, payload ? 'payload' : 'repo')
	if (payload) {
		scanFile(file, HARD, 'payload')
		scanDeclarable(file)
	}
}

const scanned = files.filter((file) => TEXT.has(extname(file)) && !file.endsWith('tools/audit-public.mjs'))
const payloadList = files.filter((file) => isPayloadFile(file))

console.log('dsh-session-tabs · pre-publish audit')
console.log(`root: ${root}`)
console.log(`files: ${files.length} tracked, ${scanned.length} text files scanned (payload: ${PAYLOAD.join(', ')}, lib/** — ${payloadList.length} files)`)
console.log(`rules: ${HARD.length} hard + ${DECLARABLE.length} declarable (payload), ${PERSONAL.length} personal-data (everywhere)`)
console.log(`declared base: ${DECLARED.length} entr${DECLARED.length === 1 ? 'y' : 'ies'} — ${DECLARED.map((entry) => `${entry.file} ${entry.rule} ×${entry.count}`).join(', ')}`)
for (const entry of DECLARED) console.log(`  • ${entry.file} · ${entry.rule} ×${entry.count} — ${entry.reason}`)

if (declaredHits.length > 0) {
	console.log('\ndeclared, allowed:')
	for (const hit of declaredHits) {
		console.log(`  ${hit.file}:${hit.line}  ${hit.rule} ${hit.index}/${hit.count} — ${hit.reason}`)
	}
}
for (const note of notes) console.log(`note: ${note}`)

if (findings.length === 0) {
	console.log('\nRESULT: clean — no personal data, no hard-pattern hits in the payload, every declarable hit is declared')
	process.exitCode = 0
} else {
	console.log('')
	for (const finding of findings) {
		console.log(`  ${finding.scope === 'payload' ? 'PAYLOAD' : 'repo   '} ${finding.file}:${finding.line}  ${finding.rule}  «${finding.excerpt}»`)
	}
	console.log(`\nRESULT: ${findings.length} finding(s) — do not publish until they are gone`)
	process.exitCode = 1
}
