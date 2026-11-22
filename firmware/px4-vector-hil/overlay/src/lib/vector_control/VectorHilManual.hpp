#pragma once
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
