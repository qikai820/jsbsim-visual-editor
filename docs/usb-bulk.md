# LMX93 USB Bulk transport

The Type-C device appears as one vendor-specific USB interface, not as MTP,
mass storage, a serial port, or a network adapter. The application's
**Tools > Simulator Files** window browses the board over this private USB
protocol. It shows the SD card and eMMC `data` filesystem as separate roots;
operating-system file managers do not mount either filesystem.

The two volume tabs at the top show total, used and available capacity with a
usage bar. **eMMC (data)** reports the `/data` filesystem, not the entire raw
eMMC device. Opening the window, refreshing, or completing a file change reads
exact block counts from `cat /proc/fs/blocks` through the existing USB NSH
channel; no firmware update is needed on boards supporting USB NSH and this
procfs entry. Missing mounts and query errors are shown as unavailable, never
as zero usage. Changing directories does not repeatedly query storage.

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

The desktop serializes physical interface access separately from outstanding
file responses. EP3 file/NSH requests retain their file-response lock while a
slow command yields the interface between response polls. EP2 clock sync,
START/LOAD/STOP and heartbeat packets do not take that file lock. User control
packets wait up to 3 seconds for interface access, while periodic heartbeats
wait up to 250 ms; each bulk write is bounded to 250 ms. A timed-out lock wait
does not leave a command queued, and failed/short writes are not replayed here.

`USB file transport is busy` during START was caused by routing EP2 control
through the best-effort EP3 helper. Console polling and Auto discovery still
skip an occupied file channel, but control now uses the independent path.
This fix is in the desktop backend and requires reopening the rebuilt desktop
application; it does not require a board firmware change. Host contention
tests cover file requests held open, console reads, expiration and send-once
behavior; a successful real-board start remains a separate acceptance check.

File records use a 32-byte little-endian `JBS1` header containing version,
opcode, request ID, status/read length, payload length, file offset, and
CRC32. Supported operations are ping, list, stat, chunked read, staged write,
commit/abort, delete, mkdir, and same-volume rename. The board only accepts relative paths under:

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
- `Network` uses UDP for telemetry/control, FTP for model synchronization,
  and Telnet NSH for the SD/eMMC file manager.
- `USB` uses only the private bulk endpoints.

The selected mode is stored on the desktop computer and restored when the
application starts.

Model-library reads have a 90-second total budget, including referenced XML
files. **Cancel load**, closing the library, and the UI timeout also cancel the
matching backend request. FTP/NSH/USB file-channel lock waits are limited to
5 seconds; a busy channel reports an error and does not leave the request
queued. Cancellation stops further reads and fallback attempts. An in-flight
curl read can take up to its existing 5-second timeout to finish; NSH reads
check cancellation between socket polls and still send `exit` during cleanup.
The user model on the canvas is replaced only after import succeeds. Rebuild
and reopen the desktop application to use this fix; no firmware update is
needed. Host TCP fixtures cover cancellation while waiting for NSH and while
waiting for a response, followed by a successful model/reference retry.

**Tools > Simulator Files** follows this selection for capacity, directory
listing, upload/download, editing, rename, copy/move, and deletion. Network
mode accesses both `/mnt/sdcard` and `/data` through the existing Telnet NSH
service; the board's FTP root exposes only the SD card. Network uploads use
temporary files, verify size and CRC through readback, then publish by rename.
Commands fit the shipping firmware's 80-byte NSH input limit. NSH transfers
are slower than USB, particularly for large binary files. Filenames must also
be supported by the board filesystem; the current FAT configuration can reject
some non-ASCII names even though UTF-8 file contents are preserved.

Capacity is read through the selected transport. An unmounted SD card is
reported as unavailable and refuses file access; if only data is mounted,
opening the manager selects data. The editor's existing conflict check also
applies to network saves. This requires rebuilding/reopening the desktop
editor, with no board firmware update.

Network discovery verifies the NuttX FTP service and its SD-card `jsbsim`
directory. If that directory is absent, it also checks the built-in
`/romfs/jsbsim` library through Telnet NSH. A board using only built-in models
can therefore connect over Ethernet with an empty SD card. This desktop fix
requires reopening the rebuilt editor; it does not require a firmware update
or copying models onto the SD card.

