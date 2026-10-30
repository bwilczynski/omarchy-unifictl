// Pure display logic. No QML, no I/O: every function takes the parsed JSON
// that unifictl prints and returns plain values, so tests/model.test.js can
// run this file under node exactly as QML loads it.

var ICONS = {
  network: String.fromCodePoint(0xF048D),   // md-server_network
  offline: String.fromCodePoint(0xF0164),   // md-cloud_off_outline
  alert: String.fromCodePoint(0xF0026),     // md-alert
  internet: String.fromCodePoint(0xF059F),  // md-web
  gateway: String.fromCodePoint(0xF1087),   // md-router_network
  switch: String.fromCodePoint(0xF04E4),    // md-switch
  ap: String.fromCodePoint(0xF0002),        // md-access_point_network
  wifi: String.fromCodePoint(0xF05A9),
  ethernet: String.fromCodePoint(0xF0200),
  other: String.fromCodePoint(0xF0FB0),     // md-devices
  update: String.fromCodePoint(0xF06B0),    // md-update
  refresh: String.fromCodePoint(0xF0450),   // md-refresh
  open: String.fromCodePoint(0xF03CC),      // md-open_in_new
  topology: String.fromCodePoint(0xF0645),  // md-sitemap
  more: String.fromCodePoint(0xF01D8),      // md-dots_horizontal
  chevron: String.fromCodePoint(0xF0142),   // md-chevron_right
  back: String.fromCodePoint(0xF004D),      // md-arrow_left
  copy: String.fromCodePoint(0xF018F),      // md-content_copy
  details: String.fromCodePoint(0xF02FD),   // md-information_outline
  traffic: String.fromCodePoint(0xF04E1)    // md-swap_vertical
}

// ---- verdicts -------------------------------------------------------------

// unifictl verdicts collapse to three levels. "idle" (a backup WAN that is
// down on purpose) counts as fine.
function verdictLevel(verdict) {
  var v = String(verdict || "").toLowerCase()
  if (v === "ok" || v === "idle" || v === "info" || v === "") return 0
  if (v === "warn" || v === "warning") return 1
  return 2
}

// Overall widget state: loading | stale | ok | warning | error
function overallState(status, stale) {
  if (!status || !(Array.isArray(status.rows))) return stale ? "stale" : "loading"
  if (stale) return "stale"
  var worst = 0
  for (var i = 0; i < status.rows.length; i++)
    worst = Math.max(worst, verdictLevel(status.rows[i].verdict))
  return worst === 0 ? "ok" : (worst === 1 ? "warning" : "error")
}

function needsAttention(state) {
  return state === "warning" || state === "error"
}

function rowsByArea(status, area) {
  var out = []
  var rows = status && Array.isArray(status.rows) ? status.rows : []
  for (var i = 0; i < rows.length; i++) if (rows[i].area === area) out.push(rows[i])
  return out
}

function area(status, name) {
  var rows = rowsByArea(status, name)
  return rows.length > 0 ? rows[0] : null
}

function primaryWan(status) {
  var wans = rowsByArea(status, "wan")
  for (var i = 0; i < wans.length; i++) if (wans[i].wan && wans[i].wan.status === "connected") return wans[i].wan
  return wans.length > 0 ? wans[0].wan : null
}

function clientCount(status) {
  var wifi = area(status, "wifi")
  var wired = area(status, "wired")
  return (wifi ? wifi.clients || 0 : 0) + (wired ? wired.clients || 0 : 0)
}

// ---- formatting -----------------------------------------------------------

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return ""
  var s = Math.max(0, Math.floor(seconds))
  var d = Math.floor(s / 86400)
  var h = Math.floor((s % 86400) / 3600)
  var m = Math.floor((s % 3600) / 60)
  if (d > 0) return d + "d " + h + "h"
  if (h > 0) return h + "h " + m + "m"
  return m + "m"
}

function formatAge(ms, nowMs) {
  var s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return s + "s ago"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  return Math.floor(s / 3600) + "h ago"
}

// Byte counts the way unifictl's tables print them: 1024-based, one decimal.
var BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !isFinite(bytes)) return ""
  var n = Math.max(0, Number(bytes))
  var unit = 0
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) { n /= 1024; unit++ }
  return (unit === 0 ? String(Math.round(n)) : n.toFixed(1)) + " " + BYTE_UNITS[unit]
}

function formatRate(bytesPerSec) {
  var b = formatBytes(bytesPerSec)
  return b === "" ? "" : b + "/s"
}

