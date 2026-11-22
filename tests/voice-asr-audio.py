#!/usr/bin/env python3
"""Exercise real WAV decoding/resampling with the installed ASR dependencies."""
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch
import wave

import av
import numpy as np

spec = importlib.util.spec_from_file_location('asr_service', Path(__file__).resolve().parents[1] / 'tools/voice-service/asr_server.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def wav(rate, channels):
    frames = np.full((rate // 10, channels), 8192, dtype='<i2')
    if channels == 2:
        frames[:, 1] = -4096
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(frames.tobytes())
    return stream.getvalue()


class AudioTests(unittest.TestCase):
    def test_real_decode_and_resample_without_av_open(self):
        # This reproduces the removed API: the decoder must never call av.open.
        with patch.object(av, 'open', side_effect=TypeError('unexpected keyword metadata_errors')):
            for rate in (8000, 16000, 44100, 48000):
                for channels in (1, 2):
                    with self.subTest(rate=rate, channels=channels):
                        data = wav(rate, channels)
                        self.assertAlmostEqual(service.audio_info(data)[0], .1)
                        samples = service.pcm_audio(data)
                        self.assertEqual(samples.dtype, np.float32)
                        self.assertEqual(samples.ndim, 1)
                        self.assertEqual(len(samples), 1600)
                        self.assertTrue(samples.flags.c_contiguous)
                        expected = .25 if channels == 1 else .0625
                        np.testing.assert_allclose(samples[100:-100], expected, atol=1e-4)


if __name__ == '__main__':
    unittest.main(verbosity=2)
