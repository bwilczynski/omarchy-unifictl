const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")

const available = spawnSync("quickshell", ["--version"]).status === 0

// Catch clipboard payloads leaking through argv, truncation, and shell expansion.
test("copy sends exact clipboard text through stdin without exposing it in argv", { skip: !available }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unifictl-clipboard-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const name of ["Service.qml", "Model.js"]) {
    fs.copyFileSync(path.join(__dirname, "..", name), path.join(dir, name))
  }
  const payload = "private controller alarm: 'quoted' \"text\" $(false) `false` \\\nZażółć 🛜\n"
  fs.mkdirSync(path.join(dir, "bin"))
  fs.mkdirSync(path.join(dir, "runtime"), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, "bin", "unifictl"), "#!/bin/sh\nexit 127\n", { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "bin", "wl-copy"), `#!/usr/bin/python3
import json, os, pathlib, sys
result = pathlib.Path(os.environ["COPY_TEST_RESULT"])
commands = []
pid = os.getpid()
while pid > 1:
    commands.append(pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().decode().split("\\0"))
    pid = int(pathlib.Path(f"/proc/{pid}/status").read_text().split("PPid:")[1].split()[0])
text = sys.stdin.read()
result.write_text(json.dumps({"text": text, "commands": commands}))
`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "shell.qml"), `import QtQuick
import Quickshell
ShellRoot {
  Service { id: service }
  Timer {
    interval: 50; running: true
    onTriggered: service.copy(${JSON.stringify(payload)})
  }
}
`)
  const resultFile = path.join(dir, "result.json")
  const child = spawn("quickshell", ["--no-color", "-p", path.join(dir, "shell.qml")], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QPA_PLATFORMTHEME: "", XDG_RUNTIME_DIR: path.join(dir, "runtime"),
      PATH: path.join(dir, "bin") + ":" + process.env.PATH, COPY_TEST_RESULT: resultFile },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  child.stdout.on("data", (data) => { output += data })
  child.stderr.on("data", (data) => { output += data })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise((resolve) => child.once("close", resolve))
    }
  })
  const deadline = Date.now() + 5000
  while (!fs.existsSync(resultFile) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(fs.existsSync(resultFile), "clipboard process did not finish:\n" + output)
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"))
  assert.equal(result.text, payload)
  assert.ok(result.commands.every((args) => args.every((arg) => !arg.includes("private controller alarm"))),
    "clipboard text appeared in process arguments")
})