// "↓ 1.3 GB ↑ 175.0 MB" from a received / transmitted pair (unifictl's
// DOWN / UP columns), or "" when neither is known.
function downUp(received, transmitted, format, gap) {
  var down = format(received)
  var up = format(transmitted)
  if (down === "" && up === "") return ""
  return "↓ " + (down || "0 B") + (gap || " ") + "↑ " + (up || "0 B")
}

function join(parts) {
  var out = []
  for (var i = 0; i < parts.length; i++) if (parts[i] !== "" && parts[i] !== null && parts[i] !== undefined) out.push(parts[i])
  return out.join(" · ")
}

// ---- bar ------------------------------------------------------------------

function barIcon(state) {
  if (state === "stale") return ICONS.offline
  if (needsAttention(state)) return ICONS.alert
  return ICONS.network
}

function barLabel(status, mode) {
  if (!status) return ""
  if (mode === "clients") return String(clientCount(status))
  if (mode === "latency") {
    var wan = primaryWan(status)
    return wan && wan.latency !== null && wan.latency !== undefined ? wan.latency + "ms" : ""
  }
  return ""
}

// First non-ok row, in unifictl's own order, as one short sentence.
function headline(status) {
  var rows = status && Array.isArray(status.rows) ? status.rows : []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    if (verdictLevel(r.verdict) === 0) continue
    if (r.area === "wan") return (r.wan ? r.wan.name : "WAN") + " " + (r.wan ? r.wan.status : "down")
    if (r.area === "devices") return (r.total - r.online) + " device(s) offline"
    if (r.area === "wifi") return (r.poorClients || []).length + " Wi-Fi client(s) with poor signal"
    if (r.area === "alarms") return r.latest ? r.latest.title : r.count + " alarm(s)"
    if (r.area === "updates") return (r.updates || []).length + " firmware update(s)"
    return r.area + ": " + r.verdict
  }
  return "All systems normal"
}

// The panel hero names the controller.
function controllerName(status) {
  var c = status && status.controller
  return c && c.name ? String(c.name) : "UniFi"
}

function tooltip(status, state) {
  if (state === "loading") return "UniFi: loading…"
  if (!status) return "UniFi: unavailable"
  var wan = primaryWan(status)
  var devices = area(status, "devices")
  var lines = ["UniFi: " + headline(status)]
  if (wan) lines.push(wan.name + ": " + join([wan.status, wan.latency !== null ? wan.latency + " ms" : ""]))
  if (devices) lines.push("Devices: " + devices.online + "/" + devices.total + " online")
  lines.push("Clients: " + clientCount(status))
  if (state === "stale") lines.push("(data is stale)")
  return lines.join("\n")
}

// ---- health grades ----------------------------------------------------------

// unifictl grades a value as good/fair/poor next to it in JSON
// (`latencyHealth`, `signalStrengthHealth`, …). Anything else is ungraded.
function grade(value) {
  var g = String(value || "")
  return g === "good" || g === "fair" || g === "poor" ? g : ""
}

function isPoor(value) {
  return grade(value) === "poor"
}

// Theme colours for the grades, read from the theme's colors.toml: green,
// yellow and red, or the ANSI color2/3/1 when a theme only has those.
// Returns "" for a grade the theme gives no colour.
function gradeColors(colorsToml) {
  var found = {}
  var lines = String(colorsToml || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (m) found[m[1]] = m[2]
  }
  return {
    good: found.green || found.color2 || "",
    fair: found.yellow || found.color3 || "",
    poor: found.red || found.color1 || ""
  }
}

var LINK_SPEEDS = { e: "10 Mbps", fe: "100 Mbps", gbe1: "1 GbE", gbe2p5: "2.5 GbE", gbe2_5: "2.5 GbE", gbe5: "5 GbE", gbe10: "10 GbE" }

function formatLinkSpeed(speed) {
  if (!speed) return ""
  return LINK_SPEEDS[speed] || String(speed)
}

// ---- popup rows -----------------------------------------------------------
//
// Row descriptor consumed by components/Section.qml:
//   { icon, title, subtitle, trailing, trailingIcon, attention, muted,
//     grade, copy: { ip, name, mac }, details, action }
//
// A leaf row has action "copy" (Enter opens its copy menu) and, when
// unifictl can show it on its own, `details`: the `… get <id>` command to
// run in a terminal. A client or device row instead opens its own view: both
// its action and its `details` are "view:client:<id>" or "view:device:<id>".
//
// `grade` is unifictl's health grade for the trailing value ("good", "fair",
// "poor", or "" when ungraded); the row colours that value with it.

