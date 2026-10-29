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
  details: String.fromCodePoint(0xF02FD)    // md-information_outline
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

var LINK_SPEEDS = { e: "10 Mbps", fe: "100 Mbps", gbe1: "1 GbE", gbe2p5: "2.5 GbE", gbe5: "5 GbE", gbe10: "10 GbE" }

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
// run in a terminal.
//
// `grade` is unifictl's health grade for the trailing value ("good", "fair",
// "poor", or "" when ungraded); the row colours that value with it.

// `unifictl <noun> get <id>`, or "" without an id.
function getCommand(noun, id) {
  if (id === null || id === undefined || String(id) === "") return ""
  return "unifictl " + noun + " get '" + String(id).replace(/'/g, "'\\''") + "'"
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
      details: getCommand("devices", d.id),
      action: "copy"
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

// One client: where it is attached, and the graded value that says how well
// (signal for Wi-Fi, link speed for a cable).
function clientRow(c) {
  var to = c.connectedTo || {}
  var wireless = c.connectionType === "wireless"
  var where = to.device ? to.device.name : ""
  if (wireless && to.ssid) where = to.ssid + " @ " + where
  else if (!wireless && to.port !== undefined && to.port !== null) where = where + " port " + to.port
  var value = wireless
    ? (to.signalStrength !== undefined && to.signalStrength !== null ? to.signalStrength + " dBm" : "")
    : formatLinkSpeed(to.linkSpeed)
  var g = grade(wireless ? to.signalStrengthHealth : to.linkSpeedHealth)
  return {
    icon: wireless ? ICONS.wifi : ICONS.ethernet,
    title: c.name || c.mac,
    subtitle: join([c.ip, where]),
    trailing: value,
    grade: g,
    attention: g === "poor",
    copy: { ip: c.ip || "", name: c.name || "", mac: c.mac || "" },
    details: getCommand("clients", c.id),
    action: "copy"
  }
}

// This machine, from `unifictl clients list --self`: one row per connection
// the controller sees (cable and Wi-Fi at once give two). Empty when the
// controller does not know it (off-site, VPN, older unifictl).
function selfRows(self) {
  var items = self && Array.isArray(self.items) ? self.items : []
  return items.map(clientRow)
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

function viewInfo(view) {
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
  return []
}
