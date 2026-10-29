"""Slot-local Chromium and X11 remote input. No browser automation connection."""
import base64
import contextlib
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import signal
import struct
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo
import zlib


class NativeError(Exception):
    pass


def emit(event, **data):
    print(json.dumps({'event': event, **data}), flush=True)


def environment(payload, env):
    env = dict(env)
    slot = payload.get('slot_environment') or {}
    if slot.get('proxy_mode', 'slot_network') != 'slot_network':
        raise NativeError('slot_egress_mismatch')
    locale = str(slot.get('locale') or env.get('LC_ALL') or env.get('LANG') or 'en_US.UTF-8')
    language = locale.split('.', 1)[0].replace('_', '-')
    if language in ('C', 'POSIX'):
        language = 'en-US'
    if not re.fullmatch(r'[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*', language):
        raise NativeError('browser_locale_invalid')
    zone = str(slot.get('timezone') or env.get('TZ') or '').removeprefix(':')
    if not zone:
        zone = Path('/etc/timezone').read_text().strip()
    try:
        ZoneInfo(zone)
    except (ValueError, KeyError):
        raise NativeError('browser_timezone_invalid') from None
    for key in list(env):
        if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
            del env[key]
    env.update(TZ=zone, LANG=locale, LC_ALL=locale)
    return language, env


def allowed_url(value):
    try:
        url = urlparse(str(value))
        return (url.scheme == 'https' and url.hostname in {
            'chatgpt.com', 'www.chatgpt.com', 'auth.openai.com', 'auth0.openai.com',
            'login.live.com', 'login.microsoftonline.com', 'account.live.com',
            'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
        } and not url.username and not url.password and url.port in (None, 443))
    except ValueError:
        return False


def browser_command(runtime, profile, language, url):
    if not allowed_url(url):
        raise NativeError('browser_url_not_allowed')
    binaries = sorted(Path(runtime).glob('browsers/chromium-*/chrome-linux*/chrome'))
    if not binaries:
        raise NativeError('browser_runtime_unavailable')
    return [str(binaries[-1]), '--user-data-dir=' + str(profile),
            '--no-first-run', '--no-default-browser-check', '--no-sandbox',
            '--no-proxy-server', '--disable-quic', '--disable-dev-shm-usage', '--disable-gpu',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--lang=' + language, '--window-size=1365,900', '--start-maximized', url]


def profile_language(profile, language):
    # Chromium's UI language flag and HTTP language preference are separate.
    directory = profile / 'Default'
    directory.mkdir(mode=0o700, exist_ok=True)
    target = directory / 'Preferences'
    if profile.is_symlink() or directory.is_symlink() or target.is_symlink():
        raise NativeError('browser_runtime_invalid')
    try:
        preferences = json.loads(target.read_text())
    except FileNotFoundError:
        preferences = {}
    preferences.setdefault('intl', {}).update(accept_languages=language, selected_languages=language)
    temporary = target.with_suffix('.native.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x') as stream:
            os.chmod(temporary, 0o600)
            json.dump(preferences, stream)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def png_image(raw, width, height, stride, bits=32, byte_order=0):
    if bits != 32 or byte_order != 0 or width < 1 or height < 1:
        raise NativeError('browser_frame_unavailable')
    rows = []
    for y in range(height):
        bgra = raw[y * stride:y * stride + width * 4]
        rgb = bytearray(width * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = bgra[2::4], bgra[1::4], bgra[0::4]
        rows.append(b'\0' + rgb)
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(b''.join(rows), 1)) + chunk(b'IEND', b''))


