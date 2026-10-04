"""Sign a native Coolify webhook for the tested commit, then wait until jevman serves exactly that commit."""
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    sha = os.environ['GITHUB_SHA']
    repository = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Expected a full Git commit SHA')
    if os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Only main can deploy')
    webhook = os.environ['COOLIFY_WEBHOOK_URL']
    app_url = os.environ['APP_URL'].rstrip('/')
    for url in (webhook, app_url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Expected HTTPS URL without credentials')
    payload = json.dumps({
        'ref': 'refs/heads/main', 'after': sha,
        'repository': {'full_name': repository},
        'commits': [{'message': 'Deploy tested commit', 'added': [], 'removed': [], 'modified': []}],
    }, separators=(',', ':')).encode()
    signature = hmac.new(os.environ['COOLIFY_WEBHOOK_SECRET'].encode(), payload, hashlib.sha256).hexdigest()
    request = urllib.request.Request(webhook, data=payload, headers={
        'Content-Type': 'application/json', 'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': str(uuid.uuid4()), 'X-Hub-Signature-256': 'sha256=' + signature,
    })
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=30) as response:
        result = json.load(response)
    if not isinstance(result, list):
        raise RuntimeError('Unexpected webhook response')
    matches = [item for item in result if item.get('application_uuid') == os.environ['COOLIFY_APP_UUID']]
    if len(matches) != 1 or matches[0].get('status') != 'success' or not matches[0].get('deployment_uuid'):
        raise RuntimeError('Webhook did not queue the expected application')
    deployment = matches[0]['deployment_uuid']
    print(f'Queued deployment {deployment} for {sha}', flush=True)
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        try:
            with opener.open(app_url + '/revision', timeout=10) as response:
                revision = json.load(response)
            with opener.open(app_url + '/health', timeout=10) as response:
                healthy = response.status == 200
            if healthy and revision.get('app') == 'jevman' and revision.get('commit') == sha and not revision.get('draining'):
                print(f'Live: jevman at {sha}', flush=True)
                summary = os.environ.get('GITHUB_STEP_SUMMARY')
                if summary:
                    with open(summary, 'a') as output:
                        output.write(f'Deployed `{sha}` to {app_url}.\n\nCoolify deployment: `{deployment}`.\n')
                return
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(3)
    raise RuntimeError(f'Timed out waiting for {sha}; inspect Coolify deployment {deployment}')


if __name__ == '__main__':
    main()
