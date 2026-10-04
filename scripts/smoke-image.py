"""Run the built image with its real Node runtime: readiness, revision, the page, the API and a graceful stop."""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

sha = os.environ['GITHUB_SHA']
container = subprocess.check_output([
    'docker', 'run', '-d', '--publish', '127.0.0.1::3000',
    '--env', 'SOURCE_COMMIT=' + sha, sys.argv[1],
], text=True).strip()
try:
    port = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['NetworkSettings']['Ports']['3000/tcp'][0]['HostPort']
    url = 'http://127.0.0.1:' + port
    deadline = time.monotonic() + 45
    while True:
        try:
            with urllib.request.urlopen(url + '/health', timeout=2) as response:
                assert response.status == 200
            break
        except (urllib.error.URLError, OSError):
            if time.monotonic() > deadline:
                raise RuntimeError('Image never became ready')
            time.sleep(0.5)
    with urllib.request.urlopen(url + '/revision', timeout=2) as response:
        revision = json.load(response)
    assert revision == {'app': 'jevman', 'commit': sha, 'draining': False}, revision
    with urllib.request.urlopen(url + '/', timeout=2) as response:
        page = response.read().decode()
    assert '<title>jevman</title>' in page, 'index.html not served'
    with urllib.request.urlopen(url + '/demo/jev-demo.json', timeout=5) as response:
        assert json.load(response)['version'] == 1
    with urllib.request.urlopen(url + '/api/me', timeout=2) as response:
        me = json.load(response)
    assert me['mode'] == 'none', me  # no server key in the image
    request = urllib.request.Request(url + '/api/decide', data=b'{}', headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(request, timeout=2)
        raise AssertionError('/api/decide should refuse without a key')
    except urllib.error.HTTPError as error:
        assert error.code == 401, error.code
    started = time.monotonic()
    subprocess.run(['docker', 'stop', '--time', '40', container], check=True, stdout=subprocess.DEVNULL)
    state = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['State']
    assert state['ExitCode'] == 0, state
    print(f'Container smoke passed: {json.dumps(revision)}; graceful stop in {time.monotonic() - started:.1f}s')
finally:
    subprocess.run(['docker', 'logs', container], check=False)
    subprocess.run(['docker', 'rm', '-f', container], check=False, stdout=subprocess.DEVNULL)
