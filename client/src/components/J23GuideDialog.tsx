import { useEffect } from 'react';
import { useLanguage } from '../i18n';
import boardSerialPortsImage from '../assets/myd-lmx9x-official-serial-ports.png';
import './J23GuideDialog.css';

type PinRow = {
  pin: string;
  rgb: string;
  pad: string;
  uart: string;
  capture: string;
  noteZh?: string;
  noteEn?: string;
};

const pinRows: PinRow[] = [
  { pin: '1', rgb: '5V', pad: '—', uart: '—', capture: '—', noteZh: '5V 电源，勿接信号', noteEn: '5V supply; not a signal pin' },
  { pin: '2', rgb: '5V_1', pad: '—', uart: '—', capture: '—', noteZh: '5V 电源，勿接信号', noteEn: '5V supply; not a signal pin' },
  { pin: '3', rgb: '3V3', pad: '—', uart: '—', capture: '—', noteZh: '3.3V 电源，勿接信号', noteEn: '3.3V supply; not a signal pin' },
  { pin: '4', rgb: '3V3_1', pad: '—', uart: '—', capture: '—', noteZh: '3.3V 电源，勿接信号', noteEn: '3.3V supply; not a signal pin' },
  { pin: '5', rgb: 'GND0', pad: '—', uart: '—', capture: '—', noteZh: '地', noteEn: 'Ground' },
  { pin: '6', rgb: 'GND1', pad: '—', uart: '—', capture: '—', noteZh: '地', noteEn: 'Ground' },
  { pin: '7', rgb: 'B0', pad: 'GPIO_IO04', uart: 'UART6 TX', capture: 'TPM3 CH0', noteZh: '与板载 RS232 共线', noteEn: 'Shared with onboard RS232' },
  { pin: '8', rgb: 'B1', pad: 'GPIO_IO05', uart: 'UART6 RX', capture: 'TPM4 CH0', noteZh: '与板载 RS232 共线', noteEn: 'Shared with onboard RS232' },
  { pin: '9', rgb: 'B2', pad: 'GPIO_IO06', uart: 'UART6 CTS', capture: 'TPM5 CH0', noteZh: '也可作 FLEXIO PWM/DSHOT 输出', noteEn: 'Also FLEXIO PWM/DSHOT output' },
  { pin: '10', rgb: 'B3', pad: 'GPIO_IO07', uart: 'UART6 RTS', capture: '—', noteZh: '也可作 FLEXIO PWM/DSHOT 输出', noteEn: 'Also FLEXIO PWM/DSHOT output' },
  { pin: '11', rgb: 'B4', pad: 'GPIO_IO08', uart: 'UART7 TX', capture: 'TPM6 CH0' },
  { pin: '12', rgb: 'B5', pad: 'GPIO_IO09', uart: 'UART7 RX', capture: '—', noteZh: 'TPM3 外部时钟，非捕获通道', noteEn: 'TPM3 external clock, not capture' },
  { pin: '13', rgb: 'B6', pad: 'GPIO_IO10', uart: 'UART7 CTS', capture: '—', noteZh: 'TPM4 外部时钟，非捕获通道', noteEn: 'TPM4 external clock, not capture' },
  { pin: '14', rgb: 'B7', pad: 'GPIO_IO11', uart: 'UART7 RTS', capture: '—', noteZh: 'TPM5 外部时钟，非捕获通道', noteEn: 'TPM5 external clock, not capture' },
  { pin: '15', rgb: 'G0', pad: 'GPIO_IO12', uart: 'UART8 TX', capture: 'TPM3 CH2' },
  { pin: '16', rgb: 'G1', pad: 'GPIO_IO13', uart: 'UART8 RX', capture: 'TPM4 CH2' },
  { pin: '17', rgb: 'G2', pad: 'GPIO_IO14', uart: 'UART3 TX / UART4 TX / UART8 CTS', capture: '—', noteZh: '与板载 RS485 共线', noteEn: 'Shared with onboard RS485' },
  { pin: '18', rgb: 'G3', pad: 'GPIO_IO15', uart: 'UART3 RX / UART4 RX / UART8 RTS', capture: '—', noteZh: '与板载 RS485 共线', noteEn: 'Shared with onboard RS485' },
  { pin: '19', rgb: 'G4', pad: 'GPIO_IO16', uart: 'UART3 CTS / UART4 CTS', capture: '—' },
  { pin: '20', rgb: 'G5', pad: 'GPIO_IO17', uart: 'UART3 RTS / UART4 RTS', capture: '—' },
  { pin: '21', rgb: 'G6', pad: 'GPIO_IO18', uart: '—', capture: 'TPM5 CH2' },
  { pin: '22', rgb: 'G7', pad: 'GPIO_IO19', uart: '—', capture: 'TPM6 CH2' },
  { pin: '23', rgb: 'R0', pad: 'GPIO_IO20', uart: '—', capture: 'TPM3 CH1' },
  { pin: '24', rgb: 'R1', pad: 'GPIO_IO21', uart: '—', capture: 'TPM4 CH1' },
  { pin: '25', rgb: 'R2', pad: 'GPIO_IO22', uart: '—', capture: 'TPM5 CH1', noteZh: '也可作 TPM6 外部时钟', noteEn: 'Also TPM6 external clock' },
  { pin: '26', rgb: 'R3', pad: 'GPIO_IO23', uart: '—', capture: 'TPM6 CH1' },
  { pin: '27', rgb: 'R4', pad: 'GPIO_IO24', uart: '—', capture: 'TPM3 CH3', noteZh: '也可作 TPM3 PWM 输出', noteEn: 'Also TPM3 PWM output' },
  { pin: '28', rgb: 'R5', pad: 'GPIO_IO25', uart: '—', capture: 'TPM4 CH3' },
  { pin: '29', rgb: 'R6', pad: 'GPIO_IO26', uart: '—', capture: 'TPM5 CH3' },
  { pin: '30', rgb: 'R7', pad: 'GPIO_IO27', uart: '—', capture: 'TPM6 CH3' },
  { pin: '40', rgb: 'DEN', pad: 'GPIO_IO01', uart: 'UART5 RX', capture: '—', noteZh: '已分配 UART5；与 SPI6 MISO 复用', noteEn: 'Assigned to UART5; shared with SPI6 MISO' },
  { pin: '41', rgb: 'VSYNC', pad: 'GPIO_IO02', uart: 'UART5 CTS', capture: '—', noteZh: '可与 SPI6 MOSI 复用；当前未启用', noteEn: 'Alternative SPI6 MOSI mux; currently unused' },
  { pin: '42', rgb: 'HYSNC', pad: 'GPIO_IO03', uart: 'UART5 RTS', capture: '—', noteZh: '可与 SPI6 SCK 复用；当前未启用', noteEn: 'Alternative SPI6 SCK mux; currently unused' },
  { pin: '43', rgb: 'PCLK', pad: 'GPIO_IO00', uart: 'UART5 TX', capture: '—', noteZh: '已分配 UART5；与 SPI6 片选复用', noteEn: 'Assigned to UART5; shared with SPI6 chip select' },
];

