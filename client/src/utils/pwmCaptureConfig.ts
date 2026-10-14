export const PWM_CAPTURE_DEVICES = Array.from({ length: 10 }, (_, index) => `/dev/capture${index}`);

export interface PwmCaptureChannel {
  name: string;
  device: string;
  property: string;
  min_us: number | string;
  max_us: number | string;
  output_min: number | string;
  output_max: number | string;
  failsafe: number | string;
  timeout_ms: number | string;
}

export function defaultPwmCaptureChannel(device: string, index: number): PwmCaptureChannel {
  return {
    name: `PWM ${index + 1}`,
    device,
    property: index === 0 ? 'fcs/aileron-cmd-norm' : '',
    min_us: 1000,
    max_us: 2000,
    output_min: -1,
    output_max: 1,
    failsafe: 0,
    timeout_ms: 500,
  };
}

// Existing projects stored one channel directly on the node. Keep that
// editable and serializable until the first channel-list edit migrates it.
export function getPwmCaptureChannels(params: Record<string, any> = {}): PwmCaptureChannel[] {
  if (params.channels !== undefined) {
    const raw = typeof params.channels === 'string' ? JSON.parse(params.channels) : params.channels;
    if (!Array.isArray(raw)) throw new Error('PWM 捕获通道列表格式无效');
    return raw.map((channel, index) => {
      if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
        throw new Error(`PWM 捕获通道 ${index + 1} 格式无效`);
      }
      return { ...defaultPwmCaptureChannel(String(channel.device || ''), index), ...channel };
    });
  }
  if (params.device !== undefined || params.property !== undefined) {
    return [{ ...defaultPwmCaptureChannel(String(params.device || ''), 0), ...params }];
  }
  return [];
}