// `<command> '<id>'` with the id shell-quoted, or "" without an id.
function quotedCommand(command, id) {
  if (id === null || id === undefined || String(id) === "") return ""
  return command + " '" + String(id).replace(/'/g, "'\\''") + "'"
}

// `unifictl <noun> get <id>`, or "" without an id.
function getCommand(noun, id) {
  return quotedCommand("unifictl " + noun + " get", id)
}

// Copy menu entries for a row's `copy` values, IP first, empty ones left out.
var COPY_LABELS = { ip: "IP", mac: "MAC", name: "Name" }

function copyOptions(copy) {
  var out = []
  if (!copy) return out
  for (var kind of ["ip", "mac", "name"]) {
    var value = copy[kind] === null || copy[kind] === undefined ? "" : String(copy[kind])
    if (value !== "") out.push({ kind: kind, label: COPY_LABELS[kind], value: value })
  }
  return out
}

function wanRows(status) {
  var wans = rowsByArea(status, "wan")
  var list = []
  for (var i = 0; i < wans.length; i++) {
    var r = wans[i]
    var w = r.wan || {}
    var up = w.status === "connected"
    var outages = (r.outages24h || []).length
    list.push({
      icon: ICONS.internet,
      title: w.name || w.id,
      subtitle: up
        ? join([w.ipAddress, "up " + formatDuration(w.uptime), w.availability !== null ? w.availability + "% 24h" : "", outages > 0 ? outages + " outage(s) 24h" : ""])
        : join([w.status, w.downtime ? "down " + formatDuration(w.downtime) : ""]),
      trailing: up && w.latency !== null ? w.latency + " ms" : "",
      grade: up ? grade(w.latencyHealth) : "",
      attention: verdictLevel(r.verdict) > 0 || isPoor(w.latencyHealth) || isPoor(w.availabilityHealth),
      muted: r.verdict === "idle",
      copy: { ip: w.ipAddress || "", name: w.name || "" },
      details: getCommand("wans", w.id),
      action: "copy"
    })
  }
  return list
}

// Summary rows for the non-WAN areas of `unifictl status`.
function summaryRows(status) {
  var list = []
  var devices = area(status, "devices")
  if (devices) {
    var problems = (devices.offline || []).concat(devices.transitioning || [])
    list.push({
      icon: ICONS.topology,
      title: "Devices " + devices.online + "/" + devices.total + " online",
      subtitle: problems.length > 0 ? problems.map(nameOf).join(", ") : "Gateway, switches, access points",
      trailingIcon: ICONS.chevron,
      attention: verdictLevel(devices.verdict) > 0,
      action: "view:devices"
    })
  }
  var wifi = area(status, "wifi")
  if (wifi) {
    var poor = wifi.poorClients || []
    list.push({
      icon: ICONS.wifi,
      title: "Wi-Fi · " + wifi.clients + " clients",
      subtitle: join([wifi.accessPoints + " access points", poor.length > 0 ? poor.length + " poor signal: " + poor.map(nameOf).join(", ") : ""]),
      trailingIcon: ICONS.chevron,
      attention: verdictLevel(wifi.verdict) > 0,
      action: "view:wifi"
    })
  }
  var wired = area(status, "wired")
  if (wired) {
    list.push({
      icon: ICONS.ethernet,
      title: "Wired · " + wired.clients + " clients",
      subtitle: wired.switches + " switches",
      trailingIcon: ICONS.chevron,
      attention: verdictLevel(wired.verdict) > 0,
      action: "view:wired"
    })
  }
  var alarms = area(status, "alarms")
  if (alarms && alarms.count > 0) {
    var a = alarms.latest || {}
    list.push({
      icon: ICONS.alert,
      title: alarms.count + " alarm(s) · " + (a.title || "latest"),
      subtitle: a.message || "",
      trailingIcon: ICONS.chevron,
      attention: verdictLevel(alarms.verdict) > 0,
      action: "view:alarms"
    })
  }
  var updates = area(status, "updates")
  if (updates && (updates.updates || []).length > 0) {
    list.push({
      icon: ICONS.update,
      title: updates.updates.length + " firmware update(s) available",
      subtitle: updates.updates.map(nameOf).join(", "),
      trailingIcon: ICONS.chevron,
      attention: verdictLevel(updates.verdict) > 0,
      action: "view:devices"
    })
  }
  return list
}

function nameOf(x) {
  if (x === null || x === undefined) return ""
  if (typeof x === "string") return x
  return String(x.name || (x.device && x.device.name) || x.id || x.mac || "?")
}

var DEVICE_ORDER = { gateway: 0, switch: 1, accessPoint: 2 }

function deviceIcon(d) {
  if (d.type === "gateway") return ICONS.gateway
  if (d.type === "switch") return ICONS.switch
  if (d.type === "accessPoint") return ICONS.ap
  return ICONS.other
}

// True when every word of `filter` appears somewhere in `fields`
// (case-insensitive). An empty filter matches everything.
function matches(fields, filter) {
  var words = String(filter || "").trim().toLowerCase().split(/\s+/)
  var hay = fields.map(function(f) { return f === null || f === undefined ? "" : String(f) }).join(" ").toLowerCase()
  for (var i = 0; i < words.length; i++) if (words[i] !== "" && hay.indexOf(words[i]) === -1) return false
  return true
}

function deviceMatches(d, filter) {
  var up = d.uplink || {}
  return matches([d.name, d.ip, d.mac, d.model, d.type, d.status, d.firmwareVersion, up.device ? up.device.name : ""], filter)
}

function deviceAction(id) {
  return id === null || id === undefined || String(id) === "" ? "" : "view:device:" + id
}

function deviceRows(devices, filter) {
  var items = devices && Array.isArray(devices.items) ? devices.items.slice() : []
  items = items.filter(function(d) { return deviceMatches(d, filter) })
  items.sort(function(a, b) {
    var up = (a.status === "connected" ? 1 : 0) - (b.status === "connected" ? 1 : 0)
    if (up !== 0) return up // offline first
    var t = (DEVICE_ORDER[a.type] !== undefined ? DEVICE_ORDER[a.type] : 9) - (DEVICE_ORDER[b.type] !== undefined ? DEVICE_ORDER[b.type] : 9)
    return t !== 0 ? t : String(a.name).localeCompare(String(b.name))
  })
  var list = []
  for (var i = 0; i < items.length; i++) {
    var d = items[i]
    var up = d.status === "connected"
    list.push({
      icon: deviceIcon(d),
      title: d.name,
      subtitle: join([d.ip, d.model, up ? "up " + formatDuration(d.uptime) : d.status]),
      trailing: d.experience !== undefined && d.experience !== null ? d.experience + "%" : "",
      grade: grade(d.experienceHealth),
      attention: !up || isPoor(d.experienceHealth),
      copy: { ip: d.ip || "", name: d.name || "", mac: d.mac || "" },
      details: deviceAction(d.id),
      action: deviceAction(d.id) || "copy"
    })
  }
  return list
}

function clientMatches(c, filter) {
  var to = c.connectedTo || {}
  return matches([c.name, c.ip, c.mac, to.ssid, to.device ? to.device.name : ""], filter)
}

function logMatches(e, filter) {
  var details = e.details || {}
  var fields = [e.title, e.event, e.message, e.category, e.subcategory, e.severity]
  for (var k in details) fields.push(details[k])
  return matches(fields, filter)
}

// Where a client is attached ("ssid @ AP" or "switch port N"), and the graded
// value that says how well: signal for Wi-Fi, link speed for a cable.
function clientLink(c) {
  var to = c.connectedTo || {}
  var wireless = c.connectionType === "wireless"
  var where = to.device ? to.device.name : ""
  if (wireless && to.ssid) where = to.ssid + " @ " + where
  else if (!wireless && to.port !== undefined && to.port !== null) where = where + " port " + to.port
  var value = wireless
    ? (to.signalStrength !== undefined && to.signalStrength !== null ? to.signalStrength + " dBm" : "")
    : formatLinkSpeed(to.linkSpeed)
  return { wireless: wireless, where: where, value: value, grade: grade(wireless ? to.signalStrengthHealth : to.linkSpeedHealth) }
}

function clientAction(c) {
  return clientActionFor(c.id)
}

function clientActionFor(id) {
  return id === null || id === undefined || String(id) === "" ? "" : "view:client:" + id
}

function clientRow(c) {
  var link = clientLink(c)
  var open = clientAction(c)
  return {
    icon: link.wireless ? ICONS.wifi : ICONS.ethernet,
    title: c.name || c.mac,
    subtitle: join([c.ip, link.where]),
    trailing: link.value,
    grade: link.grade,
    attention: link.grade === "poor",
    copy: { ip: c.ip || "", name: c.name || "", mac: c.mac || "" },
    details: open,
    action: open !== "" ? open : "copy"
  }
}

// One client's entry in `unifictl clients traffic`, or null.
function trafficFor(traffic, id) {
  var items = traffic && Array.isArray(traffic.items) ? traffic.items : []
  for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]
  return null
}

