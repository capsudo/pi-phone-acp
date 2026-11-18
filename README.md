# pi-phone-acp

ACP adapter for a pi-phone agent running on Android. Conversations and work stay on the phone, independently of T3 connections.

Implementation is in progress. The ACP v1 boundary and lifecycle tests exist. The phone HTTP backend, executable and live integration checks are not yet complete. No T3 provider has been registered.

## Development checks

Node.js 22 or later is required.

```sh
npm ci
npm run check
npm test
npm run build
```
