# Incident response integrity confirmation fixture

This dependency-free fixture contains a static incident dashboard and a small
Python incident service. Keep changes scoped to the reported behavior.

New Python regressions belong under `tests/generated/test_*.py` and use the
standard library `unittest` runner. Frontend regressions can import
`tests.frontend_harness.run_dashboard`, which executes `dashboard.js` with the
complete boot-time DOM fixture.

Existing verification-only suites are immutable and remain outside
model-visible planning, generation, and repair. Do not name, open, or modify
their files. Run new candidate regressions independently.
