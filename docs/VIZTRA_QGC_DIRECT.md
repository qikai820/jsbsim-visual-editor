# H7_USB Viztra direct UDP output to QGroundControl

The simulator sends QGC's 64-byte Viztra target frame directly over Ethernet.
The Visual Editor relay is not part of this connection.

Configure the H7_USB model with an output of type VIZTRA_UDP_QGC,
host 192.168.3.109, port 1480, and rate 3 Hz. Its three XML
properties, in order, are:

1. px4/viztra/relative-n-m
2. px4/viztra/relative-e-m
3. px4/viztra/relative-d-m

The simulator combines the relative NED position with the aircraft's current
latitude, longitude and MSL altitude. It derives ground speed and heading from
successive target positions and sends the 64-byte frame defined by QGC's
Viztra receiver. The older VIZTRA_UDP_JSON type remains available for JSON
consumers.

In QGC, set Viztra Listen IP to 0.0.0.0 and Listen port to 1480. The
Current sender field should show the simulator's Ethernet address
192.168.3.82 while H7_USB is running. The Target switch and a MAVLink 2
vehicle connection are separately required to forward the received target to
PX4.

After changing the XML or simulator firmware, reload H7_USB while disarmed.