const headerRows = Array.from({ length: 25 }, (_, index) => ({
  row: index + 1,
  leftPin: index * 2 + 1,
  rightPin: index * 2 + 2,
}));

const serialFirstPwmCapturePins = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);

const captureDevices = [
  ['0', '21 · G6', 'TPM5 CH2'], ['1', '22 · G7', 'TPM6 CH2'],
  ['2', '23 · R0', 'TPM3 CH1'], ['3', '24 · R1', 'TPM4 CH1'],
  ['4', '25 · R2', 'TPM5 CH1'], ['5', '26 · R3', 'TPM6 CH1'],
  ['6', '27 · R4', 'TPM3 CH3'], ['7', '28 · R5', 'TPM4 CH3'],
  ['8', '29 · R6', 'TPM5 CH3'], ['9', '30 · R7', 'TPM6 CH3'],
];

const otherPinDetails: Record<number, { label: string; functionZh: string; functionEn: string }> = {
  31: { label: 'GND2', functionZh: '接地', functionEn: 'Ground' },
  32: { label: 'BL_CN', functionZh: 'PDM_DATA1 / 背光 PWM', functionEn: 'PDM_DATA1 / backlight PWM' },
  33: { label: 'RESET', functionZh: 'PWR_EN_R1', functionEn: 'PWR_EN_R1' },
  34: { label: 'DISP', functionZh: 'PWR_EN_R2', functionEn: 'PWR_EN_R2' },
  35: { label: 'TP_INTn', functionZh: 'GPIO_IO28', functionEn: 'GPIO_IO28' },
  36: { label: 'TP_RESET', functionZh: 'TP_RESET_R', functionEn: 'TP_RESET_R' },
  37: { label: 'TWC', functionZh: 'I²C2 SCL', functionEn: 'I²C2 SCL' },
  38: { label: 'TWO', functionZh: 'I²C2 SDA', functionEn: 'I²C2 SDA' },
  39: { label: 'GND3', functionZh: '接地', functionEn: 'Ground' },
  44: { label: 'GND4', functionZh: '接地', functionEn: 'Ground' },
  45: { label: 'XR', functionZh: '显示屏 FPC 信号', functionEn: 'Display FPC signal' },
  46: { label: 'XL', functionZh: '显示屏 FPC 信号', functionEn: 'Display FPC signal' },
  47: { label: 'YD', functionZh: '显示屏 FPC 信号', functionEn: 'Display FPC signal' },
  48: { label: 'YU', functionZh: '显示屏 FPC 信号', functionEn: 'Display FPC signal' },
  49: { label: 'LR', functionZh: '显示屏 FPC 信号', functionEn: 'Display FPC signal' },
  50: { label: 'GND5', functionZh: '接地', functionEn: 'Ground' },
};