// This machine, from `unifictl clients list --self`: one row per connection
// the controller sees (cable and Wi-Fi at once give two), with its internet
// traffic over the last 24h from `unifictl clients traffic` when known.
// Empty when the controller does not know it (off-site, VPN, older unifictl).
function selfRows(self, traffic) {
  var items = self && Array.isArray(self.items) ? self.items : []
  return items.map(function(c) {
    var row = clientRow(c)
    var t = trafficFor(traffic, c.id)
    if (t) row.subtitle = join([row.subtitle, downUp(t.bytesReceived, t.bytesTransmitted, formatBytes) + " 24h"])
    return row
  })
}

// ---- item views: header and facts ------------------------------------------
//
// The top of a client or device view is a hero (icon, name, status line) over
// a grid of facts, like Omarchy's network panel. A fact is
//   { label, value, grade, attention, copy: bool, wide: bool }
// where grade colours the value, attention paints it urgent, copy makes a
// click copy it, and wide gives it a line of its own.

function fact(label, value, extra) {
  var f = { label: label, value: value === null || value === undefined ? "" : String(value),
    grade: "", attention: false, copy: false, wide: false }
  for (var k in extra || {}) f[k] = extra[k]
  return f
}

function present(facts) {
  return facts.filter(function(f) { return f.value !== "" })
}

