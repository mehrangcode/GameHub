import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { io, type Socket } from 'socket.io-client'
import { PROTOCOL_VERSION } from '../src/contracts/events.js'
import type { ClientToServerEvents, ServerToClientEvents } from '../src/contracts/events.js'
import type { SocketAck } from '../src/contracts/errors.js'

/**
 * `dev-socket.ts` — the socket verification tool, S23.
 *
 * This is the thing you will actually use for the next nineteen sessions: every
 * "You verify" step from S23 to S42 is *open two of these and watch them agree*.
 * So it is worth more than its size suggests, and it is deliberately pleasant:
 * colour, a real REPL with history, tab-free commands, and every server event
 * printed the moment it lands.
 *
 * ```bash
 * npx tsx scripts/dev-socket.ts --cookies /tmp/c.txt --join $TID
 * npx tsx scripts/dev-socket.ts                       # no cookies → UNAUTHORIZED
 * npx tsx scripts/dev-socket.ts --cookies /tmp/g.txt  # → identity: guest
 * ```
 *
 * ### Why it reads curl's cookie jar
 *
 * Because that is where the cookies already are. Every verification step in
 * `11-build-plan.md` establishes a session with `curl -c /tmp/c.txt`, and
 * asking you to copy a JWT out of a jar by hand is exactly the friction that
 * stops a tool from being used. The jar is Netscape format — tab-separated,
 * with `#HttpOnly_` glued to the front of the domain for the cookies that
 * matter most here, which is the one detail that makes a naive parser return
 * nothing.
 */

// ── Arguments ────────────────────────────────────────────────────────────────

interface Options {
  url: string
  cookies: string | null
  join: string | null
  seat: number | null
  protocolVersion: number
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    url: process.env['SOCKET_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`,
    cookies: null,
    join: null,
    seat: null,
    protocolVersion: PROTOCOL_VERSION,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]

    switch (flag) {
      case '--url':
        options.url = value ?? options.url
        index += 1
        break
      case '--cookies':
        options.cookies = value ?? null
        index += 1
        break
      case '--join':
        options.join = value ?? null
        index += 1
        break
      case '--seat':
        options.seat = value === undefined ? null : Number(value)
        index += 1
        break
      case '--protocol':
        // Lets you *prove* the mismatch warning fires, rather than taking the
        // handshake code's word for it.
        options.protocolVersion = Number(value ?? PROTOCOL_VERSION)
        index += 1
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (flag?.startsWith('--')) {
          console.error(`unknown flag ${flag}`)
          printUsage()
          process.exit(1)
        }
    }
  }

  return options
}

function printUsage(): void {
  console.log(`
${bold('dev-socket')} — a hand-driven Socket.IO client for the board game platform

  npx tsx scripts/dev-socket.ts [--url http://localhost:3000] [--cookies FILE]
                                [--join TABLE_ID] [--seat N] [--protocol N]

  --cookies FILE   a cookie jar written by \`curl -c FILE\` (Netscape format)
  --join TABLE_ID  emit table:join immediately after connecting
  --seat N         and then take seat N
  --protocol N     declare a protocol version (use a wrong one to see the warning)

Type ${bold('help')} once connected for the command list.
`)
}

// ── Cookie jar ───────────────────────────────────────────────────────────────

/**
 * Reads a Netscape cookie jar into a `Cookie:` header.
 *
 * `#HttpOnly_` is the trap: curl prefixes the **domain** field with it for every
 * httpOnly cookie, which is all three of ours. A parser that skips `#` comment
 * lines therefore silently produces an empty header, and the symptom is
 * `connect_error UNAUTHORIZED` from a jar that is perfectly good.
 */
function readCookieJar(path: string): string {
  const lines = readFileSync(path, 'utf8').split('\n')
  const pairs: string[] = []

  for (const raw of lines) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw
    if (line.startsWith('#') || line.trim() === '') continue

    const fields = line.split('\t')
    if (fields.length < 7) continue

    const name = fields[5]
    const value = fields[6]
    if (name === undefined || value === undefined) continue
    pairs.push(`${name}=${value.trim()}`)
  }

  if (pairs.length === 0) {
    console.warn(yellow(`  ! ${path} yielded no cookies — is it a curl -c jar?`))
  }
  return pairs.join('; ')
}

// ── Pretty printing ──────────────────────────────────────────────────────────

