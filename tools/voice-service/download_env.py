"""Normalize download proxy settings inside the ASR child process only."""
import importlib.util
import os
from urllib.parse import urlsplit

PROXY_NAMES = ('http_proxy', 'https_proxy', 'all_proxy')
SUPPORTED_SCHEMES = {'http', 'https', 'socks5', 'socks5h'}


class ProxyConfigurationError(RuntimeError):
    pass


def effective_proxy(environ, name):
    # A lower-case setting, including an empty one, takes precedence.
    if name in environ:
        return environ[name]
    return environ.get(name.upper(), '')


def prepare_download_environment(environ=None, available=None):
    """Return non-secret diagnostics while retaining the selected proxy routes.

    HTTP clients eagerly initialize even unused ALL_PROXY transports. If both
    HTTP routes already have explicit HTTP(S) proxies, their redundant SOCKS
    fallback can be omitted without changing either download route.
    """
    if environ is None:
        environ = os.environ
    if available is None:
        available = lambda name: importlib.util.find_spec(name) is not None
    messages = []
    normalized = []
    for name in list(environ):
        if name.lower() not in PROXY_NAMES or not environ[name]:
            continue
        value = environ[name]
        if value.lower().startswith('socks://'):
            environ[name] = 'socks5://' + value[len('socks://'):]
            normalized.append(name)
    if normalized:
        messages.append('已兼容处理 ' + '、'.join(normalized) + ' 的 socks://，使用 SOCKS5 协议。')

    # Drop shadowed upper-case entries too: some SDKs inspect every entry.
    for name in PROXY_NAMES:
        if name in environ and name.upper() in environ:
            del environ[name.upper()]

    selected = {name: effective_proxy(environ, name) for name in PROXY_NAMES}
    schemes = {}
    for name, value in selected.items():
        if not value:
            continue
        try:
            proxy = urlsplit(value)
            scheme = proxy.scheme.lower()
            valid = proxy.hostname is not None
            proxy.port  # Validate an explicit port; standard default ports are valid too.
        except ValueError:
            valid = False
            scheme = ''
        if not valid or scheme not in SUPPORTED_SCHEMES:
            raise ProxyConfigurationError(
                f'{name} 格式无效；请使用 http://、https://、socks5:// 或 socks5h:// 代理地址。')
        schemes[name] = scheme

    if (schemes.get('all_proxy') in {'socks5', 'socks5h'}
            and schemes.get('http_proxy') in {'http', 'https'}
            and schemes.get('https_proxy') in {'http', 'https'}):
        for name in list(environ):
            if name.lower() == 'all_proxy':
                del environ[name]
        schemes.pop('all_proxy')
        messages.append('保留已配置的 HTTP/HTTPS 代理，忽略未使用的 ALL_PROXY SOCKS 兜底。')

    if any(scheme in {'socks5', 'socks5h'} for scheme in schemes.values()):
        socks_modules = {'socksio': available('socksio'), 'PySocks': available('socks')}
        missing = [name for name, installed in socks_modules.items() if not installed]
        if missing:
            raise ProxyConfigurationError(
                'SOCKS 下载代理需要 ' + '、'.join(missing)
                + '。请运行 bash scripts/voice-service.sh install 补齐依赖；代理设置未被关闭。')
    return messages
