"""Run a packaged redaction helper using fictional data and a private Unix socket."""
import base64
import hashlib
import http.client
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, sock):
        super().__init__('localhost', timeout=5)
        self.sock_path = str(sock)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.sock_path)


def smoke(binary):
    binary = Path(binary).resolve()
    policy = base64.b64encode(json.dumps({'secrets': True, 'personal': False}).encode()).decode()
    secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    with tempfile.TemporaryDirectory(prefix='kin-redact-package-') as tmp:
        root = Path(tmp)
        sock, cap = root / 'helper.sock', root / 'capability'
        child = subprocess.Popen([str(binary), '-sock', str(sock), '-key', str(root / 'key'), '-capability', str(cap)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            end = time.monotonic() + 10
            while not (sock.exists() and cap.exists()):
                assert child.poll() is None, child.stderr.read().decode()
                assert time.monotonic() < end, 'helper did not become ready'
                time.sleep(0.02)
            capability = cap.read_text()

            def call(path, body='', principal='fictional-key-a', session='fictional-session-a', auth=capability):
                conn = UnixHTTP(sock)
                try:
                    conn.request('GET' if path == '/health' else 'POST', path, body=body.encode(), headers={
                        'x-kin-redact-capability': auth,
                        'x-kin-redact-principal': principal,
                        'x-kin-redact-session': session,
                        'x-kin-redact-policy': policy,
                        'x-kin-redact-codec': 'json',
                    })
                    res = conn.getresponse()
                    return res.status, res.read().decode()
                finally:
                    conn.close()

            assert call('/health', auth='fictional-wrong-capability')[0] == 401
            status, health = call('/health')
            assert status == 200 and json.loads(health)['tag_format'] == 'R_v1'
            raw = json.dumps({'messages': [{'role': 'user', 'content': 'fictional ' + secret}]})
            status, masked = call('/v1/mask', raw)
            assert status == 200 and secret not in masked and '{{R_API_KEY_' in masked
            status, restored = call('/v1/restore', masked)
            assert status == 200 and json.loads(restored) == json.loads(raw)
            status, other = call('/v1/restore', masked, principal='fictional-key-b')
            assert status == 200 and secret not in other
            status, other_session = call('/v1/restore', masked, session='fictional-session-b')
            assert status == 200 and secret not in other_session
            print(json.dumps({'binary': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'checks': 6, 'pass': 6, 'fictional_only': True}))
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


for target in sys.argv[1:]:
    smoke(target)
