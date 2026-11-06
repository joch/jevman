#!/usr/bin/env bash
set -euo pipefail

repository=ghcr.io/joch/jevman-deploy
package=users/joch/packages/container/jevman-deploy
revision=$GITHUB_SHA
image_id=$(cat "$1")

if [[ "$GITHUB_REPOSITORY" != joch/jevman || ! "$revision" =~ ^[a-f0-9]{40}$ ||
      ! "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'Unexpected repository, commit or image ID' >&2
  exit 1
fi
if [[ "$GITHUB_EVENT_NAME" != push || "$GITHUB_REF" != refs/heads/main ]]; then
  echo 'Expected a main branch push' >&2
  exit 1
fi

image=$(docker image inspect "$image_id")
if ! jq -e --arg id "$image_id" --arg revision "$revision" '
    length == 1 and .[0].Id == $id and .[0].Os == "linux" and
    .[0].Architecture == "amd64" and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision and
    .[0].Config.Labels["org.opencontainers.image.source"] == "https://github.com/joch/jevman"
  ' <<< "$image" >/dev/null; then
  echo 'The built image does not match the release revision or platform' >&2
  exit 1
fi
# Docker's classic image store reports the config digest as its image ID.
# The containerd store can report a manifest ID and expose the config digest
# separately. Registry uploads can change the manifest's layer encoding.
config_digest=$(jq -r '.[0] | .Descriptor.annotations["config.digest"] // .Id' <<< "$image")
if [[ ! "$config_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'The built image did not report a config digest' >&2
  exit 1
fi

# Publish only to the existing public package. Deployment credentials are
# supplied at runtime and never passed to the image build.
check_package_visibility() {
  if [[ "$(gh api "$package" --jq .visibility)" != public ]]; then
    echo 'Expected the existing public Jevman registry package' >&2
    exit 1
  fi
}

check_package_visibility

export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d "$RUNNER_TEMP/jevman-registry.XXXXXX")
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin

check_main_revision() {
  local current_revision
  current_revision=$(gh api repos/joch/jevman/git/ref/heads/main --jq .object.sha)
  if [[ ! "$current_revision" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'Could not verify the current main revision' >&2
    exit 1
  fi
  if [[ "$current_revision" != "$revision" ]]; then
    echo 'This release has been superseded by a newer main revision'
    exit 0
  fi
}

check_main_revision
docker tag "$image_id" "$repository:sha-$revision"
docker push "$repository:sha-$revision"
digest=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$repository:sha-$revision")
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'The registry did not report an image digest' >&2
  exit 1
fi
manifest=$(docker buildx imagetools inspect --raw "$repository@$digest")
if ! jq -e --arg id "$image_id" --arg config "$config_digest" --arg digest "$digest" '
    .schemaVersion == 2 and
    (.mediaType == "application/vnd.oci.image.manifest.v1+json" or
     .mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
    (.config.digest == $config or $digest == $id)
  ' <<< "$manifest" >/dev/null; then
  echo 'The registry image differs from the smoke-tested image' >&2
  exit 1
fi

check_package_visibility
check_main_revision

docker buildx imagetools create --prefer-index=false --tag "$repository:main" "$repository@$digest"
if [[ "$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$repository:main")" != "$digest" ]]; then
  echo 'The registry channel does not point to the verified image digest' >&2
  exit 1
fi
