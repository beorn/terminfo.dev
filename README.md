# terminfo.dev

**Can your terminal do that?** Feature support tables for terminal emulators — powered by automated testing.

Live at **[terminfo.dev](https://terminfo.dev)**

## What It Is

terminfo.dev is the "caniuse.com for terminal emulators." It shows which terminals support which features (SGR styling, cursor modes, Kitty keyboard, sixel graphics, OSC 8 hyperlinks, etc.) based on automated probe results from [termless](https://termless.dev).

## How It Works

1. **Probes** (`probes/*.probe.ts`) feed ANSI escape sequences to terminal emulator backends
2. **Results** are collected as pass/fail per feature per backend
3. **The site** (`docs/`) renders an interactive matrix at build time via VitePress

## Development

```bash
# Install dependencies
bun install

# Run probes probes (requires termless backends installed)
bun run probes:run

# View results
bun run probes:report

# Local dev server
bun run dev

# Build for production
bun run build
```

## probes CLI

```bash
bun run probes:run                # Run probes + show report
bun run probes:run --force        # Re-run even if cached
bun run probes:run xtermjs/*      # All xtermjs versions
bun run probes:run xtermjs/5.4.0  # Specific version
bun run probes:report             # Show cached results
bun run probes:status             # Config, backends, cache info
```

## Backends Tested

| Backend        | Engine                  | Type            |
| -------------- | ----------------------- | --------------- |
| xtermjs        | @xterm/headless 5.5     | JS              |
| ghostty        | ghostty-web 0.4         | WASM            |
| vt100          | Pure TypeScript         | JS              |
| alacritty      | alacritty_terminal 0.26 | Native (Rust)   |
| wezterm        | tattoy-wezterm-term     | Native (Rust)   |
| vt100-rust     | vt100 0.15              | Native (Rust)   |
| libvterm       | neovim/libvterm 0.3     | WASM (C)        |
| ghostty-native | libghostty-vt 1.3       | Native (Zig)    |
| kitty          | kitty 0.40              | Native (C, GPL) |
| peekaboo       | OS automation           | macOS           |

## Deployment

Built with [VitePress](https://vitepress.dev), deployed via [Cloudflare Pages](https://pages.cloudflare.com).

- **Build command**: `bun install && bun run build`
- **Output**: `docs/.vitepress/dist`
- **Custom domain**: terminfo.dev

## Related

- **[termless](https://termless.dev)** — headless terminal testing library (powers the probes)
- **[Silvery](https://silvery.dev)** — React TUI framework
