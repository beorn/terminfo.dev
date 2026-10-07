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
    elif ($c.executable.path | type) != "string" or ($c.executable.sha256 | type) != "string" or
         ($c.invocation.path | type) != "string" or ($c.invocation.sha256 | type) != "string" or
         ($c.sourceArtifact.sha256 | type) != "string" then
      error("container executable or archive identity is missing")
    elif ($h.runnerArtifact.frozenRunnerSha256 | type) != "string" or
         ($h.runnerArtifact.buildReceiptSha256 | type) != "string" or
         $c.collector.frozenRunnerSha256 != $h.runnerArtifact.frozenRunnerSha256 or
         $c.collector.buildReceiptSha256 != $h.runnerArtifact.buildReceiptSha256 then
      error("container collector bytes disagree with host runner receipt")
    elif ($c.probeRun.runId | type) != "string" or ($c.probeRun.sha256 | type) != "string" then
      error("container v2 probe run identity is missing")
    elif ($h.selectedIDs // null) != ($c.selectedIDs // null) then
      error("host/container probe selection mismatch")
    elif ($c.display.glxinfo | type) != "string" or ($c.display.geometry | type) != "string" then
      error("container display receipt is missing")
    elif $c.clipboardFixture.runId != $h.runId or $c.clipboardFixture.profile != $h.clipboardProfile or
         ($c.clipboardFixture.sha256 | type) != "string" then
      error("container clipboard fixture disagrees with host run or profile")
    else
      $h + {
        executable:$c.executable,
        invocation:$c.invocation,
        sourceArtifact:($h.sourceArtifact + $c.sourceArtifact),
        collector:$c.collector,
        probeRun:$c.probeRun,
        display:$c.display,
        clipboardFixture:$c.clipboardFixture,
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
  [[ -n "${TERMINFO_RUN_ID:-}" && -n "${TERMINFO_RUNNER:-}" && -n "${KITTY_BINARY:-}" &&
     -n "${KITTY_EXPECTED_VERSION:-}" && -n "${KITTY_SOURCE_ARCHIVE:-}" &&
     -n "${KITTY_SOURCE_SRI:-}" && -n "${KITTY_SOURCE_URL:-}" &&
     -n "${TERMINFO_KITTY_PRESET:-}" && -n "${TERMINFO_CLIPBOARD_PROFILE:-}" ]] || {
    echo "Missing run, runner, Kitty, source, preset, or clipboard profile metadata" >&2
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
  jq -e --arg preset "$TERMINFO_KITTY_PRESET" --arg profile "$TERMINFO_CLIPBOARD_PROFILE" \
    --arg version "$KITTY_EXPECTED_VERSION" --arg url "$KITTY_SOURCE_URL" \
    '.preset == $preset and .clipboardProfile == $profile and
     .declaredTarget.version == $version and .sourceArtifact.url == $url' \
    /out/host-measured.json >/dev/null || {
      echo "Container preset, profile, or Kitty metadata disagrees with host receipt" >&2
      exit 2
    }
  [[ -d "$HOME" && -w "$HOME" ]] || { echo "HOME is not a writable private tmpfs" >&2; exit 2; }

  bun "$TERMINFO_RUNNER" --help >/out/import-smoke.txt 2>/out/import-smoke.err || {
    echo "Frozen runner import smoke failed" >&2
    cat /out/import-smoke.err >&2
    exit 2
  }
  selected_ids=${TERMINFO_PROBE_IDS-null}
  jq -e --argjson ids "$selected_ids" '(.selectedIDs // null) == $ids' /out/host-measured.json >/dev/null || {
    echo "Container probe selection disagrees with host receipt" >&2; exit 2;
  }
  runner_dir=$(dirname "$TERMINFO_RUNNER")
  build_receipt="$runner_dir/terminfo.bundle.receipt.json"
  [[ -r "$build_receipt" ]] || { echo "Frozen CLI build receipt is missing" >&2; exit 2; }
  runner_sha=$(sha256sum "$TERMINFO_RUNNER" | cut -d ' ' -f 1)
  receipt_sha=$(sha256sum "$build_receipt" | cut -d ' ' -f 1)
  jq -e --arg runner "$runner_sha" --arg receipt "$receipt_sha" \
    '.runnerArtifact.frozenRunnerSha256 == $runner and .runnerArtifact.buildReceiptSha256 == $receipt and
     .runnerArtifact.build.probeHash == .runtime.suiteHash and
     .runnerArtifact.build.collectorRevision == .runtime.sourceRevision' \
    /out/host-measured.json >/dev/null || {
    echo "Frozen collector differs from host build receipt" >&2; exit 2;
  }
  # This is the declared invocation. Nixpkgs may wrap it and exec another ELF.
  sha256sum "$KITTY_BINARY" | tee /out/invocation.sha256
  sha256sum "$KITTY_SOURCE_ARCHIVE" | tee /out/source-archive.sha256
  read -r source_sha source_path < /out/source-archive.sha256
  expected_source_sha=$(printf '%s' "${KITTY_SOURCE_SRI#sha256-}" | base64 -d | od -An -tx1 -v | tr -d ' \n')
  [[ "$KITTY_SOURCE_SRI" == sha256-* && "$source_sha" == "$expected_source_sha" ]] || {
    echo "Loaded Kitty source archive differs from declared fixed hash" >&2
    exit 2
  }
  "$KITTY_BINARY" --version | tee /out/executable-version.txt
  read -r executable_name actual_version _ < /out/executable-version.txt
  [[ "$executable_name" == kitty && "$actual_version" == "$KITTY_EXPECTED_VERSION" ]] || {
    echo "Loaded Kitty version is not declared $KITTY_EXPECTED_VERSION" >&2
    exit 2
  }
  fc-match -f '%{family} | %{file}\n' 'DejaVu Sans Mono' > /out/font.txt

  xvfb_pid=
  helper_pid=
  daemon_pid=
  cleanup() {
    local status=$?
    trap - EXIT
    for owned_pid in "$daemon_pid" "$helper_pid" "$xvfb_pid"; do
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
  chmod 600 "$HOME/display-number"
  read -r display_number <"$HOME/display-number"
  export DISPLAY=":$display_number"
  export XDG_CACHE_HOME="$HOME/.cache"
  xdpyinfo > /out/xdpyinfo.txt
  glxinfo -B > /out/glxinfo.txt
  grep -Eiq 'llvmpipe' /out/glxinfo.txt || {
    echo "GL renderer is not llvmpipe; run invalid" >&2
    exit 2
  }

  case "$TERMINFO_CLIPBOARD_PROFILE" in
    default)
      kitty_clipboard_control=
      clipboard_permissions='clipboard: read=ask,write=allow; OSC52=not-run'
      ;;
    allow)
      kitty_clipboard_control='write-clipboard read-clipboard'
      clipboard_permissions='clipboard: read=allow,write=allow'
      ;;
    deny-read)
      kitty_clipboard_control='write-clipboard'
      clipboard_permissions='clipboard: read=deny,write=allow'
      ;;
    *) echo "Unknown clipboard profile: $TERMINFO_CLIPBOARD_PROFILE" >&2; exit 2 ;;
  esac
  baseline_path="$HOME/clipboard-baseline.txt"
  printf 'terminfo-owned-clipboard-%s' "$TERMINFO_RUN_ID" > "$baseline_path"
  chmod 600 "$baseline_path"
  baseline_sha=$(sha256sum "$baseline_path" | cut -d ' ' -f 1)
  xclip_binary=$(readlink -f "$(command -v xclip)")
  xclip_sha=$(sha256sum "$xclip_binary" | cut -d ' ' -f 1)
  xclip -quiet -selection clipboard -in "$baseline_path" </dev/null >/out/xclip-owner.log 2>&1 &
  helper_pid=$!
  for _ in $(seq 1 100); do
    kill -0 "$helper_pid" 2>/dev/null || { cat /out/xclip-owner.log >&2; exit 2; }
    if timeout 1 xclip -selection clipboard -out > "$HOME/clipboard-initial-read.txt" 2>/out/xclip-initial-read.err &&
       cmp -s "$baseline_path" "$HOME/clipboard-initial-read.txt"; then
      break
    fi
    sleep 0.1
  done
  [[ -r "$HOME/clipboard-initial-read.txt" &&
     "$(sha256sum "$HOME/clipboard-initial-read.txt" | cut -d ' ' -f 1)" == "$baseline_sha" ]] || {
    echo "Owned xclip baseline did not survive independent clipboard read" >&2
    cat /out/xclip-owner.log /out/xclip-initial-read.err >&2
    exit 2
  }
  initial_read_sha=$(sha256sum "$HOME/clipboard-initial-read.txt" | cut -d ' ' -f 1)

  export TERMINFO_CAPTURE_DIRECTORY=/out/artifacts
  export TERMINFO_RUNTIME_PROVENANCE=/out/runtime-provenance.json
  export TERMINFO_CLIPBOARD_FIXTURE_RECEIPT=/out/clipboard-fixture.json
  kitty_args=(--config NONE --class terminfo-kitty-container-daemon
    -o remember_window_size=no -o initial_window_width=800 -o initial_window_height=600
    -o 'font_family=DejaVu Sans Mono' -o font_size=16)
  if [[ -n "$kitty_clipboard_control" ]]; then
    kitty_args+=(-o "clipboard_control=$kitty_clipboard_control")
  fi
  printf -v kitty_config '%q ' "${kitty_args[@]}"
  "$KITTY_BINARY" "${kitty_args[@]}" \
    bun "$TERMINFO_RUNNER" test --serve >/out/daemon.log 2>&1 &
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
  jq -e --arg version "$KITTY_EXPECTED_VERSION" \
    '.results[0].response | contains("kitty(" + $version + ")")' \
    /out/xtversion-observation.json >/dev/null || {
    echo "XTVERSION did not return declared Kitty $KITTY_EXPECTED_VERSION; run invalid" >&2; exit 2;
  }
  timeout 10 xdotool search --sync --onlyvisible --pid "$daemon_pid" > /out/windows.txt
  [[ "$(wc -l < /out/windows.txt)" == 1 ]] || { echo "Ambiguous owned probe window" >&2; exit 2; }
  read -r window_id </out/windows.txt
  [[ "$(xdotool getwindowpid "$window_id")" == "$daemon_pid" ]] || {
    echo "Probe window does not belong to the launched Kitty" >&2; exit 2;
  }
  collector_pid=$(jq -er .pid /out/daemon-registration.json)
  [[ "$collector_pid" =~ ^[0-9]+$ && -r "/proc/$collector_pid/status" ]] || {
    echo "Collector daemon registration does not identify a live process" >&2; exit 2;
  }
  window_pid=$(xdotool getwindowpid "$window_id")
  live_executable=$(readlink -f "/proc/$daemon_pid/exe")
  [[ -f "$live_executable" && -x "$live_executable" ]] || {
    echo "Owned Kitty PID has no live executable" >&2; exit 2;
  }
  live_executable_sha=$(sha256sum "/proc/$daemon_pid/exe" | cut -d ' ' -f 1)
  printf '%s  %s\n' "$live_executable_sha" "$live_executable" > /out/live-executable.sha256
  jq -n --arg run "$TERMINFO_RUN_ID" --arg profile "$TERMINFO_CLIPBOARD_PROFILE" \
    --arg display "$DISPLAY" --argjson number "$display_number" \
    --arg displayFdPath "$HOME/display-number" --argjson xvfbPid "$xvfb_pid" \
    --argjson terminalPid "$daemon_pid" --argjson collectorPid "$collector_pid" \
    --arg windowId "$window_id" --argjson windowPid "$window_pid" \
    --argjson helperPid "$helper_pid" --arg helperPath "$xclip_binary" --arg helperSha "$xclip_sha" \
    --arg baselinePath "$baseline_path" --arg baselineSha "$baseline_sha" --arg initialSha "$initial_read_sha" \
    --arg config "$kitty_config" --arg permissions "$clipboard_permissions" \
    '{schemaVersion:1,runId:$run,profile:$profile,
      display:{name:$display,number:$number,displayFdPath:$displayFdPath,xvfbPid:$xvfbPid},
      terminal:{pid:$terminalPid,collectorPid:$collectorPid,windowId:$windowId,windowPid:$windowPid},
      selection:{helperPid:$helperPid,helperExecutable:{path:$helperPath,sha256:$helperSha},
        baselinePath:$baselinePath,baselineSha256:$baselineSha,initialReadSha256:$initialSha},
      config:$config,permissions:$permissions}' > "$TERMINFO_CLIPBOARD_FIXTURE_RECEIPT"
  chmod 600 "$TERMINFO_CLIPBOARD_FIXTURE_RECEIPT"
  clipboard_fixture_sha=$(sha256sum "$TERMINFO_CLIPBOARD_FIXTURE_RECEIPT" | cut -d ' ' -f 1)
  xdotool getwindowgeometry --shell "$window_id" > /out/geometry.txt
  read -r source_sha source_path < /out/source-archive.sha256
  jq -n --slurpfile host /out/host-measured.json \
    --arg path "$live_executable" --arg sha "$live_executable_sha" \
    --arg version "$(cat /out/executable-version.txt)" --arg sourceSha "$source_sha" \
    --arg config "$kitty_config" \
    --rawfile font /out/font.txt --rawfile geometry /out/geometry.txt \
    --rawfile display /out/xdpyinfo.txt --rawfile gl /out/glxinfo.txt '
    $host[0] as $h | {
      executable:{path:$path,sha256:$sha,version:$version},
      sourceArtifact:{url:$h.sourceArtifact.url,sha256:$sourceSha},
      runtime:{imageId:$h.runtime.imageId,imageTarSha256:$h.runtime.imageTarSha256,
        arch:$h.runtime.arch,nixLockRevision:$h.runtime.nixLockRevision,
        sourceRevision:$h.runtime.sourceRevision,cleanTree:($h.runtime.sourceTreeStatus == "clean"),
        suiteHash:$h.runtime.suiteHash},
      fixture:{definition:"Shared ProbeDefinition callbacks; capture checkpoints retained in each raw trace",
        config:$config,font:$font,geometry:$geometry,display:$display,gl:$gl}
    }' > "$TERMINFO_RUNTIME_PROVENANCE"
  date -u +%FT%TZ > /out/batch-wall-start.txt
  batch_status=0
  curl --fail-with-body --silent --show-error --max-time 120 --output /out/v2-run.json \
    --write-out '%{time_total}\n' \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$port/probe" > /out/batch-elapsed-seconds.txt || batch_status=$?
  date -u +%FT%TZ > /out/batch-wall-end.txt
  [[ "$batch_status" == 0 ]] || { echo "Probe batch HTTP request failed: $batch_status" >&2; exit "$batch_status"; }
  if [[ "$selected_ids" != null ]]; then
    jq -e --argjson ids "$selected_ids" '
      (.observations | map(.featureId)) as $actual |
      ($actual | length) == ($ids | length) and ($actual | unique | length) == ($ids | length) and
      ($actual | sort) == ($ids | sort) and (.ungradedDiagnostics | length) == 0' /out/v2-run.json >/dev/null || {
      echo "Actual observation selection differs from requested IDs or has diagnostics" >&2; exit 2;
    }
  fi
  jq -e --slurpfile build "$build_receipt" --arg executablePath "$live_executable" \
    --arg executableSha "$live_executable_sha" '
    .schemaVersion == 2 and (.runId | type == "string" and test("^[0-9a-f]{32}$")) and
    .target.kind == "app" and .target.id == "kitty" and
    .identity == "unverified" and .origin.kind == "collector" and
    .probeHash == $build[0].probeHash and .suiteId == $build[0].probeHash and
    .sourceRevision == $build[0].collectorRevision and
    .provenance.executable.path == $executablePath and
    .provenance.executable.sha256 == $executableSha and
    (.suiteComplete | type == "boolean") and (.rawReplies | type == "object") and
    (.assertions | type == "array") and (.observations | type == "array") and
    (has("results") | not)' /out/v2-run.json >/dev/null || {
    echo "Daemon returned an invalid or mismatched v2 probe run; raw response retained" >&2; exit 2;
  }
  probe_run_id=$(jq -er .runId /out/v2-run.json)
  probe_run_sha=$(sha256sum /out/v2-run.json | cut -d ' ' -f 1)

  # The shared callbacks captured this daemon's own window before sealing the
  # run. Keep the original owned geometry in its receipt; a later window search
  # or geometry sample cannot replace the measurement recorded in provenance.
  #
  # A frame exists only when a selected probe called ctx.capture. A selection of pure queries
  # carries none, and that is a fact about the run, not a failure of it (27875): record
  # "no frame captured" and carry the run, instead of refusing it on a bare `jq -er` exit 2 that
  # named nothing. A probe that wanted a frame still fails by name in its own result, so the run's
  # results list exactly the frame-needing ids that were selected.
  capture_frame=$(jq -c '[.observations[].frames[]? | select(.role == "target")][0] // null' /out/v2-run.json)
  if [[ "$capture_frame" == null ]]; then
    echo "no frame captured: no selected probe called ctx.capture" >&2
    capture_receipt=null
  else
    png_sha=$(jq -er '.ref | select(test("^sha256:[a-f0-9]{64}$")) | sub("^sha256:"; "")' <<<"$capture_frame")
    xwd_sha=$(jq -er '.sourceRef | select(test("^sha256:[a-f0-9]{64}$")) | sub("^sha256:"; "")' <<<"$capture_frame")
    [[ -r "/out/artifacts/$png_sha.png" && -r "/out/artifacts/$xwd_sha.xwd" ]] || {
      echo "Callback capture artifacts are missing" >&2; exit 2;
    }
    [[ "$(sha256sum "/out/artifacts/$png_sha.png" | cut -d ' ' -f 1)" == "$png_sha" &&
       "$(sha256sum "/out/artifacts/$xwd_sha.xwd" | cut -d ' ' -f 1)" == "$xwd_sha" ]] || {
      echo "Callback capture digest mismatch" >&2; exit 2;
    }
    magick identify "/out/artifacts/$png_sha.png" > /out/image-info.txt
    capture_receipt=$(jq -n --arg xwd "artifacts/$xwd_sha.xwd" --arg xwdSha "$xwd_sha" \
      --arg png "artifacts/$png_sha.png" --arg pngSha "$png_sha" \
      '{xwd:$xwd,xwdSha256:$xwdSha,png:$png,pngSha256:$pngSha}')
  fi
  if compgen -G "/out/artifacts/*" >/dev/null; then
    sha256sum /out/artifacts/* > /out/capture-hashes.txt
  else
    : > /out/capture-hashes.txt
  fi
  jq -n --arg run "$TERMINFO_RUN_ID" --arg probe "$probe_run_id" --argjson capture "$capture_receipt" \
    '{status:"raw-unreviewed-history",runId:$run,probeRunId:$probe,capture:$capture,context:"linux-x86_64-xvfb-llvmpipe"}' \
    > /out/observed.json
  read -r invocation_sha invocation_path < /out/invocation.sha256
  read -r source_sha source_path < /out/source-archive.sha256
  jq -n --argjson ids "$selected_ids" --arg run "$TERMINFO_RUN_ID" \
    --arg executablePath "$live_executable" --arg executableSha "$live_executable_sha" \
    --arg invocationPath "$invocation_path" --arg invocationSha "$invocation_sha" \
    --arg executableVersion "$(cat /out/executable-version.txt)" \
    --arg sourcePath "$source_path" --arg sourceSha "$source_sha" \
    --arg runnerSha "$runner_sha" --arg receiptSha "$receipt_sha" \
    --arg probeRun "$probe_run_id" --arg probeSha "$probe_run_sha" --argjson capture "$capture_receipt" \
    --arg profile "$TERMINFO_CLIPBOARD_PROFILE" --arg clipboardSha "$clipboard_fixture_sha" \
    --rawfile glxinfo /out/glxinfo.txt --rawfile xdpyinfo /out/xdpyinfo.txt \
    --rawfile font /out/font.txt --rawfile geometry /out/geometry.txt \
    '{runId:$run,
      executable:{path:$executablePath,version:$executableVersion,sha256:$executableSha},
      invocation:{path:$invocationPath,sha256:$invocationSha},
      sourceArtifact:{path:$sourcePath,sha256:$sourceSha},
      collector:{frozenRunnerSha256:$runnerSha,buildReceiptSha256:$receiptSha},
      probeRun:{path:"v2-run.json",runId:$probeRun,sha256:$probeSha},
      display:{glxinfo:$glxinfo,xdpyinfo:$xdpyinfo,font:$font,geometry:$geometry},
      clipboardFixture:{path:"clipboard-fixture.json",runId:$run,profile:$profile,sha256:$clipboardSha},
      capture:$capture} + (if $ids == null then {} else {selectedIDs:$ids} end)' \
    > /out/container-receipt.json
  exit 0
fi

[[ "$#" -ge 5 && "${1:-}" == --preset && "${3:-}" == --clipboard-profile ]] || {
  echo "Usage: $0 --preset baseline|current --clipboard-profile default|allow|deny-read [--ids ID,ID] OUTPUT_DIRECTORY" >&2
  exit 2
}
preset=$2
clipboard_profile=$4
shift 4
probe_ids=null
if [[ "${1:-}" == --ids ]]; then
  count=0
  for argument in "$@"; do [[ "$argument" != --ids ]] || count=$((count + 1)); done
  [[ "$count" == 1 ]] || { echo "Repeated --ids" >&2; exit 2; }
  [[ "$#" -ge 3 && "${2:-}" != --* ]] || { echo "Missing --ids value" >&2; exit 2; }
  probe_ids=$(jq -cen --arg list "$2" '$list | split(",") | if length > 0 and all(.[]; test("^[a-z0-9][a-z0-9.-]*$")) and (unique | length) == length then . else error("Invalid probe IDs") end') || { echo "Invalid probe IDs" >&2; exit 2; }
  shift 2
fi
[[ "$#" == 1 && "$1" != --* ]] || { echo "Unknown flag or unexpected launch argument" >&2; exit 2; }
output_parent=$1
case "$preset" in
  baseline|current) ;;
  *) echo "Unknown Kitty preset: $preset" >&2; exit 2 ;;
esac
case "$clipboard_profile" in
  default|allow|deny-read) ;;
  *) echo "Unknown clipboard profile: $clipboard_profile" >&2; exit 2 ;;
esac
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
mkdir -p "$run_dir/prep/receipt" "$run_dir/raw"
prep="$run_dir/prep"
raw="$run_dir/raw"

# Resolve the declared workspace, then freeze the single CLI producer's output
# with its public package imports into the content-addressed image input.
(
  cd "$code_root" &&
  @in -- bun install --frozen-lockfile --ignore-scripts &&
  @in -- bun vendor/terminfo.dev/scripts/build-cli.ts &&
  mkdir -p "$prep/bundle" &&
  @in -- bun build \
    vendor/terminfo.dev/packages/terminfo.dev/dist/terminfo.bundle.mjs \
    --target=bun --outdir "$prep/bundle" &&
  mv "$prep/bundle/terminfo.bundle.js" "$prep/bundle/index.js"
) > "$prep/bundle-build.log" 2>&1 || {
  cat "$prep/bundle-build.log" >&2
  echo "Offline frozen runner build failed; preserved at $run_dir" >&2
  exit 2
}
cli_bundle="$vendor_root/packages/terminfo.dev/dist/terminfo.bundle.mjs"
cli_receipt="$vendor_root/packages/terminfo.dev/dist/terminfo.bundle.receipt.json"
[[ -s "$cli_bundle" && -s "$cli_receipt" && -s "$prep/bundle/index.js" ]] || {
  echo "CLI producer or frozen runner output is missing; preserved at $run_dir" >&2; exit 2;
}
jq -e '
  .schemaVersion == 1 and (.probeHash | type == "string" and test("^[0-9a-f]{12}$")) and
  (.collectorRevision | type == "string" and test("^[0-9a-f]{40}$")) and
  (.manifestSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
  (.bundleSha256 | type == "string" and test("^[0-9a-f]{64}$"))' \
  "$cli_receipt" >/dev/null || { echo "Invalid CLI producer receipt" >&2; exit 2; }
suite_hash=$(jq -er .probeHash "$cli_receipt")
source_revision=$(jq -er .collectorRevision "$cli_receipt")
cli_bundle_sha=$(sha256sum "$cli_bundle" | cut -d ' ' -f 1)
manifest_sha=$(sha256sum "$vendor_root/content/suites/$suite_hash.json" | cut -d ' ' -f 1)
[[ "$cli_bundle_sha" == "$(jq -er .bundleSha256 "$cli_receipt")" &&
   "$manifest_sha" == "$(jq -er .manifestSha256 "$cli_receipt")" &&
   "$source_revision" == "$(git -C "$vendor_root" rev-parse HEAD)" ]] || {
  echo "CLI bytes, suite declaration, or source revision differ from producer receipt" >&2; exit 2;
}
cp "$cli_receipt" "$prep/bundle/terminfo.bundle.receipt.json"
frozen_runner_sha=$(sha256sum "$prep/bundle/index.js" | cut -d ' ' -f 1)
build_receipt_sha=$(sha256sum "$prep/bundle/terminfo.bundle.receipt.json" | cut -d ' ' -f 1)
cp "$script_dir/linux-container-run.sh" "$prep/bundle/linux-container-run.sh"
(
  cd "$prep"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf runner-bundle.tar -C bundle .
)
bundle_sha=$(nix hash path --type sha256 --sri "$prep/bundle")
bundle_tar_sha=$(sha256sum "$prep/runner-bundle.tar" | cut -d ' ' -f 1)
source_status=clean
[[ -z "$(git -C "$vendor_root" status --porcelain)" ]] || source_status=dirty
root_revision=$(git -C "$code_root" rev-parse HEAD)
nix_lock_revision=$(jq -er '.nodes.nixpkgs.locked.rev' "$code_root/flake.lock")
root_lock_sha=$(sha256sum "$code_root/bun.lock" | cut -d ' ' -f 1)
(
  cd "$code_root"
  TERMINFO_LINUX_RUNNER_DIR="$prep/bundle" TERMINFO_LINUX_RUNNER_SHA256="$bundle_sha" \
    nix build --impure ".#kitty-visual-${preset}-image" --out-link "$prep/image.tar" \
      --option max-jobs 2 --option cores 2 -L
) > "$prep/nix-build.log" 2>&1 || {
  tail -100 "$prep/nix-build.log" >&2
  echo "Nix image build failed; preserved at $run_dir" >&2
  exit 2
}
image_tar_sha=$(sha256sum "$prep/image.tar" | cut -d ' ' -f 1)
docker load --input "$prep/image.tar" >"$prep/docker-load.txt"
image_id=$(docker image inspect "terminfo-kitty-probe:$preset" --format '{{.Id}}')
docker image inspect "$image_id" > "$prep/image-inspect.json"
image_arch=$(docker image inspect "$image_id" --format '{{.Architecture}}')
[[ "$image_arch" == amd64 ]] || { echo "Loaded image architecture is $image_arch, expected amd64" >&2; exit 2; }
jq -e --arg preset "$preset" '
  .[0].Config.Labels["org.hallohuman.terminfo.kitty.preset"] == $preset and
  (.[0].Config.Labels["org.hallohuman.terminfo.kitty.version"] | test("^[0-9]+[.][0-9]+[.][0-9]+$")) and
  (.[0].Config.Labels["org.hallohuman.terminfo.kitty.source-url"] | startswith("https://github.com/kovidgoyal/kitty/")) and
  (.[0].Config.Labels["org.hallohuman.terminfo.kitty.source-sri"] | test("^sha256-[A-Za-z0-9+/]{43}=$"))' \
  "$prep/image-inspect.json" >/dev/null || {
  echo "Loaded image lacks declared Kitty preset metadata" >&2; exit 2;
}
kitty_version=$(jq -er '.[0].Config.Labels["org.hallohuman.terminfo.kitty.version"]' "$prep/image-inspect.json")
source_url=$(jq -er '.[0].Config.Labels["org.hallohuman.terminfo.kitty.source-url"]' "$prep/image-inspect.json")
source_sri=$(jq -er '.[0].Config.Labels["org.hallohuman.terminfo.kitty.source-sri"]' "$prep/image-inspect.json")
for declared_env in "TERMINFO_KITTY_PRESET=$preset" "KITTY_EXPECTED_VERSION=$kitty_version" \
  "KITTY_SOURCE_URL=$source_url" "KITTY_SOURCE_SRI=$source_sri"; do
  jq -e --arg entry "$declared_env" '.[0].Config.Env | index($entry) != null' \
    "$prep/image-inspect.json" >/dev/null || {
    echo "Loaded image environment disagrees with declared Kitty metadata: $declared_env" >&2
    exit 2
  }
done
jq -n \
  --argjson ids "$probe_ids" --arg run "$run_id" --arg image "$image_id" --arg tar "$image_tar_sha" \
  --arg arch "$image_arch" --arg nix "$nix_lock_revision" --arg source "$source_revision" \
  --arg root "$root_revision" --arg suite "$suite_hash" --arg bundle "$bundle_tar_sha" \
  --arg bundleNar "$bundle_sha" --arg lock "$root_lock_sha" \
  --arg runnerSha "$frozen_runner_sha" --arg receiptSha "$build_receipt_sha" \
  --arg sourceStatus "$source_status" --slurpfile build "$cli_receipt" \
  --arg collectedAt "$(date -u +%FT%TZ)" \
  --arg grace "${TERMINFO_SENTINEL_GRACE_MS:-250}" \
  --arg preset "$preset" --arg profile "$clipboard_profile" --arg version "$kitty_version" \
  --arg url "$source_url" --arg sri "$source_sri" \
  --arg runnerUrl "file://$prep/runner-bundle.tar" \
  '{schemaVersion:1,kind:"linux-xvfb-container",collectedAt:$collectedAt,runId:$run,preset:$preset,clipboardProfile:$profile,sentinelGraceMs:($grace|tonumber),
    declaredTarget:{kind:"app",id:"kitty",version:$version,os:"linux"},
    sourceArtifact:{url:$url,sri:$sri},
    runnerArtifact:{url:$runnerUrl,sha256:$bundle,narSha256:$bundleNar,
      frozenRunnerSha256:$runnerSha,buildReceiptSha256:$receiptSha,
      build:$build[0],rootBunLockSha256:$lock},
    runtime:{imageId:$image,imageTarSha256:$tar,arch:$arch,nixLockRevision:$nix,
      sourceRevision:$source,sourceTreeStatus:$sourceStatus,rootRevision:$root,suiteHash:$suite},
    status:"raw-unreviewed-history"} + (if $ids == null then {} else {selectedIDs:$ids} end)' > "$raw/host-measured.json"

# The collector reads its ownership receipt from a read-only copy: the container being measured
# must not be able to rewrite the receipt that authorizes writing to the terminal it drives.
cp "$raw/host-measured.json" "$prep/receipt/host-measured.json"

selection_env=()
[[ "$probe_ids" == null ]] || selection_env=(--env "TERMINFO_PROBE_IDS=$probe_ids")
# The one-time sentinel-grace sizing pass widens the post-DA1 read; forward it only when the host
# asked for it, so an ordinary collection keeps the measured floor.
grace_env=()
[[ -z "${TERMINFO_SENTINEL_GRACE_MS:-}" ]] || grace_env=(--env "TERMINFO_SENTINEL_GRACE_MS=$TERMINFO_SENTINEL_GRACE_MS")
container_id=$(docker create --user "$(id -u):$(id -g)" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs "/tmp:rw,nosuid,nodev,mode=1777" \
  --tmpfs "/home/runner:rw,nosuid,nodev,uid=$(id -u),gid=$(id -g),mode=0700" \
  --mount "type=bind,src=$raw,dst=/out" \
  --mount "type=bind,src=$prep/receipt,dst=/receipt,readonly" \
  --env "TERMINFO_RUN_ID=$run_id" --env "TERMINFO_IMAGE_ID=$image_id" \
  --env "TERMINFO_CLIPBOARD_PROFILE=$clipboard_profile" "${selection_env[@]}" \
  "${grace_env[@]}" \
  --env "TERMINFO_DISPOSABLE_RECEIPT=/receipt/host-measured.json" \
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
# The collector was judged by the read-only copy; if the container rewrote the writable one the
# run's authorization is not the host's, so the receipt and the run are both refused.
cmp -s "$raw/host-measured.json" "$prep/receipt/host-measured.json" || {
  echo "Container rewrote the host-measured receipt; run invalid" >&2; exit 2;
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
probe_sha=$(sha256sum "$raw/v2-run.json" | cut -d ' ' -f 1)
jq -e --arg run "$(jq -er .probeRunId "$raw/observed.json")" --arg sha "$probe_sha" \
  '.probeRun.runId == $run and .probeRun.sha256 == $sha' "$raw/container-receipt.json" >/dev/null || {
  echo "Raw v2 run differs from container receipt" >&2; exit 2;
}
jq -e --slurpfile run "$raw/v2-run.json" \
  '.executable.path == $run[0].provenance.executable.path and
   .executable.sha256 == $run[0].provenance.executable.sha256' \
  "$raw/container-receipt.json" >/dev/null || {
  echo "Retained v2 run executable differs from measured container ELF" >&2; exit 2;
}
source_sha=$(jq -er .sourceArtifact.sha256 "$raw/container-receipt.json")
source_sri=$(nix hash convert --hash-algo sha256 --to sri "$source_sha")
[[ "$source_sri" == "$(jq -er .sourceArtifact.sri "$raw/host-measured.json")" ]] || {
  echo "Runtime Kitty source archive differs from the flake pin: $source_sri" >&2
  exit 2
}
clipboard_sha=$(sha256sum "$raw/clipboard-fixture.json" | cut -d ' ' -f 1)
jq -e --arg run "$run_id" --arg profile "$clipboard_profile" \
  '.runId == $run and .profile == $profile' "$raw/clipboard-fixture.json" >/dev/null || {
  echo "Retained clipboard fixture has wrong run ID or profile" >&2; exit 2;
}
jq -e --arg run "$run_id" --arg profile "$clipboard_profile" --arg sha "$clipboard_sha" \
  '.clipboardFixture.runId == $run and .clipboardFixture.profile == $profile and
   .clipboardFixture.sha256 == $sha' "$raw/container-receipt.json" >/dev/null || {
  echo "Container clipboard fixture differs from exact retained receipt" >&2; exit 2;
}
compose_receipt "$raw/host-measured.json" "$raw/container-receipt.json" "$raw/run-receipt.json"
echo "$run_dir"