function percent(v) {
  return v === null || v === undefined ? "" : v + "%"
}

// Current rate and uptime, shared by clients and devices.
function rateFacts(x) {
  var t = x.traffic
  var list = []
  if (t) {
    list.push(fact("Receiving", t.rxBytesPerSec !== undefined && t.rxBytesPerSec !== null ? formatRate(t.rxBytesPerSec) : ""))
    list.push(fact("Sending", t.txBytesPerSec !== undefined && t.txBytesPerSec !== null ? formatRate(t.txBytesPerSec) : ""))
  }
  list.push(fact("Uptime", x.uptime ? formatDuration(x.uptime) : ""))
  list.push(fact("Experience", percent(x.experience), { grade: grade(x.experienceHealth), attention: isPoor(x.experienceHealth) }))
  return list
}

// Grid cells for facts in a 4-column grid: label, value, label, value. A wide
// fact starts a new line and spans the three value columns.
// [{ text, label: bool, span, fact }]
function factCells(facts) {
  var cells = []
  var col = 0
  for (var i = 0; i < facts.length; i++) {
    var f = facts[i]
    if (f.wide && col !== 0) { cells.push({ text: "", label: true, span: 2, fact: null }); col = 0 }
    cells.push({ text: f.label, label: true, span: 1, fact: null })
    cells.push({ text: f.value, label: false, span: f.wide ? 3 : 1, fact: f })
    col = f.wide ? 0 : (col + 2) % 4
  }
  return cells
}

// ---- client view ------------------------------------------------------------

function clientIcon(c) {
  return c && c.connectionType === "wireless" ? ICONS.wifi : ICONS.ethernet
}

// "WIRELESS · ONLINE" under the client's name.
function clientHeading(c) {
  return c ? join([c.connectionType, c.status]).toUpperCase() : ""
}

// The client view's facts, from `unifictl clients get <id>`: addresses,
// where it is attached and how well, its current rate.
function clientFacts(c) {
  if (!c) return []
  var link = clientLink(c)
  var to = c.connectedTo || {}
  var list = [
    fact("IP", c.ip, { copy: true }),
    fact(link.wireless ? "Signal" : "Link", link.value, { grade: link.grade, attention: link.grade === "poor" })
  ]
  if (link.wireless) list.push(fact("Rate", to.rateMbps ? to.rateMbps + " Mbps" : ""))
  list = present(list.concat(rateFacts(c)))
  // Long values get a line of their own, after the pairs.
  return list.concat(present([
    fact("MAC", c.mac, { copy: true, wide: true }),
    fact("Connected to", link.wireless ? link.where
      : join([to.device ? to.device.name : "", to.port !== undefined && to.port !== null ? "port " + to.port : ""]), { wide: true })
  ]))
}

// Traffic of `unifictl clients traffic <id>` for the client on screen; the
// last fetch may still belong to the client viewed before.
function clientTraffic(traffic, id) {
  return traffic && traffic.id === id && Array.isArray(traffic.items) ? traffic.items : null
}

function trafficHeading(traffic, id) {
  var items = clientTraffic(traffic, id)
  if (!items) return "TRAFFIC · 24H"
  var rx = 0, tx = 0
  for (var i = 0; i < items.length; i++) { rx += items[i].bytesReceived || 0; tx += items[i].bytesTransmitted || 0 }
  return "TRAFFIC · 24H · " + downUp(rx, tx, formatBytes)
}

