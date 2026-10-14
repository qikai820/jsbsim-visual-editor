// Device names follow the i.MX93 LPUART number. UART4 is disabled, so ttyS3
// is deliberately absent. ttyS1 is the existing UART2 HIL/Viztra path and
// is not wired to J23.
export const SERIAL_SENSOR_DEVICES = [
  '/dev/ttyS1',
  '/dev/ttyS2',
  '/dev/ttyS4',
  '/dev/ttyS5',
  '/dev/ttyS6',
  '/dev/ttyS7',
] as const;

export const SERIAL_DEVICE_LABELS: Record<string, string> = {
  '/dev/ttyS1': '/dev/ttyS1 · UART2（非 J23）',
  '/dev/ttyS2': '/dev/ttyS2 · UART3 · J23 17/18（RS485 共线）',
  '/dev/ttyS4': '/dev/ttyS4 · UART5 · J23 43/40',
  '/dev/ttyS5': '/dev/ttyS5 · UART6 · J23 7/8（RS232 共线）',
  '/dev/ttyS6': '/dev/ttyS6 · UART7 · J23 11/12',
  '/dev/ttyS7': '/dev/ttyS7 · UART8 · J23 15/16',
};
