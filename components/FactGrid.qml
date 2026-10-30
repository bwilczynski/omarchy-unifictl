import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// The facts of a client or device view as a label/value grid, laid out like
// Omarchy's network panel: four columns, dim labels, right-aligned values.
// Values coloured by grade; a copyable value copies itself on click.
GridLayout {
  id: grid

  property var panel: null
  // [{ label, value, grade, attention, copy, wide }] from Model.clientFacts / deviceFacts.
  property var facts: []

  readonly property color foreground: panel ? panel.foreground : Color.foreground
  readonly property string fontFamily: panel ? panel.fontFamily : Style.font.family

  visible: facts.length > 0
  width: parent ? parent.width : implicitWidth
  columns: 4
  columnSpacing: Style.space(20)
  rowSpacing: Style.spacing.labelGap

  Repeater {
    model: Model.factCells(grid.facts)

    Text {
      id: cell
      required property var modelData
      readonly property var fact: modelData.fact

      Layout.columnSpan: modelData.span
      Layout.fillWidth: !modelData.label
      Layout.maximumWidth: modelData.label ? implicitWidth : -1
      horizontalAlignment: modelData.label ? Text.AlignLeft : Text.AlignRight
      textFormat: Text.PlainText
      text: modelData.text
      elide: Text.ElideRight
      font.family: grid.fontFamily
      font.pixelSize: Style.font.bodySmall
      opacity: modelData.label ? 0.6 : 1.0
      color: !fact ? grid.foreground
        : fact.attention && grid.panel ? grid.panel.urgent
        : fact.grade !== "" && grid.panel ? grid.panel.gradeColor(fact.grade)
        : grid.foreground

      MouseArea {
        id: copyMouse
        anchors.fill: parent
        enabled: !!cell.fact && cell.fact.copy
        hoverEnabled: enabled
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: if (grid.panel) grid.panel.copyText(cell.text)
      }

      PanelToolTip {
        visible: copyMouse.enabled && copyMouse.containsMouse
        text: cell.fact ? "Copy " + cell.fact.label : ""
        fontFamily: grid.fontFamily
      }
    }
  }
}
