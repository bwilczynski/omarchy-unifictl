// Runs Model.js exactly as QML loads it: offline tests use made-up samples,
// live tests check it against real `unifictl` output. Run with:
//   node --test tests/
// The live tests skip when unifictl is missing or cannot reach the
// controller, or when UNIFICTL_LIVE=0.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { execFileSync } = require("node:child_process")

const Model = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8"), Model)

const unifictl = (...args) => JSON.parse(execFileSync("unifictl", [...args, "-o", "json"], { encoding: "utf8" }))

// Why the live tests cannot run here, or "" when they can. The timeout
// covers an API key behind a gpg prompt nobody can answer.
function liveSkipReason() {
  if (process.env.UNIFICTL_LIVE === "0") return "UNIFICTL_LIVE=0"
  try {
    execFileSync("unifictl", ["status", "-o", "json"], { stdio: ["ignore", "ignore", "pipe"], timeout: 20000 })
    return ""
  } catch (e) {
    if (e.code === "ENOENT") return "unifictl is not installed"
    if (e.signal) return "unifictl status timed out"
    const lines = String(e.stderr || "").trim().split("\n")
    return "unifictl cannot reach the controller: " + (lines.pop() || "exit " + e.status)
  }
}

const skipLive = liveSkipReason()
const liveTest = (name, fn) => test(name, { skip: skipLive || false }, fn)

test("verdicts: idle is fine, warn is a warning, anything else is an error", () => {
  const s = (...v) => ({ rows: v.map((verdict) => ({ verdict, area: "x" })) })
  assert.equal(Model.overallState(s("ok", "idle"), false), "ok")
  assert.equal(Model.overallState(s("ok", "warn"), false), "warning")
  assert.equal(Model.overallState(s("warn", "fail"), false), "error")
  assert.equal(Model.overallState(null, false), "loading")
  assert.equal(Model.overallState(s("ok"), true), "stale")
})

test("grades: only good, fair and poor count", () => {
  assert.equal(Model.grade("good"), "good")
  assert.equal(Model.grade("poor"), "poor")
  assert.equal(Model.grade(undefined), "")
  assert.equal(Model.grade("bad"), "")
})

test("grade colours come from the theme, with ANSI fallbacks", () => {
  const named = Model.gradeColors('green = "#9ece6a"\nyellow = "#e0af68"\nred = "#f7768e"\ncolor2 = "#000000"')
  assert.deepEqual({ ...named }, { good: "#9ece6a", fair: "#e0af68", poor: "#f7768e" })
  const ansi = Model.gradeColors('color1 = "#aa0000"\ncolor2 = "#00aa00"\ncolor3 = "#aaaa00"')
  assert.deepEqual({ ...ansi }, { good: "#00aa00", fair: "#aaaa00", poor: "#aa0000" })
  assert.deepEqual({ ...Model.gradeColors("") }, { good: "", fair: "", poor: "" })
})

test("client rows carry unifictl's grade for signal or link speed", () => {
  const wifi = Model.clientRow({ name: "phone", ip: "10.0.0.2", connectionType: "wireless",
    connectedTo: { device: { name: "AP" }, ssid: "home", signalStrength: -80, signalStrengthHealth: "poor" } })
  assert.equal(wifi.trailing, "-80 dBm")
  assert.equal(wifi.grade, "poor")
  assert.equal(wifi.attention, true)
  assert.equal(wifi.subtitle, "10.0.0.2 · home @ AP")

  const wired = Model.clientRow({ name: "hue", ip: "10.0.0.3", connectionType: "wired",
    connectedTo: { device: { name: "US 8" }, port: 6, linkSpeed: "fe", linkSpeedHealth: "fair" } })
  assert.equal(wired.trailing, "100 Mbps")
  assert.equal(wired.grade, "fair")
  assert.equal(wired.attention, false)
  assert.equal(wired.subtitle, "10.0.0.3 · US 8 port 6")

  assert.equal(Model.selfRows({ items: [{ connectionType: "wired" }, { connectionType: "wireless" }] }).length, 2)
  assert.equal(Model.selfRows({ items: [] }).length, 0)
  assert.equal(Model.selfRows(null).length, 0)
})

