import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "components"
import "Model.js" as Model

// Bar button plus popup. The main view shows Internet and Site from
// `unifictl status`; Devices / Wi-Fi / Wired / Alarms rows drill down into a
// detail view that loads its own list on demand. A client row (This device,
// Wi-Fi, Wired) opens the client view: `clients get` and its traffic by app.
//
// Mouse: left = popup, middle = force refresh, right = open console URL.
// Keys: up/down move, enter or right drills in (on a leaf row enter opens
// its copy menu), left/esc goes back (esc on the main view closes),
// r refresh, t open in terminal, o console, c/n/m copy IP/name/MAC,
// d details of the selected row (client view, or a terminal), / filter the
// open list.
Panel {
  id: root
  moduleName: "bwilczynski.unifictl"
  ipcTarget: "bwilczynski.unifictl"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Grade colours mirror unifictl's tables: green, yellow, red from the
  // theme. A theme without them leaves good dim, fair plain, poor urgent.
  property var grades: Model.gradeColors("")
  function gradeColor(grade) {
    if (grade === "good") return grades.good !== "" ? grades.good : dim
    if (grade === "fair") return grades.fair !== "" ? grades.fair : foreground
    if (grade === "poor") return grades.poor !== "" ? grades.poor : urgent
    return dim
  }

  FileView {
    id: themeColors
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.grades = Model.gradeColors(text())
  }

  // A theme switch swaps the theme directory under the watcher; Color
  // repaints when it happens, so reread then too.
  readonly property string themeKey: String(Color.foreground) + String(Color.urgent) + String(Color.accent)
  onThemeKeyChanged: themeColors.reload()

  readonly property var status: service.status
  readonly property string health: service.health
  readonly property int maxClients: Math.max(1, parseInt(setting("maxClients", 10), 10) || 10)
  readonly property string barLabelMode: String(setting("barLabel", "none"))

  // "" = main view; otherwise a key of Model.VIEWS, or "client:<id>".
  property string view: ""
  readonly property var viewInfo: Model.viewInfo(view)
  readonly property bool clientView: Model.isClientView(view)
  // The client view's `clients get`, once it is for the client on screen.
  readonly property var viewClient: clientView && service.client && viewInfo && service.client.id === viewInfo.clientId ? service.client : null
  readonly property bool detailLoaded: !viewInfo || (viewInfo.needs === "devices" ? service.devices !== null
    : viewInfo.needs === "clients" ? service.clients !== null
    : viewInfo.needs === "client" ? Model.clientTraffic(service.clientTraffic, viewInfo.clientId) !== null
    : service.logs !== null)
  // Where back from the client view lands: the list, row and filter it was
  // opened from. { view, section, index, filter }
  property var returnTo: null

  property bool cursorActive: false
  property string cursorSection: ""
  property int cursorIndex: 0
  property string filterText: ""
  property bool filtering: false
  // A row's copy menu has the keyboard while open.
  property bool copyMenuOpen: false
  property string flash: ""
  property double nowMs: Date.now()

  // ---- keyboard cursor (contract used by components/StatusRow.qml) --------

  function hasCursor(sectionId, index) {
    return cursorActive && cursorSection === sectionId && cursorIndex === index
  }

  function setCursor(sectionId, index) {
    cursorActive = true
    cursorSection = sectionId
    cursorIndex = index
  }

  function navigableSections() {
    var all = view === "" ? [wanSection, selfSection, summarySection]
      : clientView ? [clientSection, detailSection] : [detailSection]
    return all.filter(function(s) { return s.available })
  }

  function currentSection() {
    var list = navigableSections()
    for (var i = 0; i < list.length; i++) if (list[i].sectionId === cursorSection) return list[i]
    return null
  }

  function moveCursor(dy) {
    var list = navigableSections()
    if (list.length === 0) return
    var at = -1
    for (var i = 0; i < list.length; i++) if (list[i].sectionId === cursorSection) at = i
    if (!cursorActive || at === -1) {
      setCursor(list[0].sectionId, 0)
    } else {
      var next = cursorIndex + dy
      if (next < 0) {
        if (at > 0) setCursor(list[at - 1].sectionId, list[at - 1].rowCount - 1)
      } else if (next >= list[at].rowCount) {
        if (at < list.length - 1) setCursor(list[at + 1].sectionId, 0)
      } else {
        cursorIndex = next
      }
    }
    scrollCursorIntoView()
  }

  function clampCursor() {
    if (!cursorActive) return
    var section = currentSection()
    if (!section) { cursorActive = false; return }
    cursorIndex = Math.max(0, Math.min(cursorIndex, section.rowCount - 1))
  }

  function scrollCursorIntoView() {
    var section = currentSection()
    var item = section ? section.rowItem(cursorIndex) : null
    if (!item) return
    Qt.callLater(function() {
      var margin = Style.space(6)
      var top = item.mapToItem(flick.contentItem, 0, 0).y
      var bottom = top + item.height
      var maxY = Math.max(0, flick.contentHeight - flick.height)
      if (top < flick.contentY + margin) flick.contentY = Math.max(0, top - margin)
      else if (bottom > flick.contentY + flick.height - margin) flick.contentY = Math.min(maxY, bottom + margin - flick.height)
    })
  }

  // ---- actions --------------------------------------------------------------

  function activateCursor() {
    var section = currentSection()
    if (section) section.activate(cursorIndex)
  }

  function copySelected(kind) {
    var section = currentSection()
    if (section) copyFromRow(section, cursorIndex, kind)
  }

  function copyFromRow(section, index, kind) {
    copyText(section.copyValue(index, kind))
  }

  function copyText(value) {
    if (value === "") return
    service.copy(value)
    showFlash("Copied " + value)
  }

  function detailsSelected() {
    var section = currentSection()
    if (section) openDetails(section.detailsCommand(cursorIndex))
  }

  // A row's details: "view:client:<id>" opens the client view, anything
  // else is `unifictl … get <id>` for a floating terminal.
  function openDetails(command) {
    if (command.indexOf("view:") === 0) runAction(command)
    else if (command !== "") runAction("term:" + command)
  }

  function restoreKeyFocus() {
    if (opened) Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function setView(next) {
    var from = view
    var here = { view: from, section: cursorSection, index: cursorIndex, filter: filterText }
    if (filtering) stopFilter(false)
    filterText = ""
    if (!Model.isClientView(next)) returnTo = null
    else if (!Model.isClientView(from)) returnTo = here
    view = next
    flick.contentY = 0
    if (!cursorActive) return
    if (next !== "") {
      setCursor(Model.isClientView(next) ? "client" : "detail", 0)
    } else {
      // Land back on the row we drilled in from.
      var rows = summarySection.rows
      for (var i = 0; i < rows.length; i++) if (rows[i].action === "view:" + from) { setCursor("summary", i); return }
      setCursor("summary", 0)
    }
  }

  function back() {
    if (view === "") return
    var to = clientView ? returnTo : null
    setView(to ? to.view : "")
    if (!to) return
    filterText = to.filter
    if (cursorActive) {
      setCursor(to.section, to.index)
      Qt.callLater(function() { root.clampCursor(); root.scrollCursorIntoView() })
    }
  }

  // Right arrow: drill into the row under the cursor, if it is drillable.
  function drillCursor() {
    var section = currentSection()
    var r = section ? section.row(cursorIndex) : null
    if (r && String(r.action || "").indexOf("view:") === 0) section.activate(cursorIndex)
  }

  function openInTerminal() {
    runAction("term:" + (viewInfo ? viewInfo.terminal : "unifictl topology"))
  }

  function runAction(action) {
    if (action.indexOf("view:") === 0) {
      setView(action.slice(5))
    } else if (action.indexOf("term:") === 0) {
      service.openTerminal(action.slice(5))
      close()
    } else if (action === "console") {
      service.openConsole()
    }
  }

  function startFilter() {
    filtering = true
    flick.contentY = 0
    Qt.callLater(function() { filterField.forceActiveFocus(); filterField.selectAll() })
  }

  function stopFilter(keep) {
    filtering = false
    if (!keep) filterText = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function showFlash(text) {
    flash = text
    flashTimer.restart()
  }

  function handlePress(buttonCode) {
    if (buttonCode === Qt.RightButton) service.openConsole()
    else if (buttonCode === Qt.MiddleButton) service.refresh(true)
    else toggle()
  }

  // ---- wiring ---------------------------------------------------------------

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    nowMs = Date.now()
    flick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  } else {
    if (filtering) stopFilter(false)
    view = ""
    filterText = ""
    returnTo = null
  }

  Service {
    id: service
    settings: root.settings
    view: root.opened ? root.view : ""
    logLines: root.maxClients
    onStatusChanged: Qt.callLater(root.clampCursor)
    onSelfClientChanged: Qt.callLater(root.clampCursor)
    onDevicesChanged: Qt.callLater(root.clampCursor)
    onClientsChanged: Qt.callLater(root.clampCursor)
    onLogsChanged: Qt.callLater(root.clampCursor)
    onClientChanged: Qt.callLater(root.clampCursor)
    onClientTrafficChanged: Qt.callLater(root.clampCursor)
  }

  Timer {
    id: flashTimer
    interval: 1800
    onTriggered: root.flash = ""
  }

  Timer {
    interval: 10000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { service.refresh(true); return "ok" }
    function health(): string { return root.health }
    function status(): string { return JSON.stringify(service.status) }
    function error(): string { return service.lastError }
    function view(name: string): string {
      if (name !== "" && !Model.viewInfo(name)) return "unknown view: " + name
      root.open()
      root.setView(name)
      return "ok"
    }
    function currentView(): string { return root.view }
    function rowCount(): int {
      if (root.view === "") return wanSection.rowCount + selfSection.rowCount + summarySection.rowCount
      return (root.clientView ? clientSection.rowCount : 0) + detailSection.rowCount
    }
  }

  // ---- bar button -------------------------------------------------------------

  readonly property string barText: Model.barLabel(status, barLabelMode)
  readonly property color barTone: Model.needsAttention(health) ? urgent
    : (health === "stale" || health === "loading" ? Qt.darker(barForeground, 1.55) : barForeground)
  readonly property Item button: barText === "" ? iconButton : textButton

  BarIconButton {
    id: iconButton
    anchors.fill: parent
    visible: root.barText === ""
    bar: root.bar
    text: Model.barIcon(root.health)
    foreground: root.barTone
    tooltipText: root.opened ? "" : Model.tooltip(root.status, root.health)
    onPressed: function(buttonCode) { root.handlePress(buttonCode) }
  }

  WidgetButton {
    id: textButton
    anchors.fill: parent
    visible: root.barText !== ""
    bar: root.bar
    text: Model.barIcon(root.health) + " " + root.barText
    foreground: root.barTone
    tooltipText: root.opened ? "" : Model.tooltip(root.status, root.health)
    onPressed: function(buttonCode) { root.handlePress(buttonCode) }
  }

  // ---- popup ------------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.filtering || root.copyMenuOpen
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
        else if (dx < 0) root.back()
        else if (dx > 0) root.drillCursor()
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.view !== "" ? root.back() : root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var key = t.toLowerCase()
        if (key === "r") service.refresh(true)
        else if (key === "o") service.openConsole()
        else if (key === "t") root.openInTerminal()
        else if (key === "c") root.copySelected("ip")
        else if (key === "n") root.copySelected("name")
        else if (key === "m") root.copySelected("mac")
        else if (key === "d") root.detailsSelected()
        else if (t === "/" && root.view !== "") root.startFilter()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
          spacing: Style.space(12)

          PanelHero {
            visible: root.view === ""
            width: parent.width
            title: Model.controllerName(root.status)
            meta: root.status ? Model.headline(root.status) : (service.lastError || "Loading…")
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.health === "stale" || root.health === "loading" ? 0.5 : 1.0
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: Model.barIcon(root.health)
                color: Model.needsAttention(root.health) ? root.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              Row {
                spacing: Style.space(4)
                PanelActionButton {
                  iconText: Model.ICONS.refresh
                  tooltipText: service.refreshing ? "Refreshing…" : "Refresh (r)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  opacity: service.refreshing ? 0.5 : 1.0
                  onClicked: service.refresh(true)
                }
                PanelActionButton {
                  iconText: Model.ICONS.topology
                  tooltipText: "Topology in terminal (t)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.openInTerminal()
                }
                PanelActionButton {
                  visible: service.consoleUrl !== ""
                  iconText: Model.ICONS.open
                  tooltipText: "Open UniFi console (o)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: service.openConsole()
                }
              }
            }
          }

          Section {
            id: wanSection
            visible: root.view === "" && available
            panel: root
            sectionId: "wan"
            heading: "INTERNET"
            rows: Model.wanRows(root.status)
          }

          Section {
            id: selfSection
            visible: root.view === "" && available
            panel: root
            sectionId: "self"
            heading: "THIS DEVICE"
            rows: Model.selfRows(service.selfClient, service.traffic)
          }

          Section {
            id: summarySection
            visible: root.view === "" && available
            panel: root
            sectionId: "summary"
            heading: "SITE"
            rows: Model.summaryRows(root.status)
          }

          // Detail header: back, title, refresh, open in terminal.
          Item {
            visible: root.view !== ""
            width: parent.width
            implicitHeight: headerRow.implicitHeight

            Row {
              id: headerRow
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              PanelActionButton {
                iconText: Model.ICONS.back
                tooltipText: "Back (esc / ←)"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.back()
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: root.viewClient ? (root.viewClient.name || root.viewClient.mac || "Client")
                  : (root.viewInfo ? root.viewInfo.title : "")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }
            }

            Row {
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(4)

              PanelActionButton {
                iconText: Model.ICONS.refresh
                tooltipText: service.refreshing ? "Refreshing…" : "Refresh (r)"
                foreground: root.foreground
                fontFamily: root.fontFamily
                opacity: service.refreshing ? 0.5 : 1.0
                onClicked: service.refresh(true)
              }

              PanelActionButton {
                iconText: Model.ICONS.open
                tooltipText: "Open in terminal (t)"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.openInTerminal()
              }
            }
          }

          // Client view: addresses, link and current rate from `clients get`.
          Section {
            id: clientSection
            visible: root.clientView && available
            panel: root
            sectionId: "client"
            heading: root.viewClient ? Model.join([root.viewClient.connectionType, root.viewClient.status]).toUpperCase() : ""
            rows: root.clientView ? Model.clientInfoRows(root.viewClient) : []
          }

          // Top of the list, so it stays on screen however long the list is.
          TextField {
            id: filterField
            visible: root.filtering
            width: parent.width
            foreground: root.foreground
            placeholderText: root.viewInfo ? root.viewInfo.filterHint : ""
            text: root.filterText
            onTextChanged: root.filterText = text
            onAccepted: root.stopFilter(true)
            Keys.onEscapePressed: root.stopFilter(false)
          }

          Section {
            id: detailSection
            visible: root.view !== "" && available
            panel: root
            sectionId: "detail"
            heading: root.filterText !== "" ? "FILTER · \"" + root.filterText + "\""
              : root.clientView ? Model.trafficHeading(service.clientTraffic, root.viewInfo.clientId)
              : (root.viewInfo ? root.viewInfo.heading : "")
            rows: root.view === "" ? [] : Model.detailRows(root.view,
              { devices: service.devices, clients: service.clients, logs: service.logs, clientTraffic: service.clientTraffic },
              root.maxClients, root.filterText)
          }

          Text {
            visible: root.view !== "" && !detailSection.available
            width: parent.width
            textFormat: Text.PlainText
            text: !root.detailLoaded ? "Loading…" : root.filterText !== "" ? "No matches"
              : root.clientView ? "No internet traffic in the last 24h" : "Nothing to show"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: {
              if (root.flash !== "") return root.flash
              if (service.lastError !== "") return service.lastError
              return service.lastSuccessMs > 0 ? "updated " + Model.formatAge(service.lastSuccessMs, root.nowMs) : ""
            }
            visible: text !== ""
            color: service.lastError !== "" && root.flash === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignRight
            elide: Text.ElideLeft
          }
        }
      }
    }
  }
}
