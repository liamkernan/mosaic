# Incident response console fixture

This dependency-free fixture contains a static incident dashboard and a small
Python incident service. Keep changes scoped to the reported behavior.

Python regressions belong under `tests/generated/test_*.py` and use the
standard library `unittest` runner. Frontend regressions can import
`tests.frontend_harness.run_dashboard`, which executes `dashboard.js` with the
complete boot-time DOM fixture.

Safe verification commands:

```sh
python3 -m unittest tests.baseline.test_fixture_baseline
python3 -m unittest discover -s tests/generated -p 'test_*.py'
```

Do not edit `tests/baseline/` or `tests/oracle/`; they are verification-only.
