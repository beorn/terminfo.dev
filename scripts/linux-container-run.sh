#!/usr/bin/env bash
set -euo pipefail

# The same file is copied into the content-addressed runner input and serves
# as the container entry point. This is execution tooling, not a probe engine.
compose_receipt() {
  local host=$1 container=$2 output=$3
  [[ -r "$host" ]] || { echo "Missing host-measured receipt: $host" >&2; return 2; }
  [[ -r "$container" ]] || { echo "Missing container receipt: $container" >&2; return 2; }
  [[ ! -e "$output" ]] || { echo "Refusing to replace existing run receipt: $output" >&2; return 2; }
  local host_sha container_sha
  host_sha=$(sha256sum "$host" | cut -d ' ' -f 1)
  container_sha=$(sha256sum "$container" | cut -d ' ' -f 1)
  jq -e -n --slurpfile host "$host" --slurpfile container "$container" \
    --arg hostSha "$host_sha" --arg containerSha "$container_sha" '
    ($host[0]) as $h | ($container[0]) as $c |
    if ($h.runId | type) != "string" or ($c.runId | type) != "string" then
      error("missing runId in host or container receipt")
    elif $h.runId != $c.runId then
      error("runId mismatch between host and container receipts")
    elif ($h.runtime.imageId | type) != "string" or ($h.runtime.imageTarSha256 | type) != "string" then
      error("host image identity is missing")
    elif ($c.executable.sha256 | type) != "string" or ($c.sourceArtifact.sha256 | type) != "string" then
      error("container executable or archive identity is missing")
    elif ($c.display.glxinfo | type) != "string" or ($c.display.geometry | type) != "string" then
      error("container display receipt is missing")
    else
      $h + {
        executable:$c.executable,
        sourceArtifact:($h.sourceArtifact + $c.sourceArtifact),
        display:$c.display,
        capture:$c.capture,
        receiptInputs:{hostSha256:$hostSha,containerSha256:$containerSha}
      }
    end
  ' > "$output.partial" || {
    echo "Receipt composition failed; partial output retained at $output.partial" >&2
    return 2
  }
  mv "$output.partial" "$output"
}

# The launcher uses this same function after Docker exits. Shell-level checks
# can source it with owned temporary receipts without starting an image.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

if [[ "${1:-}" == "--inside" ]]; then
  shift
  [[ -n "${TERMINFO_RUN_ID:-}" && -n "${TERMINFO_RUNNER:-}" && -n "${KITTY_BINARY:-}" && -n "${KITTY_SOURCE_ARCHIVE:-}" ]] || {
    echo "Missing run ID, runner, Kitty binary, or source archive" >&2
    exit 2
  }
  [[ "$(id -u)" != 0 ]] || { echo "Refusing root container user" >&2; exit 2; }
  [[ -r /out/host-measured.json && -w /out ]] || { echo "Missing writable single-run output mount" >&2; exit 2; }
  [[ "$TERMINFO_RUN_ID" == "$(jq -er .runId /out/host-measured.json)" ]] || {
    echo "Container run ID disagrees with host receipt" >&2
    exit 2
  }
  [[ "${TERMINFO_IMAGE_ID:-}" == "$(jq -er .runtime.imageId /out/host-measured.json)" ]] || {
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
  read -r executable_sha executable_path < /out/executable.sha256
  read -r source_sha source_path < /out/source-archive.sha256
  xwd_sha=$(sha256sum /out/fixture.xwd | cut -d ' ' -f 1)
  jq -n --arg run "$TERMINFO_RUN_ID" \
    --arg executablePath "$executable_path" --arg executableSha "$executable_sha" \
    --arg executableVersion "$(cat /out/executable-version.txt)" \
    --arg sourcePath "$source_path" --arg sourceSha "$source_sha" \
    --arg png "$png_sha.png" --arg pngSha "$png_sha" --arg xwdSha "$xwd_sha" \
    --rawfile glxinfo /out/glxinfo.txt --rawfile xdpyinfo /out/xdpyinfo.txt \
    --rawfile font /out/font.txt --rawfile geometry /out/geometry.txt \
    '{runId:$run,
      executable:{path:$executablePath,version:$executableVersion,sha256:$executableSha},
      sourceArtifact:{path:$sourcePath,sha256:$sourceSha},
      display:{glxinfo:$glxinfo,xdpyinfo:$xdpyinfo,font:$font,geometry:$geometry},
      capture:{xwd:"fixture.xwd",xwdSha256:$xwdSha,png:$png,pngSha256:$pngSha}}' \
    > /out/container-receipt.json
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
  '{runId:$run, declaredTarget:{kind:"app",id:"kitty",version:"0.49.1",os:"linux"},
    sourceArtifact:{url:$url},
    runnerArtifact:{url:$runnerUrl,sha256:$bundle,narSha256:$bundleNar,rootBunLockSha256:$lock},
    runtime:{imageId:$image,imageTarSha256:$tar,arch:$arch,nixLockRevision:$nix,
      sourceRevision:$source,rootRevision:$root,suiteHash:$suite},
    status:"raw-unreviewed-history"}' > "$raw/host-measured.json"

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
[[ -r "$raw/container-receipt.json" ]] || {
  echo "Container exited without its runtime receipt; run invalid" >&2; exit 2;
}
jq -e --arg run "$run_id" '.runId == $run' "$raw/observed.json" >/dev/null || {
  echo "Raw observation run ID differs from host run ID" >&2; exit 2;
}
source_sha=$(jq -er .sourceArtifact.sha256 "$raw/container-receipt.json")
source_sri=$(nix hash convert --hash-algo sha256 --to sri "$source_sha")
[[ "$source_sri" == 'sha256-jP1o7UhNmjLk44mr/+Gg7G4PvXvlyeocT6Qbnq1K95E=' ]] || {
  echo "Runtime Kitty source archive differs from the flake pin: $source_sri" >&2
  exit 2
}
compose_receipt "$raw/host-measured.json" "$raw/container-receipt.json" "$raw/run-receipt.json"
echo "$run_dir"
