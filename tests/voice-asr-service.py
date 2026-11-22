#!/usr/bin/env python3
"""Test WAV and multipart validation without downloading a speech model."""
import importlib.util
import io
import struct
import json
import threading
from types import SimpleNamespace
import wave
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('asr_service',root/'tools/voice-service/asr_server.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
audio=io.BytesIO()
with wave.open(audio,'wb') as writer:
    writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(16000)
    writer.writeframes(struct.pack('<h',0)*1600)
data=audio.getvalue();duration,energy=service.audio_info(data)
assert duration==.1 and energy==0
def form(parts):
    return b''.join(b'--test\r\nContent-Disposition: form-data; name="'+name.encode()+b'"\r\n\r\n'+value+b'\r\n' for name,value in parts)+b'--test--\r\n'
fields=service.parse_form('multipart/form-data; boundary=test',form([('file',data),('model',b'small'),('language',b'zh')]))
assert fields['file']==data and fields['model']=='small'
for operation in [lambda:service.audio_info(b'not wav'),lambda:service.parse_form('application/json',b'{}'),lambda:service.parse_form('multipart/form-data; boundary=test',form([('file',data),('file',data)])),lambda:service.parse_form('multipart/form-data; boundary=test',form([('file',data),('command',b'bad')]))]:
    try:operation()
    except ValueError:pass
    else:raise AssertionError('invalid input accepted')
class MemorySocket:
    def __init__(self, request): self.input=io.BytesIO(request);self.output=bytearray()
    def makefile(self,*args,**kwargs): return self.input
    def sendall(self,data): self.output.extend(data)
    def settimeout(self,value): pass

class Transcriber:
    def __init__(self): self.calls=0
    def transcribe(self,*args,**kwargs):
        self.calls+=1
        assert kwargs['language']=='zh' and kwargs['vad_filter'] is True
        return iter([SimpleNamespace(text='暂停'),SimpleNamespace(text='仿真')]),None

transcriber=Transcriber()
server=SimpleNamespace(api_key='',model_name='small',inference_lock=threading.Lock(),transcriber=transcriber)
def request(method,path,body=b'',headers=None):
    values={'Content-Length':str(len(body)),**(headers or {})}
    raw=f'{method} {path} HTTP/1.0\r\n'.encode()+b''.join(f'{k}: {v}\r\n'.encode() for k,v in values.items())+b'\r\n'+body
    stream=MemorySocket(raw);service.Handler(stream,('127.0.0.1',10000),server)
    head,payload=bytes(stream.output).split(b'\r\n\r\n',1)
    return int(head.split(b' ')[1]),json.loads(payload)

assert request('GET','/health')==(200,{'ready':True,'model':'small'})
assert request('GET','/v1/models')[1]['data'][0]['id']=='small'
server.api_key='test-key'
assert request('GET','/health')[0]==401
assert request('GET','/health',headers={'Authorization':'Bearer test-key'})[0]==200
server.api_key=''
headers={'Content-Type':'multipart/form-data; boundary=test'}
status,result=request('POST','/v1/audio/transcriptions',form([('file',data),('model',b'small'),('language',b'zh')]),headers)
assert status==200 and result['text']=='' and transcriber.calls==0,'silence must not invoke the model'

spoken=io.BytesIO()
with wave.open(spoken,'wb') as writer:
    writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(16000)
    writer.writeframes(struct.pack('<hh',1000,-1000)*800)
status,result=request('POST','/v1/audio/transcriptions',form([('file',spoken.getvalue()),('model',b'small'),('language',b'zh')]),headers)
assert status==200 and result['text']=='暂停仿真' and transcriber.calls==1
assert request('POST','/v1/audio/transcriptions',form([('file',data),('model',b'wrong')]),headers)[0]==400
assert request('POST','/v1/audio/transcriptions',form([('file',data[:-20])]),headers)[0]==400
assert request('POST','/v1/audio/transcriptions',b'broken',headers)[0]==400
assert not server.inference_lock.locked(),'failed requests must release the inference lock'
server.inference_lock.acquire()
assert request('POST','/v1/audio/transcriptions',b'',headers)[0]==429
server.inference_lock.release()
assert request('POST','/unknown')[0]==404
print('ASR HTTP integration PASS: actual HTTP handler, authentication, health/models, silent/audio uploads, transcription, malformed/truncated audio, model mismatch and busy cleanup')
