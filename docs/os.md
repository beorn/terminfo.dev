---
outline: deep
---

# Operating Systems

<p class="page-tagline">Terminal support by platform, with measured scores separated from availability and parser-only evidence</p>

<div class="beginner-intro">
<p>Terminals are not just protocol parsers. The OS windowing stack, font rendering, clipboard, input model, and pseudo-terminal layer all affect whether a feature works end-to-end. These pages show which terminals are available per platform, where terminfo.dev has platform-specific app probes, and where current scores are parser or reference evidence instead.</p>
</div>

<div class="platform-grid">

<a class="platform-card" href="/os/macos">
  <div class="platform-header">
    <span class="platform-name">macOS</span>
    <span class="platform-tag">app-probed</span>
  </div>
  <p class="platform-desc">Ghostty, iTerm2, Terminal.app, Kitty, Warp, VS Code, Cursor, and related parser backends.</p>
</a>

<a class="platform-card" href="/os/linux">
  <div class="platform-header">
    <span class="platform-name">Linux</span>
    <span class="platform-tag">gaps tracked</span>
  </div>
  <p class="platform-desc">Ghostty, Kitty, Warp, Alacritty, WezTerm, editor terminals, Unix multiplexers, plus foot and GNOME Terminal gaps.</p>
</a>

<a class="platform-card" href="/os/windows">
  <div class="platform-header">
    <span class="platform-name">Windows</span>
    <span class="platform-tag">ConPTY-aware</span>
  </div>
  <p class="platform-desc">Windows terminal apps, editor-integrated terminals, cross-platform terminals, and the ConPTY platform layer.</p>
</a>

</div>

## Evidence Levels

| Evidence             | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| App probe on this OS | Full terminal app was launched and probed on that platform.                   |
| Parser probe         | Reusable terminal parser/state machine was tested without GUI rendering.      |
| Inherited engine     | Page reuses an engine-equivalent score from another tracked terminal.         |
| Reference app probe  | App was probed on a different OS; useful signal, not platform-specific proof. |
| Not probed           | The terminal or platform layer is tracked as a coverage gap.                  |

---

<p class="back-link">
  <a href="/">&#8592; Back to matrix</a>
</p>

<style>
.page-tagline {
  font-size: 1.15em;
  color: var(--vp-c-text-2);
  margin-top: -0.5em;
  margin-bottom: 1.5em;
}

.beginner-intro {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 1em 1.25em;
  margin-bottom: 1.5em;
  font-size: 0.95em;
  line-height: 1.6;
}

.platform-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 1.5em 0 2em;
}

@media (max-width: 860px) {
  .platform-grid {
    grid-template-columns: 1fr;
  }
}

.platform-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 16px;
  background: var(--vp-c-bg-soft);
  color: inherit;
  text-decoration: none !important;
  display: block;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}

.platform-card:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.platform-card:hover .platform-name {
  color: var(--vp-c-brand-1) !important;
}

.platform-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.platform-name {
  font-weight: 700;
  font-size: 1em;
  transition: color 0.2s ease;
}

.platform-tag {
  margin-left: auto;
  font-size: 0.8em;
  color: var(--vp-c-text-3);
  font-weight: 600;
  flex-shrink: 0;
}

.platform-desc {
  font-size: 0.85em;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.5;
}

.back-link {
  margin-top: 2em;
  font-size: 0.9em;
}

.back-link a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.back-link a:hover {
  text-decoration: underline;
}
</style>
