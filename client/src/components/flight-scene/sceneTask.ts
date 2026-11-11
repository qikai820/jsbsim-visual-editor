// Bound asynchronous local reads/decodes, and dispose results that arrive after
// cancellation. A cancelled load must never replace the current scene.
export function waitForSceneTask<T>(task: Promise<T>, signal: AbortSignal, label: string,
  onLateResult?: (result: T) => void, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
    };
    const abort = () => fail(new Error('已取消场景加载，保留原场景'));
    task.then(result => {
      if (settled) { onLateResult?.(result); return; }
      settled = true; cleanup(); resolve(result);
    }, fail);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => fail(new Error(`${label}超过 ${timeoutMs / 1000} 秒，保留原场景；请检查文件后重试`)), timeoutMs);
  });
}