// One row per application, heaviest first.
function appRows(traffic, id, max, filter) {
  var items = (clientTraffic(traffic, id) || []).filter(function(a) {
    return matches([a.name, a.category ? a.category.name : ""], filter)
  })
  items.sort(function(a, b) { return (b.totalBytes || 0) - (a.totalBytes || 0) })
  var list = []
  var shown = Math.min(items.length, max)
  for (var i = 0; i < shown; i++) {
    var a = items[i]
    list.push({
      icon: ICONS.traffic,
      title: a.name || String(a.id),
      subtitle: join([a.category ? a.category.name : "", downUp(a.bytesReceived, a.bytesTransmitted, formatBytes),
        a.activitySeconds ? "active " + formatDuration(a.activitySeconds) : ""]),
      trailing: formatBytes(a.totalBytes),
      action: ""
    })
  }
  if (items.length > shown) {
    list.push({
      icon: ICONS.more,
      title: (items.length - shown) + " more",
      subtitle: "Open the full list in a terminal",
      muted: true,
      action: "term:" + quotedCommand("unifictl clients traffic", id)
    })
  }
  return list
}

// ---- device view ------------------------------------------------------------

var DEVICE_TYPES = { gateway: "gateway", switch: "switch", accessPoint: "access point" }

// "SWITCH · CONNECTED" for the top of the device view.
function deviceHeading(d) {
  if (!d) return ""
  return join([DEVICE_TYPES[d.type] || d.type, d.status]).toUpperCase()
}

// The device view's facts, from `unifictl devices get <id>`: addresses and
// model, what it hangs off (uplink, or the WANs of a gateway), its current
// rate and, for an access point, a line per radio.
function deviceFacts(d) {
  if (!d) return []
  var list = [
    fact("IP", d.ip, { copy: true }),
    fact("Model", d.model),
    fact("Firmware", d.firmwareVersion)
  ]
  var up = d.uplink
  if (up && up.device) {
    list.push(fact("Link", join([formatLinkSpeed(up.linkSpeed),
      up.maxLinkSpeed && up.maxLinkSpeed !== up.linkSpeed ? "max " + formatLinkSpeed(up.maxLinkSpeed) : "",
      up.fullDuplex === false ? "half duplex" : ""]),
      { grade: grade(up.linkSpeedHealth), attention: isPoor(up.linkSpeedHealth) }))
  }
  list = present(list.concat(rateFacts(d)))
  // Long values get a line of their own, after the pairs.
  list.push(fact("MAC", d.mac, { copy: true, wide: true }))
  if (up && up.device) {
    list.push(fact("Uplink", join([up.device.name, up.port !== undefined && up.port !== null ? "port " + up.port : ""]), { wide: true }))
  }
  var wans = Array.isArray(d.wans) ? d.wans : []
  for (var i = 0; i < wans.length; i++) list.push(fact("WAN", wans[i].name || String(wans[i].id), { wide: true }))
  var radios = Array.isArray(d.radios) ? d.radios : []
  for (var r = 0; r < radios.length; r++) list.push(radioFact(radios[r]))
  return present(list)
}

// "ch 48 · 80 MHz · 3 clients · 97%", naming any metric that grades poor.
function radioFact(r) {
  var poor = []
  if (isPoor(r.utilisationHealth)) poor.push("util " + r.utilisation + "%")
  if (isPoor(r.interferenceHealth)) poor.push("interference " + r.interference + "%")
  if (isPoor(r.retriesHealth)) poor.push("retries " + r.retries + "%")
  var value = join([r.channel ? "ch " + r.channel : "", r.width ? r.width + " MHz" : "",
    r.clients !== undefined && r.clients !== null ? r.clients + (r.clients === 1 ? " client" : " clients") : "",
    percent(r.satisfaction)].concat(poor))
  return fact(r.band || "Radio", value, { wide: true, grade: grade(r.satisfactionHealth),
    attention: poor.length > 0 || isPoor(r.satisfactionHealth) })
}

// `unifictl devices get <id>` for the device on screen; the last fetch may
// still belong to the device viewed before.
function viewedDevice(device, id) {
  return device && device.id === id ? device : null
}

function vlanLabel(p) {
  var v = p.vlanConfig || {}
  var native = v.nativeVlan ? v.nativeVlan.name || ("VLAN " + v.nativeVlan.vlanId) : ""
  return v.mode === "trunk" ? join([native, "trunk"]) : native
}

