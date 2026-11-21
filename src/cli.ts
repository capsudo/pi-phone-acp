#!/usr/bin/env node
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { createAdapter } from './adapter.js'
import { HttpPhoneBackend } from './backend.js'
import { readConfig, readToken } from './config.js'
import { PhoneHttp, PhoneHttpError } from './http.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('pi-phone-acp [--doctor]\n\nACP v1 over stdio. Set PI_PHONE_URL, PI_PHONE_TOKEN_FILE and optionally PI_PHONE_CWD (default ~/work).\n--doctor performs only an authenticated read, not a phone task or networking change.\n')
    return
  }
  if (args.length && !(args.length === 1 && args[0] === '--doctor')) throw new Error('Invalid command arguments')
  const config = readConfig(process.env)
  const token = await readToken(config.tokenFile)
  const phone = new HttpPhoneBackend(new PhoneHttp(config.url, token), config.cwd)
  if (args[0] === '--doctor') {
    const result = await phone.doctor(AbortSignal.timeout(10_000))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const connection = createAdapter(phone).connect(ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))
  const stop = () => connection.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try { await connection.closed } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.stdin.destroy()
  }
}

main().catch(error => {
  // Never print raw errors, command input, URLs, response bodies or credentials.
  const message = error instanceof PhoneHttpError && [401, 403].includes(error.status)
    ? 'Phone authentication or authorization failed. Check the private device-session token and phone access.'
    : 'pi-phone-acp could not start or verify the phone. Check configuration, private credential-file permissions, service reachability and the build-508 interface.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
