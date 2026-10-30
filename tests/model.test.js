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
  assert.equal(device.details, "view:device:us-8")
  assert.equal(device.action, "view:device:us-8")
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
  for (const r of [wans[0]]) {
    assert.match(r.details, /^unifictl wans get '/)
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

const facts = (list) => Object.fromEntries([...list].map((f) => [f.label, f.value]))

test("client view: facts from clients get, app rows from clients traffic", () => {
  const wired = { id: "laptop", name: "laptop", mac: "aa:bb", ip: "10.0.0.5", connectionType: "wired", status: "online",
    connectedTo: { device: { name: "US 8" }, port: 5, linkSpeed: "gbe1", linkSpeedHealth: "good" },
    traffic: { rxBytesPerSec: 2048, txBytesPerSec: 1536 }, uptime: 273600 }
  const rows = Model.clientFacts(wired)
  assert.deepEqual(facts(rows), { IP: "10.0.0.5", MAC: "aa:bb", "Connected to": "US 8 · port 5", Link: "1 GbE",
    Receiving: "2.0 KB/s", Sending: "1.5 KB/s", Uptime: "3d 4h" })
  assert.deepEqual([...rows].filter((f) => f.copy).map((f) => f.label), ["IP", "MAC"])
  assert.deepEqual([...rows].map((f) => f.label), ["IP", "Link", "Receiving", "Sending", "Uptime", "MAC", "Connected to"],
    "short facts pair up first, long ones after on lines of their own")
  assert.equal(rows[1].grade, "good")
  assert.equal(rows[6].wide, true)
  assert.equal(Model.clientHeading(wired), "WIRED · ONLINE")
  assert.equal(Model.clientIcon(wired), Model.ICONS.ethernet)
  assert.equal(Model.clientFacts(null).length, 0)

  const wifi = Model.clientFacts({ id: "s", name: "Speaker", ip: "10.0.0.6", connectionType: "wireless", status: "online",
    connectedTo: { device: { name: "UAP-01" }, ssid: "HomeWiFi", signalStrength: -70, rateMbps: 130, signalStrengthHealth: "poor" },
    experience: 95, experienceHealth: "good" })
  assert.deepEqual(facts(wifi), { IP: "10.0.0.6", "Connected to": "HomeWiFi @ UAP-01", Signal: "-70 dBm", Rate: "130 Mbps", Experience: "95%" },
    "no MAC, rate or uptime when unknown")
  assert.equal(wifi[1].attention, true)
  assert.equal(wifi[3].grade, "good")

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
  assert.equal(apps[0].action, "", "nothing to open or copy on an app")
  assert.equal(apps[0].copy, undefined)
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
  const info = Model.clientFacts(client)
  assert.ok(info.length >= 2)
  const apps = Model.appRows(unifictl("clients", "traffic", id), id, 100, "")
  assert.ok(apps.length > 0)
  for (const f of info) assert.ok(!/undefined|NaN|null/.test(f.value), f.label + " " + f.value)
  for (const r of [...apps, ...selfRows]) assert.ok(!/undefined|NaN/.test(r.title + r.subtitle + (r.trailing || "")), r.title + " " + r.subtitle)
  console.log(JSON.stringify(facts(info)), apps.length, "apps")
  execFileSync("bash", ["-c", Model.viewInfo("client:" + id).terminal.replace(/;/g, " -o json >/dev/null;") + " -o json >/dev/null"])
})

test("device view: facts, ports and AP clients from devices get", () => {
  const info = Model.viewInfo("device:us-8")
  assert.equal(info.needs, "device")
  assert.equal(info.deviceId, "us-8")
  assert.equal(info.terminal, "unifictl devices get 'us-8'")
  assert.equal(Model.viewInfo("device:"), null)
  assert.equal(Model.isItemView("device:x"), true)
  assert.equal(Model.isItemView("client:x"), true)
  assert.equal(Model.isItemView("devices"), false)

  const sw = { id: "us-8", name: "US 8", mac: "e0:63", ip: "192.168.1.44", type: "switch", status: "connected",
    model: "USC8", firmwareVersion: "7.5.15", uptime: 910119, experience: 95, experienceHealth: "good",
    traffic: { rxBytesPerSec: 437, txBytesPerSec: 2048 },
    uplink: { device: { kind: "device", id: "us-8-60w", name: "US 8 60W" }, port: 7, linkSpeed: "gbe1", maxLinkSpeed: "gbe1", fullDuplex: true, linkSpeedHealth: "good" },
    ports: [
      { number: 2, state: "down", vlanConfig: { mode: "access", nativeVlan: { name: "LAN-INT", vlanId: 10 } } },
      { number: 1, state: "up", linkSpeed: "gbe1", vlanConfig: { mode: "trunk", nativeVlan: { name: "LAN-MGMT", vlanId: 1 } },
        traffic: { rxBytesPerSec: 1024, txBytesPerSec: 512 }, connectedTo: { kind: "device", id: "us-8-60w", name: "US 8 60W" } },
      { number: 3, state: "up", linkSpeed: "gbe2_5", poePowerWatts: 3.02, vlanConfig: { mode: "access", nativeVlan: { name: "LAN-INT", vlanId: 10 } },
        connectedTo: { kind: "client", id: "nas", name: "NAS" } },
      { number: 4, state: "up", linkSpeed: "fe" }
    ] }
  const rows = Model.deviceFacts(sw)
  assert.deepEqual(facts(rows), { IP: "192.168.1.44", MAC: "e0:63", Model: "USC8", Firmware: "7.5.15",
    Uplink: "US 8 60W · port 7", Link: "1 GbE", Receiving: "437 B/s", Sending: "2.0 KB/s", Uptime: "10d 12h", Experience: "95%" })
  assert.deepEqual([...rows].map((f) => f.label), ["IP", "Model", "Firmware", "Link", "Receiving", "Sending", "Uptime", "Experience", "MAC", "Uplink"])
  assert.equal(rows[3].grade, "good")
  assert.equal(Model.deviceHeading(sw), "SWITCH · CONNECTED")
  assert.equal(Model.deviceFacts(null).length, 0)

  const data = { device: sw }
  const ports = Model.detailRows("device:us-8", data, 10, "")
  assert.deepEqual([...ports].map((r) => r.title), ["Port 1 · US 8 60W", "Port 2", "Port 3 · NAS", "Port 4"])
  assert.equal(ports[0].action, "view:device:us-8-60w")
  assert.equal(ports[0].subtitle, "LAN-MGMT · trunk · ↓ 1.0 KB/s  ↑ 512 B/s")
  assert.equal(ports[1].muted, true)
  assert.equal(ports[1].subtitle, "down · LAN-INT")
  assert.equal(ports[2].action, "view:client:nas")
  assert.equal(ports[2].trailing, "2.5 GbE")
  assert.equal(ports[2].subtitle, "LAN-INT · PoE 3.0 W")
  assert.equal(ports[3].action, "", "nothing known on the port")
  assert.equal(Model.detailRows("device:us-8", data, 10, "nas").length, 1)
  assert.equal(Model.detailRows("device:other", data, 10, "").length, 0, "stale device is ignored")
  assert.equal(Model.deviceListHeading(sw, "us-8"), "PORTS · 3/4 UP")

  const gw = { id: "gw", name: "GW", type: "gateway", status: "connected", wans: [{ id: "internet-1", name: "Internet 1" }] }
  const gwFacts = Model.deviceFacts(gw)
  assert.deepEqual([...gwFacts].map((f) => [f.label, f.value, f.wide]), [["WAN", "Internet 1", true]])

  const ap = { id: "uap", name: "UAP", type: "accessPoint", status: "connected", numClients: 3,
    radios: [{ band: "5G", channel: 48, width: 80, txPower: 20, utilisation: 2, interference: 0, retries: 8.1, clients: 3,
      satisfaction: 97, satisfactionHealth: "good", retriesHealth: "poor" }],
    connectedClients: [
      { client: { kind: "client", id: "a", name: "A" }, ssid: "home", signalStrength: -40, signalStrengthHealth: "good" },
      { client: { kind: "client", id: "b", name: "B" }, ssid: "home", signalStrength: -75, signalStrengthHealth: "poor" },
      { client: { kind: "client", id: "c", name: "C" }, ssid: "iot", signalStrength: -60, signalStrengthHealth: "fair" }
    ] }
  const radio = Model.deviceFacts(ap).pop()
  assert.equal(radio.label, "5G")
  assert.equal(radio.value, "ch 48 · 80 MHz · 3 clients · 97% · retries 8.1%", "only poor metrics are named")
  assert.equal(radio.wide, true)
  assert.equal(radio.attention, true)
  const clients = Model.deviceListRows(ap, "uap", 2, "")
  assert.deepEqual([...clients].map((r) => r.title), ["B", "C", "1 more"], "weakest first, capped")
  assert.equal(clients[0].action, "view:client:b")
  assert.equal(clients[2].action, "term:unifictl devices get 'uap'")
  assert.equal(Model.deviceListRows(ap, "uap", 10, "iot").length, 1)
  assert.equal(Model.deviceListHeading(ap, "uap"), "CLIENTS · 3")
  assert.equal(Model.deviceHeading(ap), "ACCESS POINT · CONNECTED")
})

test("fact grid: pairs per line, wide facts on a line of their own", () => {
  const f = (label, wide) => ({ label, value: label.toLowerCase(), wide: !!wide })
  const cells = Model.factCells([f("IP"), f("MAC"), f("Uptime"), f("5G", true), f("6G", true)])
  assert.deepEqual([...cells].map((c) => [c.text, c.span]), [
    ["IP", 1], ["ip", 1], ["MAC", 1], ["mac", 1],
    ["Uptime", 1], ["uptime", 1], ["", 2],
    ["5G", 1], ["5g", 3],
    ["6G", 1], ["6g", 3]
  ])
  assert.equal(cells[1].fact.label, "IP")
  assert.equal(cells[0].label, true)
})

liveTest("live device view for every device", () => {
  const devices = unifictl("devices", "list")
  for (const { id } of devices.items) {
    const d = unifictl("devices", "get", id)
    const info = Model.deviceFacts(d)
    for (const f of info) assert.ok(!/undefined|NaN|null/.test(f.value), id + ": " + f.label + " " + f.value)
    const rows = Model.deviceListRows(d, id, 100, "")
    assert.ok(info.length + rows.length >= 2, id)
    for (const r of rows) assert.ok(!/undefined|NaN|null/.test(r.title + r.subtitle + (r.trailing || "")), id + ": " + r.title + " " + r.subtitle)
    for (const r of rows) if (r.action.startsWith("view:")) assert.ok(Model.viewInfo(r.action.slice(5)), r.action)
    console.log(id, Model.deviceHeading(d), "|", Model.deviceListHeading(d, id), "|", rows.length, "rows")
  }
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
