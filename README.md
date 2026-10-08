# gladys-tado-integration

Connect your **tado°** thermostats and air conditioners to
[Gladys Assistant](https://gladysassistant.com) directly — **no Home Assistant**
in between. It is an official Gladys **external integration**: a sandboxed
Docker container that talks to Gladys through the official JS SDK and to tado°
through its public REST API.

> **Pick the docs that fit you**: [English](docs/en.md) · [Français](docs/fr.md)

---

## Features

- **Cloud-bridged** (all tado° control goes through the tado° cloud API; this
  integration exposes **no incoming network port**).
- **OAuth2 device-code login** from the Gladys UI — the only authentication
  tado° still accepts (the username/password flow was removed by tado° in
  March 2025). Your credentials/tokens are never stored in the code, the logs
  or this repository; only a refresh token is kept, securely, via Gladys' own
  config storage.
- **Auto-discovery** of homes, zones, thermostats, AC units and their
  temperature/humidity sensors, published as Gladys devices.
- **Commands** that tado° can actually execute: target temperature, mode
  (Off / Schedule / Manual), AC power. **No command the API cannot run is
  exposed.**
- **Rate-limit aware**: reads tado°'s remaining daily budget from the response
  headers and adapts the polling interval so a free (100 req/day) account is
  not exhausted, while subscribers (20,000 req/day) get faster updates.
- Clean reconnect, back-off, auth-error and availability handling.

## Compatibility

| Target | Supported | Notes |
| ------ | --------- | ----- |
| tado° classic / smart AC (V2 / V3) via `my.tado.com` | ✅ | **This integration targets this generation.** |
| tado° X (`LINE_X`, `hops.tado.com`) | ❌ | Classic API (`/api/v2`) does not fully support X; the Home Assistant integration also excludes it and requires Matter. Detected and skipped with a clear message. |

## Repository layout

```
gladys-assistant-integration.json   # Gladys integration manifest (device type)
Dockerfile                          # read-only-friendly, unprivileged container
docs/en.md  docs/fr.md              # mandatory catalog documentation
src/
  index.js                          # SDK wiring & entry point
  gladys/                           # discovery, polling controller, commands, mapper
  tado/                             # API client, OAuth2 flow, rate-limit tracker, state
test/                               # unit tests with mocked tado° responses
.github/workflows/build.yml         # CI + GHCR publish on tag
```

## Development

Requirements: Node.js ≥ 20.

```bash
npm install        # or `npm ci` once package-lock.json is present
npm test           # unit tests (offline, mocked tado° responses)
```

The tests do **not** need a tado° account and never reach the network.

## Build the Docker image

```bash
docker build -t ghcr.io/rouxx67/gladys-tado-integration:1.0.3 .
```

## Install in Gladys

See the full guide in [docs/en.md](docs/en.md) (or [docs/fr.md](docs/fr.md)).
In short: push this repo and a tag → GitHub Actions builds the image to
`ghcr.io` → the integration appears under **Integrations → tado°** in Gladys.

## Security

- No ingress port, no inbound traffic.
- No Home Assistant dependency.
- The Gladys container runs with a read-only root filesystem, unprivileged,
  and only the single `/data` mount is writable.
- Secrets are handled exclusively by Gladys' `secret`/`account_link` config
  machinery — never hardcoded, never in logs.

## License

MIT (see [LICENSE](LICENSE)).