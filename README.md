# UniFi (unifictl) for Omarchy

An [Omarchy](https://omarchy.org) bar widget that shows the health of a UniFi
network, built on [`unifictl`](https://github.com/bwilczynski/unifictl).

The bar icon reflects `unifictl status`: normal, amber when something needs a
look, dimmed when the last refresh failed. Clicking it opens a compact popup:

- **Internet:** each WAN with its IP, uptime, 24h availability and latency.
- **Site:** Devices, Wi-Fi, Wired and Alarms summaries. Each one drills down
  into a detail view:

| View | Source | Shows |
|---|---|---|
| Devices | `unifictl devices list` | gateway, switches, APs; offline first |
| Wi-Fi | `unifictl clients list` | wireless clients, weakest signal first |
| Wired | `unifictl clients list` | wired clients with switch and port |
| Alarms | `unifictl logs -r -p high` | recent high-severity events |

Detail lists are fetched only when their view is open, so the bar costs one
`unifictl status` call per refresh.

## Requirements

- Omarchy with the Quickshell-based `omarchy-shell`
- `unifictl` on the shell's `PATH`, configured (`unifictl config`) and able to
  reach the controller
- If `unifictl` reads its API key through `pass`/gpg, the key must be unlockable
  from the desktop session (the bar runs without a terminal)

## Install

```sh
omarchy plugin add https://github.com/bwilczynski/omarchy-unifictl --enable
```

Or clone it by hand:

```sh
git clone https://github.com/bwilczynski/omarchy-unifictl ~/.config/omarchy/plugins/bwilczynski.unifictl
omarchy plugin enable bwilczynski.unifictl
```

## Usage

**Mouse:** left-click opens the popup, middle-click forces a refresh, and
right-click opens the console URL (if set).

**Keys in the popup:**

| Key | Action |
|---|---|
| ↑ ↓ / `j` `k` | move |
| Enter | activate the row: drill down, or copy the IP |
| → / `l` | drill down (Site rows) |
| ← / `h`, Esc | back to the main view (Esc on the main view closes) |
| `r` | refresh, bypassing unifictl's cache |
| `t` | open the current view in a terminal (`unifictl topology`, `clients list`, `logs`) |
| `c` `n` `m` | copy the IP, name or MAC of the selected row |
| `/` | filter clients (Wi-Fi and Wired views) |
| `o` | open the UniFi console |

## Settings

Edit them from the Omarchy bar settings, or in this widget's entry in
`~/.config/omarchy/shell.json`:

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalSec` | `60` | how often to run `unifictl status` |
| `barLabel` | `none` | text beside the icon: `none`, `clients` or `latency` |
| `maxClients` | `10` | rows per drill-down view before "N more" |
| `notify` | `true` | desktop notification when the network degrades or recovers |
| `consoleUrl` | `""` | UniFi console URL for right-click and `o` |

## IPC

```sh
omarchy-shell bwilczynski.unifictl toggle        # open, close, show, hide
omarchy-shell bwilczynski.unifictl view wifi     # open straight into a view: devices, wifi, wired, alarms
omarchy-shell bwilczynski.unifictl refresh
omarchy-shell bwilczynski.unifictl health        # loading | ok | warning | error | stale
omarchy-shell bwilczynski.unifictl status        # last `unifictl status` JSON
omarchy-shell bwilczynski.unifictl error         # last unifictl error, if any
```

`view` works well as a Hyprland keybinding.

## Development

| File | Role |
|---|---|
| `manifest.json` | plugin id, settings schema and defaults |
| `Service.qml` | runs unifictl, keeps the last good data, notifications |
| `Model.js` | pure functions from unifictl JSON to bar state and popup rows |
| `Panel.qml` | bar button, popup, main and drill-down views, keys, IPC |
| `components/` | `Section` and `StatusRow` row components |

Saving a file hot-reloads the plugin. New or changed IPC methods only register
after `omarchy restart shell`.

`Model.js` has no QML dependencies. The tests run it under node against live
`unifictl` output:

```sh
node --test tests/
omarchy plugin validate .
```

## Credits

`components/Section.qml` and `components/StatusRow.qml`, and the overall
layout, are adapted from [vcanuel/omarchy-unifi](https://github.com/vcanuel/omarchy-unifi)
(MIT, © 2026 Vincent Canuel).

## License

MIT
