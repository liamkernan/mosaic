from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class HeadingTypoOracleTest(unittest.TestCase):
    def test_incident_heading_uses_the_literal_correction(self):
        html = (ROOT / "index.html").read_text()
        self.assertIn("<h1>Incident response center</h1>", html)
        self.assertNotIn("Incidnet", html)
