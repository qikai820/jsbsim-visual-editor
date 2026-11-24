"""Isolated stdio protocol and desktop proxy tests. No device connection."""
import importlib.util
import json
from pathlib import Path
import select
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("upper_mcp", ROOT / "tools/upper-mcp/server.py")
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.endpoint = Path(self.temp.name) / "endpoint.json"
        self.token = "ab" * 32
        self.requests = []
        self.slow = threading.Event()
        parent = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                parent.requests.append(request)
                if request["token"] != parent.token:
                    reply = {"ok": False, "error": "Unauthorized"}
                elif request["name"] == "upper_stop_test":
                    parent.slow.wait(3)
                    reply = {"ok": True, "result": {"id": request["arguments"]["id"], "status": "stopped"}}
                else:
                    reply = {"ok": True, "result": {"test": {"id": 8, "status": "running"}, "fresh": True}}
                self.wfile.write(json.dumps(reply).encode() + b"\n")

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.configure()
        self.process = subprocess.Popen([sys.executable, str(ROOT / "tools/upper-mcp/server.py"), "--endpoint", str(self.endpoint)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

    def configure(self):
        self.endpoint.write_text(json.dumps({"host": "127.0.0.1", "port": self.server.server_address[1], "token": self.token}))
        self.endpoint.chmod(0o600)

    def tearDown(self):
        self.slow.set()
        self.process.stdin.close()
        self.process.wait(timeout=5)
        error = self.process.stderr.read()
        self.assertEqual(error, "")
        self.process.stdout.close()
        self.process.stderr.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def send(self, method, identity=None, params=None):
        request = {"jsonrpc": "2.0", "method": method}
        if identity is not None:
            request["id"] = identity
        if params is not None:
            request["params"] = params
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()

    def receive(self):
        self.assertTrue(select.select([self.process.stdout], [], [], 3)[0], "MCP response timed out")
        return json.loads(self.process.stdout.readline())

    def initialize(self):
        self.send("initialize", 1, {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
        self.assertEqual(self.receive()["result"]["protocolVersion"], "2025-11-25")
        self.send("notifications/initialized")

    def test_lifecycle_and_list_do_not_require_desktop(self):
        self.send("tools/list", 0)
        self.assertEqual(self.receive()["error"]["code"], -32002)
        self.initialize()
        self.endpoint.unlink()
        self.send("tools/list", 2)
        tools = self.receive()["result"]["tools"]
        self.assertEqual(len(tools), 18)
        self.assertEqual(self.requests, [])
        self.send("tools/call", 3, {"name": "upper_get_status"})
        self.assertTrue(self.receive()["result"]["isError"])

    def test_validation_blocks_unknown_or_unsafe_arguments_before_proxy(self):
        self.initialize()
        cases = [
            ("upper_start_test", {"script": "morphquad_complete"}),
            ("upper_start_test", {"script": "morphquad_complete", "dryRun": "false"}),
            ("upper_start_test", {"source": "x", "script": "morphquad_complete", "dryRun": True}),
            ("upper_stop_test", {"id": True}),
            ("upper_stop_test", {"id": 0}),
            ("upper_get_report", {"limit": 1001}),
            ("upper_get_status", {"port": 14553}),
            ("raw_mavlink_write", {}),
            ("upper_firmware_start", {"selectionId":1,"port":"/dev/ttyACM0"}),
            ("upper_firmware_prepare", {"path":"/data/a.px4","source":"unknown"}),
            ("upper_firmware_cancel", {"id":0}),
        ]
        for index, (name, args) in enumerate(cases, 10):
            self.send("tools/call", index, {"name": name, "arguments": args})
            self.assertTrue(self.receive()["result"]["isError"])
        self.assertEqual(self.requests, [])

    def test_simulator_firmware_tools_share_authenticated_proxy(self):
        self.initialize()
        calls=[("upper_firmware_prepare",{"path":"/mnt/home/fw.px4","source":"simulator"}),
               ("upper_firmware_prepare",{"path":"/tmp/fw.px4","source":"local"}),
               ("upper_firmware_start",{"selectionId":3,"simulator":"192.0.2.1","port":"/dev/ttyACM0"}),
               ("upper_firmware_cancel",{"id":4})]
        for identity,(name,args) in enumerate(calls,40):
            self.send("tools/call",identity,{"name":name,"arguments":args})
            self.assertFalse(self.receive()["result"]["isError"])
            self.assertEqual(self.requests[-1]["arguments"],args)

    def test_slow_stop_does_not_block_state_and_restart_rotates_token(self):
        self.initialize()
        self.send("tools/call", 2, {"name": "upper_stop_test", "arguments": {"id": 8}})
        deadline = time.monotonic() + 2
        while not self.requests and time.monotonic() < deadline:
            time.sleep(.01)
        self.send("tools/call", 3, {"name": "upper_get_status"})
        status = self.receive()
        self.assertEqual(status["id"], 3)
        self.assertFalse(status["result"]["isError"])
        self.slow.set()
        self.assertEqual(self.receive()["id"], 2)
        self.token = "cd" * 32
        self.configure()
        self.send("tools/call", 4, {"name": "upper_get_status"})
        self.assertFalse(self.receive()["result"]["isError"])
        self.assertEqual(self.requests[-1]["token"], self.token)

    def test_log_proxy_identity_and_async_status(self):
        self.initialize()
        for identity,(name,args) in enumerate([("upper_list_logs",{}),("upper_download_log",{"id":0,"expectedSize":24000000,"expectedTime":0}),("upper_cancel_log_download",{"jobId":1})], 20):
            self.send("tools/call",identity,{"name":name,"arguments":args})
            self.assertFalse(self.receive()["result"]["isError"])
            self.assertEqual(self.requests[-1]["arguments"],args)
        count=len(self.requests)
        for identity,args in enumerate([{"id":65535,"expectedSize":24,"expectedTime":0},{"id":0,"expectedSize":15,"expectedTime":0},{"id":0,"expectedSize":24,"expectedTime":0,"path":"/tmp/x"}],30):
            self.send("tools/call",identity,{"name":"upper_download_log","arguments":args})
            self.assertTrue(self.receive()["result"]["isError"])
        self.assertEqual(len(self.requests),count)

    def test_nsh_tool_bounds_and_authenticated_forwarding(self):
        self.initialize()
        self.send("tools/call", 2, {"name":"upper_nsh_command","arguments":{"command":"param show SYS_HITL","timeoutMs":10000}})
        self.assertFalse(self.receive()["result"]["isError"])
        self.assertEqual(self.requests[-1]["name"],"upper_nsh_command")
        count=len(self.requests)
        for identity,args in enumerate([{"command":"a\nb"},{"command":"x"*257},{"command":"status","timeoutMs":999},{"command":"status","timeoutMs":30001}],3):
            self.send("tools/call",identity,{"name":"upper_nsh_command","arguments":args})
            self.assertTrue(self.receive()["result"]["isError"])
        self.assertEqual(len(self.requests),count)

    def test_public_endpoint_credentials_and_malformed_json(self):
        self.initialize()
        self.endpoint.chmod(0o644)
        self.send("tools/call", 2, {"name": "upper_get_status"})
        self.assertTrue(self.receive()["result"]["isError"])
        self.assertEqual(self.requests, [])
        self.process.stdin.write("not json\n")
        self.process.stdin.flush()
        self.assertEqual(self.receive()["error"]["code"], -32700)


if __name__ == "__main__":
    unittest.main()
