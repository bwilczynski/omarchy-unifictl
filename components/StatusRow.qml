// Adapted from vcanuel/omarchy-unifi (MIT).
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// One keyboard-and-mouse navigable row: glyph, title over subtitle, an
// optional trailing value, and for leaf rows a copy button (menu of IP, MAC,
// name) and a details button (the client or device view, or `unifictl … get` in a
// terminal). Follows the CursorSurface contract — visuals come
// from `hasCursor`, and hovering reports back to the panel instead of
// painting its own highlight.
CursorSurface {
  id: row

  property var panel: null
  property string sectionId: ""
  property int rowIndex: 0

  property string icon: ""
  property string title: ""
  property string subtitle: ""
  property string trailing: ""
  property bool attention: false
  property bool muted: false
  property string trailingIcon: ""
  // unifictl's health grade for `trailing`: good, fair, poor or "".
  property string grade: ""
  // [{ kind, label, value }] from Model.copyOptions; empty hides the button.
  property var copyOptions: []
  // "view:…" or a terminal command for the details button; "" hides it.
  property string details: ""
  property int copyIndex: 0

  signal activated()
  signal detailsRequested()

  function openCopyMenu() {
    if (copyOptions.length === 0) return
    copyIndex = 0
    copyPopup.open()
  }

  function moveCopyCursor(delta) {
    copyIndex = Math.max(0, Math.min(copyOptions.length - 1, copyIndex + delta))
  }

  function copyOption(index) {
    var option = copyOptions[index]
    copyPopup.close()
    if (option && panel) panel.copyText(option.value)
  }

  readonly property color tone: attention && panel ? panel.urgent : (panel ? panel.foreground : Color.foreground)

  hasCursor: panel ? panel.hasCursor(sectionId, rowIndex) : false
  foreground: panel ? panel.foreground : Color.foreground
  width: parent ? parent.width : implicitWidth
  implicitHeight: Math.max(content.implicitHeight, Style.spacing.popupRowHeight) + Style.spacing.rowPaddingX
  opacity: muted ? 0.55 : 1.0

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onContainsMouseChanged: if (containsMouse && row.panel) row.panel.setCursor(row.sectionId, row.rowIndex)
    onClicked: row.activated()
  }

  RowLayout {
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(10)
    anchors.rightMargin: Style.space(10)
    spacing: Style.space(10)

    Text {
      textFormat: Text.PlainText
      text: row.icon
      color: row.tone
      font.family: row.panel ? row.panel.fontFamily : Style.font.family
      font.pixelSize: Style.font.icon
      Layout.alignment: Qt.AlignVCenter
      Layout.preferredWidth: Style.font.icon + Style.space(4)
    }

    ColumnLayout {
      id: content
      Layout.fillWidth: true
      spacing: Style.space(1)

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        text: row.title
        color: row.tone
        font.family: row.panel ? row.panel.fontFamily : Style.font.family
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        visible: text !== ""
        text: row.subtitle
        color: row.panel ? row.panel.dim : Color.muted
        font.family: row.panel ? row.panel.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

    Text {
      textFormat: Text.PlainText
      visible: row.trailingIcon !== ""
      text: row.trailingIcon
      color: row.panel ? row.panel.foreground : Color.foreground
      font.family: row.panel ? row.panel.fontFamily : Style.font.family
      font.pixelSize: Style.font.icon
      Layout.alignment: Qt.AlignVCenter
    }

    Text {
      textFormat: Text.PlainText
      visible: text !== ""
      text: row.trailing
      color: row.panel ? row.panel.gradeColor(row.grade) : Color.muted
      font.family: row.panel ? row.panel.fontFamily : Style.font.family
      font.pixelSize: Style.font.bodySmall
      Layout.alignment: Qt.AlignVCenter
    }

    PanelActionButton {
      id: copyButton
      visible: row.copyOptions.length > 0
      iconText: Model.ICONS.copy
      tooltipText: "Copy (enter)"
      foreground: row.panel ? row.panel.foreground : Color.foreground
      fontFamily: row.panel ? row.panel.fontFamily : Style.font.family
      Layout.alignment: Qt.AlignVCenter
      onClicked: row.openCopyMenu()
    }

    PanelActionButton {
      visible: row.details !== ""
      iconText: Model.ICONS.details
      tooltipText: row.details.indexOf("view:") === 0 ? "Details (d)" : "Details in terminal (d)"
      foreground: row.panel ? row.panel.foreground : Color.foreground
      fontFamily: row.panel ? row.panel.fontFamily : Style.font.family
      Layout.alignment: Qt.AlignVCenter
      onClicked: row.detailsRequested()
    }
  }

  // A refresh rebuilds the rows, and closing the panel hides them: never
  // leave the panel's keys blocked by a menu that is gone.
  Component.onDestruction: if (copyPopup.opened && panel) {
    panel.copyMenuOpen = false
    panel.restoreKeyFocus()
  }

  Connections {
    target: row.panel
    function onOpenedChanged() { if (row.panel && !row.panel.opened) copyPopup.close() }
  }

  // Tailscale-style copy menu under the copy button: up/down or j/k move,
  // enter or space copies, esc closes.
  Popup {
    id: copyPopup
    parent: copyButton
    x: copyButton.width - width
    y: copyButton.height + Style.space(4)
    width: Style.space(280)
    padding: 0
    // Keep the menu inside the panel window near its bottom edge.
    margins: Style.space(4)
    modal: false
    focus: true
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

    onOpenedChanged: {
      if (row.panel) row.panel.copyMenuOpen = opened
      if (opened) Qt.callLater(function() { copyMenu.forceActiveFocus() })
      else if (row.panel) row.panel.restoreKeyFocus()
    }

    background: BorderSurface {
      color: Color.background
      borderSpec: Border.flat(row.panel ? row.panel.dim : Color.muted, 1)
      radius: Style.cornerRadius
    }

    contentItem: Column {
      id: copyMenu
      focus: true
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) copyPopup.close()
        else if (event.key === Qt.Key_Down || event.text === "j") row.moveCopyCursor(1)
        else if (event.key === Qt.Key_Up || event.text === "k") row.moveCopyCursor(-1)
        else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) row.copyOption(row.copyIndex)
        else return
        event.accepted = true
      }

      Repeater {
        model: row.copyOptions

        CursorSurface {
          id: choice
          required property var modelData
          required property int index
          width: copyMenu.width
          implicitHeight: Style.space(44)
          radius: 0
          foreground: row.foreground
          hasCursor: row.copyIndex === index

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onEntered: row.copyIndex = choice.index
            onClicked: row.copyOption(choice.index)
          }

          RowLayout {
            anchors.fill: parent
            anchors.leftMargin: Style.space(12)
            anchors.rightMargin: Style.space(12)
            spacing: Style.space(10)

            Text {
              textFormat: Text.PlainText
              text: choice.modelData.label
              color: row.panel ? row.panel.dim : Color.muted
              font.family: row.panel ? row.panel.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
              Layout.preferredWidth: Style.space(40)
            }

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: choice.modelData.value
              color: row.foreground
              font.family: row.panel ? row.panel.fontFamily : Style.font.family
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            Text {
              textFormat: Text.PlainText
              text: Model.ICONS.copy
              color: row.foreground
              font.family: row.panel ? row.panel.fontFamily : Style.font.family
              font.pixelSize: Style.font.icon
              Layout.alignment: Qt.AlignVCenter
            }
          }
        }
      }
    }
  }
}
