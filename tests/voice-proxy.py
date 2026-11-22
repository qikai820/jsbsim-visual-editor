#!/usr/bin/env python3
"""Exercise ASR download proxy setup without network access or model weights."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SERVICE_DIR = Path(__file__).resolve().parents[1] / 'tools/voice-service'
sys.path.insert(0, str(SERVICE_DIR))
import download_env
import asr_server


class ProxyTests(unittest.TestCase):
    def prepare(self, env, installed=True):
        return download_env.prepare_download_environment(env, lambda name: installed)

    def test_mixed_http_and_legacy_socks_fallback(self):
        env = {
            'http_proxy': 'http://127.0.0.1:7890',
            'https_proxy': 'http://127.0.0.1:7890',
            'all_proxy': 'socks://127.0.0.1:7890/',
            'ALL_PROXY': 'socks://127.0.0.1:7890/',
            'NO_PROXY': 'localhost,127.0.0.1',
        }
        messages = self.prepare(env, installed=False)
        self.assertEqual(env, {
            'http_proxy': 'http://127.0.0.1:7890',
            'https_proxy': 'http://127.0.0.1:7890',
            'NO_PROXY': 'localhost,127.0.0.1',
        })
        self.assertTrue(any('SOCKS5' in message for message in messages))
        self.assertTrue(any('HTTP/HTTPS' in message for message in messages))

    def test_socks_credentials_preserved_and_not_logged(self):
        value = 'socks://user:private-password@127.0.0.1:7890/'
        env = {'ALL_PROXY': value}
        messages = self.prepare(env)
        self.assertEqual(env['ALL_PROXY'], value.replace('socks://', 'socks5://', 1))
        self.assertNotIn('private-password', str(messages))
        self.assertNotIn('user:', str(messages))

    def test_lower_case_including_empty_overrides_upper_case(self):
        env = {'http_proxy': '', 'HTTP_PROXY': 'ftp://invalid:12',
               'https_proxy': 'http://proxy.local', 'HTTPS_PROXY': 'ftp://invalid:12'}
        self.prepare(env, installed=False)
        self.assertEqual(env, {'http_proxy': '', 'https_proxy': 'http://proxy.local'})

    def test_active_socks_requires_dependencies_without_disabling_proxy(self):
        for env in ({'all_proxy': 'socks://127.0.0.1:7890'},
                    {'http_proxy': 'http://127.0.0.1:7890',
                     'all_proxy': 'socks5h://127.0.0.1:7890'}):
            with self.subTest(env=list(env)):
                with self.assertRaises(download_env.ProxyConfigurationError) as failure:
                    self.prepare(env, installed=False)
                self.assertIn('socksio', str(failure.exception))
                self.assertIn('PySocks', str(failure.exception))
                self.assertIn('voice-service.sh install', str(failure.exception))
                self.assertIn('all_proxy', env)

    def test_invalid_proxy_error_omits_secret(self):
        for value in ('ftp://user:secret@proxy:12', 'http://user:secret@proxy:bad',
                      'socks5://user:secret@', 'http://user:secret@proxy:70000'):
            with self.subTest(value=value):
                with self.assertRaises(download_env.ProxyConfigurationError) as failure:
                    self.prepare({'https_proxy': value})
                self.assertIn('https_proxy', str(failure.exception))
                self.assertNotIn('secret', str(failure.exception))

    def test_no_proxy(self):
        env = {'NO_PROXY': '*', 'UNRELATED': 'preserved'}
        self.assertEqual(self.prepare(env, installed=False), [])
        self.assertEqual(env, {'NO_PROXY': '*', 'UNRELATED': 'preserved'})

    def test_local_model_does_not_inspect_download_proxies(self):
        class ModelLoadReached(Exception):
            pass
        whisper = types.ModuleType('faster_whisper')
        whisper.WhisperModel = unittest.mock.Mock(side_effect=ModelLoadReached)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(sys, 'argv', ['asr_server.py', '--model', directory]), \
                patch.dict(sys.modules, {'faster_whisper': whisper}), \
                patch.object(download_env, 'prepare_download_environment') as prepare:
            with self.assertRaises(ModelLoadReached):
                asr_server.main()
            prepare.assert_not_called()

    def test_proxy_error_has_nonzero_exit_without_model_load(self):
        with patch.object(sys, 'argv', ['asr_server.py', '--check-proxy']), \
                patch.dict(os.environ, {'all_proxy': 'ftp://user:secret@proxy:12'}, clear=True), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(asr_server.main(), 2)
        self.assertIn('all_proxy', stderr.getvalue())
        self.assertNotIn('secret', stderr.getvalue())

    @unittest.skipUnless(importlib.util.find_spec('huggingface_hub'),
                         'Run with .toolchains/voice/bin/python to check installed download SDK')
    def test_installed_download_client_regression(self):
        from huggingface_hub import utils
        env = {'http_proxy': 'http://127.0.0.1:7890',
               'https_proxy': 'http://127.0.0.1:7890',
               'all_proxy': 'socks://127.0.0.1:7890/'}
        with patch.dict(os.environ, env, clear=True):
            # Reset a cached client if this SDK exposes the public hook.
            if hasattr(utils, 'close_session'):
                utils.close_session()
            self.prepare(os.environ, installed=False)
            client = utils.get_session()
            self.assertIsNotNone(client)
            client.close()
            if hasattr(utils, 'close_session'):
                utils.close_session()


if __name__ == '__main__':
    unittest.main(verbosity=2)
