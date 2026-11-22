#!/usr/bin/env python3
"""MCP stdio adapter for a running JSBSim desktop. Python 3.10+, stdlib only.

No MAVLink/USB/UDP access. The desktop remains the only device owner.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import stat
import sys
import threading

VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
MAX_MESSAGE = 8 * 1024 * 1024
BUILTIN = {"type": "string", "enum": ["morphquad_complete"]}


def tool(name, description, properties=None, required=(), read_only=True):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": properties or {},
                            "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": read_only, "destructiveHint": not read_only,
                            "idempotentHint": read_only, "openWorldHint": False}}


TOOLS = [
    tool("upper_get_status", "读取上位机已有飞控/视景缓存、数据年龄、共享测试状态和 MCP 调用记录；不向飞控追加遥测请求。"),
    tool("upper_list_scripts", "列出当前上位机构建内置的测试脚本。"),
    tool("upper_get_script", "读取内置脚本 XML。", {"script": BUILTIN}, ("script",)),
    tool("upper_validate_script", "解析脚本，不向飞控发送指令。source 或 script 二选一。",
         {"source": {"type": "string"}, "script": BUILTIN}),
    tool("upper_start_test", "通过上位机共享测试引擎启动；source 或 script 二选一。显式 dryRun=true 为干跑，false 才控制 HIL。需要已在工具箱连接；50 Hz、实时时钟，完成/中止均降落。不覆盖正在编辑的脚本，不自动修改参数。",
         {"source": {"type": "string"}, "script": BUILTIN, "dryRun": {"type": "boolean"}}, ("dryRun",), False),
    tool("upper_stop_test", "停止指定 id 的当前测试，等待原退出策略完成；UI 仍可查看状态。",
         {"id": {"type": "integer", "minimum": 1}}, ("id",), False),
    tool("upper_get_report", "读取已退出测试的结果。默认省略轨迹和源 XML；使用 offset/limit 分页读取轨迹，每页最多 1000 点。",
         {"offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 0, "maximum": 1000}}),
    tool("upper_save_report", "将已退出测试的完整记录保存到上位机应用数据目录 test-reports，返回绝对路径。", read_only=False),
]
CATALOG = {item["name"]: item for item in TOOLS}


def default_endpoint():
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming")))
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share")))
    return base / "com.jsbsim.visual-editor/mcp-endpoint.json"


def validate(name, arguments):
    if name not in CATALOG:
        raise ValueError("Unknown tool")
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    schema = CATALOG[name]["inputSchema"]
    if set(arguments) - set(schema["properties"]):
        raise ValueError("Unknown tool argument")
    if set(schema["required"]) - set(arguments):
        raise ValueError("Missing required argument")
    for key, value in arguments.items():
        spec = schema["properties"][key]
        good = {"string": isinstance(value, str), "boolean": type(value) is bool,
                "integer": type(value) is int}[spec["type"]]
        if not good or ("enum" in spec and value not in spec["enum"]):
            raise ValueError("Invalid argument: " + key)
        if ("minimum" in spec and value < spec["minimum"]) or ("maximum" in spec and value > spec["maximum"]):
            raise ValueError("Argument out of range: " + key)
    if name in ("upper_validate_script", "upper_start_test"):
        if ("source" in arguments) == ("script" in arguments) or arguments.get("source") == "":
            raise ValueError("Provide exactly one nonempty source or script")


def call_upper(endpoint, name, arguments):
    validate(name, arguments)
    # Reread each time: restarting the desktop rotates token/port. No persistent
    # HIL connection or client-side command replay on reconnect.
    info = endpoint.stat()
    if os.name == "posix" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise ValueError("Endpoint file must belong to this user and have mode 0600")
    if info.st_size > 4096:
        raise ValueError("Invalid endpoint file")
    config = json.loads(endpoint.read_text(encoding="utf-8"))
    if config.get("host") != "127.0.0.1" or type(config.get("port")) is not int or not 0 < config["port"] < 65536:
        raise ValueError("Invalid local endpoint")
    if not isinstance(config.get("token"), str) or len(config["token"]) != 64:
        raise ValueError("Invalid endpoint credentials")
    request = json.dumps({"token": config["token"], "name": name, "arguments": arguments},
                         ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
    if len(request) > MAX_MESSAGE:
        raise ValueError("Request is too large")
    with socket.create_connection(("127.0.0.1", config["port"]), timeout=3) as sock:
        sock.settimeout(155)
        sock.sendall(request)
        with sock.makefile("rb") as stream:
            reply = stream.readline(32 * 1024 * 1024 + 1)
    if len(reply) > 32 * 1024 * 1024 or not reply.endswith(b"\n"):
        raise ValueError("Incomplete or oversized desktop reply; query status before retrying control")
    result = json.loads(reply)
    if not result.get("ok"):
        raise ValueError(result.get("error", "Desktop request failed"))
    return result["result"]


class Server:
    def __init__(self, endpoint):
        self.endpoint = endpoint
        self.initialized = False
        self.ready = False

    def handle(self, request):
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
        method, identity = request["method"], request.get("id")
        if "id" not in request:
            if method == "notifications/initialized" and self.initialized:
                self.ready = True
            return None
        if method == "ping":
            result = {}
        elif method == "initialize":
            params = request.get("params", {})
            version = params.get("protocolVersion") if isinstance(params, dict) else None
            result = {"protocolVersion": version if version in VERSIONS else VERSIONS[0],
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "jsbsim-upper-mcp", "version": "0.1.0"},
                      "instructions": "上位机是唯一飞控连接拥有者。先用 upper_get_status 核对状态和数据年龄；控制操作不要自动重试。UI 终止操作始终有效。"}
            self.initialized = True
        elif not self.ready:
            return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32002, "message": "Initialize first"}}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            try:
                params = request.get("params", {})
                if not isinstance(params, dict):
                    raise ValueError("Invalid params")
                value = call_upper(self.endpoint, params.get("name"), params.get("arguments", {}))
                result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, allow_nan=False)}], "isError": False}
            except (OSError, ValueError, TypeError, KeyError) as error:
                message = "上位机未连接；请启动带 MCP 的上位机并打开 PX4 工具箱。" if isinstance(error, (FileNotFoundError, ConnectionRefusedError)) else str(error)
                result = {"content": [{"type": "text", "text": message}], "isError": True}
        else:
            return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not found"}}
        return {"jsonrpc": "2.0", "id": identity, "result": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=Path, default=Path(os.environ.get("JSBSIM_MCP_ENDPOINT", str(default_endpoint()))))
    args = parser.parse_args()
    server, lock = Server(args.endpoint), threading.Lock()

    def respond(request):
        response = server.handle(request)
        if response is not None:
            with lock:
                print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)

    # A long stop/landing request must not block status queries on this client.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        while True:
            line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
            if not line:
                break
            if len(line) > MAX_MESSAGE:
                print("MCP input exceeded 8 MiB", file=sys.stderr)
                break
            try:
                request = json.loads(line)
            except (ValueError, UnicodeError):
                with lock:
                    print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), flush=True)
                continue
            if isinstance(request, dict) and request.get("method") == "tools/call" and server.ready:
                pool.submit(respond, request)
            else:
                respond(request)


if __name__ == "__main__":
    main()
