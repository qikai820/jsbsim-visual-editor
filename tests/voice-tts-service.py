#!/usr/bin/env python3
"""Exercise the desktop's WAV TTS API without a model or network socket."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import threading
from types import SimpleNamespace
from unittest.mock import patch
import wave

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tts_service', root / 'tools/voice-service/tts_server.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class Voice:
    def __init__(self):
        self.texts = []

    def synthesize_wav(self, text, output):
        self.texts.append(text)
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(22050)
        output.writeframes(struct.pack('<hh', 1000, -1000) * 2205)


class MemorySocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, *args, **kwargs):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, value):
        pass


voice = Voice()
server = SimpleNamespace(api_key='', model_name='piper-zh-cn', voice_name='huayan',
                         inference_lock=threading.Lock(), voice=voice)


def request(method, path, body=b'', headers=None):
    values = {'Content-Type': 'application/json', 'Content-Length': str(len(body)), **(headers or {})}
    raw = f'{method} {path} HTTP/1.0\r\n'.encode() + b''.join(
        f'{key}: {value}\r\n'.encode() for key, value in values.items()) + b'\r\n' + body
    stream = MemorySocket(raw)
    service.Handler(stream, ('127.0.0.1', 10000), server)
    head, payload = bytes(stream.output).split(b'\r\n\r\n', 1)
    return int(head.split(b' ')[1]), head, payload


body = {'model': 'piper-zh-cn', 'input': '中文播报已启用。', 'voice': 'huayan', 'response_format': 'wav'}
encoded = json.dumps(body).encode()
assert json.loads(request('GET', '/health')[2])['ready'] is True
assert json.loads(request('GET', '/v1/models')[2])['data'][0]['id'] == 'piper-zh-cn'
status, headers, audio = request('POST', '/v1/audio/speech', encoded)
assert status == 200 and b'Content-Type: audio/wav' in headers
with wave.open(io.BytesIO(audio), 'rb') as wav:
    assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 22050)
    assert wav.getnframes() == 4410
assert voice.texts == [body['input']]
assert request('POST', '/v1/audio/speech', json.dumps({'input': '测试', 'voice': 'default'}).encode())[0] == 200

for change in [{'input': ''}, {'input': 1}, {'input': '字' * 1001}, {'model': 'wrong'},
               {'voice': 'wrong'}, {'response_format': 'mp3'}, {'unexpected': 'field'}]:
    assert request('POST', '/v1/audio/speech', json.dumps({**body, **change}).encode())[0] == 400
for malformed in [b'[]', b'{broken', b'\xff', b'{"input":"one","input":"two"}']:
    assert request('POST', '/v1/audio/speech', malformed)[0] == 400
assert request('POST', '/v1/audio/speech', encoded, {'Content-Type': 'text/plain'})[0] == 400
assert request('POST', '/v1/audio/speech', encoded, {'Content-Length': str(len(encoded) + 1)})[0] == 400
assert request('POST', '/v1/audio/speech', encoded, {'Content-Length': str(service.MAX_BODY + 1)})[0] == 400
assert not server.inference_lock.locked()
server.inference_lock.acquire()
assert request('POST', '/v1/audio/speech', encoded)[0] == 429
server.inference_lock.release()
with patch.object(voice, 'synthesize_wav', side_effect=RuntimeError('private input text')):
    status, _, error = request('POST', '/v1/audio/speech', encoded)
    assert status == 500 and b'private input text' not in error
assert not server.inference_lock.locked()
server.api_key = 'test-key'
assert request('GET', '/health')[0] == 401
assert request('GET', '/health', headers={'Authorization': 'Bearer test-key'})[0] == 200
server.api_key = ''
assert request('POST', '/unknown')[0] == 404
assert request('GET', '/unknown')[0] == 404
with patch.object(service, 'MAX_AUDIO', 100):
    assert request('POST', '/v1/audio/speech', encoded)[0] == 400
print('TTS HTTP integration PASS: real handler, Chinese/WAV, health/models, authentication, input validation, busy and failure cleanup')
