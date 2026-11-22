#!/usr/bin/env python3
"""Small local WAV transcription service; model work uses faster-whisper."""
import argparse
import array
import hmac
import io
import json
import math
import os
import sys
import threading
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_AUDIO = 4 * 1024 * 1024


def parse_form(content_type, body):
    if len(body) > MAX_AUDIO or not content_type.startswith('multipart/form-data;'):
        raise ValueError('Expected multipart/form-data, up to 4 MiB')
    message = BytesParser(policy=policy.default).parsebytes(
        b'Content-Type: ' + content_type.encode('ascii') + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
    if not message.is_multipart():
        raise ValueError('Invalid multipart boundary')
    fields = {}
    for part in message.iter_parts():
        name = part.get_param('name', header='Content-Disposition')
        if name not in ('file', 'model', 'language', 'response_format') or name in fields:
            raise ValueError('Unknown or duplicate form field')
        data = part.get_payload(decode=True)
        fields[name] = data if name == 'file' else data.decode('utf-8').strip()
    if not fields.get('file') or fields.get('response_format', 'json') != 'json':
        raise ValueError('Audio file and JSON response format are required')
    return fields


def audio_info(data):
    if len(data) > MAX_AUDIO:
        raise ValueError('Audio is too large')
    try:
        with wave.open(io.BytesIO(data), 'rb') as audio:
            if audio.getnchannels() not in (1, 2) or audio.getsampwidth() != 2 or not 8000 <= audio.getframerate() <= 48000:
                raise ValueError('Expected 16-bit PCM WAV, mono/stereo, 8-48 kHz')
            duration = audio.getnframes() / audio.getframerate()
            if not 0 < duration <= 65:
                raise ValueError('Audio duration must be between 0 and 65 seconds')
            expected_size = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            frames = audio.readframes(audio.getnframes())
            if len(frames) != expected_size:
                raise ValueError('WAV data is truncated')
    except (wave.Error, EOFError) as error:
        raise ValueError('Invalid WAV audio') from error
    samples = array.array('h', frames)
    if sys.byteorder != 'little':
        samples.byteswap()
    energy = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))
    return duration, energy


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled recognition must not be treated as a control action.

    def authenticated(self):
        expected = self.server.api_key
        if expected and not hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'), ('Bearer ' + expected).encode('utf-8')):
            self.reply(401, {'error': 'Authentication required'})
            return False
        return True

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path == '/health':
            self.reply(200, {'ready': True, 'model': self.server.model_name})
        elif self.path == '/v1/models':
            self.reply(200, {'data': [{'id': self.server.model_name, 'object': 'model'}]})
        else:
            self.reply(404, {'error': 'Unknown endpoint'})

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path != '/v1/audio/transcriptions':
            self.reply(404, {'error': 'Unknown endpoint'})
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self.reply(429, {'error': 'Speech recognition is busy'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_AUDIO:
                raise ValueError('A Content-Length between 1 and 4 MiB is required')
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError('Incomplete audio upload')
            fields = parse_form(self.headers.get('Content-Type', ''), body)
            if fields.get('model', self.server.model_name) != self.server.model_name:
                raise ValueError('The selected ASR model is not loaded by this service')
            language = fields.get('language', 'zh')
            if not language or len(language) > 12 or not language.replace('-', '').isalpha():
                raise ValueError('Invalid language')
            duration, energy = audio_info(fields['file'])
            if energy < 80:
                text = ''
            else:
                segments, _ = self.server.transcriber.transcribe(
                    io.BytesIO(fields['file']), language=language, beam_size=3,
                    vad_filter=True, condition_on_previous_text=False)
                text = ''.join(segment.text for segment in segments).strip()
            self.reply(200, {'text': text, 'duration': duration})
        except (ValueError, OSError) as error:
            self.reply(400, {'error': str(error)})
        except Exception as error:
            print('[ASR] inference failed: ' + type(error).__name__, file=sys.stderr, flush=True)
            self.reply(500, {'error': 'Speech recognition failed; check the local service console'})
        finally:
            self.server.inference_lock.release()

    def log_message(self, *args):
        pass  # Do not retain audio, transcripts or authorization headers.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default='small', help='faster-whisper model ID or an existing model directory')
    parser.add_argument('--name', help='model name exposed to the upper computer (defaults to --model)')
    parser.add_argument('--device', choices=('cpu', 'cuda', 'auto'), default='cpu')
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8178)
    parser.add_argument('--download-root', default=None)
    parser.add_argument('--check-proxy', action='store_true', help='validate download proxy/client without downloading a model or opening a port')
    args = parser.parse_args()
    if not 1 <= args.threads <= 128 or not 1 <= args.port <= 65535:
        parser.error('Invalid thread count or port')
    if args.check_proxy or not os.path.isdir(args.model):
        from download_env import ProxyConfigurationError, prepare_download_environment
        try:
            for message in prepare_download_environment():
                print('[ASR] ' + message, flush=True)
        except ProxyConfigurationError as error:
            print('[ASR] ' + str(error), file=sys.stderr)
            return 2
    if args.check_proxy:
        try:
            from huggingface_hub.utils import get_session
            get_session().close()
        except (ImportError, ValueError) as error:
            print(f'[ASR] 下载客户端初始化失败（{type(error).__name__}）；请检查代理并运行 voice-service.sh install 补齐依赖。', file=sys.stderr)
            return 2
        print('[ASR] 下载代理与客户端配置检查通过（未发起网络请求、未下载模型）。', flush=True)
        return 0
    from faster_whisper import WhisperModel
    transcriber = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                              cpu_threads=args.threads, download_root=args.download_root)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.transcriber = transcriber
    server.model_name = args.name or args.model
    server.inference_lock = threading.Lock()
    server.api_key = os.environ.get('VOICE_ASR_API_KEY', '')
    print(f'[ASR] ready http://{args.host}:{args.port}/v1, model={server.model_name}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    raise SystemExit(main())
