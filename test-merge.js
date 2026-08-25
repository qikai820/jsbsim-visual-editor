// Test XML merge functionality
var parser = require("./server/xmlParser");

// Use String.fromCharCode to build XML without shell issues
var lt = "<";
var gt = ">";
var slash = "/";

function tag(name, content, attrs) {
  var a = attrs ? " " + attrs : "";
  if (content === undefined) return lt + name + a + slash + gt;
  return lt + name + a + gt + content + lt + slash + name + gt;
}

// Main XML: references SensorImu.xml
var mainXml = tag("fdm_config",
  tag("system", null, 'file="SensorImu.xml"'),
  'name="Test" version="2.0"'
);

// Referenced system file
var subXml = tag("system",
  tag("property", "sensor/imu/accel-x") +
  tag("property", "sensor/imu/accel-y") +
  tag("channel",
    tag("function",
      tag("product", tag("property", "sensor/imu/accel-x") + tag("value", "0.98")),
      'name="sensor/imu/filtered"'
    ) +
    tag("kinematic",
      tag("input", "fcs/aileron-cmd-norm") +
      tag("output", "fcs/aileron-pos-rad"),
      'name="Roll Control"'
    ),
    'name="IMU"'
  ),
  'name="Sensor/IMU"'
);

var fileMap = {
  "SensorImu.xml": subXml
};

try {
  var result = parser.parseXml(mainXml, fileMap);
  console.log("Aircraft:", result.aircraft.name);
  console.log("Nodes:", result.nodes.length);
  for (var i = 0; i < result.nodes.length; i++) {
    var n = result.nodes[i];
    var p = n.data.params;
    console.log("  [" + n.data.componentType + "] " + n.data.label);
    if (p.name) console.log("    name: " + p.name);
    if (p.properties) console.log("    properties: " + p.properties);
    if (p.channels) console.log("    channels: " + p.channels);
  }
  console.log("\n✅ Merge successful");
} catch (e) {
  console.error("❌ Error:", e.message);
}