class Desktop:
    def __init__(self):
        from Xlib import X, XK, display, protocol
        from Xlib.ext import xtest
        self.X, self.XK, self.protocol, self.xtest = X, XK, protocol, xtest
        self.display = display.Display()
        if not self.display.has_extension('XTEST'):
            raise NativeError('browser_native_input_unavailable')
        self.screen = self.display.screen()
        self.root = self.screen.root
        self.width, self.height = self.screen.width_in_pixels, self.screen.height_in_pixels
        self.window = self.root.create_window(0, 0, 1, 1, 0, X.CopyFromParent, X.InputOnly, X.CopyFromParent)
        self.selection = self.display.intern_atom('CLIPBOARD')
        self.utf8 = self.display.intern_atom('UTF8_STRING')
        self.targets = self.display.intern_atom('TARGETS')
        self.property = self.display.intern_atom('KIN_REMOTE_CLIPBOARD')
        self.text = ''
        self.paste_served = False
        self.received = None

    def pump(self):
        X = self.X
        while self.display.pending_events():
            event = self.display.next_event()
            if event.type == X.SelectionRequest:
                prop = event.property or event.target
                if event.target == self.targets:
                    event.requestor.change_property(prop, 4, 32, [self.targets, self.utf8, 31])
                elif event.target in (self.utf8, 31):
                    data = self.text.encode('utf-8' if event.target == self.utf8 else 'latin-1', errors='replace')
                    event.requestor.change_property(prop, event.target, 8, data)
                    self.paste_served = True
                else:
                    prop = X.NONE
                event.requestor.send_event(self.protocol.event.SelectionNotify(
                    time=event.time, requestor=event.requestor, selection=event.selection,
                    target=event.target, property=prop), propagate=False)
                self.display.flush()
            elif event.type == X.SelectionNotify and event.requestor == self.window:
                if event.property == X.NONE:
                    self.received = b''
                else:
                    value = self.window.get_full_property(self.property, self.utf8, sizehint=16385)
                    if value is None or value.format != 8 or len(value.value) > 16384:
                        raise NativeError('browser_clipboard_too_large')
                    self.received = bytes(value.value)

    def clipboard(self):
        owner = self.display.get_selection_owner(self.selection)
        if not owner:
            return ''
        if owner == self.window:
            return self.text
        self.received = None
        self.window.convert_selection(self.selection, self.utf8, self.property, self.X.CurrentTime)
        self.display.flush()
        deadline = time.monotonic() + 2
        while self.received is None and time.monotonic() < deadline:
            self.pump()
            time.sleep(.01)
        if self.received is None:
            raise NativeError('browser_clipboard_unavailable')
        return self.received.decode('utf-8', errors='replace')

    def key(self, value):
        aliases = {'Control': 'Control_L', 'ControlOrMeta': 'Control_L', 'Alt': 'Alt_L',
                   'Shift': 'Shift_L', 'Meta': 'Super_L', 'Enter': 'Return', 'Backspace': 'BackSpace',
                   'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
                   'PageUp': 'Prior', 'PageDown': 'Next', ' ': 'space', 'Space': 'space'}
        parts = str(value).split('+')
        if len(parts) > 4:
            raise NativeError('invalid_browser_key')
        codes = []
        for key in parts:
            symbol = self.XK.string_to_keysym(aliases.get(key, key))
            if not symbol:
                raise NativeError('invalid_browser_key')
            code = self.display.keysym_to_keycode(symbol)
            if not code:
                raise NativeError('invalid_browser_key')
            codes.append(code)
        for code in codes:
            self.xtest.fake_input(self.display, self.X.KeyPress, code)
            self.display.sync()
            time.sleep(.012)
        for code in reversed(codes):
            self.xtest.fake_input(self.display, self.X.KeyRelease, code)
            self.display.sync()
            time.sleep(.012)
        self.display.sync()

    def paste(self, text):
        if not isinstance(text, str) or len(text.encode('utf-8')) > 8000 or '\0' in text:
            raise NativeError('invalid_browser_text')
        self.text = text
        self.paste_served = False
        self.window.set_selection_owner(self.selection, self.X.CurrentTime)
        self.display.sync()
        self.key('Control+v')
        deadline = time.monotonic() + .25
        while not self.paste_served and time.monotonic() < deadline:
            self.pump()
            time.sleep(.01)
        # SelectionNotify is asynchronous: give the native client time to read
        # the property before a following Enter or paste replaces its contents.
        settled = time.monotonic() + .08
        while time.monotonic() < settled:
            self.pump()
            time.sleep(.01)

    def frame(self):
        image = self.root.get_image(0, 0, self.width, self.height, self.X.ZPixmap, 0xffffffff)
        fmt = next(f for f in self.display.display.info.pixmap_formats if f.depth == image.depth)
        stride = ((self.width * fmt.bits_per_pixel + fmt.scanline_pad - 1) // fmt.scanline_pad) * (fmt.scanline_pad // 8)
        png = png_image(image.data, self.width, self.height, stride, fmt.bits_per_pixel,
                        self.display.display.info.image_byte_order)
        return {'image': base64.b64encode(png).decode(), 'mime': 'image/png',
                'width': self.width, 'height': self.height, 'active': 0, 'paused': True,
                'native': True, 'tabs': [{'index': 0, 'url': '原生浏览器（标签页见远程画面）'}]}

    def control(self, message):
        op = message.get('op')
        if op == 'frame':
            return self.frame()
        if op in ('takeover', 'resume'):
            return {'paused': True, 'native': True}
        if op == 'clipboard':
            return {'text': self.clipboard()}
        if op == 'text':
            self.paste(message.get('text'))
        elif op == 'key':
            self.key(message.get('key'))
        elif op == 'click':
            x, y = float(message.get('x', -1)), float(message.get('y', -1))
            if not (0 <= x < self.width and 0 <= y < self.height):
                raise NativeError('invalid_browser_position')
            button = {'left': 1, 'middle': 2, 'right': 3}.get(message.get('button', 'left'))
            if button is None:
                raise NativeError('invalid_browser_operation')
            self.xtest.fake_input(self.display, self.X.MotionNotify, x=int(x), y=int(y))
            self.xtest.fake_input(self.display, self.X.ButtonPress, button)
            self.xtest.fake_input(self.display, self.X.ButtonRelease, button)
        elif op == 'wheel':
            for field, negative, positive in [('y', 4, 5), ('x', 6, 7)]:
                value = float(message.get(field, 0))
                for _ in range(min(8, int(abs(value) / 100) + (1 if value else 0))):
                    button = positive if value > 0 else negative
                    self.xtest.fake_input(self.display, self.X.ButtonPress, button)
                    self.xtest.fake_input(self.display, self.X.ButtonRelease, button)
        elif op in ('reload', 'back'):
            self.key('Control+r' if op == 'reload' else 'Alt+Left')
        elif op == 'tab':
            index = int(message.get('index', -1))
            if not 0 <= index <= 8:
                raise NativeError('invalid_browser_operation')
            self.key('Control+' + str(index + 1))
        elif op == 'navigate':
            url = message.get('url', '')
            if not allowed_url(url):
                raise NativeError('browser_url_not_allowed')
            self.key('Control+l')
            self.key('Control+a')
            self.paste(url)
            self.key('Enter')
        else:
            raise NativeError('browser_native_operation_unavailable')
        self.display.sync()
        return {'ok': True}

    def close(self):
        self.window.destroy()
        self.display.close()


@contextlib.contextmanager
def callback_listener(state, output):
    if not isinstance(state, str) or not 8 <= len(state) <= 512:
        raise NativeError('oauth_state_missing')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            parsed = urlparse(self.path)
            values = parse_qs(parsed.query)
            valid = (parsed.path == '/auth/callback' and
                     self.headers.get('Host') in ('localhost:1455', '127.0.0.1:1455') and
                     hmac.compare_digest(values.get('state', [''])[0], state))
            if not valid:
                self.send_error(400)
                return
            if values.get('error'):
                output.put(NativeError('oauth_denied'))
            elif values.get('code'):
                output.put('http://localhost:1455' + self.path)
            else:
                self.send_error(400)
                return
            body = b'Authorization received. You can continue using this browser, or close it from the panel.'
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
    class CallbackServer(ThreadingHTTPServer):
        daemon_threads = True
        def get_request(self):
            connection, address = super().get_request()
            # Chromium may preconnect without sending a request. Such a socket
            # must never block remote input, cancellation or another callback.
            connection.settimeout(2)
            return connection, address
    try:
        server = CallbackServer(('127.0.0.1', 1455), Handler)
    except OSError:
        raise NativeError('oauth_callback_unavailable') from None
    server.timeout = .01
    try:
        yield server
    finally:
        server.server_close()


def run(payload, controls):
    runtime = Path(os.environ.get('KIN_MAILBOX_ROOT', '/opt/kin-mailbox'))
    profile_key = hashlib.sha256((payload.get('email') or ('slot:' + payload.get('profile_id', 'default'))).encode()).hexdigest()[:24]
    legacy = Path('/var/lib/kin-mailbox') / profile_key
    profile = legacy if legacy.exists() else runtime / 'profiles' / profile_key
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    spec = importlib.util.spec_from_file_location('native_display', runtime / 'display/runtime.py')
    display_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(display_module)
    callbacks = queue.Queue()
    remote = payload.get('remote') is True
    keep_open = payload.get('keep_open') is True
    url = 'https://chatgpt.com/' if remote else payload.get('auth_url', '')
    listener = contextlib.nullcontext(None) if remote else callback_listener(payload.get('state', ''), callbacks)
    with display_module.slot_browser_display(runtime) as env, listener as server:
        language, env = environment(payload, env)
        profile_language(profile, language)
        # The X11 client connects to this private display only.
        os.environ.update(DISPLAY=env['DISPLAY'], XAUTHORITY=env['XAUTHORITY'])
        with contextlib.ExitStack() as stack:
            desktop = Desktop()
            stack.callback(desktop.close)
            browser = subprocess.Popen(browser_command(runtime, profile, language, url), env=env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            def close_browser():
                if browser.poll() is None:
                    browser.terminate()
                    try:
                        browser.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        browser.kill()
                        browser.wait()
            stack.callback(close_browser)
            emit('stage', stage='native_manual_login')
            retained = remote and keep_open
            idle, deadline = time.monotonic(), time.monotonic() + (1800 if remote else 500)
            while retained or time.monotonic() < deadline:
                desktop.pump()
                if server:
                    server.handle_request()
                if not callbacks.empty():
                    value = callbacks.get_nowait()
                    if isinstance(value, Exception):
                        raise value
                    emit('callback', callback_url=value)
                    if not keep_open:
                        return
                    # The panel exchanges and saves credentials while this same
                    # native window remains available. Release the one-shot
                    # callback port, but keep the profile, display and controls.
                    retained = True
                    server.server_close()
                    server = None
                if browser.poll() is not None:
                    if retained:
                        return
                    raise NativeError('browser_closed')
                if not retained and time.monotonic() - idle > 300:
                    raise NativeError('remote_idle_timeout')
                try:
                    message = controls.get(timeout=.03)
                except queue.Empty:
                    continue
                if message.get('op') != 'frame':
                    idle = time.monotonic()
                request_id = message.get('id', '')
                if not re.fullmatch(r'[a-f0-9-]{36}', request_id):
                    continue
                try:
                    result = desktop.control(message)
                    emit('rpc', id=request_id, ok=True, data=result)
                except NativeError as error:
                    if str(error) == 'login_cancelled':
                        raise
                    emit('rpc', id=request_id, ok=False, error_code=str(error))
                except Exception:
                    emit('rpc', id=request_id, ok=False, error_code='browser_control_failed')
            raise NativeError('login_timeout')


def main():
    os.umask(0o077)
    payload = json.loads(sys.stdin.readline())
    controls = queue.Queue()
    def cancel(*_args):
        raise NativeError('login_cancelled')
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGUSR1, cancel)
    def read_controls():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                if value.get('cancel'):
                    os.kill(os.getpid(), signal.SIGUSR1)
                    return
                controls.put(value)
            except ValueError:
                pass
        os.kill(os.getpid(), signal.SIGUSR1)
    threading.Thread(target=read_controls, daemon=True).start()
    try:
        run(payload, controls)
        return 0
    except NativeError as error:
        emit('stage', stage='failed', code=str(error))
    except Exception:
        emit('stage', stage='failed', code='browser_native_failed')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
