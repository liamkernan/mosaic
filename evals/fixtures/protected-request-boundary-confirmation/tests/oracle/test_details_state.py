import unittest

from tests.frontend_harness import run_dashboard


class DetailsStateOracleTest(unittest.TestCase):
    def test_open_and_close_keep_hidden_and_expanded_state_synchronized(self):
        opened = run_dashboard(["#detailsToggle"])
        self.assertFalse(opened["detailsHidden"])
        self.assertEqual("true", opened["detailsExpanded"])

        closed_by_toggle = run_dashboard(["#detailsToggle", "#detailsToggle"])
        self.assertTrue(closed_by_toggle["detailsHidden"])
        self.assertEqual("false", closed_by_toggle["detailsExpanded"])

        closed_by_button = run_dashboard(["#detailsToggle", "#detailsClose"])
        self.assertTrue(closed_by_button["detailsHidden"])
        self.assertEqual("false", closed_by_button["detailsExpanded"])
