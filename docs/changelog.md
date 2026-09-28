# Website changelog

## Unreleased — draft

- Reporting work is in progress to separate recorded observations from reviewed results and to show probe coverage without treating unknown behavior as lack of support.
- Current terminal and Termless versions are being remeasured. The Linux Kitty container capture remains unreviewed history until its run and interpretation pass admission.
- Each future website build will identify the owning source commit, build time, local changes or GitHub run, and the same metadata in its build artifact.

These are proposed website changes, not a deployed release. The CLI package has a separate release path: tags beginning with `v` trigger its npm publication workflow. A future website-only GitHub release must use a different tag namespace, such as `site-v`, and must not invoke that workflow.
