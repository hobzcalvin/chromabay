# Web access to Wi-Fi devices

## Decision

Use Chrome's Local Network Access (LNA) permission for the deployed
`https://chromabay.app` site. Chrome 147 extended LNA to WebSockets, so an HTTPS page can
open ChromaBay's existing cleartext socket at `ws://device.local:8080` after the user chooses
**Allow** in the browser prompt. The firmware does not need TLS or a second protocol.

The devices page exposes its Wi-Fi controls when either:

- it is running on local HTTP development, where local sockets already work; or
- it is running on HTTPS in Chrome/Chromium 147 or newer.

Constructing the existing `WebSocket` is what triggers the browser permission; there is no
separate permission API the app needs to call. ChromaBay uses an explicit `.local` name or
private IP, so it does not depend on the evolving `targetAddressSpace` proposal.

## Important constraints

- Use an explicit `.local` hostname or private IP in the input. Chrome can recognize those as
  local before connecting and exempt an authorized `ws://` connection from mixed-content
  blocking.
- The production page must remain HTTPS.
- LNA's Permissions Policy defaults to `self`, which is sufficient for ChromaBay's top-level
  page. No special response header is required. Embedded cross-origin use would need an
  explicit `local-network` policy.
- Safari and Firefox do not currently provide the equivalent WebSocket exception. The native
  app and local development remain the fallback there.
- If access was denied, it can be changed in Chrome's site settings under **Local Network**
  (sometimes labeled **Apps on device**).

## Testing

1. Open `https://chromabay.app/devices` in Chrome 147+.
2. Enter the device's explicit host, for example `chromabay-ed30.local`.
3. Choose **Allow** when Chrome asks for Local Network Access.
4. Confirm the ordinary device card appears and can read settings.
5. Deny once, verify the error points to site settings, then reset the permission and retry.

Localhost does not exercise this permission path because it is already in a local address
space.

## Related redirect idea

A device may separately serve a tiny HTTP page that redirects
`http://device.local` to `https://chromabay.app`. Top-level navigation is not the same as the
app's WebSocket access and does not solve discovery by itself, but it remains a useful
"you found the device; open the app here" affordance.

References:

- [Chrome 147 release notes](https://developer.chrome.com/release-notes/147#local-network-access-restrictions-for-websockets)
- [Chrome Local Network Access overview](https://developer.chrome.com/blog/local-network-access)
- [Local Network Access specification](https://wicg.github.io/local-network-access/)
