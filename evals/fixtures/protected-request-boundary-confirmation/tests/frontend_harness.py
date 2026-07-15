import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


NODE_RUNNER = r"""
const fs = require("fs");
const vm = require("vm");

function element(attributes = {}, dataset = {}) {
  return {
    attributes: { ...attributes },
    dataset: { ...dataset },
    hidden: false,
    listeners: {},
    textContent: "",
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    click() {
      if (!this.listeners.click) throw new Error("Missing click handler");
      this.listeners.click();
    },
  };
}

const watchIncident = element({}, { watching: "false" });
const watchStatus = element();
watchStatus.textContent = "Not watching";
const detailsToggle = element({ "aria-controls": "detailsPanel", "aria-expanded": "false" });
const detailsPanel = element();
detailsPanel.hidden = true;
const detailsClose = element();

const elements = {
  "#watchIncident": watchIncident,
  "#watchStatus": watchStatus,
  "#detailsToggle": detailsToggle,
  "#detailsPanel": detailsPanel,
  "#detailsClose": detailsClose,
};
const document = { querySelector(selector) { return elements[selector] || null; } };

vm.runInNewContext(fs.readFileSync(process.argv[1], "utf8"), { document, String });
for (const action of JSON.parse(process.argv[2])) {
  const target = elements[action];
  if (!target) throw new Error(`Unknown action target: ${action}`);
  target.click();
}

process.stdout.write(JSON.stringify({
  watching: watchIncident.dataset.watching,
  watchStatus: watchStatus.textContent,
  detailsHidden: detailsPanel.hidden,
  detailsExpanded: detailsToggle.getAttribute("aria-expanded"),
}));
"""


def run_dashboard(actions):
    completed = subprocess.run(
        ["node", "-e", NODE_RUNNER, str(ROOT / "dashboard.js"), json.dumps(actions)],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)
