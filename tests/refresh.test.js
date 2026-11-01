const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const available = spawnSync("quickshell", ["--version"]).status === 0

// Run the actual service; replace only the external controller/credential CLI.
// Each status waits long enough for a view change and repeated refresh attempt.
async function scenario(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unifictl-refresh-"))
  for (const name of ["Service.qml", "Model.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", name), path.join(dir, name))
  }
  fs.mkdirSync(path.join(dir, "bin"))
  fs.mkdirSync(path.join(dir, "runtime"), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "bin", "unifictl"), `#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ["REFRESH_TEST_DIR"])
args = sys.argv[1:]
if args == ["--version"]:
    print("unifictl 0.4.4")
    sys.exit(0)
def record(event):
    with (root / "calls").open("a") as f:
        f.write(json.dumps({"event": event, "args": args}) + "\\n")
record("start")
if args[0] == "status":
    countfile = root / "count"
    count = int(countfile.read_text()) + 1 if countfile.exists() else 1
    countfile.write_text(str(count))
    time.sleep(0.25)
    mode = os.environ["REFRESH_TEST_MODE"]
    fail = mode == "failure" or (mode == "stale" and count == 2) or (mode == "recovery" and count == 1)
    record("failed" if fail else "success")
    if fail:
        print("no config file; run unifictl config init" if mode == "recovery" else "authentication cancelled", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"rows": [], "sample": count}))
else:
    print("{}")
`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "shell.qml"), `import QtQuick
import Quickshell
ShellRoot {
  property int phase: 0
  property int ticks: 0
  property int idleTicks: 0
  property bool attempted: false
  Service { id: service; settings: ({ notify: false }) }
  Timer {
    interval: 20; repeat: true; running: true
    onTriggered: {
      ticks++
      if (service.setup === "checking") return
      if (service.refreshing) {
        idleTicks = 0
        if (!attempted) {
          attempted = true
          service.view = "devices"
          service.refresh(true)
        }
        return
      }
      if (service.status === null && service.lastError === "") return
      // Observe a settled cycle, not the gap between probe exit and its
      // deferred refresh, or a process exit and follow-up startup.
      if (++idleTicks < 3) return
      if (phase === 0 && ${JSON.stringify(mode)} !== "failure") {
        phase = 1
        idleTicks = 0
        attempted = false
        service.refresh(true)
        return
      }
      // A failed status must also block view-triggered requests after exit.
      service.view = "wifi"
      if (phase < 2) { phase = 2; ticks = 0; return }
      if (ticks < 5 || service.refreshing) return
      console.log("RESULT:" + JSON.stringify({
        status: service.status, stale: service.stale, setup: service.setup,
        error: service.lastError
      }))
      Qt.quit()
    }
  }
}
`)
  const child = spawn("quickshell", ["--no-color", "-p", path.join(dir, "shell.qml")], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QPA_PLATFORMTHEME: "",
      XDG_RUNTIME_DIR: path.join(dir, "runtime"), PATH: path.join(dir, "bin") + ":" + process.env.PATH,
      REFRESH_TEST_DIR: dir, REFRESH_TEST_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const closed = new Promise(resolve => child.once("close", resolve))
  const timeout = setTimeout(() => child.kill(), 5000)
  t.after(async () => {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await closed
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await closed
  const match = output.match(/RESULT:(\{.*\})/)
  assert.ok(match, "service did not complete scenario:\n" + output)
  return { state: JSON.parse(match[1]), calls: fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse) }
}

function assertStatusFirst(calls) {
  let pending = false
  for (const call of calls) {
    if (call.args[0] === "status") {
      if (call.event === "start") {
        assert.equal(pending, false, "overlapping status requests")
        pending = true
      } else pending = false
    } else assert.equal(pending, false, "detail or secondary request started before status finished")
  }
}

test("refresh waits for status and preserves force on follow-up requests", { skip: !available }, async t => {
  const { calls, state } = await scenario(t, "success")
  assertStatusFirst(calls)
  const statuses = calls.filter(c => c.event === "start" && c.args[0] === "status")
  assert.equal(statuses.length, 2)
  assert.ok(statuses[1].args.includes("--refresh"))
  const completed = calls.findLastIndex(c => c.event === "success")
  const followups = calls.slice(completed + 1).filter(c => c.args.includes("--refresh"))
  assert.ok(followups.some(c => c.args.slice(0, 3).join(" ") === "clients list --self"))
  assert.ok(followups.some(c => c.args.slice(0, 2).join(" ") === "clients traffic"))
  assert.ok(followups.some(c => c.args.slice(0, 2).join(" ") === "devices list"))
  assert.equal(state.stale, false)
})

test("failed or cancelled status starts no secondary or view requests", { skip: !available }, async t => {
  const { calls, state } = await scenario(t, "failure")
  assert.deepEqual(calls.map(c => [c.event, c.args[0]]), [["start", "status"], ["failed", "status"]])
  assert.match(state.error, /authentication cancelled/)
})

test("failed refresh retains last good status and stops the cycle", { skip: !available }, async t => {
  const { calls, state } = await scenario(t, "stale")
  assertStatusFirst(calls)
  assert.equal(state.status.sample, 1)
  assert.equal(state.stale, true)
  const failed = calls.findIndex(c => c.event === "failed")
  assert.equal(failed, calls.length - 1)
})

test("successful retry after missing configuration runs one status then follow-ups", { skip: !available }, async t => {
  const { calls, state } = await scenario(t, "recovery")
  assertStatusFirst(calls)
  assert.equal(calls.filter(c => c.event === "start" && c.args[0] === "status").length, 2)
  assert.equal(state.setup, "ok")
  assert.ok(calls.some(c => c.args.slice(0, 3).join(" ") === "clients list --self"))
})
