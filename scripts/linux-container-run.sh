#!/usr/bin/env bash
set -euo pipefail

# The same file is copied into the content-addressed runner input and serves
# as the container entry point. This is execution tooling, not a probe engine.
if [[ "${1:-}" == "--inside" ]]; then
  shift
  [[ -n "${TERMINFO_RUN_ID:-}" && -n "${TERMINFO_RUNNER:-}" && -n "${KITTY_BINARY:-}" && -n "${KITTY_SOURCE_ARCHIVE:-}" ]] || {
    echo "Missing run ID, runner, Kitty binary, or source archive" >&2
    exit 2
  }
  [[ "$(id -u)" != 0 ]] || { echo "Refusing root container user" >&2; exit 2; }
  [[ -r /out/launch-input.json && -w /out ]] || { echo "Missing writable single-run output mount" >&2; exit 2; }
  [[ "${TERMINFO_IMAGE_ID:-}" == "$(jq -er .runtime.imageId /out/launch-input.json)" ]] || {
    echo "Loaded image ID disagrees with host receipt" >&2
    exit 2
  }
  [[ -d "$HOME" && -w "$HOME" ]] || { echo "HOME is not a writable private tmpfs" >&2; exit 2; }

  bun "$TERMINFO_RUNNER" --help >/out/import-smoke.txt 2>/out/import-smoke.err || {
    echo "Frozen runner import smoke failed" >&2
    cat /out/import-smoke.err >&2
    exit 2
  }
  sha256sum "$KITTY_BINARY" | tee /out/executable.sha256
  sha256sum "$KITTY_SOURCE_ARCHIVE" | tee /out/source-archive.sha256
  "$KITTY_BINARY" --version | tee /out/executable-version.txt
  grep -Eq '^kitty 0\.49\.1([[:space:]]|$)' /out/executable-version.txt || {
    echo "Loaded Kitty version is not 0.49.1" >&2
    exit 2
  }
  fc-match -f '%{family} | %{file}\n' 'DejaVu Sans Mono' > /out/font.txt

  xvfb_pid=
  daemon_pid=
  fixture_pid=
  cleanup() {
    local status=$?
    trap - EXIT
    for owned_pid in "$fixture_pid" "$daemon_pid" "$xvfb_pid"; do
      if [[ -n "$owned_pid" ]] && kill -0 "$owned_pid" 2>/dev/null; then
        if ! kill "$owned_pid"; then
          echo "Could not stop owned process $owned_pid" >&2
          status=1
        fi
        if ! wait "$owned_pid"; then
          echo "Owned process $owned_pid exited after termination" >&2
        fi
      fi
    done
    exit "$status"
  }
  trap cleanup EXIT

  Xvfb -displayfd 3 -screen 0 1024x768x24 +extension GLX +render -noreset -nolisten tcp \
    3>"$HOME/display-number" >/out/xvfb.log 2>&1 &
  xvfb_pid=$!
  for _ in $(seq 1 100); do
    [[ -s "$HOME/display-number" ]] && break
    kill -0 "$xvfb_pid" 2>/dev/null || { cat /out/xvfb.log >&2; exit 2; }
    sleep 0.1
  done
  [[ -s "$HOME/display-number" ]] || { echo "Xvfb display allocation timed out" >&2; exit 2; }
  read -r display_number <"$HOME/display-number"
  export DISPLAY=":$display_number"
  export XDG_CACHE_HOME="$HOME/.cache"
  xdpyinfo > /out/xdpyinfo.txt
  glxinfo -B > /out/glxinfo.txt
  grep -Eiq 'llvmpipe' /out/glxinfo.txt || {
    echo "GL renderer is not llvmpipe; run invalid" >&2
    exit 2
  }

  "$KITTY_BINARY" --config NONE --class terminfo-kitty-container-daemon \
    -o remember_window_size=no -o initial_window_width=800 -o initial_window_height=600 \
    -o font_family='DejaVu Sans Mono' -o font_size=16 \
    bun "$TERMINFO_RUNNER" probe server --start >/out/daemon.log 2>&1 &
  daemon_pid=$!
  daemon_dir="$HOME/.terminfo-dev/daemons"
  for _ in $(seq 1 150); do
    daemon_files=("$daemon_dir"/*.json)
    [[ -f "${daemon_files[0]}" ]] && break
    kill -0 "$daemon_pid" 2>/dev/null || { cat /out/daemon.log >&2; exit 2; }
    sleep 0.1
  done
  daemon_files=("$daemon_dir"/*.json)
  [[ "${#daemon_files[@]}" == 1 && -f "${daemon_files[0]}" ]] || {
    echo "Expected exactly one owned daemon registration" >&2
    exit 2
  }
  jq -e --arg run "$TERMINFO_RUN_ID" '.runId == $run and (.port | type == "number") and (.token | type == "string")' \
    "${daemon_files[0]}" >/dev/null || {
      echo "Daemon registration has wrong run ID or invalid fields" >&2
      exit 2
    }
  jq 'del(.token)' "${daemon_files[0]}" > /out/daemon-registration.json
  port=$(jq -er .port /out/daemon-registration.json)
  token=$(jq -er .token "${daemon_files[0]}")
  curl --fail-with-body --silent --show-error "http://127.0.0.1:$port/info" > /out/info.json
  jq -e --arg run "$TERMINFO_RUN_ID" '.runId == $run' /out/info.json >/dev/null || {
    echo "Daemon info has wrong run ID" >&2; exit 2;
  }
  jq -n --arg write "$(printf '\033[c')" --arg read '\x1b\[\?[0-9;]*c' \
    '{commands:[{write:$write,read:$read,timeout:2000}]}' >"$HOME/query.json"
  curl --fail-with-body --silent --show-error -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' --data-binary @"$HOME/query.json" \
    "http://127.0.0.1:$port/query" > /out/da1-observation.json
  jq -e '.results[0].response | type == "string" and length > 0' /out/da1-observation.json >/dev/null || {
    echo "DA1 query did not return a reply; run invalid" >&2; exit 2;
  }
  jq -n --arg write "$(printf '\033[>q')" --arg read '\x1bP>\|[^\x1b]*\x1b\\' \
    '{commands:[{write:$write,read:$read,timeout:2000}]}' >"$HOME/version-query.json"
  curl --fail-with-body --silent --show-error -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' --data-binary @"$HOME/version-query.json" \
    "http://127.0.0.1:$port/query" > /out/xtversion-observation.json
  jq -e '.results[0].response | contains("0.49.1")' /out/xtversion-observation.json >/dev/null || {
    echo "XTVERSION did not return Kitty 0.49.1; run invalid" >&2; exit 2;
  }

  "$KITTY_BINARY" --config NONE --class terminfo-kitty-container-fixture \
    -o remember_window_size=no -o initial_window_width=800 -o initial_window_height=600 \
    -o font_family='DejaVu Sans Mono' -o font_size=16 \
    bash -c 'printf "\033[2J\033[HKitty Linux container fixture\n\033[4:3mCurly underline\033[0m\n"; touch "$HOME/fixture-ready"; sleep 30' \
    >/out/fixture.log 2>&1 &
  fixture_pid=$!
  for _ in $(seq 1 100); do
    [[ -f "$HOME/fixture-ready" ]] && break
    kill -0 "$fixture_pid" 2>/dev/null || { cat /out/fixture.log >&2; exit 2; }
    sleep 0.1
  done
  [[ -f "$HOME/fixture-ready" ]] || { echo "Fixture did not become ready" >&2; exit 2; }
  timeout 10 xdotool search --sync --onlyvisible --class terminfo-kitty-container-fixture > /out/windows.txt
  read -r window_id </out/windows.txt
  xdotool getwindowgeometry --shell "$window_id" > /out/geometry.txt
  sleep 0.3
  xwd -id "$window_id" -silent > /out/fixture.xwd
  magick /out/fixture.xwd /out/fixture.png
  magick identify /out/fixture.png > /out/image-info.txt
  png_sha=$(sha256sum /out/fixture.png | cut -d ' ' -f 1)
  mv /out/fixture.png "/out/$png_sha.png"
  sha256sum /out/fixture.xwd "/out/$png_sha.png" > /out/capture-hashes.txt
  jq -n --arg run "$TERMINFO_RUN_ID" --arg png "$png_sha.png" \
    '{status:"raw-unreviewed-history",runId:$run,png:$png,context:"linux-x86_64-xvfb-llvmpipe"}' \
    > /out/observed.json
  exit 0
fi

[[ "$#" == 1 ]] || { echo "Usage: $0 OUTPUT_DIRECTORY" >&2; exit 2; }
output_parent=$1
script_dir=$(cd "$(dirname "$0")" && pwd -P)
vendor_root=$(cd "$script_dir/.." && pwd -P)
code_root=$(cd "$vendor_root/../.." && pwd -P)
[[ -f "$code_root/flake.nix" && -f "$code_root/bun.lock" ]] || {
  echo "Expected owned CODE root with flake.nix and bun.lock" >&2; exit 2;
}
mkdir -p "$output_parent"
output_parent=$(cd "$output_parent" && pwd -P)
run_id=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
run_dir="$output_parent/$run_id"
mkdir "$run_dir"
mkdir "$run_dir/prep" "$run_dir/raw"
prep="$run_dir/prep"
raw="$run_dir/raw"

# The offline frozen install checks that the current lock and cached package
# bytes can resolve the same workspace before the Bun bundle is frozen.
(
  cd "$code_root"
  AT_IN_ALLOW_SUBMODULE_DRIFT=1 @in -- bun install --frozen-lockfile --offline --ignore-scripts
  AT_IN_ALLOW_SUBMODULE_DRIFT=1 @in -- bun build \
    vendor/terminfo.dev/packages/admin/src/index.ts --target=bun --outdir "$prep/bundle"
) > "$prep/bundle-build.log" 2>&1 || {
  cat "$prep/bundle-build.log" >&2
  echo "Offline frozen runner build failed; preserved at $run_dir" >&2
  exit 2
}
cp "$script_dir/linux-container-run.sh" "$prep/bundle/linux-container-run.sh"
(
  cd "$prep"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf runner-bundle.tar -C bundle .
)
bundle_sha=$(nix hash path --type sha256 --sri "$prep/bundle")
bundle_tar_sha=$(sha256sum "$prep/runner-bundle.tar" | cut -d ' ' -f 1)
source_revision=$(git -C "$vendor_root" rev-parse HEAD)
[[ -z "$(git -C "$vendor_root" status --porcelain)" ]] || source_revision="$source_revision+dirty"
root_revision=$(git -C "$code_root" rev-parse HEAD)
nix_lock_revision=$(jq -er '.nodes.nixpkgs.locked.rev' "$code_root/flake.lock")
root_lock_sha=$(sha256sum "$code_root/bun.lock" | cut -d ' ' -f 1)
suite_hash=$(
  cd "$vendor_root"
  {
    printf '%s\n' packages/terminfo.dev/src/probes/unified.ts
    rg --files packages/probe-defs/src | rg '\.ts$' | rg -v '\.(test|spec)\.ts$'
  } | sort | while IFS= read -r path; do printf '%s\0' "$path"; cat "$path"; done | sha256sum | cut -d ' ' -f 1
)
(
  cd "$code_root"
  TERMINFO_LINUX_RUNNER_DIR="$prep/bundle" TERMINFO_LINUX_RUNNER_SHA256="$bundle_sha" \
    nix build --impure .#kitty-visual-current-image --out-link "$prep/image.tar" \
      --option max-jobs 2 --option cores 2 -L
) > "$prep/nix-build.log" 2>&1 || {
  tail -100 "$prep/nix-build.log" >&2
  echo "Nix image build failed; preserved at $run_dir" >&2
  exit 2
}
image_tar_sha=$(sha256sum "$prep/image.tar" | cut -d ' ' -f 1)
docker load --input "$prep/image.tar" >"$prep/docker-load.txt"
image_id=$(docker image inspect terminfo-kitty-probe:0.49.1 --format '{{.Id}}')
image_arch=$(docker image inspect "$image_id" --format '{{.Architecture}}')
[[ "$image_arch" == amd64 ]] || { echo "Loaded image architecture is $image_arch, expected amd64" >&2; exit 2; }
jq -n \
  --arg run "$run_id" --arg image "$image_id" --arg tar "$image_tar_sha" \
  --arg arch "$image_arch" --arg nix "$nix_lock_revision" --arg source "$source_revision" \
  --arg root "$root_revision" --arg suite "$suite_hash" --arg bundle "$bundle_tar_sha" \
  --arg bundleNar "$bundle_sha" --arg lock "$root_lock_sha" \
  --arg url 'https://github.com/kovidgoyal/kitty/releases/download/v0.49.1/kitty-0.49.1-x86_64.txz' \
  --arg runnerUrl "file://$prep/runner-bundle.tar" \
  '{runId:$run, executable:{path:"/nix/store/.../bin/kitty",version:"0.49.1",sha256:null},
    sourceArtifact:{url:$url,sha256:null},
    runnerArtifact:{url:$runnerUrl,sha256:$bundle,narSha256:$bundleNar,rootBunLockSha256:$lock},
    runtime:{imageId:$image,imageTarSha256:$tar,arch:$arch,nixLockRevision:$nix,
      sourceRevision:$source,rootRevision:$root,suiteHash:$suite},
    status:"raw-unreviewed-history"}' > "$raw/launch-input.json"

container_id=$(docker create --user "$(id -u):$(id -g)" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs "/tmp:rw,nosuid,nodev,mode=1777" \
  --tmpfs "/home/runner:rw,nosuid,nodev,uid=$(id -u),gid=$(id -g),mode=0700" \
  --mount "type=bind,src=$raw,dst=/out" \
  --env "TERMINFO_RUN_ID=$run_id" --env "TERMINFO_IMAGE_ID=$image_id" \
  "$image_id")
echo "$container_id" > "$prep/container-id.txt"
if ! timeout 180 docker start --attach "$container_id" > "$prep/container-stdout.log" 2>"$prep/container-stderr.log"; then
  if [[ "$(docker inspect "$container_id" --format '{{.State.Running}}')" == true ]]; then
    if ! docker stop --time 5 "$container_id" > "$prep/stop.txt" 2>&1; then
      echo "Could not stop owned container $container_id; see $prep/stop.txt" >&2
    fi
  fi
fi
docker inspect "$container_id" > "$prep/container-inspect.json"
exit_code=$(jq -er '.[0].State.ExitCode' "$prep/container-inspect.json")
logs_status=0
docker logs "$container_id" > "$prep/docker-stdout.log" 2>"$prep/docker-stderr.log" || logs_status=$?
docker rm "$container_id" > "$prep/docker-rm.txt"
[[ "$logs_status" == 0 ]] || {
  echo "Could not preserve Docker logs for $container_id (status $logs_status)" >&2
  exit 2
}
if [[ "$exit_code" != 0 || ! -f "$raw/observed.json" ]]; then
  echo "Container failed (exit $exit_code); raw artifacts preserved at $run_dir" >&2
  cat "$prep/container-stderr.log" >&2
  exit 2
fi
read -r executable_sha executable_path < "$raw/executable.sha256"
read -r source_sha source_path < "$raw/source-archive.sha256"
[[ -n "$executable_sha" && -n "$executable_path" && -n "$source_sha" && -n "$source_path" ]] || {
  echo "Runtime executable or source archive hash missing" >&2; exit 2;
}
source_sri=$(nix hash convert --hash-algo sha256 --to sri "$source_sha")
[[ "$source_sri" == 'sha256-jP1o7UhNmjLk44mr/+Gg7G4PvXvlyeocT6Qbnq1K95E=' ]] || {
  echo "Runtime Kitty source archive differs from the flake pin: $source_sri" >&2
  exit 2
}
jq --arg path "$executable_path" --arg executable "$executable_sha" \
  --arg source "$source_sha" --arg sourcePath "$source_path" \
  '.executable.path=$path | .executable.sha256=$executable |
   .sourceArtifact.sha256=$source | .sourceArtifact.path=$sourcePath' \
  "$raw/launch-input.json" > "$raw/run-receipt.json"
echo "$run_dir"
