<script setup lang="ts">
import type { StepResult, StepRow } from "../../data/step-table"

defineProps<{ rows: readonly StepRow[] }>()

const RESULT_TEXT: Record<StepResult, string> = {
  pass: "pass",
  fail: "fail",
  held: "fail · not graded",
}

/** `row 2, col 1` becomes the `2;1` a terminal reports, so six columns fit in a popover at 412 px. */
function positionCell(value?: string): string | undefined {
  if (value === undefined) return undefined
  const match = /^row (\d+), col (\d+)$/.exec(value)
  return match ? `${match[1]};${match[2]}` : value
}
</script>

<template>
  <table class="result-steps">
    <caption>
      Steps
    </caption>
    <colgroup>
      <col style="width: 17%" />
      <col style="width: 26%" />
      <col style="width: 15%" />
      <col style="width: 15%" />
      <col style="width: 14%" />
      <col style="width: 13%" />
    </colgroup>
    <thead>
      <tr>
        <th scope="col">Step</th>
        <th scope="col">Sent</th>
        <th scope="col">Reply</th>
        <th scope="col">Expected row;col</th>
        <th scope="col">Got row;col</th>
        <th scope="col">Result</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, index) in rows" :key="index" :class="`result-steps__row result-steps__row--${row.result}`">
        <th scope="row">{{ row.step }}</th>
        <td>
          <code v-if="row.sent">{{ row.sent }}</code>
        </td>
        <td>
          <code v-if="row.reply">{{ row.reply }}</code>
        </td>
        <td :title="row.expected">{{ positionCell(row.expected) ?? "—" }}</td>
        <td :title="row.got">{{ positionCell(row.got) ?? "—" }}</td>
        <td>{{ RESULT_TEXT[row.result] }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.result-steps {
  width: 100%;
  margin: 6px 0 0;
  border-collapse: collapse;
  font-size: 0.66rem;
  line-height: 1.35;
  table-layout: fixed;
}
.result-steps caption {
  padding: 0 0 3px;
  font-size: 0.58rem;
  letter-spacing: 0.06em;
  text-align: left;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.result-steps th,
.result-steps td {
  padding: 3px 4px;
  border-top: 1px solid var(--vp-c-divider);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.result-steps thead th {
  border-top: 0;
  font-weight: 500;
  color: var(--vp-c-text-2);
}
.result-steps tbody th {
  font-weight: 500;
}
.result-steps code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
}
.result-steps__row--fail,
.result-steps__row--held {
  background: var(--vp-c-danger-soft, rgba(244, 63, 94, 0.08));
}
.result-steps__row--fail td:last-child,
.result-steps__row--held td:last-child {
  font-weight: 600;
}
.result-steps__row--held td:last-child {
  font-weight: 500;
  color: var(--vp-c-text-2);
}
</style>
