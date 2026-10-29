// Runs Model.js exactly as QML loads it and checks it against live unifictl
// output. Run with: node --test tests/
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { execFileSync } = require("node:child_process")

const Model = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8"), Model)

const unifictl = (...args) => JSON.parse(execFileSync("unifictl", [...args, "-o", "json"], { encoding: "utf8" }))

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

  const client = Model.clientRow({ id: "phone-1", name: "phone", connectionType: "wireless" })
  assert.equal(client.action, "copy")
  assert.equal(client.details, "unifictl clients get 'phone-1'")
  const [device] = Model.deviceRows({ items: [{ id: "us-8", name: "US 8", status: "connected" }] })
  assert.equal(device.details, "unifictl devices get 'us-8'")
  const [alarm] = Model.logRows([{ title: "x", details: { srcIp: "1.2.3.4" } }])
  assert.equal(alarm.action, "copy")
  assert.equal(alarm.details, undefined)
})

test("live status, devices and clients produce rows", () => {
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
  for (const r of [wans[0], Model.deviceRows(devices)[0], rows[0]]) {
    assert.match(r.details, /^unifictl (wans|devices|clients) get '/)
    execFileSync("bash", ["-c", r.details + " -o json > /dev/null"])
  }

  console.log(Model.tooltip(status, Model.overallState(status, false)))
  console.log(JSON.stringify(Model.summaryRows(status).map((r) => [r.title, r.subtitle]), null, 1))
})

test("hero: controller name, falling back to UniFi", () => {
  const s = { controller: { name: "Gateway-1", osVersion: "5.1.33", networkVersion: "10.6.109" }, rows: [] }
  assert.equal(Model.controllerName(s), "Gateway-1")
  assert.equal(Model.controllerName({ rows: [] }), "UniFi")
  assert.equal(Model.controllerName(null), "UniFi")
})

test("hero: live status names the controller", () => {
  const s = unifictl("status")
  assert.notEqual(Model.controllerName(s), "UniFi")
})
