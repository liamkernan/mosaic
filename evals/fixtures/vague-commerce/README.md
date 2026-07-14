# Cedar Market benchmark fixture

This deterministic fixture has two independent surfaces:

- `storefront/service.py` builds order-confirmation data and contains unrelated order and support helpers.
- `index.html`, `script.js`, and `styles.css` implement a dependency-free storefront with cart and quick-view behavior.

`tests/baseline/` protects existing behavior. Case-specific tests under `tests/oracle/` are evaluation-only and must never be included in model context or edited by generated changes.
