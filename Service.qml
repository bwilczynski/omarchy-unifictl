import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Polls `unifictl status -o json` on a timer for the bar icon, and
// `clients list --self` plus `clients traffic` for this machine's own
// connection and its 24h traffic. A failed status
// run keeps the last good data and marks it stale instead of blanking the
// widget. Detail data (devices, clients, logs) is fetched only for the drill-down
// view that is open, so the main view costs three quick calls per tick. The
// client view ("client:<id>") loads `clients get` and `clients traffic <id>`,
// the device view ("device:<id>") `devices get <id>`.
Item {
  id: root

  property var settings: ({})
  // Drill-down view currently on screen ("" when the popup shows the main view).
  property string view: ""
  property int logLines: 15

  property var status: null
  property var selfClient: null
  property var devices: null
  property var clients: null
  property var logs: null
  // Site-wide `clients traffic`, for this machine's 24h total.
  property var traffic: null
  // The client view's `clients get <id>` and `clients traffic <id>`. Both
  // carry the id, so the panel can tell them from a previous client's.
  property var client: null
  property var clientTraffic: null
  // The device view's `devices get <id>`, which carries its id too.
  property var device: null
  property bool stale: false
  property string lastError: ""
  property double lastSuccessMs: 0
  readonly property var procs: [statusProc, selfProc, trafficProc, devicesProc, clientsProc, logsProc, clientProc, clientTrafficProc, deviceProc]
  readonly property bool refreshing: procs.some(function(p) { return p.running })

  readonly property string health: Model.overallState(status, stale)
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 60, 15, 3600)
  readonly property bool notifyOnChange: setting("notify", true) !== false
  readonly property string consoleUrl: String(setting("consoleUrl", ""))

  property string _notifiedState: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    return Math.max(min, Math.min(max, n))
  }

  // `force` bypasses unifictl's response cache (manual refresh only).
  function run(proc, args, force) {
    if (proc.running) return
    proc.command = ["unifictl"].concat(args).concat(["-o", "json", "--color", "never"]).concat(force ? ["--refresh"] : [])
    proc.running = true
    watchdog.restart()
  }

  function refresh(force) {
    run(statusProc, ["status"], force === true)
    run(selfProc, ["clients", "list", "--self"], force === true)
    run(trafficProc, ["clients", "traffic"], force === true)
    refreshDetails(force === true)
  }

  function refreshDetails(force) {
    var info = Model.viewInfo(view)
    if (!info) return
    if (info.needs === "devices") run(devicesProc, ["devices", "list"], force)
    else if (info.needs === "clients") run(clientsProc, ["clients", "list"], force)
    else if (info.needs === "logs") run(logsProc, ["logs", "-r", "-p", "high", "-n", String(logLines)], force)
    else if (info.needs === "client") {
      run(clientProc, ["clients", "get", info.clientId], force)
      run(clientTrafficProc, ["clients", "traffic", info.clientId], force)
    }
    else if (info.needs === "device") run(deviceProc, ["devices", "get", info.deviceId], force)
  }

  // While a fetch for one client or device ran, opening another skipped its
  // own fetch: when the finished one was for a different item, fetch again.
  // `proc.command` is ["unifictl", "clients"|"devices", "get"|"traffic", <id>, …].
  function refetchIfOtherItem(proc, needs) {
    var info = Model.viewInfo(view)
    if (info && info.needs === needs && proc.command[3] !== info.id) refreshDetails(false)
  }

  onViewChanged: refreshDetails(false)

  function failed(stderr, fallback) {
    var msg = String(stderr || "").trim()
    lastError = msg !== "" ? msg.split("\n").pop() : fallback
    console.warn("unifictl:", lastError)
  }

  // Tell the user once when things go from fine to broken, and once when
  // they recover. Changes inside the same bad state stay quiet.
  function maybeNotify() {
    var bad = Model.needsAttention(health)
    var previous = _notifiedState
    _notifiedState = bad ? "bad" : (health === "ok" ? "ok" : previous)
    if (!notifyOnChange || previous === "" || previous === _notifiedState) return
    if (_notifiedState === "bad") notify("UniFi", Model.headline(status), "normal")
    else notify("UniFi", "Network is back to normal", "low")
  }

  function notify(title, body, urgency) {
    Quickshell.execDetached(["omarchy-notification-send", "--app-name", "UniFi",
      "-g", Model.ICONS.network, "-u", urgency, title, body])
  }

  function openConsole() {
    if (consoleUrl !== "") Quickshell.execDetached(["omarchy-launch-webapp", consoleUrl])
  }

  function openTerminal(command) {
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation", command])
  }

  function copy(text) {
    var value = String(text || "")
    if (value === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(value) + " | wl-copy"])
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh(false)
  }

  // A controller that accepts the connection and then stalls would otherwise
  // hold a process forever and block every later refresh.
  Timer {
    id: watchdog
    interval: 30000
    onTriggered: {
      for (var p of root.procs) if (p.running) p.running = false
    }
  }

  Process {
    id: statusProc
    stdout: StdioCollector { id: statusOut; waitForEnd: true }
    stderr: StdioCollector { id: statusErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(statusOut.text) : { ok: false, error: "unifictl status exited " + exitCode }
      if (parsed.ok && parsed.value && Array.isArray(parsed.value.rows)) {
        root.status = parsed.value
        root.stale = false
        root.lastError = ""
        root.lastSuccessMs = Date.now()
      } else {
        root.failed(statusErr.text, parsed.error || "unexpected status output")
        if (root.status) root.stale = true
      }
      root.maybeNotify()
    }
  }

  // Optional: this machine may be off-site or unknown to the controller, so a
  // failure only hides the row and never marks the widget stale.
  Process {
    id: selfProc
    stdout: StdioCollector { id: selfOut; waitForEnd: true }
    stderr: StdioCollector { id: selfErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(selfOut.text) : { ok: false }
      root.selfClient = parsed.ok ? parsed.value : null
      if (!parsed.ok) console.warn("unifictl clients list --self:", String(selfErr.text || "").trim())
    }
  }

  Process {
    id: devicesProc
    stdout: StdioCollector { id: devicesOut; waitForEnd: true }
    stderr: StdioCollector { id: devicesErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(devicesOut.text) : { ok: false }
      if (parsed.ok) root.devices = parsed.value
      else root.failed(devicesErr.text, "unifictl devices list failed")
    }
  }

  Process {
    id: clientsProc
    stdout: StdioCollector { id: clientsOut; waitForEnd: true }
    stderr: StdioCollector { id: clientsErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(clientsOut.text) : { ok: false }
      if (parsed.ok) root.clients = parsed.value
      else root.failed(clientsErr.text, "unifictl clients list failed")
    }
  }

  Process {
    id: logsProc
    stdout: StdioCollector { id: logsOut; waitForEnd: true }
    stderr: StdioCollector { id: logsErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseNdjson(logsOut.text) : { ok: false }
      if (parsed.ok) root.logs = parsed.value
      else root.failed(logsErr.text, "unifictl logs failed")
    }
  }

  // Optional, like selfProc: a failure only drops the traffic figure.
  Process {
    id: trafficProc
    stdout: StdioCollector { id: trafficOut; waitForEnd: true }
    stderr: StdioCollector { id: trafficErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(trafficOut.text) : { ok: false }
      root.traffic = parsed.ok ? parsed.value : null
      if (!parsed.ok) console.warn("unifictl clients traffic:", String(trafficErr.text || "").trim())
    }
  }

  Process {
    id: clientProc
    stdout: StdioCollector { id: clientOut; waitForEnd: true }
    stderr: StdioCollector { id: clientErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(clientOut.text) : { ok: false }
      if (parsed.ok) root.client = parsed.value
      else root.failed(clientErr.text, "unifictl clients get failed")
      root.refetchIfOtherItem(clientProc, "client")
    }
  }

  Process {
    id: clientTrafficProc
    stdout: StdioCollector { id: clientTrafficOut; waitForEnd: true }
    stderr: StdioCollector { id: clientTrafficErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(clientTrafficOut.text) : { ok: false }
      if (parsed.ok) root.clientTraffic = parsed.value
      else root.failed(clientTrafficErr.text, "unifictl clients traffic failed")
      root.refetchIfOtherItem(clientTrafficProc, "client")
    }
  }

  Process {
    id: deviceProc
    stdout: StdioCollector { id: deviceOut; waitForEnd: true }
    stderr: StdioCollector { id: deviceErr; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = exitCode === 0 ? Model.parseJson(deviceOut.text) : { ok: false }
      if (parsed.ok) root.device = parsed.value
      else root.failed(deviceErr.text, "unifictl devices get failed")
      root.refetchIfOtherItem(deviceProc, "device")
    }
  }
}
