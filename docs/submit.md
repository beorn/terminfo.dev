---
title: Submit Results
description: Submit your terminal's feature test results to terminfo.dev
---

# Submit Results

Paste your terminal test results below to submit them to terminfo.dev.

## How to get results

Run one of these commands in your terminal:

```bash
# With Node.js
npx terminfo.dev test --json

# Without Node.js (Mac/Linux)
curl -sL terminfo.dev/test | sh
```

Then copy the JSON output and paste it below.

<div id="submit-form">
  <textarea id="json-input" rows="12" style="width: 100%; font-family: monospace; font-size: 13px; padding: 12px; border: 1px solid var(--vp-c-border); border-radius: 8px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); resize: vertical;" placeholder='Paste your JSON results here...'></textarea>
  <div style="margin-top: 12px;">
    <button id="submit-btn" style="padding: 8px 24px; font-size: 14px; border-radius: 6px; border: none; background: var(--vp-c-brand-1); color: white; cursor: pointer; font-weight: 500;">Submit as GitHub Issue</button>
    <span id="status" style="margin-left: 12px; font-size: 14px;"></span>
  </div>
</div>

<script setup>
import { onMounted } from 'vue'

onMounted(() => {
  const btn = document.getElementById('submit-btn')
  const input = document.getElementById('json-input')
  const status = document.getElementById('status')

  btn.addEventListener('click', () => {
    const raw = input.value.trim()
    if (!raw) {
      status.textContent = 'Please paste JSON results first.'
      status.style.color = 'var(--vp-c-danger-1)'
      return
    }

    let data
    try {
      data = JSON.parse(raw)
    } catch (e) {
      status.textContent = 'Invalid JSON. Please paste the full output from the test command.'
      status.style.color = 'var(--vp-c-danger-1)'
      return
    }

    const terminal = data.terminal || 'Unknown'
    const version = data.terminalVersion || ''
    const os = data.os || 'Unknown'
    const results = data.results || {}
    const passed = Object.values(results).filter(Boolean).length
    const total = Object.keys(results).length
    const pct = total > 0 ? Math.round((passed / total) * 100) : 0

    const title = `${terminal} results on ${os}`
    const body = `## Terminal Probe Results\n\nTerminal: **${terminal} ${version}** on ${os}\nPassed: ${passed}/${total} (${pct}%)\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``

    const url = `https://github.com/beorn/terminfo.dev/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=probe-results`

    window.open(url, '_blank')
    status.textContent = 'GitHub issue opened! Review and click "Submit new issue".'
    status.style.color = 'var(--vp-c-success-1)'
  })
})
</script>

## What happens next?

1. Your browser opens a pre-filled GitHub issue
2. Review the data — make sure your terminal was detected correctly
3. Click **Submit new issue**
4. We'll process the results and add your terminal to the database

Your terminal will appear on terminfo.dev within a few days.

## Already have npx?

The easiest way is the all-in-one command:

```bash
npx terminfo.dev submit
```

This tests your terminal and submits directly — no copy-paste needed.
