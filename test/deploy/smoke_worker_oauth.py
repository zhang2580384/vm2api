#!/usr/bin/env python3
"""Exercise exact worker artifacts in disposable --network none containers."""
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse


def check_worker(binary):
    requests = []
    status = 200

    class Mock(http.server.BaseHTTPRequestHandler):
        def respond(self):
            raw = self.rfile.read(int(self.headers.get('content-length', '0')))
            body = json.loads(raw) if raw else None
            route = urllib.parse.urlsplit(self.path).path
            requests.append({'path': route, 'headers': dict(self.headers), 'body': body})
            replies = {
                '/oauth/token': {'access_token': 'FICTIONAL_NEW_ACCESS',
                                 'refresh_token': 'FICTIONAL_NEW_REFRESH', 'expires_in': 28800},
                '/api/oauth/profile': {'email': 'fictional@example.invalid'},
                '/api/oauth/usage': {'five_hour': {'utilization': 17}},
                '/v1/models': {'data': [{'id': 'fictional-model'}]},
                '/v1/messages/count_tokens': {'input_tokens': 123},
            }
            code = status if route != '/oauth/token' else 200
            if route not in replies:
                code = 404
            reply = replies.get(route, {'error': {'type': 'fixture_unknown_path'}})
            if code != 200:
                reply = {'error': {'type': 'fixture_failure', 'message': 'fictional error'}}
            data = json.dumps(reply).encode()
            self.send_response(code)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = respond
        do_POST = respond

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    rows = []
    try:
        with tempfile.TemporaryDirectory(prefix='fictional-worker-artifact-') as directory:
            root = Path(directory)
            credentials = root / 'credentials.json'
            config = root / 'worker.json'
            base = 'http://127.0.0.1:' + str(server.server_port)
            config.write_text(json.dumps({
                'vm_id': 'vm-fictional', 'socket_path': str(root / 'worker.sock'),
                'credential_path': str(credentials), 'proxy_required': True,
                'egress_mode': 'transparent', 'test_endpoints': True,
                'anthropic_base_url': base, 'oauth_token_url': base + '/oauth/token',
            }))
            cases = [('profile', 'oauth', 200), ('usage', 'oauth', 200),
                     ('models', 'oauth', 200), ('count-tokens', 'oauth', 200),
                     ('count-tokens', 'setup-token', 200), ('count-tokens', 'apikey', 200),
                     ('profile', 'expired-oauth', 200), ('refresh', 'expired-oauth', 200),
                     ('usage', 'oauth', 401), ('usage', 'oauth', 503)]
            for operation, kind, status in cases:
                requests.clear()
                oauth = {'accessToken': 'FICTIONAL_ACCESS', 'refreshToken': 'FICTIONAL_REFRESH',
                         'expiresAt': int(time.time() * 1000) + 3600000}
                document = {'type': 'oauth', 'claudeAiOauth': oauth}
                if kind == 'expired-oauth':
                    oauth['expiresAt'] = 1
                elif kind == 'setup-token':
                    document['type'] = kind
                    oauth.pop('refreshToken')
                elif kind == 'apikey':
                    document = {'type': 'apikey', 'anthropicApiKey': {'apiKey': 'FICTIONAL_API_KEY'}}
                credentials.write_text(json.dumps(document))
                payload = {'body': {'model': 'fictional-model',
                                    'messages': [{'role': 'user', 'content': 'FICTIONAL_COUNT'}]},
                           'headers': {'anthropic-beta': 'fictional-count-beta'}}
                result = subprocess.run([str(binary), 'oauth', operation, '--config', str(config)],
                                        input=json.dumps(payload), text=True, capture_output=True,
                                        timeout=40, env={'PATH': '/usr/local/bin:/usr/bin:/bin'})
                assert result.returncode == 0, (operation, kind, result.returncode, result.stderr)
                output = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                response = output[-1]
                assert response['ok'] == (status == 200), (operation, kind, response)
                assert response['status'] == status, (operation, kind, response)
                assert requests, (operation, kind, 'No local request observed')
                if kind == 'expired-oauth':
                    saved = json.loads(credentials.read_text())['claudeAiOauth']
                    assert saved['accessToken'] == 'FICTIONAL_NEW_ACCESS'
                    assert saved['refreshToken'] == 'FICTIONAL_NEW_REFRESH'
                    if operation == 'profile':
                        assert requests[-1]['headers']['Authorization'] == 'Bearer FICTIONAL_NEW_ACCESS'
                if operation == 'count-tokens':
                    final = requests[-1]
                    assert final['path'] == '/v1/messages/count_tokens'
                    assert final['body'] == payload['body']
                    headers = {key.lower(): value for key, value in final['headers'].items()}
                    assert headers['anthropic-beta'] == 'fictional-count-beta'
                    if kind == 'apikey':
                        assert headers['x-api-key'] == 'FICTIONAL_API_KEY'
                        assert 'authorization' not in headers
                    else:
                        assert headers['authorization'] == 'Bearer FICTIONAL_ACCESS'
                    assert response['body']['input_tokens'] == 123
                rows.append({'operation': operation, 'credential': kind, 'status': status,
                             'local_requests': len(requests), 'pass': True})
    finally:
        server.shutdown()
        server.server_close()
    return {'worker': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'cases': rows}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: smoke_worker_oauth.py <worker-binary> [more worker binaries]')
    for argument in sys.argv[1:]:
        print(json.dumps(check_worker(Path(argument).resolve())), flush=True)
