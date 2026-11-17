"""Verify Jevman's exact revision and public routes after publication."""

import argparse
import http.client
import json
import re
import time
import urllib.error
import urllib.request

from deploy import NoRedirect


ORIGIN = 'https://jevman.chadda.se'
ALIAS = 'https://jevman.apps.chadda.se'
MAX_BODY = 1024 * 1024


class VerificationError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def check_release(get, expected, origin, alias):
    def check_revision():
        headers, body = get(origin + '/revision', 200)
        require('no-store' in headers.get('Cache-Control', '').lower(),
                '/revision is missing its no-store cache directive')
        revision = json.loads(body)
        require(isinstance(revision, dict) and revision.get('app') == 'jevman',
                '/revision does not identify Jevman')
        commit = revision.get('commit')
        require(isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit),
                '/revision did not return a valid commit')
        require(commit == expected, f'/revision reports {commit}')
        require(revision.get('draining') is False, '/revision reports a draining or unknown state')

    check_revision()
    _, body = get(origin + '/health', 200)
    require(body == b'ready', '/health did not report ready')
    _, body = get(origin + '/', 200)
    require(b'<title>jevman' in body and b'og:image' in body, 'The home page is missing Jevman metadata')
    _, body = get(origin + '/leaderboard', 200)
    require(b'Which AI plays Pac-Man best?' in body, 'The leaderboard page was not served')
    _, body = get(origin + '/leaderboard.json', 200)
    leaderboard = json.loads(body)
    entries = leaderboard.get('entries') if isinstance(leaderboard, dict) else None
    require(isinstance(entries, list) and entries, 'The leaderboard is missing its entries')
    _, body = get(origin + '/api/me', 200)
    account = json.loads(body)
    require(isinstance(account, dict) and account.get('mode') == 'none' and account.get('loginAvailable') is True,
            '/api/me did not confirm that login is available for a signed-out visitor')
    path = '/leaderboard?from=release-check'
    headers, _ = get(alias + path, 301)
    require(headers.get('Location') == origin + path, 'The legacy host redirect changed its destination or query')
    check_revision()


def verify(revision, timeout, poll=5, origin=ORIGIN, alias=ALIAS):
    opener = urllib.request.build_opener(NoRedirect())
    opener.addheaders = [('User-Agent', 'JevmanRollout/1.0 (+https://github.com/joch/jevman)')]
    deadline = time.monotonic() + timeout

    def get(url, expected_status):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
        try:
            response = opener.open(request, timeout=min(10, remaining))
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.status == expected_status,
                    f'{url} returned HTTP {response.status}, expected {expected_status}')
            body = response.read(MAX_BODY + 1) if expected_status == 200 else b''
            require(len(body) <= MAX_BODY, f'{url} exceeded the response limit')
            return response.headers, body

    last_error = 'No probe completed'
    while time.monotonic() < deadline:
        try:
            check_release(get, revision, origin, alias)
            if time.monotonic() >= deadline:
                break
            return
        except VerificationError as error:
            last_error = str(error)
        except (OSError, ValueError, http.client.HTTPException) as error:
            if time.monotonic() >= deadline:
                break
            last_error = f'Public request or response parsing failed ({type(error).__name__})'
        time.sleep(min(poll, max(0, deadline - time.monotonic())))
    raise VerificationError(f'Timed out waiting for {revision}. Last check: {last_error}.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('revision', help='full Git SHA of the published release')
    parser.add_argument('--timeout', type=int, default=600, help='seconds to wait for public verification')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.revision) or not 1 <= args.timeout <= 600:
        parser.error('provide a full Git SHA and a timeout between 1 and 600 seconds')
    print(f'Waiting up to {args.timeout}s for public revision {args.revision}', flush=True)
    try:
        verify(args.revision, args.timeout)
    except VerificationError as error:
        parser.exit(1, f'{error}\n')
    print(f'Public Jevman revision {args.revision} passed health, leaderboard, account and redirect checks.')


if __name__ == '__main__':
    main()
