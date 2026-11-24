#!/usr/bin/env python3
"""Local Piper speech synthesis with the WAV API used by the desktop."""
import argparse
import hmac
import io
import json
import os
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 16 * 1024
MAX_AUDIO = 4 * 1024 * 1024


def parse_request(data, model, voice):
    def object_fields(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON field')
            result[key] = value
        return result

    value = json.loads(data, object_pairs_hook=object_fields)
    if not isinstance(value, dict) or set(value) - {'model', 'input', 'voice', 'response_format'}:
        raise ValueError('Expected a speech request JSON object')
    text = value.get('input')
    if not isinstance(text, str) or not text.strip() or len(text) > 1000:
        raise ValueError('Speech input must contain 1 to 1000 characters')
    if value.get('model', model) != model:
        raise ValueError('The selected TTS model is not loaded by this service')
    if value.get('voice', voice) not in (voice, 'default'):
        raise ValueError('Unknown voice')
    if value.get('response_format', 'wav') != 'wav':
        raise ValueError('This local service supports WAV output only')
    return text.strip()


def synthesize(voice, text):
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as output:
        voice.synthesize_wav(text, output)
    data = audio.getvalue()
    if not 44 < len(data) <= MAX_AUDIO:
        raise ValueError('Synthesized audio is empty or exceeds 4 MiB; use shorter text')
    return data


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def reply(self, status, value, content_type='application/json; charset=utf-8'):
        data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A cancelled desktop request can close the connection.

    def authenticated(self):
        expected = self.server.api_key
        if expected and not hmac.compare_digest(self.headers.get('Authorization', '').encode('utf-8'),
                                               ('Bearer ' + expected).encode('utf-8')):
            self.reply(401, {'error': 'Authentication required'})
            return False
        return True

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path == '/health':
            self.reply(200, {'ready': True, 'model': self.server.model_name,
                             'voices': [self.server.voice_name], 'language': 'zh-CN'})
        elif self.path == '/v1/models':
            self.reply(200, {'data': [{'id': self.server.model_name, 'object': 'model'}]})
        else:
            self.reply(404, {'error': 'Unknown endpoint'})

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path != '/v1/audio/speech':
            self.reply(404, {'error': 'Unknown endpoint'})
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self.reply(429, {'error': 'Speech synthesis is busy'})
            return
        try:
            if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                raise ValueError('Expected application/json')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                raise ValueError('Expected a Content-Length between 1 and 16384 bytes')
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError('Incomplete speech request')
            text = parse_request(data, self.server.model_name, self.server.voice_name)
            self.reply(200, synthesize(self.server.voice, text), 'audio/wav')
        except (ValueError, UnicodeError) as error:
            # Parser errors contain fixed messages or JSON locations, never input text.
            self.reply(400, {'error': str(error)})
        except Exception as error:
            print('[TTS] synthesis failed: ' + type(error).__name__, file=sys.stderr, flush=True)
            self.reply(500, {'error': f'Speech synthesis failed ({type(error).__name__}); check the local service console'})
        finally:
            self.server.inference_lock.release()

    def log_message(self, *args):
        pass  # Do not retain speech text, audio or authentication headers.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, help='Path to a local Piper ONNX voice model')
    parser.add_argument('--name', default='piper-zh-cn', help='Model name exposed to the desktop')
    parser.add_argument('--voice', default='huayan', help='Voice name exposed to the desktop')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8179)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not args.name or not args.voice:
        parser.error('Invalid service port, model name or voice name')
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    from piper import PiperVoice
    voice = PiperVoice.load(args.model, use_cuda=False)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.voice = voice
    server.model_name = args.name
    server.voice_name = args.voice
    server.api_key = os.environ.get('VOICE_TTS_API_KEY', '')
    server.inference_lock = threading.Lock()
    print(f'[TTS] ready http://{args.host}:{args.port}/v1, model={args.name}, voice={args.voice}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
