/**
 * @file simClient.js
 * @brief 仿真机 Route B UDP 通道的上位机侧客户端
 *
 * 职责：
 *   - 监听仿真机 jsbsim_server 经 UDP 推送的 JSON 遥测 (默认 :5801)
 *   - 把最新一帧存到 state.latest，并做断线检测 (2s 无包 => connected=false)
 *   - 把浏览器发来的手动控制指令打包成 VisControlFrame (72B) 经独立 UDP 端口发回仿真机
 *
 * 协议与 px4-jsbsim-bridge/src/jsbsim_server.cpp 严格对称。
 */

const dgram = require('dgram');

const LISTEN_PORT = parseInt(process.env.SIM_UDP_PORT || '5801', 10);
const CTRL_HOST = process.env.SIM_UDP_HOST || '127.0.0.1'; // 仿真机 IP
const CTRL_PORT = parseInt(process.env.SIM_UDP_CTRL_PORT || '5802', 10);
const DISCONNECT_TIMEOUT = 2000; // ms

const state = {
  latest: null,        // 最新遥测帧 (见设计说明 §5.1)
  connected: false,
  lastPacketTime: 0,   // ms
  packets: 0,
};

const sock = dgram.createSocket('udp4');

sock.on('message', (msg) => {
  try {
    const t = JSON.parse(msg.toString('utf8'));
    if (typeof t !== 'object' || t === null) return;
    state.latest = t;
    state.connected = true;
    state.lastPacketTime = Date.now();
    state.packets++;
  } catch (e) {
    // 非 JSON（或截断）包直接忽略
  }
});

sock.on('error', (err) => {
  console.error('[simClient] UDP 错误:', err.message);
});

sock.on('listening', () => {
  const addr = sock.address();
  console.log(`[simClient] 监听仿真遥测 UDP 0.0.0.0:${addr.port}`);
});

sock.bind(LISTEN_PORT);

/**
 * 发送手动控制帧给仿真机。
 * @param {boolean} override true=接管执行器；false=释放给飞控/HIL
 * @param {number[]} channels 长度 16 的归一化执行器指令（与 ActuatorFrame 对齐）
 */
function sendControl(override, channels) {
  const buf = Buffer.alloc(72);
  buf.write('VCTL', 0, 'ascii');           // magic[4]
  buf.writeUInt8(override ? 1 : 0, 4);      // override
  // pad[3] 默认 0
  const ch = channels || [];
  for (let i = 0; i < 16; i++) {
    buf.writeFloatLE(Number(ch[i] || 0), 8 + i * 4);
  }
  sock.send(buf, CTRL_PORT, CTRL_HOST, (err) => {
    if (err) console.error('[simClient] 发送控制失败:', err.message);
  });
}

// 断线检测：超过超时未收到包 => 标记断开（保留 last 供面板显示）
setInterval(() => {
  if (state.connected && Date.now() - state.lastPacketTime > DISCONNECT_TIMEOUT) {
    state.connected = false;
    console.warn('[simClient] 遥测超时，仿真机疑似断开');
  }
}, 500).unref?.();

module.exports = { state, sendControl };
