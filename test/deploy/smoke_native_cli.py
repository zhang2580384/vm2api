#!/usr/bin/env python3
"""Offline native CLI regression. Run in a disposable --network none container."""
import concurrent.futures
import http.client
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time


def main():
    cancelled_upstream = threading.Event()

    class Mock(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('content-length', '0')))
            body = json.loads(raw)
            if b'cancel-test' in raw:
                cancelled_upstream.set()
                time.sleep(5)
            message = {'id': 'msg_local', 'type': 'message', 'role': 'assistant',
                       'model': body['model'], 'content': [], 'stop_reason': None,
                       'stop_sequence': None, 'usage': {'input_tokens': 1, 'output_tokens': 0}}
            events = [{'type': 'message_start', 'message': message},
                      {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                      {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'ok'}},
                      {'type': 'content_block_stop', 'index': 0},
                      {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1}},
                      {'type': 'message_stop'}]
            data = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
            try:
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory(prefix='native-cli-smoke-') as directory:
        root = Path(directory)
        template = Path('/opt/vm2api/image-wrap-cli')
        native = Path('/opt/vm2api/image-native-cli')
        home = root / 'home'
        kin = home / '.kin'
        shutil.copytree(template, kin)
        shutil.copy2(native / 'cli-node', kin / 'cli-node')
        shutil.copytree(native / 'glibc239/arm64', kin / 'glibc239/arm64')
        (home / '.claude').mkdir()
        credentials = root / 'credentials.json'
        credentials.write_text(json.dumps({'anthropicApiKey': {'apiKey': 'offline-fixture-key'}}))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        config = {'vm_id': 'offline-native-smoke', 'socket_path': str(root/'kernel.sock'),
                  'credential_path': str(credentials), 'internal_token': 'offline-token',
                  'provider': 'local_cli', 'dataplane': 'wrap', 'claude_bin': str(kin/'cli-node'),
                  'slots_per_worker': 20, 'system_layout': 'zero', 'persona_preset': 'zero',
                  'cli_version': '2.1.303', 'default_cache_ttl': '5m', 'cc_entrypoint': 'cli',
                  'test_endpoints': True, 'anthropic_base_url': base, 'max_request_bytes': 134217728,
                  'first_byte_timeout_seconds': 90, 'idle_timeout_seconds': 90}
        config_path = root / 'kernel.json'
        config_path.write_text(json.dumps(config))
        env = {**os.environ, 'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home/'.claude'),
               'ANTHROPIC_API_KEY': 'offline-fixture-key', 'ANTHROPIC_BASE_URL': base,
               'DISABLE_TELEMETRY': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
               'NO_PROXY': '127.0.0.1,localhost'}
        for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'):
            env.pop(key, None)
        log = open(root/'kernel.log', 'w')
        proc = subprocess.Popen([str(kin/'kin-kernel'), '--gateway-worker', '--config', str(config_path)],
                                env=env, cwd=root, stdout=log, stderr=log, start_new_session=True)

        class Unix(http.client.HTTPConnection):
            def connect(self):
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(90)
                self.sock.connect(str(root/'kernel.sock'))

        def request(endpoint, body=None):
            conn = Unix('localhost', timeout=90)
            try:
                conn.request('GET' if body is None else 'POST', endpoint,
                             body=None if body is None else json.dumps(body, separators=(',', ':')).encode(),
                             headers={'x-internal-token': 'offline-token', 'content-type': 'application/json'})
                response = conn.getresponse()
                return response.status, response.read()
            finally:
                conn.close()

        def send(ident, size, text=None):
            body = {'model': 'claude-sonnet-5-5', 'stream': True, 'max_tokens': 16,
                    'messages': [{'role': 'user', 'content': text if text is not None else 'x'*size}]}
            start = time.monotonic()
            status, response = request('/internal/v1/messages', {'request_id': ident, 'body': body,
                                        'headers': {}, 'stream': True, 'delivery_mode': 'realtime'})
            return {'id': ident, 'bytes': size, 'status': status,
                    'complete': b'event: message_stop' in response,
                    'kernel_unavailable': b'kernel_unavailable' in response,
                    'elapsed_seconds': round(time.monotonic()-start, 3)}

        try:
            ready = False
            for _ in range(90):
                if proc.poll() is not None:
                    raise RuntimeError('kernel exited before readiness')
                try:
                    _, raw = request('/internal/health')
                    ready = json.loads(raw).get('ready_slots') == 20
                except (OSError, ValueError):
                    pass
                if ready:
                    break
                time.sleep(1)
            assert ready, 'kernel did not become ready'
            results = [send('single-'+str(size), size) for size in (1024, 15*1024*1024, 32*1024*1024)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                results += list(pool.map(lambda i: send('parallel-'+str(i), 15*1024*1024), range(4)))
            assert all(r['status'] == 200 and r['complete'] and not r['kernel_unavailable'] for r in results), results
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(send, 'cancel-probe', 11, 'cancel-test')
                assert cancelled_upstream.wait(15), 'cancel request never reached local mock'
                status, data = request('/internal/v1/cancel', {'request_id': 'cancel-probe'})
                assert status == 200 and json.loads(data).get('cancelled'), data
                pending.result(timeout=20)
            deadline = time.time() + 15
            health = {}
            while time.time() < deadline:
                _, raw = request('/internal/health')
                health = json.loads(raw)
                if (
                    health.get('healthy')
                    and health.get('cli_restarts') == 0
                    and health.get('ready_slots') == 20
                ):
                    break
                time.sleep(0.5)
            assert health.get('healthy') and health.get('cli_restarts') == 0 and health.get('ready_slots') == 20, health
            print(json.dumps({'passed': True, 'requests': results, 'cancelled': True,
                              'ready_slots': health['ready_slots'], 'cli_restarts': health['cli_restarts']}), flush=True)
        except Exception:
            log.flush()
            print((root/'kernel.log').read_text()[-6000:], flush=True)
            raise
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            server.shutdown()
            server.server_close()
            log.close()


if __name__ == '__main__':
    main()