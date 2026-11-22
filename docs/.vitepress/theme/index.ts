import DefaultTheme from "vitepress/theme"
import type { Theme } from "vitepress"
import ResultEvidenceCell from "./ResultEvidenceCell.vue"
import RunHistory from "./RunHistory.vue"
import TermRow from "./TermRow.vue"
import SupportBar from "./SupportBar.vue"
import ResultList from "./ResultList.vue"
import CountPills from "./CountPills.vue"
import "./tooltip.css"
import "./result-cells.css"
import "./analysis.css"
import "./glossary-links.css"
import "./breadcrumb.css"
import "./summary-bars.css"
import "./hero.css"
import "./bar-rows.css"

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ResultEvidenceCell", ResultEvidenceCell)
    app.component("RunHistory", RunHistory)
    // #37761: one component per pattern, for every page.
    app.component("TermRow", TermRow)
    app.component("SupportBar", SupportBar)
    app.component("ResultList", ResultList)
    app.component("CountPills", CountPills)
  },
} satisfies Theme
