# Research Notes

This file records external reverse-engineering references that may inform the
workflow, without merging their protocol assumptions into this project.

## Enterprise Windows Blog

Reference:

```text
https://hansiy.net/p/86b7133e
```

Scope of that article:

```text
Product: China Mobile Cloud PC enterprise edition, explicitly non-family edition
Client: Windows V3.8.2 Electron client
Route: HTTP API keepalive after Electron deobfuscation and HAR decryption
Claimed keepalive endpoint: /resource/desktopUptime
```

This project scope:

```text
Product: family cloud PC
Observed client route: Linux/ZTE CAG 8899 with ZTEC/ZIME tunnel traffic
Success boundary: SPICE display flow reaches DISPLAY_INIT and surface/render signals
```

Do not copy the enterprise Windows protocol fields, endpoints, constants, or
success definition into this project unless the family Linux route is
independently captured and proves the same behavior.

Useful methodology extracted from the article:

- Treat source-code analysis as a hypothesis, not proof.
- Prefer actual capture evidence when source analysis and runtime behavior
  conflict.
- Build small end-to-end probes for each recovered layer before implementing a
  long-running keepalive loop.
- Separate login/account liveness from desktop-session liveness.
- Validate server acceptance with a harmless endpoint before sending risky
  auth/session packets.
- Keep implementation fail-closed when the version, edition, or client platform
  differs.
- Do not let failover wrappers convert business errors into network errors.
  Login-like APIs must surface service `errorCode` values so SMS, trust-device,
  and MFA branches can be handled explicitly.
- When implementing device trust flows, preserve all fields shown by the family
  client source or capture. In the enterprise Windows reference, missing
  `body.code` caused SMS verification failure; family edition must be verified
  independently before dropping fields.
- SMS codes may have a short validity window and a matching resend cooldown.
  Keep login flows explicit and avoid blind retries that consume the code window.
- Use field-deletion tests only after a harmless family-edition endpoint is
  identified. Loose validation in another edition does not prove loose
  validation here.

Current family-edition implication:

```text
Continue the Linux CAG/ZIME path.
Optionally audit family-edition HTTP traffic for session-liveness endpoints,
but do not redefine success away from DISPLAY_INIT/SURFACE_CREATE/MARK unless
family-edition captures prove that a simpler server-side heartbeat is sufficient.
```

## Family Edition Source Audit Update

The installed family Linux client contains a separate HTTP heartbeat candidate:

```text
/cc/cloudPc/heartbeat/v2
```

This endpoint is not the enterprise Windows blog endpoint
`/resource/desktopUptime`. The only behavior imported from the enterprise blog
is the reverse-engineering discipline:

```text
source analysis is a hypothesis
capture/runtime behavior wins
business errors must remain visible
do not collapse edition-specific behavior into one protocol
```

For family `/cc/cloudPc/heartbeat/v2`, source and runtime currently agree that
`4043` is the dangerous other-login/kick signal. A runtime response of `4041`
was accepted by the family client's scheduler semantics because the source only
stops on `4043`.
