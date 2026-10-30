# UniFi (unifictl) for Omarchy

An [Omarchy](https://omarchy.org) bar widget that shows the health of a UniFi
network, built on [`unifictl`](https://github.com/bwilczynski/unifictl).

The bar icon reflects `unifictl status`: normal, amber when something needs a
look, dimmed when the last refresh failed. Clicking it opens a compact popup:

- **Internet:** each WAN with its IP, uptime, 24h availability and latency.
- **This device:** this machine as the controller sees it
  (`unifictl clients list --self`), one row per connection (cable and Wi-Fi
  both show when both are up): IP, the switch port or AP/SSID it is on, its
  link speed or signal, and its internet traffic over the last 24h
  (`unifictl clients traffic`). Hidden when the controller doesn't know it.
- **Site:** Devices, Wi-Fi, Wired and Alarms summaries. Each one drills down
  into a detail view:

| View | Source | Shows |
|---|---|---|
| Devices | `unifictl devices list` | gateway, switches, APs; offline first |
| Wi-Fi | `unifictl clients list` | wireless clients, weakest signal first |
| Wired | `unifictl clients list` | wired clients with switch, port and link speed |
| Alarms | `unifictl logs -r -p high` | recent high-severity events |

Opening any client (This device, Wi-Fi, Wired) shows the **client view**:
its IP, MAC, where it is connected and how well, its current download and
upload rate (`unifictl clients get <id>`), and its internet traffic over the
last 24h by application, heaviest first (`unifictl clients traffic <id>`).
Back returns to the list and row you opened it from.

Values unifictl grades (WAN latency, device experience, Wi-Fi signal, link
speed) are coloured the way unifictl's tables colour them: green, yellow, red
for good, fair, poor, taken from the theme's `colors.toml`. A poor grade
also tints the whole row.

Detail lists are fetched only when their view is open, so the bar costs
`unifictl status`, `unifictl clients list --self` and `unifictl clients
traffic` per refresh.

## Requirements

- Omarchy with the Quickshell-based `omarchy-shell`
- `unifictl` 0.4.3 or newer on the shell's `PATH`, configured (`unifictl config`) and able to
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
right-click opens the console URL (if set). Device, client and WAN rows have
two buttons: copy opens a menu of the row's IP, MAC and name, and details
opens the client view for a client, or runs `unifictl devices|wans get <id>`
in a floating terminal. Clicking a client row opens the client view too.

**Keys in the popup:**

| Key | Action |
|---|---|
| ↑ ↓ / `j` `k` | move |
| Enter | activate the row: drill down, open a client, or open its copy menu (↑ ↓ / `j` `k` pick, Enter copies, Esc closes) |
| → / `l` | drill down (Site rows) or open a client |
| ← / `h`, Esc | back: from a client to its list, from a list to the main view (Esc on the main view closes) |
| `r` | refresh, bypassing unifictl's cache |
| `t` | open the current view in a terminal (`unifictl topology`, `clients list`, `logs`, `clients get` + `clients traffic`) |
| `c` `n` `m` | copy the IP, name or MAC of the selected row |
| `d` | show the selected row's details: the client view for a client, else `unifictl … get <id>` in a terminal |
| `/` | filter the open list (devices, clients, alarms, a client's applications); Enter keeps the filter, Esc clears it |
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

`Model.js` has no QML dependencies. The tests run it under node, against
made-up samples and against live `unifictl` output. The live tests skip when
`unifictl` is missing or cannot reach the controller, or with
`UNIFICTL_LIVE=0`:

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