const useColour = process.stdout.isTTY === true
const ESC = String.fromCharCode(27)
const paint = (code: string, text: string) => (useColour ? `${ESC}[${code}m${text}${ESC}[0m` : text)
const bold = (text: string) => paint('1', text)
const dim = (text: string) => paint('2', text)
const red = (text: string) => paint('31', text)
const green = (text: string) => paint('32', text)
const yellow = (text: string) => paint('33', text)
const cyan = (text: string) => paint('36', text)

const stamp = () => dim(new Date().toISOString().slice(11, 23))

function event(name: string, payload: unknown): void {
  console.log(`${stamp()} ${cyan('←')} ${bold(name)} ${format(payload)}`)
}

function format(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? String(value)
  return json.length > 2000 ? `${json.slice(0, 2000)}\n${dim('  … truncated')}` : json
}

function ack(name: string, response: SocketAck<unknown>): void {
  if (response.ok) {
    console.log(`${stamp()} ${green('✓')} ${name} ${format(response.data)}`)
    return
  }
  console.log(
    `${stamp()} ${red('✗')} ${name} ${red(response.code)} ${dim(response.i18nKey)} ` +
      `${response.details === undefined ? '' : format(response.details)}`,
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2))
const cookieHeader = options.cookies === null ? '' : readCookieJar(options.cookies)

console.log(
  `${dim('connecting to')} ${options.url} ${dim(cookieHeader === '' ? '(no cookies)' : `(${cookieHeader.split(';').length} cookies)`)}`,
)

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(options.url, {
  transports: ['websocket'],
  /**
   * ★ **No `withCredentials` here, and that is not an oversight.**
   *
   * `withCredentials: true` is what a *browser* client needs (06 §4) — it tells
   * the browser to attach its own cookie jar to the handshake. In Node there is
   * no jar, so the cookies are set by hand below. And setting both is actively
   * broken: with `withCredentials` on, engine.io-client's Node websocket
   * transport does **not** apply `extraHeaders`, so every connection comes back
   * `UNAUTHORIZED` from a cookie file that is perfectly good.
   *
   * That cost twenty minutes the first time. The symptom is indistinguishable
   * from an expired token, a bad jar, or a broken handshake — so if you are
   * reading this because a socket will not authenticate, check here first.
   */
  extraHeaders: cookieHeader === '' ? {} : { Cookie: cookieHeader },
  auth: { protocolVersion: options.protocolVersion },
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity,
})

let joined: string | null = null

socket.on('connect', () => {
  console.log(`${stamp()} ${green('●')} connected ${dim(socket.id ?? '')}`)
})

socket.on('connect_error', (error: Error & { data?: unknown }) => {
  console.log(`${stamp()} ${red('✗ connect_error')} ${error.message} ${format(error.data)}`)
  // A rejected handshake is the *expected* result of the no-cookie verification
  // step, so exiting cleanly beats retrying forever behind a wall of output.
  if (error.message === 'UNAUTHORIZED' || error.message === 'RATE_LIMITED') {
    socket.close()
    process.exit(0)
  }
})

socket.on('disconnect', (reason) => {
  console.log(`${stamp()} ${yellow('○')} disconnected ${dim(reason)}`)
})

socket.on('connected', (payload) => {
  event('connected', payload)
  if (options.join !== null) send('table:join', { tableId: options.join })
})

socket.on('table:snapshot', (payload) => {
  joined = payload.table.id
  event('table:snapshot', {
    table: { id: payload.table.id, game: payload.table.gameSlug, status: payload.table.status },
    you: payload.you,
    seats: payload.table.seats.map((seat) => ({
      seat: seat.seat,
      who: seat.occupant?.displayName ?? (seat.occupant?.kind === 'bot' ? 'bot' : null),
    })),
    members: payload.members.length,
    chat: payload.chat.length,
  })

  if (options.seat !== null) {
    const seat = options.seat
    options.seat = null
    send('table:takeSeat', { tableId: payload.table.id, seat })
  }
})

socket.on('table:memberJoined', (payload) => event('table:memberJoined', payload))
socket.on('table:memberLeft', (payload) => event('table:memberLeft', payload))
socket.on('table:seatChanged', (payload) => event('table:seatChanged', payload))
socket.on('table:optionsChanged', (payload) => event('table:optionsChanged', payload))
socket.on('table:statusChanged', (payload) => event('table:statusChanged', payload))
socket.on('table:presence', (payload) => event('table:presence', payload))
socket.on('chat:message', (payload) => event('chat:message', payload.message))
socket.on('error', (payload) => event(red('error'), payload))

