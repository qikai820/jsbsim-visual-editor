#!/usr/bin/env python3
"""Prepare a reviewable PX4 overlay/patch. Never writes the PX4 checkout or board."""
import difflib
from pathlib import Path
import sys
import subprocess

root = Path(__file__).resolve().parents[1]
px4 = Path(sys.argv[1] if len(sys.argv)>1 else root.parent/'PX4-Autopilot').resolve()
out = root/'firmware/px4-vector-hil'
overlay = out/'overlay'
changes = {}
def baseline(name):
    return subprocess.check_output(['git','show','73a4d3d36e:'+name],cwd=px4,text=True)

def edit(name, replacements):
    original = baseline(name)
    text = original
    for old,new in replacements:
        if text.count(old)!=1: raise RuntimeError(f'Expected one match: {name}: {old[:90]}')
        text=text.replace(old,new,1)
    changes[name]=(original,text)

helper='''#pragma once
#include <lib/matrix/matrix/math.hpp>
#include <cmath>

namespace vector_control {
// Explicit HIL-only interface; production RC and non-HIL flight retain their mapping.
inline bool hilManualInterface(bool enabled, bool hil, bool reference, int airframe)
{
    return enabled && hil && reference && airframe == 16;
}
inline bool hilManualSample(bool interface, int source, bool valid, bool armed, bool airborne)
{
    return interface && source >= 2 && source <= 7 && valid && armed && airborne;
}
inline float hilManualAngle(float normalized, float limit_degrees)
{
    if (!std::isfinite(normalized)) { return 0.f; }
    const float demand = normalized < -1.f ? -1.f : normalized > 1.f ? 1.f : normalized;
    const float degrees = demand * 120.f;
    const float bounded = degrees < -limit_degrees ? -limit_degrees : degrees > limit_degrees ? limit_degrees : degrees;
    return bounded * 0.017453292519943295f;
}
inline matrix::Quatf hilManualAttitude(float roll, float pitch, float heading, float limit_degrees)
{
    return matrix::Quatf(matrix::Eulerf(0.f,0.f,heading))
        * matrix::Quatf(matrix::Eulerf(hilManualAngle(roll,limit_degrees),0.f,0.f))
        * matrix::Quatf(matrix::Eulerf(0.f,hilManualAngle(pitch,limit_degrees),0.f));
}
inline matrix::Vector3f hilManualThrust(const matrix::Quatf &q, float collective)
{
    // Full-vector vehicle: manual throttle controls NED vertical force while
    // AUX controls attitude. Motor allocation and feedback stay in vector_*.
    return matrix::Dcmf(q).transpose() * matrix::Vector3f(0.f,0.f,-collective);
}
}
'''
changes['src/lib/vector_control/VectorHilManual.hpp']=('',helper)
param='''
/**
 * MorphQuad HIL manual attitude test interface
 *
 * Only active with vehicle_status HIL_STATE_ON, CA_AIRFRAME=16 and VEC_REF_EN.
 * MAVLink MANUAL_CONTROL AUX1/AUX2 request roll/pitch: +/-1 maps to +/-120 deg.
 * Manual/Stabilized and Altitude are bounded to +/-45 deg; Position to +/-120.
 * Manual throttle controls vertical NED force for the full-vector vehicle.
 * No effect on non-HIL flight. Disabled by default.
 * @boolean
 * @group Vector Position Control
 */
PARAM_DEFINE_INT32(VEC_HIL_TEST, 0);
'''
name='src/modules/vector_pos_control/vector_geometry_params.c'
original=baseline(name);changes[name]=(original,original+param)
edit('src/modules/vector_att_control/vector_att_control.hpp',[
 ('bool _reference_enabled{false};','bool _hil_test_enabled{false};\n\tbool _hil_state{false};\n\tbool _reference_enabled{false};'),
])
edit('src/modules/vector_att_control/vector_att_control_main.cpp',[
 ('#include <lib/vector_control/VectorGeometry.hpp>','#include <lib/vector_control/VectorGeometry.hpp>\n#include <lib/vector_control/VectorHilManual.hpp>'),
 ('VectorAttitudeControl::parameters_updated()\n{','VectorAttitudeControl::parameters_updated()\n{\n\tint32_t hil_test = 0;\n\tconst param_t hil_handle = param_find("VEC_HIL_TEST");\n\tif (hil_handle != PARAM_INVALID) { param_get(hil_handle, &hil_test); }\n\t_hil_test_enabled = hil_test == 1;'),
 ('\t\t\t\t_vehicle_type_rotary_wing =', '\t\t\t\t_hil_state = vehicle_status.hil_state == vehicle_status_s::HIL_STATE_ON;\n\t\t\t\t_vehicle_type_rotary_wing ='),
 ('\tq_sp.copyTo(attitude_setpoint.q_d);','''\tconst bool hil_manual = vector_control::hilManualSample(
        vector_control::hilManualInterface(_hil_test_enabled, _hil_state, _reference_enabled, _param_vector_airframe.get()),
        _manual_control_setpoint.data_source, _manual_control_setpoint.valid && hrt_elapsed_time(&_manual_control_setpoint.timestamp) < 500_ms,
        _vehicle_control_mode.flag_armed, !_landed);
    if (hil_manual) {
        q_sp = vector_control::hilManualAttitude(_manual_control_setpoint.aux1, _manual_control_setpoint.aux2, yaw_setpoint, 45.f);
    }
\tq_sp.copyTo(attitude_setpoint.q_d);'''),
 ('\tattitude_setpoint.thrust_body[2] = -throttle_curve(_manual_control_setpoint.throttle);','''\tattitude_setpoint.thrust_body[2] = -throttle_curve(_manual_control_setpoint.throttle);
    if (hil_manual) {
        vector_control::hilManualThrust(q, throttle_curve(_manual_control_setpoint.throttle)).copyTo(attitude_setpoint.thrust_body);
    }'''),
])
edit('src/modules/vector_pos_control/VectorPositionControl.hpp',[
 ('bool _reference_enabled{false};','bool _hil_test_enabled{false};\n\tbool _reference_enabled{false};'),
])
edit('src/modules/vector_pos_control/VectorPositionControl.cpp',[
 ('#include <lib/vector_control/VectorGeometry.hpp>','#include <lib/vector_control/VectorGeometry.hpp>\n#include <lib/vector_control/VectorHilManual.hpp>'),
 ('\t\tModuleParams::updateParams();','''\t\tModuleParams::updateParams();
        int32_t hil_test = 0;
        const param_t hil_handle = param_find("VEC_HIL_TEST");
        if (hil_handle != PARAM_INVALID) { param_get(hil_handle, &hil_test); }
        _hil_test_enabled = hil_test == 1;'''),
 ('\t\t\tif (spatial && _reference_enabled) {','''            const bool hil_interface = vector_control::hilManualInterface(_hil_test_enabled,
                _vehicle_status.hil_state == vehicle_status_s::HIL_STATE_ON, _reference_enabled, _param_vector_airframe.get());
            const bool hil_altitude = hil_interface && _vehicle_status.nav_state == vehicle_status_s::NAVIGATION_STATE_ALTCTL;
            const bool hil_input_valid = vector_control::hilManualSample(hil_interface, manual.data_source, manual_fresh,
                _vehicle_control_mode.flag_armed, !_vehicle_land_detected.landed && !_vehicle_land_detected.ground_contact)
                && (manual_position || hil_altitude);
\t\t\tif (spatial && _reference_enabled) {'''),
 ('const bool allowed = control_update_success && (manual_position || user_hold)','const bool allowed = control_update_success && (manual_position || user_hold || hil_altitude)'),
 ('''const bool input_valid = allowed && _param_vector_aux_att.get() && rc_input_valid
							 && switches_valid && vector_enabled && !level_requested;''','''const bool input_valid = hil_input_valid || (allowed && _param_vector_aux_att.get() && rc_input_valid
                             && switches_valid && vector_enabled && !level_requested);'''),
 ('const float limit = vector_control::spatialAttitudeLimit(_param_spatial_limit.get());','const float limit = hil_interface ? math::radians(hil_altitude ? 45.f : 120.f) : vector_control::spatialAttitudeLimit(_param_spatial_limit.get());'),
 ('input_valid && _param_rc_map_aux1.get() > 0 && PX4_ISFINITE(manual.aux1)','input_valid && (hil_input_valid || _param_rc_map_aux1.get() > 0) && PX4_ISFINITE(manual.aux1)'),
 ('input_valid && _param_rc_map_aux2.get() > 0 && PX4_ISFINITE(manual.aux2)','input_valid && (hil_input_valid || _param_rc_map_aux2.get() > 0) && PX4_ISFINITE(manual.aux2)'),
 # HIL AUX always has +/-120 scale; Altitude clamps the reference to +/-45.
 ('? math::constrain(manual.aux1, -1.f, 1.f) * limit : 0.f;','? (hil_input_valid ? vector_control::hilManualAngle(manual.aux1, hil_altitude ? 45.f : 120.f) : math::constrain(manual.aux1, -1.f, 1.f) * limit) : 0.f;'),
 ('? math::constrain(manual.aux2, -1.f, 1.f) * limit : 0.f;','? (hil_input_valid ? vector_control::hilManualAngle(manual.aux2, hil_altitude ? 45.f : 120.f) : math::constrain(manual.aux2, -1.f, 1.f) * limit) : 0.f;'),
])
patch=[]
for name,(before,after) in changes.items():
    target=overlay/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(after)
    patch.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+name if before else '/dev/null',tofile='b/'+name))
out.mkdir(parents=True,exist_ok=True);(out/'vector-hil-manual.patch').write_text(''.join(patch))
print(f'Prepared {len(changes)} files and patch at {out}; PX4 checkout unchanged')