test("filter matches every word, in any list", () => {
  const devices = { items: [
    { name: "US 8", ip: "10.0.0.1", type: "switch", model: "USC8", status: "connected" },
    { name: "UAP-01", ip: "10.0.0.2", type: "accessPoint", model: "U7PG2", status: "connected" }
  ] }
  assert.equal(Model.detailRows("devices", { devices }, 10, "usc8").length, 1)
  assert.equal(Model.detailRows("devices", { devices }, 10, "uap 10.0.0.2").length, 1)
  assert.equal(Model.detailRows("devices", { devices }, 10, "").length, 2)

  const logs = [
    { title: "Threat Detected", message: "intrusion from 10.0.0.9", category: "security", details: { dstIp: "140.82.121.3" } },
    { title: "AP Disconnected", message: "UAP-02 lost contact", category: "device" }
  ]
  assert.equal(Model.detailRows("alarms", { logs }, 10, "140.82").length, 1)
  assert.equal(Model.detailRows("alarms", { logs }, 10, "uap-02").length, 1)
  assert.equal(Model.detailRows("alarms", { logs }, 10, "nothing").length, 0)

  for (const v of ["devices", "wifi", "wired", "alarms"]) assert.ok(Model.viewInfo(v).filterHint, v)
})

test("leaf rows offer a copy menu and a details command", () => {
  const opts = Model.copyOptions({ ip: "10.0.0.2", name: "phone", mac: "" })
  assert.deepEqual([...opts].map((o) => [o.label, o.value]), [["IP", "10.0.0.2"], ["Name", "phone"]])
  assert.equal(Model.copyOptions(undefined).length, 0)

  assert.equal(Model.getCommand("clients", "o'brien"), "unifictl clients get 'o'\\''brien'")
  assert.equal(Model.getCommand("devices", ""), "")

  const [device] = Model.deviceRows({ items: [{ id: "us-8", name: "US 8", status: "connected" }] })
  assert.equal(device.details, "unifictl devices get 'us-8'")
  const [alarm] = Model.logRows([{ title: "x", details: { srcIp: "1.2.3.4" } }])
  assert.equal(alarm.action, "copy")
  assert.equal(alarm.details, undefined)
})

