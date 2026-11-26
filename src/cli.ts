#!/usr/bin/env node
import { PhoneUnavailable } from './availability.js'
import { HttpPhoneBackend } from './backend.js'
import { readConfig, readToken } from './config.js'
import { PhoneHttp, PhoneHttpError } from './http.js'
import { PhoneMonitor } from './phone-monitor.js'
import { relayPhone } from './relay.js'
import { servePhone } from './server.js'
import { ensureAdapter } from './runtime.js'
import { SocketOccupiedError } from './socket.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('pi-phone-acp [--doctor]\n\nACP v1 over stdio. Set PI_PHONE_URL, PI_PHONE_TOKEN_FILE and optionally PI_PHONE_CWD (default ~/work).\nThe command starts or reuses a persistent adapter and relays ACP to it automatically. No service is installed.\n--doctor performs only an authenticated read, not a phone task or networking change.\n')
    return
  }
  if (args.length && !(args.length === 1 && ['--doctor', '--serve', '--relay'].includes(args[0]!))) throw new Error('Invalid command arguments')
  if (!args.length || args[0] === '--relay') {
    const lifetime = new AbortController()
    const stop = () => {
      lifetime.abort()
      // allow relay cleanup first, but do not leave a process waiting forever for blocked stdio to flush
      const deadline = setTimeout(() => process.exit(0), 2000)
      deadline.unref()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      const endpoint = args.length ? { path: process.env.PI_PHONE_SOCKET ?? '', identity: undefined } : await ensureAdapter(process.env, lifetime.signal)
      await relayPhone(endpoint.path, process.stdin, process.stdout, lifetime.signal, endpoint.identity)
    } catch (error) {
      if (!lifetime.signal.aborted) {
        throw error
      }
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      process.stdin.destroy()
      // A closed ACP connection is terminal for this stdio process. Do not leave
      // stdout open or attempt to reattach it when the phone returns.
      process.stdout.end()
    }
    return
  }

  const config = readConfig(process.env)
  const token = await readToken(config.tokenFile)
  const credentials = args[0] === '--serve' ? () => readToken(config.tokenFile) : token
  const phone = new HttpPhoneBackend(new PhoneHttp(config.url, credentials), config.cwd)
  if (args[0] === '--doctor') {
    const result = await phone.doctor(AbortSignal.timeout(10_000))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const monitor = new PhoneMonitor(phone, {}, args[0] === '--serve' ? failure => {
    process.stderr.write(failure ? `${failure.message}\n` : 'Phone API is reachable again. New ADE connections can be accepted.\n')
  } : undefined)
  const createPhone = () => new HttpPhoneBackend(new PhoneHttp(config.url, credentials, fetch, 35_000, {
    success: () => monitor.contact(),
    failure: () => monitor.suspect(),
  }), config.cwd)

  if (args[0] === '--serve') {
    const identity = process.env.PI_PHONE_INSTANCE
    if (identity && !/^[a-f0-9]{64}$/.test(identity)) {
      throw new Error('Invalid adapter identity')
    }
    const server = await servePhone(process.env.PI_PHONE_SOCKET ?? '', monitor, createPhone, identity)
    if (process.connected && process.send) {
      process.send({ type: 'ready' }, () => { if (process.connected) { process.disconnect() } })
    }
    const stop = () => { void server.stop().catch(() => {}) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await server.closed
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      await server.stop()
    }
    return
  }

}

main().catch(error => {
  // Never print raw errors, command input, URLs, response bodies or credentials.
  if (process.connected && process.send) {
    const occupied = error instanceof SocketOccupiedError || (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')
    process.send({ type: occupied ? 'occupied' : 'error' }, () => { if (process.connected) { process.disconnect() } })
  }
  const message = error instanceof PhoneUnavailable ? error.message
    : error instanceof PhoneHttpError && [401, 403].includes(error.status)
    ? 'Phone authentication or authorization failed. Check the private device-session token and phone access.'
    : process.argv[2] === '--relay'
      ? 'pi-phone-acp relay could not connect. Check the persistent adapter and its private PI_PHONE_SOCKET endpoint.'
      : 'pi-phone-acp could not start or verify the phone. Check configuration, private credential-file permissions, socket directory permissions, service reachability and the build-508 interface.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
