# Roadmap

These are planned areas of work, not release dates or claims that untested features are supported. The [changelog](/changelog) records the current unpublished correction draft.

## R1 — Trustworthy measurements

Correct overstated results and terminal attribution, review controlled Linux Kitty and headless-engine evidence, and make each reported result's scope, method and available evidence inspectable. Keep site, API and CLI results tied to the same reviewed runs and explain corrections publicly. This release remains under review; its remaining evidence and reproduction gaps are named in the changelog.

R1 does not add Mac or Windows app measurements, multiplexer implementation, new protocol families or automatic refresh. A missing or inconclusive measurement remains visible rather than becoming a support claim.

## R2 — Everyday interactions

Add behavioral evidence for common keyboard, paste, mouse, clipboard and basic image scenarios. A terminal recognizing a request is separate from successfully performing the interaction. Each new result needs a controlled target and an observable outcome.

## R3 — Multiplexer compatibility

Use controlled outer-terminal capability profiles to check what multiplexers preserve, translate or block, then verify a small set of real integrations. Each result distinguishes the mux contract from the behavior of the whole tested path.

Later work can cover more platforms and terminals, advanced protocols and scheduled refreshes. Each update needs its own reviewed evidence, scope and release notes. Rebuilding the site does not make an older measurement new.
