# LMX93 USB Bulk transport

The Type-C device appears as one vendor-specific USB interface, not as MTP,
mass storage, a serial port, or a network adapter. The application's
**Tools > Simulator Files** window browses the board over this private USB
protocol. It shows the SD card and eMMC `data` filesystem as separate roots;
operating-system file managers do not mount either filesystem.

Development identity: `VID 1209`, `PID 93a1`, interface 0. Allocate a unique
production VID/PID before shipping hardware.

| Endpoint | Direction (host view) | Use |
|---|---|---|
| `0x82` | device to host | simulation JSON telemetry |
| `0x02` | host to device | `VCTL` / `VCMD` simulation control |
| `0x83` | device to host | private file responses |
| `0x03` | host to device | private file requests |

Simulation records are `SIM1`, a little-endian `u32` payload length, then the
existing UDP payload. USB and UDP operate in parallel.

File records use a 32-byte little-endian `JBS1` header containing version,
opcode, request ID, status/read length, payload length, file offset, and
CRC32. Supported operations are ping, list, stat, chunked read, staged write,
commit/abort, delete, and mkdir. The board only accepts relative paths under:

- `/mnt/sdcard/jsbsim`
- `/mnt/sdcard/LOG`
- `/mnt/sdcard/dsdl/px4`
- `/mnt/sdcard` through the `sd` file-manager root
- `/data` through the `data` file-manager root
- `/romfs/jsbsim` (read-only built-in aviation library)

Uploads use a `.usbpart` file and become visible at the target pathname only
after commit. File transfers use USB only when a protocol PING succeeds;
otherwise they automatically use Ethernet. The **Local Settings > Simulator
communication** control applies to both file transfer and live simulation:

- `Auto` keeps network fallback available and uses USB files after a successful
  protocol PING.
- `Network` uses UDP for telemetry/control and FTP for files.
- `USB` uses only the private bulk endpoints.

The selected mode is stored on the desktop computer and restored when the
application starts.

## Linux

No kernel driver needs to be installed; the host application uses libusb.
Install `packaging/99-lmx93-usb.rules` into `/etc/udev/rules.d/`, reload the
udev rules, and reconnect the board so a desktop user can open the interface.

## Windows

The firmware advertises the `WINUSB` Microsoft compatible ID. Windows binds
its built-in WinUSB driver, and the application accesses it through libusb;
there is no custom kernel driver or driver-signing/certification package.

## Verification

After flashing the matching NuttX image, run this from the repository root:

```sh
./test-usb.sh
```

The test sends a protocol PING and lists the built-in ROMFS aircraft directory.
A working link prints `USB bulk self-test PASS: lmx93-usb-file/1; ...`. The Tauri
command `usb_file_ping` performs the same initial check. The commands
`usb_file_list`, `usb_file_read`, `usb_file_write`, `usb_file_delete`, and
`usb_file_mkdir` expose the private RPC directly. Existing UI model, script,
configuration, DSDL, and log operations use the same USB module by default.

The [Log Center](LOG_CENTER.md) lists finalized `.mcap` files under the board's
`LOG` directory. A recording still named `.active` is not listed.
