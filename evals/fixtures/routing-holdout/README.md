# Account Portal fixture

This small fixture backs Mosaic's final unpinned GPT-5.6 routing holdout. The browser files implement account-order controls. The Python package implements order updates and an account-export workflow.

Keep changes scoped to the reported behavior. Preserve order identifiers and totals, do not expose credentials or session tokens, and place any generated Python regressions under tests/generated.
