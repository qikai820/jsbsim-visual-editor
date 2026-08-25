#!/usr/bin/env python3
"""
Mock JSBSim telemetry sender - JSBSim property path format.
Sends JSON with flat property paths (like /position/h-sl-ft) to UDP 5801.
"""

import json
import math
import socket
import time

UDP_HOST = "127.0.0.1"
UDP_PORT = 5801
RATE_HZ = 50

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

t0 = time.time()
frame = 0

while True:
    t = time.time() - t0
    frame += 1

    # JSBSim property path format
    telemetry = {
        "t": round(t, 3),
        "frame": frame,

        # Position properties
        "/position/h-sl-ft": 10.0 + 0.5 * math.sin(t * 0.3),
        "/position/lat-gc-deg": 30.0 + 0.0001 * math.sin(t * 0.1),
        "/position/long-gc-deg": 120.0 + 0.0001 * math.cos(t * 0.1),
        "/position/h-agl-ft": 10.0 + 0.5 * math.sin(t * 0.3),

        # Attitude properties
        "/attitude/phi-deg": 2.0 * math.sin(t * 0.5),
        "/attitude/theta-deg": 1.5 * math.sin(t * 0.7),
        "/attitude/psi-deg": 10.0 * math.sin(t * 0.2),
        "/attitude/roll-rad": 0.035 * math.sin(t * 0.5),
        "/attitude/pitch-rad": 0.026 * math.sin(t * 0.7),
        "/attitude/heading-rad": 0.175 * math.sin(t * 0.2),

        # Velocities
        "/velocities/u-fps": 0.5 * math.sin(t * 0.3),
        "/velocities/v-fps": 0.3 * math.cos(t * 0.4),
        "/velocities/w-fps": 0.2 * math.sin(t * 0.6),
        "/velocities/v-north-fps": 0.5 * math.sin(t * 0.3),
        "/velocities/v-east-fps": 0.3 * math.cos(t * 0.4),
        "/velocities/v-down-fps": -0.2 * math.sin(t * 0.6),
        "/velocities/vc-fps": 0.6 * math.sin(t * 0.25),
        "/velocities/mach": 0.0005 * math.sin(t * 0.25),

        # Angular rates
        "/velocities/p-rad_sec": 0.087 * math.sin(t * 1.2),
        "/velocities/q-rad_sec": 0.052 * math.cos(t * 1.5),
        "/velocities/r-rad_sec": 0.14 * math.sin(t * 0.8),

        # Accelerations
        "/accelerations/udot-ft_sec2": 0.1 * math.sin(t * 2.0),
        "/accelerations/vdot-ft_sec2": 0.08 * math.cos(t * 2.5),
        "/accelerations/wdot-ft_sec2": 0.5 * math.sin(t * 1.0),

        # Aerodynamics
        "/aero/alpha-deg": 2.0 + 0.5 * math.sin(t * 0.3),
        "/aero/beta-deg": 0.5 * math.sin(t * 0.4),
        "/aero/qbar-psf": 5.0 + 0.5 * math.sin(t * 0.25),
        "/aero/cl-squared": 0.09 + 0.02 * math.sin(t * 0.5),
        "/aero/cd": 0.05 + 0.005 * math.sin(t * 0.7),

        # Controls
        "/fcs/throttle-cmd-norm": 0.52 + 0.02 * math.sin(t * 1.0),
        "/fcs/elevator-cmd-norm": 0.03 * math.cos(t * 1.0),
        "/fcs/aileron-cmd-norm": 0.05 * math.sin(t * 0.8),
        "/fcs/rudder-cmd-norm": 0.04 * math.sin(t * 0.6),

        # Motor RPMs (F450 has 4 motors)
        "/propulsion/engine[0]/propeller/rpm": 5200 + 100 * math.sin(t * 1.0),
        "/propulsion/engine[1]/propeller/rpm": 5150 + 80 * math.cos(t * 1.2),
        "/propulsion/engine[2]/propeller/rpm": 5180 + 90 * math.sin(t * 0.9),
        "/propulsion/engine[3]/propeller/rpm": 5220 + 110 * math.cos(t * 1.1),

        # Thrust
        "/propulsion/engine[0]/thrust-lbs": 1.2 + 0.1 * math.sin(t * 1.0),
        "/propulsion/engine[1]/thrust-lbs": 1.18 + 0.08 * math.cos(t * 1.2),
        "/propulsion/engine[2]/thrust-lbs": 1.19 + 0.09 * math.sin(t * 0.9),
        "/propulsion/engine[3]/thrust-lbs": 1.21 + 0.11 * math.cos(t * 1.1),
        "/propulsion/total-thrust-lbs": 4.78 + 0.38 * math.sin(t * 0.5),

        # Fuel
        "/propulsion/fuel-lbs": 5.0 - 0.001 * t,

        # Wind
        "/wind/north-fps": 2.0 + 0.5 * math.sin(t * 0.1),
        "/wind/east-fps": 1.0 + 0.3 * math.cos(t * 0.15),
        "/wind/downdraft-fps": 0.0,

        # Simulation
        "/simulation/sim-time-sec": t,
        "/simulation/dt": 0.01,
    }

    data = json.dumps(telemetry).encode("utf-8")
    sock.sendto(data, (UDP_HOST, UDP_PORT))

    if frame % (RATE_HZ * 5) == 0:
        print(f"[telemetry] t={t:.1f}s frame={frame} alt={telemetry['/position/h-sl-ft']:.1f}ft")

    time.sleep(1.0 / RATE_HZ)
