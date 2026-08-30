# PX4 DSDL collection

This directory mirrors the DSDL repositories referenced by PX4-Autopilot.
Namespace directories are preserved because DSDL type resolution depends on
their original paths.

- `cyphal_v1/public_regulated`: OpenCyphal public regulated data types.
- `cyphal_v1/px4_legacy`: PX4's legacy branch of regulated Cyphal types.
- `dronecan_v0`: PX4 DroneCAN/UAVCAN v0 DSDL definitions.

Source repositories:

- https://github.com/opencyphal/public_regulated_data_types
- https://github.com/PX4/public_regulated_data_types (branch `legacy`)
- https://github.com/PX4/DSDL

Do not flatten these folders: duplicate filenames are valid in different DSDL
namespaces and versions.