function getHeaderPinDetail(pin: number, isZh: boolean) {
  const row = pinRows.find(item => Number(item.pin) === pin);
  if (row) {
    const functions = [row.uart, row.capture].filter(value => value !== '—');
    return { label: row.rgb, detail: functions.join(' / ') };
  }
  const other = otherPinDetails[pin];
  return { label: other.label, detail: isZh ? other.functionZh : other.functionEn };
}

interface J23GuideDialogProps {
  onClose: () => void;
}

export default function J23GuideDialog({ onClose }: J23GuideDialogProps) {
  const { isZh } = useLanguage();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className="j23-guide-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="j23-guide-dialog" role="dialog" aria-label={isZh ? '使用说明：J23 RGB 50 针扩展' : 'User Guide: J23 RGB 50-pin Expansion'}>
      <header className="j23-guide-header">
        <div>
          <h2>{isZh ? '使用说明 · J23 RGB 50 针扩展' : 'User Guide · J23 RGB 50-pin Expansion'}</h2>
          <p>{isZh ? '适用于 MYD-LMX9X 底板；脚号依据 MYB-LMX9X-V10-240408 原理图' : 'For the MYD-LMX9X carrier; pin numbers follow schematic MYB-LMX9X-V10-240408'}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={isZh ? '关闭使用说明' : 'Close user guide'}>×</button>
      </header>
      <div className="j23-guide-body">
        <section>
          <h3>{isZh ? '接线要点' : 'Wiring'}</h3>
          <ol>
            <li>{isZh ? '下方双排针图按转接板照片中的方向和提供的编号顺序绘制：FPC 在左、排针在右，逐行从上到下。接线前请断电并用万用表逐脚核对转接板与 J23 FPC 的对应关系。' : 'The 2×25 header diagram follows the supplied numbering with the FPC on the left and header on the right, top to bottom. Before wiring, power off and verify each breakout-to-J23 connection with a continuity meter.'}</li>
            <li>{isZh ? 'UART 用 3.3V TTL 电平：板端 TX 接模块 RX，板端 RX 接模块 TX，双方共地。RS232、RS485 模块需要对应收发器，不能直连 TTL 脚。' : 'Use 3.3V TTL UART: board TX to module RX, board RX to module TX, and common ground. RS232/RS485 needs a matching transceiver.'}</li>
            <li>{isZh ? '本固件将 UART5（43 TX、40 RX）和 SPI6 冲突脚分配给 UART5。UART3 的 17/18 脚与板载 RS485 共线；使用板载收发器时，向 /dev/rs485_dir 写入 1 进入发送，待 ttyS2 发完后写入 0 返回接收。' : 'This firmware assigns the shared UART5/SPI6 pads to UART5. UART3 pins 17/18 also feed onboard RS485; write 1 to /dev/rs485_dir to transmit, then write 0 after ttyS2 has drained to receive.'}</li>
            <li>{isZh ? '捕获 PWM 时，将 3.3V 信号接到所选 TPM CH 引脚并共地；TPM EXTCLK 只是外部时钟输入，不算 PWM 捕获通道。' : 'For PWM input capture, connect a 3.3V signal to a TPM CH pin and share ground. TPM EXTCLK is an external clock input, not a PWM capture channel.'}</li>
          </ol>
        </section>
        <section className="j23-guide-summary">
          <h3>{isZh ? '数量与当前固件' : 'Capacity and current firmware'}</h3>
          <p>{isZh ? '固件配置同时启用 J23 的 5 路两线串口（UART6/7/8/3/5）和 10 路 PWM 输入捕获（21～30 脚）。SPI6 已关闭；9 脚保留作 UART6 CTS 的可选复用，不列入本次 10 路。' : 'The firmware config enables five two-wire J23 UARTs (6/7/8/3/5) and ten PWM inputs (pins 21–30) together. SPI6 is disabled; pin 9 remains an optional UART6 CTS mux and is not one of these ten captures.'}</p>
          <p>{isZh ? '“串口传感器”的设备选项现包含 J23 的 /dev/ttyS2、S4、S5、S6、S7；另保留 /dev/ttyS1（UART2，非 J23）供现有 HIL/Viztra 配置使用。/dev/ttyS0 是调试控制台，UART4 未启用，因此不提供 S0/S3。' : 'The Serial Sensor device selector includes J23 ports /dev/ttyS2, S4, S5, S6 and S7. It also retains /dev/ttyS1 (UART2, not on J23) for existing HIL/Viztra configurations. ttyS0 is the debug console and UART4 is disabled, so S0/S3 are not offered.'}</p>
          <p>{isZh ? '这是固件设备分配；实际信号电平、频率范围和 10 路并发捕获还需在板上验证。' : 'These are firmware device assignments. Signal levels, frequency range, and concurrent ten-channel capture still require board validation.'}</p>
        </section>
        <section>
          <h3>{isZh ? '官方接口示意图中的串口位置' : 'Serial ports in the official board diagram'}</h3>
          <p className="j23-guide-photo-intro">{isZh ? '米尔官方开发板概览第 2 页的正面接口图；彩色框突出串口相关位置。RGB 本身是显示接口，UART 功能需按下方脚号表复用。' : 'Top-view diagram from page 2 of MYIR’s official board overview. Colored outlines highlight serial-related connectors. RGB is a display connector; UART functions require the pin mux shown below.'}</p>
          <div className="j23-guide-photo-layout">
            <figure className="j23-guide-board-photo">
              <div className="j23-guide-board-photo-image">
                <img src={boardSerialPortsImage} alt={isZh ? '米尔官方 MYD-LMX9X 开发板正面接口图，标有 A55 Debug、M33 Debug、RS232/RS485/CAN 和 RGB' : 'Official MYIR MYD-LMX9X top-view connector diagram with A55 Debug, M33 Debug, RS232/RS485/CAN and RGB labels'} />
                <span className="j23-guide-photo-highlight j23-guide-photo-highlight--a55" aria-hidden="true"><b>1</b></span>
                <span className="j23-guide-photo-highlight j23-guide-photo-highlight--m33" aria-hidden="true"><b>2</b></span>
                <span className="j23-guide-photo-highlight j23-guide-photo-highlight--terminal" aria-hidden="true"><b>3</b></span>
                <span className="j23-guide-photo-highlight j23-guide-photo-highlight--rgb" aria-hidden="true"><b>4</b></span>
              </div>
              <figcaption>{isZh ? '图源：米尔电子《MYD-LMX9X Development Board Overview》第 2 页；J14/J15、J7、J23 座号依据底板原理图。' : 'Source: MYIR, MYD-LMX9X Development Board Overview, page 2. J14/J15, J7 and J23 references follow the base-board schematic.'} <a href="https://www.myirtech.com/download/IMX9/MYD-LMX9X.pdf" target="_blank" rel="noopener noreferrer">{isZh ? '查看官方原文' : 'Official PDF'}</a></figcaption>
            </figure>
            <div className="j23-guide-photo-key">
              <div><span className="j23-guide-photo-key-number j23-guide-photo-key-number--a55">1</span><div><strong>J14 · A55 Debug</strong><p>{isZh ? 'UART1，/dev/ttyS0，调试控制台。' : 'UART1, /dev/ttyS0, debug console.'}</p></div></div>
              <div><span className="j23-guide-photo-key-number j23-guide-photo-key-number--m33">2</span><div><strong>J15 · M33 Debug</strong><p>{isZh ? 'UART2，/dev/ttyS1；不在 J23 上。' : 'UART2, /dev/ttyS1; not on J23.'}</p></div></div>
              <div><span className="j23-guide-photo-key-number j23-guide-photo-key-number--terminal">3</span><div><strong>J7 · RS232 / RS485 / CAN</strong><p>{isZh ? '端子 1/2 为 RS232 TX/RX（UART6）；4/5 为 RS485 A/B（UART3）。' : 'Terminals 1/2 are RS232 TX/RX (UART6); 4/5 are RS485 A/B (UART3).'}</p></div></div>
              <div><span className="j23-guide-photo-key-number j23-guide-photo-key-number--rgb">4</span><div><strong>J23 · RGB FPC</strong><p>{isZh ? '50 针显示座经转接板复用 UART6/7/8/3/5；TX/RX 脚号见下方表格。' : 'The 50-pin display connector exposes UART6/7/8/3/5 through the breakout; see TX/RX pin table below.'}</p></div></div>
            </div>
          </div>
        </section>
        <section>
          <h3>{isZh ? '串口优先的引脚分配' : 'Serial-first pin allocation'}</h3>
          <div className="j23-guide-table-scroll">
            <table>
              <thead><tr><th>{isZh ? '串口' : 'UART'}</th><th>{isZh ? '设备' : 'Device'}</th><th>TX</th><th>RX</th><th>{isZh ? '说明' : 'Note'}</th></tr></thead>
              <tbody>
                <tr><td>UART6</td><td>/dev/ttyS5</td><td>7 · B0</td><td>8 · B1</td><td>{isZh ? '与板载 RS232 共线' : 'Shared with onboard RS232'}</td></tr>
                <tr><td>UART7</td><td>/dev/ttyS6</td><td>11 · B4</td><td>12 · B5</td><td>3.3V TTL</td></tr>
                <tr><td>UART8</td><td>/dev/ttyS7</td><td>15 · G0</td><td>16 · G1</td><td>3.3V TTL</td></tr>
                <tr><td>UART3</td><td>/dev/ttyS2</td><td>17 · G2</td><td>18 · G3</td><td>{isZh ? '与板载 RS485 共线；/dev/rs485_dir 控制方向' : 'Shared with onboard RS485; /dev/rs485_dir controls direction'}</td></tr>
                <tr><td>UART5</td><td>/dev/ttyS4</td><td>43 · PCLK</td><td>40 · DEN</td><td>{isZh ? '占用原 SPI6 引脚' : 'Uses former SPI6 pins'}</td></tr>
              </tbody>
            </table>
          </div>
          <p>{isZh ? '打开 /dev/capture0～9 后，以 CAPIOC_ALL 读取频率、占空比和边沿数；至少等待完整脉冲周期。驱动采用 TPM 计数器捕获，上位机读数前请先在板端确认设备已注册。' : 'Open /dev/capture0–9 and use CAPIOC_ALL to read frequency, duty, and edge count after a full pulse cycle. Verify device registration on the board before reading from the host.'}</p>
          <p>{isZh ? '给模型输入时，在左侧「协议」添加一个“PWM 捕获 Hardware Input”，在模块中添加多路捕获通道；每路选择下表设备并填写各自的 JSBSim 输入属性。默认将 1000～2000 μs 映射到 -1～1；各路可分别调整范围、丢信号超时和安全值，单模块最多 10 路。保存到仿真机后重启该模型，配置写入 config/models/模型名.pwm.xml。' : 'To feed model inputs, add one “PWM Capture Hardware Input” from Protocol and add capture channels inside it. Each channel selects a device below and its own JSBSim input property. Each maps 1000–2000 μs to -1–1 by default and can have its own range, timeout and failsafe; one module supports up to ten channels. Save to the simulator and restart the model to load config/models/model.pwm.xml.'}</p>
          <div className="j23-guide-table-scroll"><table><thead><tr><th>{isZh ? '捕获设备' : 'Capture device'}</th><th>{isZh ? 'J23 脚号' : 'J23 pin'}</th><th>TPM</th></tr></thead><tbody>{captureDevices.map(([index, pin, tpm]) => <tr key={index}><td>/dev/capture{index}</td><td>{pin}</td><td>{tpm}</td></tr>)}</tbody></table></div>
        </section>
        <section>
          <h3>{isZh ? '转接板双排针示意（2×25）' : 'Breakout header diagram (2×25)'}</h3>
          <p className="j23-guide-diagram-caption">{isZh ? '按照片方向查看：FPC 在左，排针在右；第 1 行位于最上方。每行左列是奇数脚，右列是偶数脚。' : 'As photographed: FPC on the left, header on the right, row 1 at the top. Odd pins are on the left; even pins are on the right.'}</p>
          <p className="j23-guide-diagram-legend"><span className="j23-guide-diagram-capture-badge">{isZh ? 'PWM 捕获' : 'PWM capture'}</span>{isZh ? '绿色标记为本固件分配的 21～30 脚，共 10 路。9 脚具备 TPM5 CH0 复用能力，但本固件未启用。' : 'Green marks the ten firmware-assigned pins 21–30. Pin 9 can mux TPM5 CH0 but is not enabled in this build.'}</p>
          <div className="j23-guide-diagram-scroll">
            <div className="j23-guide-diagram">
              <div className="j23-guide-diagram-fpc">FPC</div>
              <div className="j23-guide-diagram-pins">
                <div className="j23-guide-diagram-head"><span>{isZh ? '行' : 'Row'}</span><span>{isZh ? '左列脚号与功能' : 'Left pin and function'}</span><span>{isZh ? '右列脚号与功能' : 'Right pin and function'}</span></div>
                {headerRows.map(({ row, leftPin, rightPin }) => <div className="j23-guide-diagram-row" key={row}>
                  <span className="j23-guide-diagram-row-number">{row}</span>
                  {[leftPin, rightPin].map(pin => {
                    const { label, detail } = getHeaderPinDetail(pin, isZh);
                    const isPwmCaptureCandidate = serialFirstPwmCapturePins.has(pin);
                    return <span className={`j23-guide-diagram-pin-cell${isPwmCaptureCandidate ? ' j23-guide-diagram-pin-cell--capture' : ''}`} key={pin}>
                      <span className="j23-guide-diagram-pin">{pin}</span>
                      <span className="j23-guide-diagram-pin-function"><strong>{label}</strong>{detail && <span> · {detail}</span>}</span>
                      {isPwmCaptureCandidate && <span className="j23-guide-diagram-capture-badge">{isZh ? 'PWM 捕获' : 'PWM capture'}</span>}
                    </span>;
                  })}
                </div>)}
              </div>
            </div>
          </div>
        </section>
        <section>
          <h3>{isZh ? 'J23 引脚对应表' : 'J23 pin map'}</h3>
          <div className="j23-guide-table-scroll">
            <table>
              <thead><tr>
                <th>{isZh ? 'J23 脚号' : 'J23 pin'}</th><th>{isZh ? 'J23 标识' : 'J23 label'}</th><th>{isZh ? 'SoC 引脚' : 'SoC pad'}</th>
                <th>{isZh ? 'UART 可选功能' : 'UART mux option'}</th><th>{isZh ? 'PWM 捕获可选功能' : 'PWM capture mux option'}</th>
                <th>{isZh ? '提醒' : 'Notes'}</th>
              </tr></thead>
              <tbody>{pinRows.map(row => <tr key={row.pin}>
                <td>{row.pin}</td><td>{row.rgb}</td><td>{row.pad}</td><td>{row.uart}</td><td>{row.capture}</td>
                <td>{(isZh ? row.noteZh : row.noteEn) || '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="j23-guide-footnote">{isZh ? 'J23：1、2 = 5V；3、4 = 3.3V；5、6、31、39、44、50 = GND。UART1/2 不经过 J23。HYSNC 为原理图原文。' : 'J23: pins 1–2 = 5V; 3–4 = 3.3V; 5, 6, 31, 39, 44, 50 = GND. UART1/2 are not on J23. HYSNC follows the schematic label.'}</p>
        </section>
      </div>
      <footer><button type="button" onClick={onClose}>{isZh ? '关闭' : 'Close'}</button></footer>
    </div>
  </div>;
}
