# Website changelog

## Unreleased — draft

- Corrected results attributed to the wrong terminal or backend by checking the measured run and runtime identity.
- Required catalog loaders reject missing files and invalid root or row shapes; discovery rejects corrupt retained records.
- Downgraded claims where a recognized sequence, missing reply or limited screenshot did not establish the reported behavior.
- Results separate immutable observations from reviewed interpretations, with probe coverage shown independently of support among conclusive results.
- Reviewed measurements cover Kitty 0.49.2 on Linux in three permission contexts and eleven Termless headless targets. Earlier excluded runs remain history; the corrected suite has not measured macOS or Windows apps.
- Per-result evidence links expose raw responses, assertions and available screenshots. A query response or headless cell check is not presented as proof of app rendering.
- The build footer links the owning source commit, build time and local/GitHub context in [build metadata](/api/v1/build.json). Deployment uses the same validated site archive, identified by its SHA-256.

Three gaps remain open: public standalone reproduction of controlled app captures, result-local expected properties for historical image reviews, and undated manual pointer confirmations. The [roadmap](/roadmap) separates this measurement repair from later interaction, multiplexer and platform work.

These changes await publication. The CLI package has a separate release path: tags beginning with `v` trigger its npm publication workflow. A future website-only GitHub release must use a different tag namespace, such as `site-v`, and must not invoke that workflow.
