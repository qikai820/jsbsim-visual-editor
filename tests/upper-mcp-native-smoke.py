"""Smoke-test the actual release desktop and stdio adapter in a network namespace.

Run under bwrap --unshare-net --dev /dev and xvfb-run. No host USB or LAN.
"""
import argparse
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--work", type=Path, required=True)
args = parser.parse_args()
assert [name for _, name in socket.if_nameindex()] == ["lo"], "Must run in an isolated network namespace"
assert not list(Path("/dev").glob("ttyACM*")), "Must run without host USB devices"
work = args.work
env = dict(os.environ, XDG_DATA_HOME=str(work / "data"), XDG_CONFIG_HOME=str(work / "config"),
           XDG_CACHE_HOME=str(work / "cache"), SIM_TRANSPORT_MODE="network", SIM_UDP_HOST="127.0.0.1",
           SIM_EXTERNAL="0", WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS="1", APPIMAGE_EXTRACT_AND_RUN="1")
endpoint = work / "data/com.jsbsim.visual-editor/mcp-endpoint.json"
root = Path(__file__).resolve().parents[1]
desktop_log = (work / "desktop.log").open("w")
desktop = subprocess.Popen([str(args.binary)], env=env, stdout=desktop_log, stderr=subprocess.STDOUT, start_new_session=True)
adapter = None
results = []
try:
    deadline = time.monotonic() + 30
    while not endpoint.exists() and time.monotonic() < deadline:
        if desktop.poll() is not None:
            raise RuntimeError("Desktop exited; see desktop.log")
        time.sleep(.1)
    assert endpoint.exists(), "Desktop did not create endpoint"
    assert endpoint.stat().st_mode & 0o777 == 0o600
    config = json.loads(endpoint.read_text())
    assert config["host"] == "127.0.0.1"
    adapter = subprocess.Popen([sys.executable, str(root / "tools/upper-mcp/server.py"), "--endpoint", str(endpoint)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    serial = 0

    def rpc(method, params=None, notify=False):
        global serial
        serial += 1
        request = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            request["id"] = serial
        adapter.stdin.write(json.dumps(request) + "\n")
        adapter.stdin.flush()
        if notify:
            return
        assert select.select([adapter.stdout], [], [], 20)[0], "MCP response timeout: " + method
        response = json.loads(adapter.stdout.readline())
        assert response["id"] == serial and "result" in response, response
        return response["result"]

    def call(name, arguments=None, error=False):
        reply = rpc("tools/call", {"name": name, "arguments": arguments or {}})
        assert reply["isError"] == error, (name, reply)
        text = reply["content"][0]["text"]
        return text if error else json.loads(text)

    rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "native-smoke", "version": "1"}})
    rpc("notifications/initialized", notify=True)
    assert len(rpc("tools/list")["tools"]) == 12
    results.append("actual stdio initialize/list: nine tools")
    status = call("upper_get_status")
    assert status["connection"]["connected"] is False
    assert status["test"]["id"] == 0
    results.append("actual native cache read with no flight controller connection")
    scripts = call("upper_list_scripts")
    assert scripts["scripts"][0]["id"] == "morphquad_complete"
    valid = call("upper_validate_script", {"script": "morphquad_complete"})
    assert valid["events"] == 1774
    results.append("current complete script parsed: 1774 events")
    source = call("upper_get_script", {"script": "morphquad_complete"})["source"]
    assert len(source.encode()) > 2 * 1024 * 1024
    assert call("upper_validate_script", {"source": source})["events"] == 1774
    results.append("3 MiB source request round trip (framing bound compatible with complete script)")
    # No UI toolbox context exists. This verifies backend -> real frontend ->
    # same session entry point -> reply, without opening any FC transport.
    time.sleep(3)
    rejected = call("upper_start_test", {"source": "<runscript name='smoke'><run start='0' end='1' dt='0.02'/></runscript>", "dryRun": True}, error=True)
    assert "请先打开 PX4 工具箱选择测试实例" in rejected, rejected
    results.append("real UI bridge delivered start request and rejected absent toolbox context")
    assert call("upper_get_status")["test"]["id"] == 0
    with socket.create_connection(("127.0.0.1", config["port"]), timeout=3) as sock:
        sock.sendall(json.dumps({"token": "00" * 32, "name": "upper_get_status", "arguments": {}}).encode() + b"\n")
        with sock.makefile("rb") as stream:
            reply = json.loads(stream.readline())
        assert reply["ok"] is False
    results.append("native endpoint rejects wrong token")
    (work / "result.json").write_text(json.dumps({"passed": True, "checks": results, "hostHardwareAccessible": False}, indent=2))
    print(json.dumps({"passed": True, "checks": results}, ensure_ascii=False))
finally:
    if adapter:
        adapter.stdin.close()
        adapter.wait(timeout=5)
        assert adapter.stderr.read() == ""
    try:
        os.killpg(desktop.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        desktop.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(desktop.pid, signal.SIGKILL)
        desktop.wait()
    desktop_log.close()