The USB NSH window waits up to 35 seconds for `ifup`, `ifdown`, and `ifconfig`.

System Settings provides a fixed-footer **Save & Apply** action for Ethernet
IPv4 settings. In Auto mode, a read-only probe selects USB when available,
otherwise the current Ethernet NSH connection; explicit USB/Network modes
retain their selected transport. A write is never replayed on another channel
after a timeout. Ethernet saves reconnect at the new IP when editing the
active interface, verify its MAC and all three IPv4 fields, and only then
update the editor's control destination. Editing another port preserves the
active connection. Failed verification retains the form edits. These settings
apply to the current runtime; firmware defaults are restored after reboot.
The matching firmware gives those commands 30 seconds to complete PHY
negotiation. Other commands retain the short response budget. A command that
exceeds its budget is reported as still running and is not forcibly deleted
inside a driver. New NSH commands are rejected as busy until the old child
exits; other USB services remain available after the response. `top` receives
its native SIGINT request after one second. This requires the updated firmware
and editor; increasing only the editor timeout cannot fix older firmware's
one-second command cancellation.

This command-channel fix does not add Ethernet cable detection. The current
startup script brings up only `eth0`; `eth1` is the independent EQoS controller
and needs its own `ifup eth1`. A failed PHY negotiation still requires another
successful `ifup` on the affected interface. Confirm both cold boot without a
cable followed by insertion and a normal cable-connected boot on the board.

Board protocol v6 adds opcode `14` on the same file-service endpoints for the
debug console mirror. A request has no payload and puts the last read byte
position in the header offset. The response returns up to 1024 console bytes
and the next offset. A positive status means the 64 KiB ring buffer wrapped
before the requested position. **JSBSim 信息 > NSH 打印** starts or stops desktop
polling; the board continues writing to the physical debug UART. The mirror
includes ongoing serial NSH output and other text sent through that UART.

The in-app file manager can rename, copy, and move files and directories.
Right-click a file or folder for its actions; right-click an empty area to
paste into the current directory, or right-click a folder to paste into it.
**Upload folder** places a local folder under the current SD/data directory,
including nested and empty directories on Linux. New folders are uploaded to
a temporary directory and published after every file passes readback verification.
If a folder with the same name exists, the user chooses whether to overwrite
or skip same-name files; other files are merged. Conflicting file and folder
types are not overwritten. Folder upload requires board file protocol v4.
The non-Linux folder picker can upload files up to 16 MiB each and cannot
upload an empty folder or preserve empty subdirectories.
The built-in editor uses the MIT-licensed CodeMirror 6 component for UTF-8
text files up to 4 MiB, with XML/JSON highlighting and Ctrl+S. It only shows
**Save to simulator** after the content changes. Before saving, the app checks
that the device copy still matches the opened version and refuses to overwrite
an externally changed file. Closing with unsaved edits asks for confirmation.
On Linux, **Open with computer editor** downloads a local copy and opens the
system's application chooser. The file manager checks the local copy and only
offers **Save to simulator** when its contents have changed. Saving checks whether
the device file changed in the meantime; removing the session keeps the local
copy in the configured download directory.
Copy stages content in the destination volume and publishes it after USB
readback verification. A move within one volume uses board rename; a move
between SD and data copies and verifies first, then removes the source. An
existing destination is never intentionally replaced by copy or move.

## Linux

No kernel driver needs to be installed; the host application uses libusb.
Install `packaging/69-lmx93-usb.rules` into `/etc/udev/rules.d/`, reload the
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
A board with the console mirror prints `USB bulk self-test PASS: lmx93-usb-file/6; ...`. The Tauri
command `usb_file_ping` performs the same initial check. The commands
`usb_file_list`, `usb_file_read`, `usb_file_write`, `usb_file_delete`, and
`usb_file_mkdir` expose the private RPC directly. Existing UI model, script,
configuration, DSDL, and log operations use the same USB module by default.

The [Log Center](LOG_CENTER.md) lists finalized `.mcap` files under the board's
`LOG` directory. A recording still named `.active` is not listed.
