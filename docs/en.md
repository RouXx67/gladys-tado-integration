# tado° for Gladys Assistant (English)

Connect your **tado°** heating and cooling to Gladys Assistant directly — no
Home Assistant required. This integration runs in a sandboxed Docker container,
talks to the Gladys host API through the official SDK and to tado° through its
public REST API.

## Overview

- Discovers your **homes** and **zones** and publishes one Gladys device per
  zone (thermostat or air conditioner), each carrying temperature, humidity,
  target temperature, mode and operating state.
- **Remote control** from the Gladys UI: target temperature, mode
  (Off / Schedule / Manual) and AC power.
- **Cloud-only**: all control is via the tado° cloud API. The container exposes
  **no incoming port** and never receives inbound traffic.

## Compatibility & limits

| Target                                              | Supported |
| --------------------------------------------------- | --------- |
| tado° classic (smart thermostat V2/V3)              | **Yes**   |
| tado° smart AC / heat pump (V3)                     | **Yes**   |
| tado° X (`LINE_X`)                                  | **No**    |
| Hot-water zones                                     | Read values reported, control not exposed in this version |

`tado° X` uses a *different* API (`hops.tado.com`, "Rooms" instead of "Zones")
and is not implemented here — the classic `my.tado.com/api/v2` endpoints do not
fully cover it. The official Home Assistant integration makes the same choice
(X requires Matter). A `tado° X` home is auto-detected and skipped, with a
warning in the logs. Scope is intentionally limited to what can be verified and
executed reliably.

**Rate limits.** tado° limits its API to **100 requests/day** on free accounts
and **20,000/day** for subscribers, resetting at ~12:00 (Europe/Berlin). This
integration reads the remaining budget from the response headers and extends
the polling interval so it stays inside your quota. Choose conservative
intervals if you are on a free plan.

## Prerequisites

- Gladys Assistant **4.86 or later** (for the `account_link` config field).
- A **tado° account**. The login is the OAuth2 *device-code* flow: you approve
  it in your browser or in the tado° app. The username/password flow no longer
  exists.

## Installation

An installed integration is simply a published Docker image + manifest. Do it
once, then any Gladys can install it from the catalog in one click.

1. Create a GitHub repository from this project (or push it to your own).
2. Update `docker_image` in `gladys-assistant-integration.json` to your
   `ghcr.io/...` reference (by default:
   `ghcr.io/RouXx67/gladys-tado-integration:1.0.0`).
3. Push a tag (e.g. `v1.0.0`). GitHub Actions runs the tests and builds a
   multi-arch image to the GitHub Container Registry.
4. In Gladys, go to **Integrations** → search **tado°** → **Install**.

To install manually:
`docker build -t ghcr.io/RouXx67/gladys-tado-integration:1.0.0 .`
and push the tag matching your manifest.

## Configuration

In the Gladys **Integrations → tado° → Configuration** screen:

1. Click **Link my tado° account**. Gladys opens the tado° login URL; approve
   it in your browser/app. The integration polls until approval and stores
   only a refresh token (through Gladys' secure config storage).
2. Tune the refresh intervals if needed:
   - **Active polling interval** (minutes): used while any zone is actively
     heating/cooling. Default `15`.
   - **Idle polling interval** (minutes): used when everything is idle. Default
     `60`.
   - **Overlay termination**: whether a manual command lasts until changed
     (`MANUAL`) or until the next schedule block (`NEXT_TIME_BLOCK`).

Then open **Discovery** and run a scan. Gladys shows the discovered devices;
create the ones you want.

## Commands you can use in scenes/dashboard

- **Target temperature** — sets a manual hold.
- **Mode** — `Off`, `Schedule` (follow the tado° schedule), `Manual`.
- **AC power** (air conditioners).

Temperature and humidity are read-only sensors; OS state reflects whether the
unit is currently running.

## Troubleshooting

- **"Link your account first."** — complete step 1 of Configuration.
- **No devices shown.** — run a Discovery scan; verify the tado° zone is not a
  hot-water zone (control not exposed this version).
- **"rate limit reached" / slow updates.** — you are likely on the free tier.
  Increase the polling intervals or subscribe (Auto-Assist).
- **A `tado° X` home is skipped.** — expected; tado° X is not supported. Use
  Gladys' Matter integration instead.

## Develop & test

- `npm ci` — install (Node.js ≥ 20).
- `npm test` — run the unit tests. They use **mocked tado° responses**, need
  **no credentials** and make **no network calls**.
- Build: `docker build -t ghcr.io/RouXx67/gladys-tado-integration:1.0.0 .`

## Security

No incoming port. Unprivileged, read-only-root, single `/data` writable mount.
No Home Assistant. Tokens only via Gladys' secure config storage.