/** Emits with an ack, printing whichever arm comes back. */
function send(name: string, payload: unknown): void {
  ;(
    socket as unknown as {
      emit: (e: string, p: unknown, cb: (a: SocketAck<unknown>) => void) => void
    }
  ).emit(name, payload, (response) => ack(name, response))
}

function requireTable(): string | null {
  if (joined !== null) return joined
  console.log(yellow('  ! join a table first:  join <tableId>'))
  return null
}

const COMMANDS = `
${bold('commands')}
  join <tableId> [spectator]   table:join
  leave                        table:leave
  takeSeat <n>                 table:takeSeat
  releaseSeat                  table:releaseSeat
  bot <seat> [easy|medium|hard]  table:addBot        ${dim('(host only)')}
  unbot <seat>                 table:removeBot      ${dim('(host only)')}
  kick <seat>                  table:kick           ${dim('(host only)')}
  options <json>               table:updateOptions  ${dim('(host only)')}
  chat <text>                  chat:send
  emote <id>                   chat:emote
  beat                         presence:heartbeat
  spam <n>                     n chat messages fast ${dim('(watch RATE_LIMITED)')}
  raw <event> <json>           anything at all      ${dim('(try raw table:takeSeat {"tableId":"x","seat":1,"userId":"someone"})')}
  quit
`

const repl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' })
console.log(COMMANDS)
repl.prompt()

repl.on('line', (line) => {
  const [command, ...rest] = line.trim().split(/\s+/)
  const argument = rest.join(' ')

  try {
    switch (command) {
      case '':
        break
      case 'help':
        console.log(COMMANDS)
        break
      case 'join': {
        const [tableId, mode] = rest
        if (tableId === undefined) {
          console.log(yellow('  usage: join <tableId> [spectator]'))
          break
        }
        send('table:join', {
          tableId,
          ...(mode === 'spectator' ? { asSpectator: true } : {}),
        })
        break
      }
      case 'leave': {
        const tableId = requireTable()
        if (tableId !== null) {
          send('table:leave', { tableId })
          joined = null
        }
        break
      }
      case 'takeSeat': {
        const tableId = requireTable()
        if (tableId !== null) send('table:takeSeat', { tableId, seat: Number(rest[0]) })
        break
      }
      case 'releaseSeat': {
        const tableId = requireTable()
        if (tableId !== null) send('table:releaseSeat', { tableId })
        break
      }
      case 'bot': {
        const tableId = requireTable()
        if (tableId !== null) {
          send('table:addBot', {
            tableId,
            seat: Number(rest[0]),
            ...(rest[1] === undefined ? {} : { difficulty: rest[1] }),
          })
        }
        break
      }
      case 'unbot': {
        const tableId = requireTable()
        if (tableId !== null) send('table:removeBot', { tableId, seat: Number(rest[0]) })
        break
      }
      case 'kick': {
        const tableId = requireTable()
        if (tableId !== null) send('table:kick', { tableId, seat: Number(rest[0]) })
        break
      }
      case 'options': {
        const tableId = requireTable()
        if (tableId !== null) {
          send('table:updateOptions', { tableId, options: JSON.parse(argument) as unknown })
        }
        break
      }
      case 'chat': {
        const tableId = requireTable()
        if (tableId !== null) send('chat:send', { tableId, body: argument })
        break
      }
      case 'emote': {
        const tableId = requireTable()
        if (tableId !== null) send('chat:emote', { tableId, emoteId: rest[0] ?? 'wave' })
        break
      }
      case 'beat': {
        const tableId = requireTable()
        if (tableId !== null) send('presence:heartbeat', { tableId })
        break
      }
      case 'spam': {
        const tableId = requireTable()
        const count = Number(rest[0] ?? 10)
        if (tableId !== null) {
          for (let index = 0; index < count; index += 1) {
            send('chat:send', { tableId, body: `spam ${index}` })
          }
        }
        break
      }
      case 'raw': {
        const [name, ...json] = rest
        if (name === undefined) {
          console.log(yellow('  usage: raw <event> <json>'))
          break
        }
        send(name, JSON.parse(json.join(' ') || '{}') as unknown)
        break
      }
      case 'quit':
      case 'exit':
        socket.close()
        repl.close()
        process.exit(0)
        break
      default:
        console.log(yellow(`  ? unknown command '${command ?? ''}' — type help`))
    }
  } catch (error) {
    console.log(red(`  ! ${error instanceof Error ? error.message : String(error)}`))
  }

  repl.prompt()
})

repl.on('close', () => {
  socket.close()
  process.exit(0)
})