function portRow(p) {
  var to = p.connectedTo || null
  var up = p.state === "up"
  var open = !to ? "" : to.kind === "device" ? deviceAction(to.id) : to.kind === "client" ? clientActionFor(to.id) : ""
  var rate = p.traffic && up ? downUp(p.traffic.rxBytesPerSec, p.traffic.txBytesPerSec, formatRate, "  ") : ""
  return {
    icon: to && to.kind === "device" ? ICONS.switch : ICONS.ethernet,
    title: join(["Port " + p.number, to ? to.name || to.id : ""]),
    subtitle: join([up ? "" : p.state, vlanLabel(p), p.poePowerWatts ? "PoE " + Number(p.poePowerWatts).toFixed(1) + " W" : "", rate]),
    trailing: up ? formatLinkSpeed(p.linkSpeed) : "",
    muted: !up,
    copy: to ? { name: to.name || "" } : null,
    details: open,
    action: open !== "" ? open : (to ? "copy" : "")
  }
}

function portMatches(p, filter) {
  var to = p.connectedTo || {}
  return matches(["port " + p.number, to.name, p.state, vlanLabel(p), formatLinkSpeed(p.linkSpeed), p.poeMode ? "poe" : ""], filter)
}

function apClientRow(c) {
  var cl = c.client || {}
  var open = clientActionFor(cl.id)
  var g = grade(c.signalStrengthHealth)
  return {
    icon: ICONS.wifi,
    title: cl.name || String(cl.id || ""),
    subtitle: c.ssid || "",
    trailing: c.signalStrength !== undefined && c.signalStrength !== null ? c.signalStrength + " dBm" : "",
    grade: g,
    attention: g === "poor",
    copy: { name: cl.name || "" },
    details: open,
    action: open !== "" ? open : "copy"
  }
}

// The device view's list: a switch's or gateway's ports in order, an access
// point's clients weakest signal first. Rows for what is plugged in or
// associated open that device's or client's view.
function deviceListRows(device, id, max, filter) {
  var d = viewedDevice(device, id)
  if (!d) return []
  var ports = (Array.isArray(d.ports) ? d.ports.slice() : []).filter(function(p) { return portMatches(p, filter) })
  ports.sort(function(a, b) { return a.number - b.number })
  var list = ports.map(portRow)
  var clients = (Array.isArray(d.connectedClients) ? d.connectedClients.slice() : []).filter(function(c) {
    return matches([c.client ? c.client.name : "", c.ssid], filter)
  })
  clients.sort(function(a, b) {
    var sa = a.signalStrength !== undefined && a.signalStrength !== null ? a.signalStrength : 0
    var sb = b.signalStrength !== undefined && b.signalStrength !== null ? b.signalStrength : 0
    return sa !== sb ? sa - sb : String(a.client ? a.client.name : "").localeCompare(String(b.client ? b.client.name : ""))
  })
  var shown = Math.min(clients.length, max)
  for (var i = 0; i < shown; i++) list.push(apClientRow(clients[i]))
  if (clients.length > shown) {
    list.push({
      icon: ICONS.more,
      title: (clients.length - shown) + " more",
      subtitle: "Open the device in a terminal",
      muted: true,
      action: "term:" + getCommand("devices", id)
    })
  }
  return list
}

// "PORTS · 6/8 UP", "CLIENTS · 4", or both for a device that has both.
function deviceListHeading(device, id) {
  var d = viewedDevice(device, id)
  if (!d) return ""
  var parts = []
  var ports = Array.isArray(d.ports) ? d.ports : []
  if (ports.length > 0) {
    var upCount = ports.filter(function(p) { return p.state === "up" }).length
    parts.push("PORTS · " + upCount + "/" + ports.length + " UP")
  }
  var clients = Array.isArray(d.connectedClients) ? d.connectedClients : []
  if (clients.length > 0 || d.type === "accessPoint") parts.push("CLIENTS · " + (d.numClients !== undefined ? d.numClients : clients.length))
  return parts.join(" · ")
}

function clientRows(clients, max, filter, connectionType) {
  var items = clients && Array.isArray(clients.items) ? clients.items.slice() : []
  items = items.filter(function(c) {
    return (!connectionType || c.connectionType === connectionType) && clientMatches(c, filter)
  })
  // Weakest Wi-Fi first: those are the ones worth looking at.
  items.sort(function(a, b) {
    var sa = a.connectedTo && a.connectedTo.signalStrength !== undefined ? a.connectedTo.signalStrength : 0
    var sb = b.connectedTo && b.connectedTo.signalStrength !== undefined ? b.connectedTo.signalStrength : 0
    if (sa !== sb) return sa - sb
    return String(a.name).localeCompare(String(b.name))
  })
  var list = []
  var shown = Math.min(items.length, max)
  for (var i = 0; i < shown; i++) list.push(clientRow(items[i]))
  if (items.length > shown) {
    list.push({
      icon: ICONS.more,
      title: (items.length - shown) + " more",
      subtitle: "Open the full list in a terminal",
      muted: true,
      action: "term:unifictl clients list"
    })
  }
  return list
}

