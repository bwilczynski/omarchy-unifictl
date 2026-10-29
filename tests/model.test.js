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

test("live status, devices and clients produce rows", () => {
  const status = unifictl("status")
  const devices = unifictl("devices", "list")
  const clients = unifictl("clients", "list")

  const wans = Model.wanRows(status)
  assert.ok(wans.length > 0)
  assert.ok(Model.summaryRows(status).length >= 3)
  assert.equal(Model.deviceRows(devices).length, devices.items.length)

  const rows = Model.clientRows(clients, 5, "")
  assert.equal(rows.length, Math.min(clients.items.length, 5) + (clients.items.length > 5 ? 1 : 0))
  assert.ok(Model.tooltip(status, Model.overallState(status, false)).startsWith("UniFi: "))

  for (const r of [...wans, ...Model.summaryRows(status), ...Model.deviceRows(devices), ...rows]) {
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

  console.log(Model.tooltip(status, Model.overallState(status, false)))
  console.log(JSON.stringify(Model.summaryRows(status).map((r) => [r.title, r.subtitle]), null, 1))
})