liveTest("live status, devices and clients produce rows", () => {
  const status = unifictl("status")
  const self = unifictl("clients", "list", "--self")
  const selfRows = Model.selfRows(self)
  assert.equal(selfRows.length, self.items.length)
  for (const r of selfRows) assert.ok(r.grade !== "", "self row is graded")
  console.log("self", JSON.stringify(selfRows.map((r) => [r.title, r.subtitle, r.trailing, r.grade])))
  const devices = unifictl("devices", "list")
  const clients = unifictl("clients", "list")

  const wans = Model.wanRows(status)
  assert.ok(wans.length > 0)
  assert.ok(Model.summaryRows(status).length >= 3)
  assert.equal(Model.deviceRows(devices).length, devices.items.length)

  const rows = Model.clientRows(clients, 5, "")
  assert.equal(rows.length, Math.min(clients.items.length, 5) + (clients.items.length > 5 ? 1 : 0))
  assert.ok(Model.tooltip(status, Model.overallState(status, false)).startsWith("UniFi: "))

  assert.ok(wans.some((r) => r.grade !== ""), "a connected WAN carries a latency grade")
  assert.ok(Model.deviceRows(devices).some((r) => r.grade !== ""), "devices carry experience grades")
  for (const r of [...wans, ...selfRows, ...Model.summaryRows(status), ...Model.deviceRows(devices), ...rows]) {
    assert.equal(typeof r.title, "string")
    assert.ok(!String(r.subtitle).includes("undefined"), r.subtitle)
  }
  const summary = Model.summaryRows(status)
  for (const r of summary) assert.match(r.action, /^view:(devices|wifi|wired|alarms)$/, r.title)

  const logs = Model.parseNdjson(execFileSync("unifictl", ["logs", "-r", "-p", "high", "-n", "5", "-o", "json"], { encoding: "utf8" }))
  assert.ok(logs.ok)
  const data = { devices, clients, logs: logs.value }
  const wifi = Model.detailRows("wifi", data, 100, "")
  const wired = Model.detailRows("wired", data, 100, "")
  assert.equal(wifi.length + wired.length, clients.items.length)
  assert.equal(Model.detailRows("devices", data, 100, "").length, devices.items.length)
  assert.equal(Model.detailRows("alarms", data, 100, "").length, logs.value.length)
  console.log("wifi", wifi.length, "wired", wired.length, "alarms", logs.value.length)

  // Every details command runs as is.
  for (const r of [wans[0], Model.deviceRows(devices)[0]]) {
    assert.match(r.details, /^unifictl (wans|devices) get '/)
    execFileSync("bash", ["-c", r.details + " -o json > /dev/null"])
  }

  console.log(Model.tooltip(status, Model.overallState(status, false)))
  console.log(JSON.stringify(Model.summaryRows(status).map((r) => [r.title, r.subtitle]), null, 1))
})

test("bytes and rates read like unifictl's tables", () => {
  assert.equal(Model.formatBytes(943718400), "900.0 MB")
  assert.equal(Model.formatBytes(278937), "272.4 KB")
  assert.equal(Model.formatBytes(2684354560), "2.5 GB")
  assert.equal(Model.formatBytes(512), "512 B")
  assert.equal(Model.formatBytes(0), "0 B")
  assert.equal(Model.formatBytes(undefined), "")
  assert.equal(Model.formatRate(1536), "1.5 KB/s")
  assert.equal(Model.formatRate(null), "")
})

test("client rows open the client view; others keep the terminal", () => {
  const client = Model.clientRow({ id: "phone-1", name: "phone", connectionType: "wireless" })
  assert.equal(client.action, "view:client:phone-1")
  assert.equal(client.details, "view:client:phone-1")
  assert.equal(Model.clientRow({ name: "no id", connectionType: "wired" }).action, "copy")

  const info = Model.viewInfo("client:phone-1")
  assert.equal(info.needs, "client")
  assert.equal(info.clientId, "phone-1")
  assert.equal(info.terminal, "unifictl clients get 'phone-1'; unifictl clients traffic 'phone-1'")
  assert.equal(Model.viewInfo("client:"), null)
  assert.equal(Model.isClientView("client:x"), true)
  assert.equal(Model.isClientView("wifi"), false)
})

test("this device shows its 24h traffic", () => {
  const self = { items: [{ id: "laptop", name: "laptop", ip: "10.0.0.5", connectionType: "wired",
    connectedTo: { device: { name: "US 8" }, port: 5, linkSpeed: "gbe1" } }] }
  const traffic = { items: [{ id: "laptop", bytesReceived: 1400000000, bytesTransmitted: 175000000, totalBytes: 1575000000 }] }
  const [row] = Model.selfRows(self, traffic)
  assert.equal(row.subtitle, "10.0.0.5 · US 8 port 5 · ↓ 1.3 GB ↑ 166.9 MB 24h")
  assert.equal(Model.selfRows(self, null)[0].subtitle, "10.0.0.5 · US 8 port 5")
  assert.equal(Model.selfRows(self, { items: [] })[0].subtitle, "10.0.0.5 · US 8 port 5")
})

test("client view: info rows from clients get, app rows from clients traffic", () => {
  const wired = { id: "laptop", name: "laptop", mac: "aa:bb", ip: "10.0.0.5", connectionType: "wired", status: "online",
    connectedTo: { device: { name: "US 8" }, port: 5, linkSpeed: "gbe1", linkSpeedHealth: "good" },
    traffic: { rxBytesPerSec: 2048, txBytesPerSec: 1536 }, uptime: 273600 }
  const rows = Model.clientInfoRows(wired)
  assert.deepEqual([...rows].map((r) => r.title), ["10.0.0.5", "US 8 · port 5", "↓ 2.0 KB/s  ↑ 1.5 KB/s"])
  assert.equal(rows[0].subtitle, "aa:bb · wired · online")
  assert.deepEqual({ ...rows[0].copy }, { ip: "10.0.0.5", name: "laptop", mac: "aa:bb" })
  assert.equal(rows[1].trailing, "1 GbE")
  assert.equal(rows[1].grade, "good")
  assert.equal(rows[2].subtitle, "Right now · up 3d 4h")
  assert.equal(Model.clientInfoRows(null).length, 0)

  const wifi = Model.clientInfoRows({ id: "s", name: "Speaker", ip: "10.0.0.6", connectionType: "wireless", status: "online",
    connectedTo: { device: { name: "UAP-01" }, ssid: "HomeWiFi", signalStrength: -70, rateMbps: 130, signalStrengthHealth: "poor" },
    experience: 95, experienceHealth: "good" })
  assert.equal(wifi[1].title, "HomeWiFi @ UAP-01")
  assert.equal(wifi[1].subtitle, "130 Mbps · experience 95%")
  assert.equal(wifi[1].trailing, "-70 dBm")
  assert.equal(wifi[1].attention, true)
  assert.equal(wifi.length, 2, "no rate row without traffic")

  const traffic = { id: "laptop", items: [
    { name: "SSL/TLS", category: { name: "Network protocols" }, bytesReceived: 314572800, bytesTransmitted: 104857600, totalBytes: 419430400, activitySeconds: 3600 },
    { name: "Video", category: { name: "Media streaming" }, bytesReceived: 943718400, bytesTransmitted: 41943040, totalBytes: 985661440, activitySeconds: 43200 },
    { name: "Updates", category: { name: "Software updates" }, bytesReceived: 20971520, bytesTransmitted: 4194304, totalBytes: 25165824, activitySeconds: 0 }
  ] }
  const apps = Model.appRows(traffic, "laptop", 10, "")
  assert.deepEqual([...apps].map((r) => r.title), ["Video", "SSL/TLS", "Updates"], "heaviest first")
  assert.equal(apps[0].trailing, "940.0 MB")
  assert.equal(apps[0].subtitle, "Media streaming · ↓ 900.0 MB ↑ 40.0 MB · active 12h 0m")
  assert.equal(apps[2].subtitle, "Software updates · ↓ 20.0 MB ↑ 4.0 MB")
  assert.equal(Model.appRows(traffic, "laptop", 10, "updates").length, 1)
  assert.equal(Model.appRows(traffic, "other", 10, "").length, 0, "stale traffic for another client is ignored")
  const capped = Model.appRows(traffic, "laptop", 2, "")
  assert.equal(capped.length, 3)
  assert.equal(capped[2].action, "term:unifictl clients traffic 'laptop'")
  assert.equal(Model.detailRows("client:laptop", { clientTraffic: traffic }, 10, "").length, 3)

  assert.equal(Model.trafficHeading(traffic, "laptop"), "TRAFFIC · 24H · ↓ 1.2 GB ↑ 144.0 MB")
  assert.equal(Model.trafficHeading(null, "laptop"), "TRAFFIC · 24H")
})

liveTest("live client view and traffic", () => {
  const self = unifictl("clients", "list", "--self")
  const traffic = unifictl("clients", "traffic")
  assert.ok(traffic.items.length > 0)
  const selfRows = Model.selfRows(self, traffic)
  console.log("self", JSON.stringify(selfRows.map((r) => r.subtitle)))
  const id = (self.items[0] || traffic.items[0]).id
  const client = unifictl("clients", "get", id)
  const info = Model.clientInfoRows(client)
  assert.ok(info.length >= 2)
  const apps = Model.appRows(unifictl("clients", "traffic", id), id, 100, "")
  assert.ok(apps.length > 0)
  for (const r of [...info, ...apps, ...selfRows]) assert.ok(!/undefined|NaN/.test(r.title + r.subtitle + (r.trailing || "")), r.title + " " + r.subtitle)
  console.log(JSON.stringify(info.map((r) => [r.title, r.subtitle, r.trailing])), apps.length, "apps")
  execFileSync("bash", ["-c", Model.viewInfo("client:" + id).terminal.replace(/;/g, " -o json >/dev/null;") + " -o json >/dev/null"])
})

test("hero: controller name, falling back to UniFi", () => {
  const s = { controller: { name: "Gateway-1", osVersion: "5.1.33", networkVersion: "10.6.109" }, rows: [] }
  assert.equal(Model.controllerName(s), "Gateway-1")
  assert.equal(Model.controllerName({ rows: [] }), "UniFi")
  assert.equal(Model.controllerName(null), "UniFi")
})

liveTest("hero: live status names the controller", () => {
  const s = unifictl("status")
  assert.notEqual(Model.controllerName(s), "UniFi")
})