function parseJson(text) {
  try {
    var value = JSON.parse(String(text || ""))
    return { ok: true, value: value }
  } catch (e) {
    return { ok: false, error: "unifictl returned invalid JSON" }
  }
}

// ---- drill-down views -----------------------------------------------------

var VIEWS = {
  devices: { title: "Devices", heading: "GATEWAY · SWITCHES · ACCESS POINTS", needs: "devices", terminal: "unifictl topology",
    filterHint: "Filter devices by name, IP, MAC, model" },
  wifi: { title: "Wi-Fi clients", heading: "WEAKEST SIGNAL FIRST", needs: "clients", terminal: "unifictl clients list",
    filterHint: "Filter clients by name, IP, MAC, SSID, AP" },
  wired: { title: "Wired clients", heading: "CONNECTED BY CABLE", needs: "clients", terminal: "unifictl clients list",
    filterHint: "Filter clients by name, IP, MAC, switch" },
  alarms: { title: "Alarms", heading: "RECENT HIGH-SEVERITY EVENTS", needs: "logs", terminal: "unifictl logs -p high",
    filterHint: "Filter alarms by title, message, IP" }
}

// A client view is "client:<id>": `unifictl clients get` on top, its traffic
// by application below. It opens from any client row, so it is not in VIEWS.
var CLIENT_VIEW = "client:"

function isClientView(view) {
  return String(view || "").indexOf(CLIENT_VIEW) === 0
}

function clientView(view) {
  var id = String(view).slice(CLIENT_VIEW.length)
  if (id === "") return null
  return { title: "Client", heading: "TRAFFIC · 24H", needs: "client", clientId: id, id: id,
    terminal: getCommand("clients", id) + "; " + quotedCommand("unifictl clients traffic", id),
    filterHint: "Filter applications by name, category" }
}

// A device view is "device:<id>": `unifictl devices get` on top, its ports
// or Wi-Fi clients below. It opens from device rows and from ports and
// uplinks that lead to another device.
var DEVICE_VIEW = "device:"

function isDeviceView(view) {
  return String(view || "").indexOf(DEVICE_VIEW) === 0
}

function deviceView(view) {
  var id = String(view).slice(DEVICE_VIEW.length)
  if (id === "") return null
  return { title: "Device", heading: "", needs: "device", deviceId: id, id: id,
    terminal: getCommand("devices", id),
    filterHint: "Filter by port, name, VLAN, SSID" }
}

// One client or device on screen, rather than a list: these stack, so back
// walks the trail of items opened from one another.
function isItemView(view) {
  return isClientView(view) || isDeviceView(view)
}

function viewInfo(view) {
  if (isClientView(view)) return clientView(view)
  if (isDeviceView(view)) return deviceView(view)
  return VIEWS[view] || null
}

// `unifictl logs -o json` prints one JSON object per line.
function parseNdjson(text) {
  var out = []
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    try { out.push(JSON.parse(line)) } catch (e) { return { ok: false, error: "unifictl returned invalid JSON" } }
  }
  return { ok: true, value: out }
}

function formatTime(iso) {
  var d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso || "")
  var pad = function(n) { return n < 10 ? "0" + n : String(n) }
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
}

function logRows(entries, filter) {
  var items = (Array.isArray(entries) ? entries : []).filter(function(e) { return logMatches(e, filter) })
  var list = []
  for (var i = 0; i < items.length; i++) {
    var e = items[i]
    var details = e.details || {}
    list.push({
      icon: e.category === "security" ? ICONS.alert : ICONS.other,
      title: e.title || e.event || "Event",
      subtitle: join([formatTime(e.time), e.message]),
      attention: e.severity === "veryHigh",
      copy: { ip: details.srcIp || "", name: e.message || "" },
      action: "copy"
    })
  }
  return list
}

function detailRows(view, data, max, filter) {
  if (view === "devices") return deviceRows(data.devices, filter)
  if (view === "wifi") return clientRows(data.clients, max, filter, "wireless")
  if (view === "wired") return clientRows(data.clients, max, filter, "wired")
  if (view === "alarms") return logRows(data.logs, filter)
  var info = viewInfo(view)
  if (info && info.needs === "client") return appRows(data.clientTraffic, info.clientId, max, filter)
  if (info && info.needs === "device") return deviceListRows(data.device, info.deviceId, max, filter)
  return []
}
